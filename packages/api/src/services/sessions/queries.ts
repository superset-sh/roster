import {
  db,
  delegations,
  members,
  messages,
  projects,
  threadSessions,
  type ThreadSubscriptionReason,
  threadSubscriptions,
  threads,
  users,
} from "@roster/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { agentDisplay, normalizeHandle } from "../../lib/agent-identity";
import {
  collectReferences,
  type ThreadReferences,
} from "../../lib/thread-references";
import { readableError } from "../../utils/session-error";
import { attachmentsForMessages } from "../attachments";
import { type ChannelScope, visibleToMember } from "../channels";
import {

  type ChannelMessage,
  messageColumns,
  toChannelMessage,
  withAttachments,
} from "../message-columns";

export interface WaitingOn {
  handle: string;
  display: string;
  channelId: string;
  channelSlug: string;
  threadId: string | null;
  status: string;
  lastProgress: string | null;
  task: string;
}

export interface ThreadBackgroundWork {
  rosterSessionId: string;
  id: string;
  kind: "process" | "subagent";
  name: string;
  detail?: string;
  canStop: boolean;
  startedAtMs: number;
}

export interface ThreadSummary {
  id: string;
  projectId: string;
  rootMessageId: string;
  status: string;
  lastProgress: string | null;
  error: string | null;
  startedAt: Date;
  endedAt: Date | null;
  rootText: string;
  authorName: string | null;
  authorEmail: string | null;
  replyCount: number;
  lastReplyAt: Date | null;
  replierNames: string[];
  waitingOn: WaitingOn[];
  completedAt: Date | null;
  completedByMemberId: string | null;
  backgroundWork: ThreadBackgroundWork[];
}

const THREAD_ID = sql.raw(`"roster"."threads"."id"`);

function uuidList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

interface ReplyStats {
  replyCount: number;
  lastReplyAt: Date | null;
  replierNames: string[];
}

const NO_REPLIES: ReplyStats = {
  replyCount: 0,
  lastReplyAt: null,
  replierNames: [],
};

async function replyStatsByThread(
  threadIds: string[],
): Promise<Map<string, ReplyStats>> {
  const found = new Map<string, ReplyStats>();
  if (threadIds.length === 0) return found;

  const result = await db.execute(sql`
    select
      s.thread_id,
      count(*)::int as reply_count,
      max(s.created_at) as last_reply_at,
      coalesce(json_agg(distinct s.display order by s.display), '[]'::json) as replier_names
    from (
      select
        rp.thread_id,
        rp.created_at,
        case
          when rp.kind = 'user' then coalesce(
            case when btrim(coalesce(ru.name, '')) <> '' then ru.name end,
            nullif(split_part(ru.email, '@', 1), ''),
            ru.email,
            'Unknown'
          )
          else coalesce(
            case when rm.type = 'agent'
              then nullif(regexp_replace(btrim(lower(rm.agent_name)), '^@', ''), '')
            end,
            'Agent'
          )
        end as display
      from roster.messages rp
      join roster.threads t on t.id = rp.thread_id
      left join auth.members rm on rm.id = rp.author_member_id
      left join auth.users ru on ru.id = rm.user_id
      where rp.thread_id in (${uuidList(threadIds)})
        and rp.id <> t.root_message_id
        and rp.deleted_at is null
    ) s
    group by s.thread_id`);

  for (const row of result.rows as Array<{
    thread_id: string;
    reply_count: number;
    last_reply_at: Date | string | null;
    replier_names: string[] | null;
  }>) {
    found.set(row.thread_id, {
      replyCount: Number(row.reply_count ?? 0),
      lastReplyAt: asDate(row.last_reply_at),
      replierNames: row.replier_names ?? [],
    });
  }

  return found;
}

interface LeadSession {
  status: string | null;
  lastProgress: string | null;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

const NO_SESSION: LeadSession = {
  status: null,
  lastProgress: null,
  error: null,
  startedAt: null,
  endedAt: null,
};

async function leadSessionByThread(
  threadIds: string[],
): Promise<Map<string, LeadSession>> {
  const found = new Map<string, LeadSession>();
  if (threadIds.length === 0) return found;

  const result = await db.execute(sql`
    select distinct on (ts.thread_id)
      ts.thread_id,
      ts.status,
      ts.last_progress,
      ts.error,
      ts.ended_at,
      min(ts.started_at) over (partition by ts.thread_id) as started_at
    from roster.thread_sessions ts
    where ts.thread_id in (${uuidList(threadIds)})
    order by ts.thread_id, ${LEAD_ORDER}`);

  for (const row of result.rows as Array<{
    thread_id: string;
    status: string | null;
    last_progress: string | null;
    error: string | null;
    started_at: Date | string | null;
    ended_at: Date | string | null;
  }>) {
    found.set(row.thread_id, {
      status: row.status,
      lastProgress: row.last_progress,
      error: row.error,
      startedAt: asDate(row.started_at),
      endedAt: asDate(row.ended_at),
    });
  }

  return found;
}

const LEAD_ORDER = sql`case ts.status when 'running' then 0 when 'needs_input' then 1 when 'starting' then 2 when 'waiting' then 3 when 'idle' then 4 else 5 end, case when ts.role = 'main' then 0 else 1 end, ts.started_at desc`;

function leadSession<T>(column: string): SQL<T> {
  return sql<T>`(select ts.${sql.raw(column)} from roster.thread_sessions ts where ts.thread_id = ${THREAD_ID} order by ${LEAD_ORDER} limit 1)`;
}

const statusSql = leadSession<string>("status");

const startedAtSql = sql<
  Date | string | null
>`(select min(ts.started_at) from roster.thread_sessions ts where ts.thread_id = ${THREAD_ID})`;

function childLead<T>(column: string): SQL<T> {
  return sql<T>`(select ts.${sql.raw(column)} from roster.thread_sessions ts where ts.thread_id = ${delegations.childThreadId} order by ${LEAD_ORDER} limit 1)`;
}

async function waitingOnByParent(
  parentThreadIds: string[],
): Promise<Map<string, WaitingOn[]>> {
  const found = new Map<string, WaitingOn[]>();
  if (parentThreadIds.length === 0) return found;

  const rows = await db
    .select({
      parentThreadId: delegations.parentThreadId,
      childThreadId: delegations.childThreadId,
      task: delegations.task,
      channelId: projects.id,
      channelSlug: projects.slug,
      ownerAgentName: members.agentName,
      status: childLead<string | null>("status").as("child_status"),
      lastProgress: childLead<string | null>("last_progress").as(
        "child_progress",
      ),
    })
    .from(delegations)
    .innerJoin(members, eq(delegations.targetMemberId, members.id))
    .innerJoin(threads, eq(delegations.parentThreadId, threads.id))
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .where(
      and(
        inArray(delegations.parentThreadId, parentThreadIds),
        eq(delegations.status, "open"),
      ),
    )
    .orderBy(asc(delegations.createdAt));

  for (const row of rows) {
    const waiting = found.get(row.parentThreadId) ?? [];
    waiting.push({
      handle: normalizeHandle(row.ownerAgentName),
      display: agentDisplay(row.ownerAgentName),
      channelId: row.channelId,
      channelSlug: row.channelSlug,
      threadId: row.childThreadId,
      status: row.status ?? "starting",
      lastProgress: row.lastProgress,
      task: row.task,
    });
    found.set(row.parentThreadId, waiting);
  }

  return found;
}

const summaryColumns = {
  id: threads.id,
  projectId: threads.projectId,
  rootMessageId: threads.rootMessageId,
  completedAt: threads.completedAt,
  completedByMemberId: threads.completedByMemberId,
  rootText: messages.text,
  authorName: users.name,
  authorEmail: users.email,
};

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface SummaryRow {
  id: string;
  projectId: string;
  rootMessageId: string;
  completedAt: Date | null;
  completedByMemberId: string | null;
  rootText: string | null;
  authorName: string | null;
  authorEmail: string | null;
}

interface ThreadExtras {
  replies: Map<string, ReplyStats>;
  leads: Map<string, LeadSession>;
  waiting: Map<string, WaitingOn[]>;
  background: Map<string, ThreadBackgroundWork[]>;
}

export async function backgroundWorkByThread(
  threadIds: string[],
): Promise<Map<string, ThreadBackgroundWork[]>> {
  const found = new Map<string, ThreadBackgroundWork[]>();
  if (threadIds.length === 0) return found;

  const rows = await db
    .select({
      id: threadSessions.id,
      threadId: threadSessions.threadId,
      tasks: threadSessions.backgroundTasks,
    })
    .from(threadSessions)
    .where(
      and(
        inArray(threadSessions.threadId, threadIds),
        sql`jsonb_array_length(${threadSessions.backgroundTasks}) > 0`,
      ),
    );

  for (const row of rows) {
    const work = found.get(row.threadId) ?? [];
    for (const task of row.tasks ?? []) {
      work.push({ rosterSessionId: row.id, ...task });
    }
    found.set(row.threadId, work);
  }

  return found;
}

async function threadExtras(threadIds: string[]): Promise<ThreadExtras> {
  const [replies, leads, waiting, background] = await Promise.all([
    replyStatsByThread(threadIds),
    leadSessionByThread(threadIds),
    waitingOnByParent(threadIds),
    backgroundWorkByThread(threadIds),
  ]);

  return { replies, leads, waiting, background };
}

function toSummary(row: SummaryRow, extras: ThreadExtras): ThreadSummary {
  const replies = extras.replies.get(row.id) ?? NO_REPLIES;
  const lead = extras.leads.get(row.id) ?? NO_SESSION;

  return {
    id: row.id,
    projectId: row.projectId,
    rootMessageId: row.rootMessageId,
    completedAt: asDate(row.completedAt),
    completedByMemberId: row.completedByMemberId,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    status: lead.status ?? "starting",
    lastProgress: lead.lastProgress,
    error: readableError(lead.error),
    startedAt: lead.startedAt ?? new Date(),
    endedAt: lead.endedAt,
    rootText: row.rootText ?? "",
    replyCount: replies.replyCount,
    lastReplyAt: replies.lastReplyAt,
    replierNames: replies.replierNames,
    waitingOn: extras.waiting.get(row.id) ?? [],
    backgroundWork: extras.background.get(row.id) ?? [],
  };
}

export interface ChannelThread extends ThreadSummary {
  lastReadAt: Date | null;
  muted: boolean;
}

export async function listChannelThreads(args: {
  projectId: string;
  memberId: string;
}): Promise<ChannelThread[]> {
  const rows = await db
    .select({
      ...summaryColumns,
      lastReadAt: threadSubscriptions.lastReadAt,
      muted: isNotNull(threadSubscriptions.mutedAt),
    })
    .from(threads)
    .leftJoin(messages, eq(threads.rootMessageId, messages.id))
    .leftJoin(members, eq(messages.authorMemberId, members.id))
    .leftJoin(users, eq(members.userId, users.id))
    .leftJoin(
      threadSubscriptions,
      and(
        eq(threadSubscriptions.threadId, threads.id),
        eq(threadSubscriptions.memberId, args.memberId),
      ),
    )
    .where(eq(threads.projectId, args.projectId))
    .orderBy(desc(startedAtSql))
    .limit(100);

  const extras = await threadExtras(rows.map((row) => row.id));

  return rows.map((row) => ({
    ...toSummary(row, extras),
    lastReadAt: asDate(row.lastReadAt),
    muted: Boolean(row.muted),
  }));
}

export interface InboxThread extends ThreadSummary {
  channelSlug: string;
  channelName: string;
  lastActivityAt: Date;
  unread: boolean;
  muted: boolean;
  reason: ThreadSubscriptionReason;
}

export async function listInboxThreads(
  scope: ChannelScope,
): Promise<InboxThread[]> {
  const rows = await db
    .select({
      ...summaryColumns,
      channelSlug: projects.slug,
      channelName: projects.name,
      lastActivityAt: threads.lastActivityAt,
      unread: sql<boolean>`${threads.lastActivityAt} > ${threadSubscriptions.lastReadAt}`,
      muted: isNotNull(threadSubscriptions.mutedAt),
      reason: threadSubscriptions.reason,
    })
    .from(threads)
    .innerJoin(
      threadSubscriptions,
      and(
        eq(threadSubscriptions.threadId, threads.id),
        eq(threadSubscriptions.memberId, scope.memberId),
      ),
    )
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .leftJoin(messages, eq(threads.rootMessageId, messages.id))
    .leftJoin(members, eq(messages.authorMemberId, members.id))
    .leftJoin(users, eq(members.userId, users.id))
    .where(
      and(
        eq(threads.organizationId, scope.organizationId),
        visibleToMember(scope.memberId, scope.role),
      ),
    )
    .orderBy(desc(threads.lastActivityAt))
    .limit(200);

  const extras = await threadExtras(rows.map((row) => row.id));

  return rows.map((row) => ({
    ...toSummary(row, extras),
    channelSlug: row.channelSlug,
    channelName: row.channelName,
    lastActivityAt: asDate(row.lastActivityAt) ?? new Date(),
    unread: Boolean(row.unread),
    muted: Boolean(row.muted),
    reason: row.reason,
  }));
}

/*
 * What counts as working in the sidebar and the threads list. `idle` is
 * deliberately absent: it is where every session comes to rest, so including
 * it would leave every thread ever run showing as live forever. A rested
 * session reaches the sidebar through the unseen-turn half of
 * `listLiveThreads` instead, which expires as soon as someone reads it.
 */
export const LIVE_THREAD_STATUSES = [
  "starting",
  "running",
  "needs_input",
  "waiting",
] as const;

const FINISHED_TURN_STATUSES = ["idle", "completed"] as const;

export interface LiveThread {
  id: string;
  projectId: string;
  channelSlug: string;
  status: string;
  rootText: string;
  lastProgress: string | null;
  startedAt: Date;
  turnUnseen: boolean;
}

const LIVE_STATUS_LIST = sql.join(
  LIVE_THREAD_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

const FINISHED_STATUS_LIST = sql.join(
  FINISHED_TURN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

const HAS_LIVE_SESSION = sql`exists (select 1 from roster.thread_sessions ts where ts.thread_id = ${THREAD_ID} and ts.status in (${LIVE_STATUS_LIST}))`;

const ENDED_SINCE_LAST_READ = sql`exists (select 1 from roster.thread_sessions ts where ts.thread_id = ${threadSubscriptions.threadId} and ts.status in (${FINISHED_STATUS_LIST}) and ts.ended_at > ${threadSubscriptions.lastReadAt})`;

const LIVE_LIMIT = 200;

interface LiveRow {
  id: string;
  projectId: string;
  channelSlug: string;
  rootText: string | null;
}

function workingThreads(scope: ChannelScope): Promise<LiveRow[]> {
  return db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      channelSlug: projects.slug,
      rootText: messages.text,
    })
    .from(threads)
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .leftJoin(messages, eq(threads.rootMessageId, messages.id))
    .where(
      and(
        eq(threads.organizationId, scope.organizationId),
        visibleToMember(scope.memberId, scope.role),
        isNull(threads.completedAt),
        HAS_LIVE_SESSION,
      ),
    )
    .orderBy(desc(startedAtSql))
    .limit(LIVE_LIMIT);
}

function unreadTurnThreads(scope: ChannelScope): Promise<LiveRow[]> {
  return db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      channelSlug: projects.slug,
      rootText: messages.text,
    })
    .from(threadSubscriptions)
    .innerJoin(threads, eq(threadSubscriptions.threadId, threads.id))
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .leftJoin(messages, eq(threads.rootMessageId, messages.id))
    .where(
      and(
        eq(threadSubscriptions.memberId, scope.memberId),
        isNull(threadSubscriptions.mutedAt),
        eq(threads.organizationId, scope.organizationId),
        visibleToMember(scope.memberId, scope.role),
        isNull(threads.completedAt),
        ENDED_SINCE_LAST_READ,
      ),
    )
    .orderBy(desc(startedAtSql))
    .limit(LIVE_LIMIT);
}

export async function listLiveThreads(
  scope: ChannelScope,
): Promise<LiveThread[]> {
  const [working, unread] = await Promise.all([
    workingThreads(scope),
    unreadTurnThreads(scope),
  ]);

  const rows = new Map<string, LiveRow & { turnUnseen: boolean }>();
  for (const row of working) rows.set(row.id, { ...row, turnUnseen: false });
  for (const row of unread) {
    if (!rows.has(row.id)) rows.set(row.id, { ...row, turnUnseen: true });
  }

  const leads = await leadSessionByThread([...rows.keys()]);

  return [...rows.values()]
    .map((row) => {
      const lead = leads.get(row.id) ?? NO_SESSION;

      return {
        id: row.id,
        projectId: row.projectId,
        channelSlug: row.channelSlug,
        status: lead.status ?? "starting",
        rootText: row.rootText ?? "",
        lastProgress: lead.lastProgress,
        startedAt: lead.startedAt ?? new Date(),
        turnUnseen: row.turnUnseen,
      };
    })
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, LIVE_LIMIT);
}

export async function threadLeadStatus(
  threadId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ status: statusSql.as("lead_status") })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);

  return row?.status ?? null;
}

export async function threadProjectId(
  threadId: string,
): Promise<string | null> {
  const row = await db.query.threads.findFirst({
    where: eq(threads.id, threadId),
    columns: { projectId: true },
  });
  return row?.projectId ?? null;
}

export interface ThreadTarget {
  id: string;
  organizationId: string;
  projectId: string;
  rootMessageId: string;
  status: string;
  completedAt: Date | null;
}

export async function threadTarget(
  threadId: string,
): Promise<ThreadTarget | null> {
  const [row] = await db
    .select({
      id: threads.id,
      organizationId: threads.organizationId,
      projectId: threads.projectId,
      rootMessageId: threads.rootMessageId,
      status: statusSql.as("lead_status"),
      completedAt: threads.completedAt,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);

  return row ? { ...row, status: row.status ?? "starting" } : null;
}

export interface ThreadPublishState {
  id: string;
  projectId: string;
  rootMessageId: string;
  status: string;
  lastProgress: string | null;
  error: string | null;
  startedAt: Date;
  endedAt: Date | null;
  waitingOn: WaitingOn[];
  completedAt: Date | null;
  completedByMemberId: string | null;
  backgroundWork: ThreadBackgroundWork[];
}

export async function threadPublishState(
  threadId: string,
): Promise<ThreadPublishState | null> {
  const [row] = await db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      rootMessageId: threads.rootMessageId,
      completedAt: threads.completedAt,
      completedByMemberId: threads.completedByMemberId,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);

  if (!row) return null;

  const [leads, waiting, background] = await Promise.all([
    leadSessionByThread([row.id]),
    waitingOnByParent([row.id]),
    backgroundWorkByThread([row.id]),
  ]);
  const lead = leads.get(row.id) ?? NO_SESSION;

  return {
    id: row.id,
    projectId: row.projectId,
    rootMessageId: row.rootMessageId,
    status: lead.status ?? "starting",
    lastProgress: lead.lastProgress,
    error: readableError(lead.error),
    startedAt: lead.startedAt ?? new Date(),
    endedAt: lead.endedAt,
    waitingOn: waiting.get(row.id) ?? [],
    completedAt: asDate(row.completedAt),
    completedByMemberId: row.completedByMemberId,
    backgroundWork: background.get(row.id) ?? [],
  };
}

export async function joinableThread(args: {
  projectId: string;
  authorMemberId: string;
  since: Date;
}): Promise<ThreadTarget | null> {
  const [row] = await db
    .select({
      id: threads.id,
      organizationId: threads.organizationId,
      projectId: threads.projectId,
      rootMessageId: threads.rootMessageId,
      status: threadSessions.status,
      completedAt: threads.completedAt,
    })
    .from(threads)
    .innerJoin(messages, eq(threads.rootMessageId, messages.id))
    .innerJoin(
      threadSessions,
      and(
        eq(threadSessions.threadId, threads.id),
        eq(threadSessions.role, "main"),
      ),
    )
    .where(
      and(
        eq(threads.projectId, args.projectId),
        inArray(threadSessions.status, ["starting", "running"]),
        gte(threadSessions.startedAt, args.since),
        eq(messages.authorMemberId, args.authorMemberId),
      ),
    )
    .orderBy(desc(threadSessions.startedAt))
    .limit(1);

  return row ?? null;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ChannelMessage[];
}

export const THREAD_REPLY_LIMIT = 50;

export async function threadSummary(args: {
  projectId: string;
  threadId: string;
}): Promise<ThreadSummary | null> {
  const [row] = await db
    .select(summaryColumns)
    .from(threads)
    .leftJoin(messages, eq(threads.rootMessageId, messages.id))
    .leftJoin(members, eq(messages.authorMemberId, members.id))
    .leftJoin(users, eq(members.userId, users.id))
    .where(
      and(eq(threads.id, args.threadId), eq(threads.projectId, args.projectId)),
    )
    .limit(1);

  if (!row) return null;

  return toSummary(row, await threadExtras([row.id]));
}

export async function threadDetail(args: {
  projectId: string;
  threadId: string;
  before?: number;
  limit?: number;
}): Promise<ThreadDetail | null> {
  const thread = await threadSummary(args);
  if (!thread) return null;

  const limit = Math.min(Math.max(args.limit ?? THREAD_REPLY_LIMIT, 1), 200);

  const conditions = [
    eq(messages.threadId, args.threadId),
    isNull(messages.deletedAt),
    ne(messages.id, thread.rootMessageId),
  ];
  if (args.before !== undefined) conditions.push(lt(messages.seq, args.before));

  const [rootRows, replyRows] = await Promise.all([
    args.before === undefined
      ? threadMessageRows([
          eq(messages.id, thread.rootMessageId),
          isNull(messages.deletedAt),
        ])
      : Promise.resolve([]),
    threadMessageRows(conditions, limit),
  ]);

  const rows = [...rootRows, ...replyRows.reverse()];

  return { thread, messages: await withAttachments(rows.map(toChannelMessage)) };
}

export async function threadReferences(args: {
  projectId: string;
  threadId: string;
}): Promise<ThreadReferences> {
  const rows = await db
    .select({
      id: messages.id,
      seq: messages.seq,
      body: messages.body,
      text: messages.text,
    })
    .from(messages)
    .where(
      and(
        eq(messages.projectId, args.projectId),
        isNull(messages.deletedAt),
        or(
          eq(messages.threadId, args.threadId),
          inArray(
            messages.id,
            db
              .select({ id: threads.rootMessageId })
              .from(threads)
              .where(eq(threads.id, args.threadId)),
          ),
        ),
      ),
    )
    .orderBy(asc(messages.seq));

  if (rows.length === 0) {
    return { files: [], pullRequests: [], pages: [], links: [] };
  }

  const grouped = await attachmentsForMessages(rows.map((row) => row.id));

  return collectReferences(
    rows.map((row) => ({
      id: row.id,
      seq: Number(row.seq),
      body: row.body,
      text: row.text,
      attachments: grouped.get(row.id) ?? [],
    })),
  );
}

function threadMessageRows(conditions: SQL[], limit?: number) {
  const query = db
    .select(messageColumns)
    .from(messages)
    .leftJoin(members, eq(messages.authorMemberId, members.id))
    .leftJoin(users, eq(members.userId, users.id))
    .where(and(...conditions));

  return limit === undefined
    ? query.orderBy(asc(messages.seq))
    : query.orderBy(desc(messages.seq)).limit(limit);
}

export async function countOpenWorktrees(scope: {
  organizationId: string;
  memberId: string;
  role: string;
}): Promise<number> {
  const rows = await db
    .select({ workspaceId: threadSessions.supersetWorkspaceId })
    .from(threadSessions)
    .innerJoin(projects, eq(threadSessions.projectId, projects.id))
    .where(
      and(
        eq(projects.organizationId, scope.organizationId),
        visibleToMember(scope.memberId, scope.role),
        isNull(threadSessions.workspaceReapedAt),
        isNotNull(threadSessions.supersetWorkspaceId),
      ),
    );

  return new Set(rows.map((row) => row.workspaceId)).size;
}
