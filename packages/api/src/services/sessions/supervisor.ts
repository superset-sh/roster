import { createHash } from "node:crypto";

import {
  db,
  delegations,
  members,
  messages,
  projects,
  type SelectThread,
  type SelectThreadSession,
  threadSessions,
  threads,
} from "@roster/db";
import {
  cancelChatTurn,
  ChatCallError,
  getChatItems,
  type ChatApprovalRequest,
  type ChatBackgroundTask,
  type ChatCursor,
  type ChatDurableEvent,
  chatStreamUrl,
  closeChatSession,
  createChatSession,
  createWorkspace,
  isDeltaChatEnvelope,
  isDurableChatEnvelope,
  isResetChatEnvelope,
  parseChatCursor,
  parseChatEnvelope,
  promptChat,
  respondToChatApproval,
  serializeChatCursor,
  deleteWorkspace,
} from "@roster/superset";
import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { humanSessionError, sessionErrorDetail } from "../../utils/session-error";
import { handleList } from "../../lib/handle-list";
import { sessionPrompt } from "../../utils/message-run";
import {
  type DelegationContext,
  rosterEnvelope,
} from "../../utils/roster-envelope";
import {
  type LifecycleEvent,
  nextStatus,
  type ThreadStatus,
} from "../../utils/session-state";
import { mergeSteers, undeliveredSteerNotice } from "../../utils/steer-queue";
import { markdownToTiptap } from "../../utils/tiptap";
import {
  attachmentsForMessages,
  textWithAttachments,
} from "../attachments";
import {
  agentById,
  agentFolder,
  archiveEphemeralAgentsFor,
  defaultAgentFor,
} from "../agents";
import { allocateSeq } from "../channels";
import { channelName, publish, threadChannelName } from "../centrifugo";
import { emitMessageById } from "../message-events";
import { notifyThreadFailed, subscribeThreadAuthor } from "../notifications";
import { addReaction } from "../reactions";
import { taskForThread } from "../tasks";
import { hostConnection, jwtForMember, NO_MEMBER } from "./connection";
import { threadPublishState } from "./queries";

export { threadChannelName };

const WRITE_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_PUBLISH_HOPS = 3;
export const REST_TTL_MS = 60 * 60 * 1000;

const TERMINAL_STATUSES = ["completed", "failed", "canceled"] as const;

export { THREAD_STATUSES, type ThreadStatus } from "../../utils/session-state";

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

const PARKED: ThreadStatus = "waiting";

function isParked(status: string): boolean {
  return status === PARKED;
}

function isIdle(status: string): boolean {
  return status === "idle";
}

export async function answersDelegation(args: {
  threadId: string;
  agentMemberId?: string;
}): Promise<boolean> {
  const open = await db.query.delegations.findFirst({
    where: and(
      eq(delegations.status, "open"),
      args.agentMemberId
        ? or(
            eq(delegations.childThreadId, args.threadId),
            and(
              eq(delegations.parentThreadId, args.threadId),
              eq(delegations.targetMemberId, args.agentMemberId),
            ),
          )
        : eq(delegations.childThreadId, args.threadId),
    ),
    columns: { id: true },
  });
  return open !== undefined;
}

async function statusAfter(
  session: SessionView,
  event: LifecycleEvent,
): Promise<ThreadStatus | null> {
  return nextStatus({
    current: session.status,
    event,
    answersDelegation: await answersDelegation({
      threadId: session.threadId,
      agentMemberId: session.agentMemberId,
    }),
  });
}

const COMPLETE_EMOJI = "✅";

const finishing = new Set<string>();
const pendingSteers = new Map<string, string[]>();

let started = false;
let starting: Promise<void> | null = null;

interface SessionView {
  id: string;
  threadId: string;
  projectId: string;
  agentMemberId: string;
  role: string;
  runAsMemberId: string | null;
  supersetWorkspaceId: string | null;
  supersetHostKey: string | null;
  supersetChatSessionId: string | null;
  supersetHarnessSessionId: string | null;
  chatCursor: string | null;
  status: string;
  lastProgress: string | null;
  workspaceReapedAt: Date | null;
  error: string | null;
  organizationId: string;
  threadProjectId: string;
  rootMessageId: string;
}

const sessionViewColumns = {
  id: threadSessions.id,
  threadId: threadSessions.threadId,
  projectId: threadSessions.projectId,
  agentMemberId: threadSessions.agentMemberId,
  role: threadSessions.role,
  runAsMemberId: threadSessions.runAsMemberId,
  supersetWorkspaceId: threadSessions.supersetWorkspaceId,
  supersetHostKey: threadSessions.supersetHostKey,
  supersetChatSessionId: threadSessions.supersetChatSessionId,
  supersetHarnessSessionId: threadSessions.supersetHarnessSessionId,
  chatCursor: threadSessions.chatCursor,
  status: threadSessions.status,
  lastProgress: threadSessions.lastProgress,
  workspaceReapedAt: threadSessions.workspaceReapedAt,
  error: threadSessions.error,
  organizationId: threads.organizationId,
  threadProjectId: threads.projectId,
  rootMessageId: threads.rootMessageId,
};

async function sessionById(sessionId: string): Promise<SessionView | null> {
  const [row] = await db
    .select(sessionViewColumns)
    .from(threadSessions)
    .innerJoin(threads, eq(threadSessions.threadId, threads.id))
    .where(eq(threadSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

async function sessionForAgent(
  threadId: string,
  agentMemberId: string,
): Promise<SessionView | null> {
  const [row] = await db
    .select(sessionViewColumns)
    .from(threadSessions)
    .innerJoin(threads, eq(threadSessions.threadId, threads.id))
    .where(
      and(
        eq(threadSessions.threadId, threadId),
        eq(threadSessions.agentMemberId, agentMemberId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function askingSession(
  threadId: string,
): Promise<SessionView | null> {
  const rows = await db
    .select(sessionViewColumns)
    .from(threadSessions)
    .innerJoin(threads, eq(threadSessions.threadId, threads.id))
    .where(
      and(
        eq(threadSessions.threadId, threadId),
        inArray(threadSessions.status, ["running", "starting", "needs_input"]),
      ),
    )
    .orderBy(desc(threadSessions.startedAt))
    .limit(1);

  return rows[0] ?? (await mainSession(threadId));
}

async function mainSession(threadId: string): Promise<SessionView | null> {
  const [row] = await db
    .select(sessionViewColumns)
    .from(threadSessions)
    .innerJoin(threads, eq(threadSessions.threadId, threads.id))
    .where(
      and(
        eq(threadSessions.threadId, threadId),
        eq(threadSessions.role, "main"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function sessionsOf(threadId: string): Promise<SessionView[]> {
  return db
    .select(sessionViewColumns)
    .from(threadSessions)
    .innerJoin(threads, eq(threadSessions.threadId, threads.id))
    .where(eq(threadSessions.threadId, threadId))
    .orderBy(desc(threadSessions.role), threadSessions.createdAt);
}

async function patch(
  sessionId: string,
  values: Partial<SelectThreadSession>,
): Promise<SessionView | null> {
  const [row] = await db
    .update(threadSessions)
    .set(values)
    .where(eq(threadSessions.id, sessionId))
    .returning({ id: threadSessions.id });
  if (!row) return null;
  return sessionById(row.id);
}

export async function patchLive(
  sessionId: string,
  values: Partial<SelectThreadSession>,
): Promise<SessionView | null> {
  const [row] = await db
    .update(threadSessions)
    .set(values)
    .where(
      and(
        eq(threadSessions.id, sessionId),
        notInArray(threadSessions.status, [...TERMINAL_STATUSES]),
      ),
    )
    .returning({ id: threadSessions.id });
  if (!row) return null;
  return sessionById(row.id);
}

function threadIdentity(session: SessionView): {
  id: string;
  organizationId: string;
  projectId: string;
  rootMessageId: string;
} {
  return {
    id: session.threadId,
    organizationId: session.organizationId,
    projectId: session.threadProjectId,
    rootMessageId: session.rootMessageId,
  };
}

async function bumpTurn(threadId: string): Promise<void> {
  await db
    .update(threads)
    .set({ turnCount: sql`${threads.turnCount} + 1` })
    .where(eq(threads.id, threadId));
}

async function publishThread(threadId: string, hops = 0): Promise<void> {
  const state = await threadPublishState(threadId);
  if (!state) return;

  const payload = {
    type: "thread" as const,
    thread: {
      id: state.id,
      projectId: state.projectId,
      rootMessageId: state.rootMessageId,
      status: state.status,
      lastProgress: state.lastProgress,
      error: state.error,
      startedAt: state.startedAt.toISOString(),
      endedAt: state.endedAt ? state.endedAt.toISOString() : null,
      waitingOn: state.waitingOn,
      completedAt: state.completedAt ? state.completedAt.toISOString() : null,
      completedByMemberId: state.completedByMemberId,
      backgroundWork: state.backgroundWork,
    },
  };
  await Promise.all([
    publish(threadChannelName(state.id), payload),
    publish(channelName(state.projectId), payload),
  ]);

  if (hops >= MAX_PUBLISH_HOPS) return;

  const asked = await db.query.delegations.findFirst({
    where: and(
      eq(delegations.childThreadId, threadId),
      eq(delegations.status, "open"),
    ),
    columns: { parentThreadId: true },
  });
  if (asked) await publishThread(asked.parentThreadId, hops + 1);
}

export async function markWaiting(args: {
  threadId: string;
  waitingOn: string[];
}): Promise<void> {
  if (args.waitingOn.length === 0) return;

  const session = await mainSession(args.threadId);
  if (!session) return;

  const row = await patch(session.id, {
    status: "waiting",
    lastProgress: `Waiting on ${handleList(args.waitingOn)}…`,
    error: null,
  });
  if (row) await publishThread(row.threadId);
}

/** The agent is working again — clear needs_input, or revive an idle session. */
async function wake(sessionId: string): Promise<void> {
  const session = await sessionById(sessionId);
  if (!session) return;

  const chat = chatWatches.get(sessionId);
  if (chat) activateChatWatch(chat);

  const status = await statusAfter(session, "Start");
  if (status === null) return;

  const row = await patch(sessionId, { status, endedAt: null, error: null });
  if (row) await publishThread(row.threadId);
}

/**
 * The agent's turn has ended. A session parked on a delegate stays
 * parked — the quiet is what parking means — but the turn still ended, and
 * what the agent said before handing the work over belongs in the thread.
 */
export async function endTurn(
  session: SessionView,
  event: LifecycleEvent,
): Promise<void> {
  const status = await statusAfter(session, event);
  if (status === null && !isParked(session.status)) return;

  await finish({
    sessionId: session.id,
    status: status ?? PARKED,
    error: null,
    capture: true,
  });
}

const MAX_EVENT_FAILURES = 3;
const AFFIRMATIVE = /^\s*(y|yes|yep|yeah|ok|okay|sure|allow|approve|approved|go ahead|do it|proceed)\b/i;
const HESITANT = /\b(no|not|don'?t|do not|wait|later|stop|hold|cancel|never)\b/i;

interface ChatWatch {
  sessionId: string;
  threadId: string;
  hostKey: string;
  memberId: string;
  workspaceId: string;
  chatSessionId: string;
  socket: WebSocket | null;
  failures: number;
  failedSeq: number | null;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  restTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  cursor: ChatCursor | null;
  turnId: string | null;
  startedTurns: Set<string>;
  replies: Map<string, string>;
  lastReply: string | null;
  lastProgress: string | null;
  lastWriteAt: number;
  queue: Promise<void>;
  pendingProgress: string | null;
  progressTimer: ReturnType<typeof setTimeout> | null;
  itemKinds: Map<string, string>;
  liveText: Map<string, string>;
  pendingApprovals: Map<string, ChatApprovalRequest>;
  backgroundKey: string;
  harnessSessionId: string | null;
}

const chatWatches = new Map<string, ChatWatch>();
const chatEventsInFlight = new Set<Promise<void>>();

export async function chatEventsSettled(): Promise<void> {
  while (chatEventsInFlight.size > 0) await Promise.all([...chatEventsInFlight]);
}

function startChatWatch(args: {
  sessionId: string;
  threadId: string;
  hostKey: string;
  memberId: string;
  workspaceId: string;
  chatSessionId: string;
  since?: ChatCursor | null;
  harnessSessionId?: string | null;
}): void {
  const previous = chatWatches.get(args.sessionId);
  const since =
    args.since ??
    (previous?.chatSessionId === args.chatSessionId ? previous.cursor : null);
  stopChatWatch(args.sessionId);

  const watch: ChatWatch = {
    sessionId: args.sessionId,
    threadId: args.threadId,
    hostKey: args.hostKey,
    memberId: args.memberId,
    workspaceId: args.workspaceId,
    chatSessionId: args.chatSessionId,
    socket: null,
    failures: 0,
    failedSeq: null,
    attempts: 0,
    retryTimer: null,
    restTimer: null,
    stopped: false,
    cursor: since,
    turnId: null,
    startedTurns: new Set(),
    replies: new Map(),
    lastReply: null,
    lastProgress: null,
    lastWriteAt: 0,
    queue: Promise.resolve(),
    pendingProgress: null,
    progressTimer: null,
    itemKinds: new Map(),
    liveText: new Map(),
    pendingApprovals: new Map(),
    backgroundKey: "[]",
    harnessSessionId: args.harnessSessionId ?? null,
  };
  chatWatches.set(args.sessionId, watch);
  connectChatWatch(watch);
}

function connectChatWatch(watch: ChatWatch): void {
  void (async () => {
    let auth: Awaited<ReturnType<typeof jwtForMember>>;
    try {
      auth = await jwtForMember({
        memberId: watch.memberId,
        hostKey: watch.hostKey,
      });
    } catch (cause) {
      console.warn(
        `[sessions] could not mint a Superset token for ${watch.sessionId}: ${sessionErrorDetail(cause)}`,
      );
      if (!watch.stopped) scheduleChatRetry(watch);
      return;
    }
    if (watch.stopped) return;
    if (auth.jwt === null) {
      await giveUpChatWatch(watch, auth.problem);
      return;
    }

    if (watch.cursor) await seedPendingApprovals(watch);
    if (watch.stopped) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(
        chatStreamUrl({
          routingKey: watch.hostKey,
          sessionId: watch.chatSessionId,
          jwt: auth.jwt,
          since: watch.cursor,
          deltas: ["text"],
        }),
      );
    } catch {
      scheduleChatRetry(watch);
      return;
    }
    watch.socket = socket;

    socket.onmessage = (event) => {
      if (watch.socket !== socket) return;
      const envelope = parseChatEnvelope(String(event.data));
      if (!envelope) return;
      watch.attempts = 0;
      if (isResetChatEnvelope(envelope)) {
        watch.cursor = null;
        if (envelope.reset.reason === "session_not_found") {
          stopChatWatch(watch.sessionId);
          void finish({
            sessionId: watch.sessionId,
            status: "failed",
            error: "The agent session is gone from that machine.",
          });
          return;
        }
        socket.close();
        return;
      }
      if (isDeltaChatEnvelope(envelope)) {
        if (envelope.delta.type === "text") chatTextDelta(watch, envelope.delta);
        return;
      }
      if (!isDurableChatEnvelope(envelope)) return;
      const { cursor, event: chatEvent } = envelope;
      const handled = watch.queue.then(async () => {
        if (watch.socket !== socket) return;
        try {
          await handleChatEvent(watch, chatEvent);
        } catch (cause) {
          console.warn(
            `[sessions] chat event ${cursor.seq} failed for ${watch.sessionId}: ${sessionErrorDetail(cause)}`,
          );
          watch.failures = watch.failedSeq === cursor.seq ? watch.failures + 1 : 1;
          watch.failedSeq = cursor.seq;
          if (watch.failures < MAX_EVENT_FAILURES) {
            watch.socket = null;
            socket.close();
            scheduleChatRetry(watch);
            return;
          }
          console.warn(
            `[sessions] skipping chat event ${cursor.seq} for ${watch.sessionId} after ${watch.failures} failures`,
          );
        }
        watch.cursor = cursor;
        await saveChatCursor(watch);
      });
      watch.queue = handled;
      chatEventsInFlight.add(handled);
      void handled.finally(() => chatEventsInFlight.delete(handled));
    };

    socket.onerror = () => {};

    socket.onclose = () => {
      if (watch.socket !== socket) return;
      watch.socket = null;
      scheduleChatRetry(watch);
    };
  })();
}

function scheduleChatRetry(watch: ChatWatch): void {
  if (watch.stopped || chatWatches.get(watch.sessionId) !== watch) return;

  if (watch.attempts >= MAX_ATTEMPTS) {
    void giveUpChatWatch(watch, "That machine is offline — Roster stopped waiting for it.");
    return;
  }

  const delay = Math.min(BASE_BACKOFF_MS * 2 ** watch.attempts, MAX_BACKOFF_MS);
  watch.attempts += 1;
  watch.retryTimer = setTimeout(() => {
    watch.retryTimer = null;
    if (!watch.stopped) connectChatWatch(watch);
  }, delay);
}

/**
 * Only a session in the middle of a turn has failed when its machine goes
 * quiet. An idle or parked one already said what it had to say.
 */
async function giveUpChatWatch(watch: ChatWatch, reason: string): Promise<void> {
  stopChatWatch(watch.sessionId);
  const session = await sessionById(watch.sessionId);
  if (!session || isTerminal(session.status)) return;
  if (isIdle(session.status) || isParked(session.status) || session.status === "needs_input") {
    const row = await patch(watch.sessionId, { backgroundTasks: [] });
    if (row) await publishThread(row.threadId);
    return;
  }
  await finish({ sessionId: watch.sessionId, status: "failed", error: reason });
}

async function latestChatItems(watch: ChatWatch) {
  const auth = await jwtForMember({ memberId: watch.memberId, hostKey: watch.hostKey }).catch(
    () => null,
  );
  if (!auth?.jwt) return [];
  const page = await getChatItems({
    jwt: auth.jwt,
    routingKey: watch.hostKey,
    sessionId: watch.chatSessionId,
    limit: 200,
  }).catch(() => null);
  if (!page?.ok) return [];
  return page.envelopes.flatMap((envelope) =>
    envelope.event.type === "item"
      ? [{ item: envelope.event.item, turnId: envelope.event.turnId, cursor: envelope.cursor }]
      : [],
  );
}

async function seedPendingApprovals(watch: ChatWatch): Promise<void> {
  const seen = watch.cursor;
  if (!seen) return;
  const latest = new Map<string, ChatApprovalRequest>();
  for (const { item, cursor } of await latestChatItems(watch)) {
    if (cursor.epoch !== seen.epoch || cursor.seq > seen.seq) continue;
    if (item.kind === "approval_request") latest.set(item.id, item);
  }
  for (const item of latest.values()) {
    if (item.status === "pending") watch.pendingApprovals.set(item.id, item);
  }
}

async function recoverReply(watch: ChatWatch, turnId: string): Promise<string | null> {
  let reply: string | null = null;
  for (const entry of await latestChatItems(watch)) {
    if (
      entry.turnId === turnId &&
      entry.item.kind === "agent_message" &&
      entry.item.text.trim().length > 0
    ) {
      reply = entry.item.text;
    }
  }
  return reply;
}

function stopChatWatch(sessionId: string): void {
  const watch = chatWatches.get(sessionId);
  if (!watch) return;
  watch.stopped = true;
  if (watch.retryTimer) clearTimeout(watch.retryTimer);
  if (watch.restTimer) clearTimeout(watch.restTimer);
  if (watch.progressTimer) clearTimeout(watch.progressTimer);
  const socket = watch.socket;
  watch.socket = null;
  try {
    socket?.close();
  } catch {}
  chatWatches.delete(sessionId);
  void saveChatCursor(watch);
}

function restChatWatch(watch: ChatWatch): void {
  if (watch.restTimer) clearTimeout(watch.restTimer);
  watch.restTimer = setTimeout(() => {
    if (chatWatches.get(watch.sessionId) === watch) stopChatWatch(watch.sessionId);
  }, REST_TTL_MS);
}

function activateChatWatch(watch: ChatWatch): void {
  if (watch.restTimer) clearTimeout(watch.restTimer);
  watch.restTimer = null;
}

async function saveChatCursor(watch: ChatWatch): Promise<void> {
  if (!watch.cursor) return;
  await db
    .update(threadSessions)
    .set({ chatCursor: serializeChatCursor(watch.cursor) })
    .where(
      and(
        eq(threadSessions.id, watch.sessionId),
        eq(threadSessions.supersetChatSessionId, watch.chatSessionId),
      ),
    );
}

function lastLine(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines.at(-1);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function chatTextDelta(watch: ChatWatch, delta: { itemId: string; append: string }): void {
  const kind = watch.itemKinds.get(delta.itemId);
  if (kind === "reasoning") {
    void chatProgress(watch, "Thinking…");
    return;
  }
  if (kind !== "agent_message") return;
  const text = (watch.liveText.get(delta.itemId) ?? "") + delta.append;
  watch.liveText.set(delta.itemId, text);
  void chatProgress(watch, lastLine(text));
}

async function chatProgress(watch: ChatWatch, line: string | null): Promise<void> {
  if (line === null || line === watch.lastProgress) return;
  watch.pendingProgress = line;
  const wait = WRITE_INTERVAL_MS - (Date.now() - watch.lastWriteAt);
  if (wait > 0) {
    watch.progressTimer ??= setTimeout(() => {
      watch.progressTimer = null;
      void writeChatProgress(watch);
    }, wait);
    return;
  }
  await writeChatProgress(watch);
}

async function writeChatProgress(watch: ChatWatch): Promise<void> {
  const line = watch.pendingProgress;
  watch.pendingProgress = null;
  if (line === null || line === watch.lastProgress || watch.stopped) return;
  watch.lastProgress = line;
  watch.lastWriteAt = Date.now();

  const session = await sessionById(watch.sessionId);
  if (!session || isTerminal(session.status) || isParked(session.status)) return;

  const row = await patch(watch.sessionId, { lastProgress: line, error: null });
  if (row) await publishThread(row.threadId);
}

async function handleChatEvent(
  watch: ChatWatch,
  event: ChatDurableEvent,
): Promise<void> {
  if (chatWatches.get(watch.sessionId) !== watch) return;

  if (event.type === "session") {
    await chatSessionState(watch, event.session.backgroundTasks ?? [], event.session.harnessSessionId);
    return;
  }

  if (event.type === "turn") {
    const turn = event.turn;
    if (turn.status === "running") {
      watch.turnId = turn.id;
      watch.startedTurns.add(turn.id);
      await wake(watch.sessionId);
      return;
    }
    if (watch.turnId === turn.id) watch.turnId = null;
    const seen = watch.startedTurns.delete(turn.id);
    const instant = (turn.completedAtMs ?? turn.startedAtMs) <= turn.startedAtMs;
    if (!seen && instant && turn.status === "completed") return;
    watch.lastReply =
      watch.replies.get(turn.id) ??
      (turn.status === "completed" ? await recoverReply(watch, turn.id) : null);
    watch.replies.delete(turn.id);
    watch.pendingApprovals.clear();

    if (turn.status === "failed") {
      await finish({
        sessionId: watch.sessionId,
        status: "failed",
        error: turn.error?.message ?? "The agent stopped with an error.",
        capture: true,
      });
      return;
    }

    if (!seen) await wake(watch.sessionId);
    const session = await sessionById(watch.sessionId);
    if (!session || isTerminal(session.status)) return;
    await endTurn(session, "Stop");
    return;
  }

  const item = event.item;
  watch.itemKinds.set(item.id, item.kind);
  switch (item.kind) {
    case "reasoning":
      await chatProgress(watch, "Thinking…");
      return;
    case "agent_message":
      if (item.completedAtMs !== undefined) watch.liveText.delete(item.id);
      if (item.text.trim().length > 0) {
        watch.replies.set(event.turnId, item.text);
        await chatProgress(watch, lastLine(item.text));
      }
      return;
    case "tool_call":
      if (item.status === "running") await chatProgress(watch, item.title);
      return;
    case "approval_request":
      if (item.status === "pending") {
        if (watch.pendingApprovals.has(item.id)) return;
        watch.pendingApprovals.set(item.id, item);
        await chatAskForInput(watch, item);
        return;
      }
      if (watch.pendingApprovals.delete(item.id) && watch.pendingApprovals.size === 0) {
        await wake(watch.sessionId);
      }
      return;
    default:
      return;
  }
}

async function chatSessionState(
  watch: ChatWatch,
  tasks: ChatBackgroundTask[],
  harnessSessionId: string | undefined,
): Promise<void> {
  const values: Partial<SelectThreadSession> = {};

  if (harnessSessionId && harnessSessionId !== watch.harnessSessionId) {
    watch.harnessSessionId = harnessSessionId;
    values.supersetHarnessSessionId = harnessSessionId;
  }

  const key = JSON.stringify(tasks);
  const tasksChanged = key !== watch.backgroundKey;
  if (tasksChanged) {
    watch.backgroundKey = key;
    values.backgroundTasks = tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      name: task.name,
      ...(task.detail ? { detail: task.detail } : {}),
      canStop: task.canStop,
      startedAtMs: task.startedAtMs,
    }));
  }

  if (Object.keys(values).length === 0) return;
  const row = await patch(watch.sessionId, values);
  if (row && tasksChanged) await publishThread(row.threadId);
}

function approvalQuestion(item: ChatApprovalRequest): string {
  const options = (item.options ?? []).map((option) => option.label);
  const choices =
    options.length > 0 ? `\n\nOptions: ${options.join(" · ")}` : "";
  return `**Needs your approval:** ${item.title}${choices}\n\nReply *yes* to allow it, or anything else to decline.`;
}

async function chatAskForInput(
  watch: ChatWatch,
  item: ChatApprovalRequest,
): Promise<void> {
  const session = await sessionById(watch.sessionId);
  if (!session) return;

  const status = await statusAfter(session, "PermissionRequest");
  if (status === null) return;

  const row = await patch(watch.sessionId, { status, lastProgress: item.title });
  if (!row) return;

  await persistAgentMessage({
    sessionId: watch.sessionId,
    thread: threadIdentity(row),
    text: approvalQuestion(item),
    agentMemberId: row.agentMemberId,
    agentChannelId: row.projectId,
  });

  await publishThread(row.threadId);
}

function decisionFor(item: ChatApprovalRequest, allow: boolean) {
  const wanted = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const option = (item.options ?? []).find(
    (candidate) => candidate.kind !== undefined && wanted.includes(candidate.kind),
  );
  if (option) return { type: "option" as const, optionId: option.optionId };
  return allow ? { type: "accept" as const } : { type: "decline" as const };
}

/** Answers a pending approval with a thread reply; true when the reply was the answer. */
async function answerApprovals(
  session: SessionView,
  host: { jwt: string; routingKey: string },
  text: string,
): Promise<boolean> {
  const watch = chatWatches.get(session.id);
  if (!watch || watch.pendingApprovals.size === 0) return false;

  const allow = AFFIRMATIVE.test(text) && !HESITANT.test(text);
  for (const item of [...watch.pendingApprovals.values()]) {
    await respondToChatApproval({
      ...host,
      sessionId: watch.chatSessionId,
      approvalId: item.id,
      decision: decisionFor(item, allow),
    });
  }
  return allow;
}

async function chatHost(session: SessionView) {
  const connection = await hostConnection(session);
  return {
    connection,
    host: {
      jwt: connection.jwt,
      routingKey: session.supersetHostKey ?? connection.hostKey,
    },
  };
}

/**
 * Delivers text to a session's chat, reopening the harness when the host lost
 * it (a host-service restart keeps the transcript but not the process).
 */
function harnessIsGone(cause: unknown): boolean {
  return (
    cause instanceof ChatCallError &&
    (cause.code === "NOT_FOUND" || cause.code === "CONFLICT")
  );
}

async function deliverToChat(args: {
  session: SessionView;
  text: string;
  briefIfNew?: boolean;
}): Promise<void> {
  const { session } = args;
  const workspaceId = session.supersetWorkspaceId;
  if (!workspaceId) throw new Error("That session has no worktree.");

  const { connection, host } = await chatHost(session);
  let chatSessionId = session.supersetChatSessionId;
  let fresh = false;
  let delivered = false;

  if (chatSessionId) {
    const answered = await answerApprovals(session, host, args.text).catch(() => false);
    if (answered) return;

    try {
      await promptChat({ ...host, sessionId: chatSessionId, text: args.text });
      delivered = true;
    } catch (cause) {
      if (!harnessIsGone(cause)) throw cause;
      chatSessionId = null;
    }
  }

  if (!chatSessionId) {
    const created = await createChatSession({
      ...host,
      workspaceId,
      resumeHarnessSessionId: session.supersetHarnessSessionId,
    });
    fresh = !session.supersetHarnessSessionId;
    chatSessionId = created.sessionId;
    await patch(session.id, {
      supersetChatSessionId: chatSessionId,
      chatCursor: null,
    });
  }

  if (!delivered) {
    const text =
      fresh && args.briefIfNew !== false
        ? await briefedPrompt({ session, request: args.text })
        : args.text;
    await promptChat({ ...host, sessionId: chatSessionId, text });
  }

  const existing = chatWatches.get(session.id);
  if (!existing || existing.chatSessionId !== chatSessionId) {
    startChatWatch({
      sessionId: session.id,
      threadId: session.threadId,
      hostKey: host.routingKey,
      memberId: connection.memberId,
      workspaceId,
      chatSessionId,
      since:
        session.supersetChatSessionId === chatSessionId
          ? parseChatCursor(session.chatCursor)
          : null,
      harnessSessionId: session.supersetHarnessSessionId,
    });
  } else {
    activateChatWatch(existing);
  }
}

interface FinishOutcome {
  resumeWith: string | null;
}

const NOTHING_TO_RESUME: FinishOutcome = { resumeWith: null };

async function finish(args: {
  sessionId: string;
  status: ThreadStatus;
  error?: string | null;
  capture?: boolean;
  evenIfParked?: boolean;
}): Promise<void> {
  if (finishing.has(args.sessionId)) return;
  finishing.add(args.sessionId);

  let outcome: FinishOutcome = NOTHING_TO_RESUME;
  try {
    outcome = await finishOnce(args);
  } finally {
    finishing.delete(args.sessionId);
  }

  if (outcome.resumeWith === null) return;

  console.warn(
    `[sessions] turn ended with queued work for ${args.sessionId} — starting the next turn with it`,
  );
  await resume({ sessionId: args.sessionId, text: outcome.resumeWith });
}

async function finishOnce(args: {
  sessionId: string;
  status: ThreadStatus;
  error?: string | null;
  capture?: boolean;
  evenIfParked?: boolean;
}): Promise<FinishOutcome> {
  const session = await sessionById(args.sessionId);
  if (!session || isTerminal(session.status)) {
    stopChatWatch(args.sessionId);
    if (session) await reportUndelivered(args.sessionId, "that session had already ended.");
    else pendingSteers.delete(args.sessionId);
    return NOTHING_TO_RESUME;
  }

  const chat = chatWatches.get(args.sessionId);
  const finalText = args.capture ? (chat?.lastReply ?? null) : null;
  if (chat) chat.lastReply = null;

  if (args.status === "idle" && chat && !isParked(session.status)) {
    restChatWatch(chat);
  } else {
    stopChatWatch(args.sessionId);
  }
  const queued = takeSteers(args.sessionId);

  if (isParked(session.status) && !args.evenIfParked) {
    if (finalText && finalText.trim().length > 0) {
      await persistAgentMessage({
        sessionId: args.sessionId,
        thread: threadIdentity(session),
        text: finalText,
        agentMemberId: session.agentMemberId,
        agentChannelId: session.projectId,
      });
    }
    return await resumable(session, queued);
  }

  const values: Partial<SelectThreadSession> = {
    status: args.status,
    endedAt: new Date(),
  };
  if (args.error !== undefined) values.error = args.error;
  if (isTerminal(args.status)) values.backgroundTasks = [];

  const row = await patchLive(args.sessionId, values);
  if (!row) {
    await reportUndelivered(args.sessionId, "that session is gone.", queued);
    return NOTHING_TO_RESUME;
  }

  const spoke =
    finalText !== null && finalText.trim().length > 0
      ? await persistAgentMessage({
          sessionId: args.sessionId,
          thread: threadIdentity(row),
          text: finalText,
          agentMemberId: row.agentMemberId,
          agentChannelId: row.projectId,
        })
      : false;

  await publishThread(row.threadId);

  if (args.status === "failed" && !spoke) {
    await notifyThreadFailed({
      threadId: row.threadId,
      sessionId: args.sessionId,
      reason: args.error ?? null,
    });
  }

  if (args.status === "canceled" && queued.length > 0) {
    await reportUndelivered(row.id, "that session was canceled.", queued);
    return NOTHING_TO_RESUME;
  }

  const outcome = await resumable(row, queued);
  if (outcome.resumeWith !== null) return outcome;

  await settleIfDelegated({
    threadId: row.threadId,
    agentMemberId: row.agentMemberId,
    reply: finalText ?? "",
    failed: args.status !== "completed",
  });

  return NOTHING_TO_RESUME;
}

function takeSteers(sessionId: string): string[] {
  const queue = pendingSteers.get(sessionId) ?? [];
  pendingSteers.delete(sessionId);
  return queue;
}

async function resumable(
  session: SessionView,
  queued: string[],
): Promise<FinishOutcome> {
  if (queued.length === 0) return NOTHING_TO_RESUME;

  const text = mergeSteers(queued);
  if (text.length === 0) return NOTHING_TO_RESUME;

  if (!session.supersetWorkspaceId || session.workspaceReapedAt) {
    await reportUndelivered(session.id, "its worktree is gone.", queued);
    return NOTHING_TO_RESUME;
  }

  return { resumeWith: text };
}

async function reportUndelivered(
  sessionId: string,
  reason: string,
  taken?: string[],
): Promise<void> {
  const queue = taken ?? takeSteers(sessionId);
  if (queue.length === 0) return;

  console.warn(
    `[sessions] ${queue.length} undelivered steer(s) for ${sessionId}: ${reason}`,
  );
  await recordSessionError(sessionId, undeliveredSteerNotice(queue.length, reason));
}

async function settleIfDelegated(args: {
  threadId: string;
  agentMemberId: string;
  reply: string;
  failed: boolean;
}): Promise<void> {
  try {
    const { settleDelegationFor } = await import("../delegations");
    await settleDelegationFor(args);
  } catch (cause) {
    console.warn(
      `[sessions] delegation settle failed for ${args.threadId}: ${sessionErrorDetail(cause)}`,
    );
  }
}

export async function persistAgentMessage(args: {
  sessionId: string;
  thread: {
    id: string;
    organizationId: string;
    projectId: string;
    rootMessageId: string;
  };
  text: string;
  agentMemberId?: string;
  agentChannelId?: string;
  dedupe?: boolean;
}): Promise<boolean> {
  const { thread, text } = args;
  const agentChannelId = args.agentChannelId ?? thread.projectId;
  const agentMemberId =
    args.agentMemberId ?? (await sessionById(args.sessionId))?.agentMemberId;

  if (args.dedupe !== false) {
    const existing = await db.query.messages.findFirst({
      where: and(
        eq(messages.threadId, thread.id),
        eq(messages.kind, "agent"),
        agentMemberId
          ? eq(messages.authorMemberId, agentMemberId)
          : isNull(messages.authorMemberId),
      ),
      orderBy: desc(messages.seq),
    });
    if (existing?.text === text) return false;
  }

  const clientId =
    args.dedupe === false
      ? null
      : `agent:${args.sessionId}:${createHash("sha256")
          .update(text)
          .digest("base64url")
          .slice(0, 22)}`;

  const seq = await allocateSeq(thread.projectId);
  const [row] = await db
    .insert(messages)
    .values({
      organizationId: thread.organizationId,
      projectId: thread.projectId,
      seq,
      authorMemberId: agentMemberId ?? null,
      kind: "agent",
      agentChannelId,
      body: markdownToTiptap(text),
      text,
      threadId: thread.id,
      parentMessageId: thread.rootMessageId,
      clientId,
    })
    .onConflictDoNothing({ target: [messages.projectId, messages.clientId] })
    .returning();

  if (!row) return false;

  await emitMessageById(row.id);
  return true;
}

async function briefedPrompt(args: {
  session: SessionView;
  request: string;
  context?: string[];
  delegation?: DelegationContext;
}): Promise<string> {
  const [agent, task] = await Promise.all([
    agentById(args.session.agentMemberId),
    taskForThread(args.session.threadId),
  ]);

  const envelope = rosterEnvelope({
    threadId: args.session.threadId,
    channelId: args.session.projectId,
    handle: agent?.handle ?? "agent",
    brief: agent?.brief ?? null,
    delegation: args.delegation,
    task: task
      ? { id: task.id, title: task.title, status: task.status }
      : undefined,
  });

  return `${envelope}\n\n${sessionPrompt({
    context: args.context ?? [],
    request: args.request,
  })}`;
}

export async function startSession(args: {
  threadId: string;
  text: string;
  context?: string[];
  delegation?: DelegationContext;
}): Promise<void> {
  const session = await mainSession(args.threadId);
  if (!session) return;

  await startSessionRow({ session, ...args });
}

export async function joinThread(args: {
  threadId: string;
  agentMemberId: string;
  projectId: string;
  text: string;
  delegation?: DelegationContext;
}): Promise<boolean> {
  await ensureStarted();

  const folder = await agentFolder(args.agentMemberId);
  if (!folder) return false;

  const lender = await worktreeLender(args.threadId, folder.id);

  const existing = await sessionForAgent(args.threadId, args.agentMemberId);
  const session =
    existing ??
    (await (async () => {
      const [row] = await db
        .insert(threadSessions)
        .values({
          threadId: args.threadId,
          projectId: args.projectId,
          agentMemberId: args.agentMemberId,
          role: "delegate",
          runAsMemberId: folder.ownerMemberId,
          status: "starting",
        })
        .onConflictDoNothing({
          target: [threadSessions.threadId, threadSessions.agentMemberId],
        })
        .returning({ id: threadSessions.id });

      return row
        ? await sessionById(row.id)
        : await sessionForAgent(args.threadId, args.agentMemberId);
    })());

  if (!session) return false;

  await patch(session.id, { status: "starting", endedAt: null, error: null });

  await startSessionRow({
    session,
    text: args.text,
    delegation: args.delegation,
    shareWorkspace: lender ?? undefined,
  });

  return true;
}

/**
 * An agent entering a thread borrows the worktree of an agent already working
 * there — but only when both live in the same folder. Anything else gets a
 * fresh worktree of its own.
 */
async function worktreeLender(
  threadId: string,
  folderId: string,
): Promise<{ workspaceId: string; hostKey: string } | null> {
  const candidates = await sessionsOf(threadId);

  for (const candidate of candidates) {
    if (!candidate.supersetWorkspaceId || !candidate.supersetHostKey) continue;
    if (candidate.workspaceReapedAt) continue;

    const lenderFolder = await agentFolder(candidate.agentMemberId);
    if (lenderFolder?.id !== folderId) continue;

    return {
      workspaceId: candidate.supersetWorkspaceId,
      hostKey: candidate.supersetHostKey,
    };
  }

  return null;
}

async function startSessionRow(args: {
  session: SessionView;
  text: string;
  context?: string[];
  delegation?: DelegationContext;
  shareWorkspace?: { workspaceId: string; hostKey: string };
}): Promise<void> {
  const { session } = args;

  await bumpTurn(session.threadId);

  try {
    const connection = await hostConnection(session);

    const workspace = args.shareWorkspace
      ? { id: args.shareWorkspace.workspaceId }
      : await createWorkspace({
          jwt: connection.jwt,
          routingKey: connection.hostKey,
          projectId: connection.folder.supersetProjectId,
          namingPrompt: args.text,
        });
    const hostKey = args.shareWorkspace?.hostKey ?? connection.hostKey;

    await patch(session.id, {
      supersetWorkspaceId: workspace.id,
      supersetHostKey: hostKey,
    });

    const prompt = await briefedPrompt({
      session,
      request: args.text,
      context: args.context,
      delegation: args.delegation,
    });

    await startChatSession({
      session,
      hostKey,
      memberId: connection.memberId,
      jwt: connection.jwt,
      workspaceId: workspace.id,
      prompt,
    });
  } catch (cause) {
    console.warn(
      `[sessions] start failed for ${session.id}: ${sessionErrorDetail(cause)}`,
    );
    await reportUndelivered(session.id, "that session never started.");
    await finish({
      sessionId: session.id,
      status: "failed",
      error: humanSessionError(cause, {
        fallback: "Could not start a session on that machine.",
      }),
    });
  }
}

async function startChatSession(args: {
  session: SessionView;
  hostKey: string;
  memberId: string;
  jwt: string;
  workspaceId: string;
  prompt: string;
}): Promise<void> {
  const { session } = args;
  const host = { jwt: args.jwt, routingKey: args.hostKey };

  const created = await createChatSession({ ...host, workspaceId: args.workspaceId });
  await patch(session.id, {
    supersetChatSessionId: created.sessionId,
    supersetHarnessSessionId: null,
    chatCursor: null,
  });

  const current = await sessionById(session.id);
  if (current && isTerminal(current.status)) {
    console.warn(
      `[sessions] ${session.id} was ${current.status} before its agent came up — not reviving it`,
    );
    await reportUndelivered(session.id, `that session was ${current.status}.`);
    return;
  }

  startChatWatch({
    sessionId: session.id,
    threadId: session.threadId,
    hostKey: args.hostKey,
    memberId: args.memberId,
    workspaceId: args.workspaceId,
    chatSessionId: created.sessionId,
  });

  await promptChat({ ...host, sessionId: created.sessionId, text: args.prompt });

  const running = await patchLive(session.id, { status: "running", error: null });
  if (running) await publishThread(running.threadId);

  await drainSteers(session.id);
}

function queueSteer(sessionId: string, text: string): void {
  const queue = pendingSteers.get(sessionId) ?? [];
  queue.push(text);
  pendingSteers.set(sessionId, queue);
  console.warn(`[sessions] queued steer for ${sessionId} (${queue.length})`);
}

async function drainSteers(sessionId: string): Promise<void> {
  const queue = takeSteers(sessionId);
  if (queue.length === 0) return;
  console.warn(`[sessions] draining ${queue.length} steer(s) for ${sessionId}`);

  for (let index = 0; index < queue.length; index += 1) {
    const text = queue[index] as string;

    let delivered = false;
    try {
      delivered = await interrupt({ sessionId, text });
    } catch (cause) {
      console.warn(
        `[sessions] drain failed for ${sessionId}: ${sessionErrorDetail(cause)}`,
      );
    }

    if (!delivered) {
      requeueSteers(sessionId, queue.slice(index));
      return;
    }
  }
}

function requeueSteers(sessionId: string, texts: string[]): void {
  if (texts.length === 0) return;
  const queue = pendingSteers.get(sessionId) ?? [];
  pendingSteers.set(sessionId, [...texts, ...queue]);
  console.warn(
    `[sessions] ${texts.length} steer(s) held for ${sessionId} — still undelivered`,
  );
}

async function interrupt(args: {
  sessionId: string;
  text: string;
}): Promise<boolean> {
  const session = await sessionById(args.sessionId);
  if (!session) return false;

  if (!session.supersetWorkspaceId) {
    if (isTerminal(session.status)) {
      await recordSessionError(
        args.sessionId,
        undeliveredSteerNotice(1, "that session had already ended."),
      );
      return true;
    }
    return false;
  }

  try {
    await deliverToChat({ session, text: args.text });
    const row = await patch(args.sessionId, { status: "running", error: null });
    if (row) await publishThread(row.threadId);
    return true;
  } catch (cause) {
    console.warn(
      `[sessions] steer failed for ${args.sessionId}: ${sessionErrorDetail(cause)}`,
    );
    const row = await patch(args.sessionId, {
      error: humanSessionError(cause, {
        fallback: "Could not reach the running session.",
      }),
    });
    if (row) await publishThread(row.threadId);
    return false;
  }
}

async function resume(args: {
  sessionId: string;
  text: string;
}): Promise<void> {
  const session = await sessionById(args.sessionId);
  if (!session?.supersetWorkspaceId || session.workspaceReapedAt) {
    await recordSessionError(
      args.sessionId,
      "That session has no worktree left to reply into.",
    );
    return;
  }

  const revived = await patch(args.sessionId, {
    status: "running",
    endedAt: null,
    error: null,
  });
  if (revived) await publishThread(revived.threadId);

  try {
    await deliverToChat({ session, text: args.text });
  } catch (cause) {
    console.warn(
      `[sessions] resume failed for ${args.sessionId}: ${sessionErrorDetail(cause)}`,
    );
    await finish({
      sessionId: args.sessionId,
      status: "failed",
      error: humanSessionError(cause, {
        fallback: "Could not reach that machine to continue the session.",
      }),
    });
  }
}

async function recordSessionError(
  sessionId: string,
  reason: string,
): Promise<void> {
  const row = await patch(sessionId, { error: reason });
  if (row) await publishThread(row.threadId);
}

export async function steer(args: {
  threadId: string;
  text: string;
  agentMemberId?: string;
}): Promise<void> {
  await ensureStarted();

  const session = args.agentMemberId
    ? await sessionForAgent(args.threadId, args.agentMemberId)
    : await mainSession(args.threadId);
  if (!session) return;

  await bumpTurn(session.threadId);

  // An idle session has no agent listening, so it needs restarting rather
  // than typing into. A needs_input one is listening — interrupt types the
  // answer straight into the prompt it is blocked on.
  if (
    isTerminal(session.status) ||
    isParked(session.status) ||
    isIdle(session.status)
  ) {
    await resume({ sessionId: session.id, text: args.text });
    return;
  }

  const delivered = await interrupt({ sessionId: session.id, text: args.text });
  if (!delivered) queueSteer(session.id, args.text);
}

async function retryPrompt(session: SessionView): Promise<string> {
  const latest = await db.query.messages.findFirst({
    where: and(
      eq(messages.threadId, session.threadId),
      eq(messages.kind, "user"),
    ),
    orderBy: desc(messages.seq),
  });
  const text = latest?.text?.trim();
  if (latest && text && text.length > 0) {
    const files = await attachmentsForMessages([latest.id]);
    return textWithAttachments(text, files.get(latest.id) ?? []);
  }

  const root = await db.query.messages.findFirst({
    where: eq(messages.id, session.rootMessageId),
  });
  const rootText = root?.text?.trim();
  return rootText && rootText.length > 0 ? rootText : "Continue.";
}

async function reattach(session: SessionView): Promise<void> {
  if (!session.supersetWorkspaceId) return;

  try {
    await deliverToChat({ session, text: await retryPrompt(session) });
  } catch (cause) {
    console.warn(
      `[sessions] retry failed for ${session.id}: ${sessionErrorDetail(cause)}`,
    );
    await finish({
      sessionId: session.id,
      status: "failed",
      error: humanSessionError(cause, {
        fallback: "Could not reach that machine to retry the session.",
      }),
    });
  }
}

export async function cancelThread(args: {
  threadId: string;
}): Promise<boolean> {
  await ensureStarted();

  return cancelThreadTree(args.threadId, new Set());
}

async function cancelThreadTree(
  threadId: string,
  seen: Set<string>,
): Promise<boolean> {
  if (seen.has(threadId)) return false;
  seen.add(threadId);

  for (const childThreadId of await closeOpenDelegations(threadId)) {
    await cancelThreadTree(childThreadId, seen);
  }

  const sessions = await sessionsOf(threadId);
  const live = sessions.filter((session) => !isTerminal(session.status));
  if (live.length === 0) return false;

  for (const session of live) {
    await cancelSession(session);
  }

  return true;
}

async function closeOpenDelegations(parentThreadId: string): Promise<string[]> {
  const closed = await db
    .update(delegations)
    .set({ status: "canceled", answeredAt: new Date() })
    .where(
      and(
        eq(delegations.parentThreadId, parentThreadId),
        eq(delegations.status, "open"),
      ),
    )
    .returning({ childThreadId: delegations.childThreadId });

  return closed
    .map((row) => row.childThreadId)
    .filter((childThreadId): childThreadId is string => childThreadId !== null);
}

async function cancelSession(session: SessionView): Promise<void> {
  if (session.supersetChatSessionId) {
    try {
      const { host } = await chatHost(session);
      const turnId = chatWatches.get(session.id)?.turnId;
      if (turnId) {
        await cancelChatTurn({ ...host, sessionId: session.supersetChatSessionId, turnId });
      } else {
        await closeChatSession({ ...host, sessionId: session.supersetChatSessionId });
      }
    } catch (cause) {
      console.warn(
        `[sessions] cancel on host failed for ${session.id}: ${sessionErrorDetail(cause)}`,
      );
    }
  }

  await finish({
    sessionId: session.id,
    status: "canceled",
    error: null,
    evenIfParked: true,
  });
}

export async function reapThread(args: { threadId: string }): Promise<void> {
  const sessions = await sessionsOf(args.threadId);
  const reaped = new Set<string>();

  for (const session of sessions) {
    stopChatWatch(session.id);
    pendingSteers.delete(session.id);

    const workspaceId = session.supersetWorkspaceId;
    if (!workspaceId || session.workspaceReapedAt) continue;

    if (session.supersetChatSessionId) {
      try {
        const { host } = await chatHost(session);
        await closeChatSession({ ...host, sessionId: session.supersetChatSessionId });
      } catch {}
    }

    if (!reaped.has(workspaceId)) {
      try {
        const connection = await hostConnection(session);
        await deleteWorkspace({
          jwt: connection.jwt,
          routingKey: session.supersetHostKey ?? connection.hostKey,
          workspaceId,
        });
      } catch (cause) {
        console.warn(
          `[sessions] reap failed for ${session.id}: ${sessionErrorDetail(cause)}`,
        );
        continue;
      }
      reaped.add(workspaceId);
    }

    await patch(session.id, { workspaceReapedAt: new Date() });
  }
}

export function workspaceSurvivedReap(session: {
  supersetWorkspaceId: string | null;
  workspaceReapedAt: Date | null;
}): boolean {
  return session.supersetWorkspaceId !== null && !session.workspaceReapedAt;
}

export async function assertReaped(args: { threadId: string }): Promise<void> {
  const sessions = await sessionsOf(args.threadId);
  const survived = sessions.filter(workspaceSurvivedReap);
  if (survived.length === 0) return;

  throw new Error(
    `${survived.length} workspace${survived.length === 1 ? "" : "s"} for thread ${args.threadId} outlived the reap`,
  );
}

export async function completeThread(args: {
  threadId: string;
  memberId: string;
}): Promise<void> {
  const [thread] = await db
    .update(threads)
    .set({ completedAt: new Date(), completedByMemberId: args.memberId })
    .where(eq(threads.id, args.threadId))
    .returning({ rootMessageId: threads.rootMessageId });

  if (!thread) return;

  await addReaction({
    messageId: thread.rootMessageId,
    memberId: args.memberId,
    emoji: COMPLETE_EMOJI,
  });

  await archiveEphemeralAgentsFor(args.threadId);

  await publishThread(args.threadId);
}

export async function retryThread(args: {
  threadId: string;
}): Promise<boolean> {
  await ensureStarted();

  const session = await mainSession(args.threadId);
  if (!session) return false;
  if (!session.supersetWorkspaceId || session.workspaceReapedAt) {
    await recordSessionError(
      session.id,
      "That session has no worktree left to retry.",
    );
    return false;
  }

  stopChatWatch(session.id);

  const revived = await patch(session.id, {
    status: "running",
    endedAt: null,
    error: null,
  });
  if (revived) await publishThread(revived.threadId);

  void reattach(revived ?? session).catch(() => {});

  return true;
}

/**
 * A session with a worktree but no chat — one started before threads ran on
 * chat, or one cut off mid-start — has nothing to watch. A reply starts a chat
 * in its worktree.
 */
async function strandedTerminalSession(row: SessionView): Promise<void> {
  const parked = await patchLive(row.id, {
    status: "idle",
    endedAt: new Date(),
    lastProgress: null,
    error: "This session lost its agent before it could be watched. Reply to continue it.",
  });
  if (parked) await publishThread(parked.threadId);
}

export function stopAllChatWatches(): void {
  for (const sessionId of [...chatWatches.keys()]) stopChatWatch(sessionId);
  started = false;
  starting = null;
}

export function ensureStarted(): Promise<void> {
  if (started) return Promise.resolve();
  if (starting) return starting;

  starting = (async () => {
    const rows = await db
      .select(sessionViewColumns)
      .from(threadSessions)
      .innerJoin(threads, eq(threadSessions.threadId, threads.id))
      .where(
        or(
          inArray(threadSessions.status, ["starting", "running", "needs_input"]),
          and(
            eq(threadSessions.status, "idle"),
            gte(threadSessions.endedAt, new Date(Date.now() - REST_TTL_MS)),
          ),
        ),
      );
    started = true;
    for (const row of rows) {
      if (!row.supersetChatSessionId) {
        if (row.status !== "idle" && row.supersetWorkspaceId) {
          await strandedTerminalSession(row);
        }
        continue;
      }
      if (!row.supersetWorkspaceId || !row.supersetHostKey) continue;

      if (!row.runAsMemberId) {
        await finish({ sessionId: row.id, status: "failed", error: NO_MEMBER });
        continue;
      }

      startChatWatch({
        sessionId: row.id,
        threadId: row.threadId,
        hostKey: row.supersetHostKey,
        memberId: row.runAsMemberId,
        workspaceId: row.supersetWorkspaceId,
        chatSessionId: row.supersetChatSessionId,
        since: parseChatCursor(row.chatCursor),
        harnessSessionId: row.supersetHarnessSessionId,
      });
      const watch = chatWatches.get(row.id);
      if (watch && row.status === "idle") restChatWatch(watch);
    }
  })().catch(() => {
    started = true;
  });

  return starting;
}

/**
 * A channel's own agent runs every thread in it, whoever else was tagged.
 * Agents from elsewhere come in through `roster ask`, under it.
 */
export async function createThread(args: {
  organizationId: string;
  projectId: string;
  rootMessageId: string;
  authorMemberId?: string | null;
}): Promise<SelectThread | null> {
  const agentMemberId = (await defaultAgentFor(args.projectId))?.id;
  if (!agentMemberId) {
    throw new Error("That channel has no default agent to open a thread with.");
  }

  const folder = await agentFolder(agentMemberId);

  const [row] = await db
    .insert(threads)
    .values({
      organizationId: args.organizationId,
      projectId: args.projectId,
      rootMessageId: args.rootMessageId,
    })
    .onConflictDoNothing({ target: threads.rootMessageId })
    .returning();

  if (!row) return null;

  await db
    .insert(threadSessions)
    .values({
      threadId: row.id,
      projectId: args.projectId,
      agentMemberId,
      role: "main",
      runAsMemberId: folder?.ownerMemberId ?? null,
      status: "starting",
    })
    .onConflictDoNothing({
      target: [threadSessions.threadId, threadSessions.agentMemberId],
    });

  await db
    .update(messages)
    .set({ threadId: row.id })
    .where(and(eq(messages.id, args.rootMessageId), isNull(messages.threadId)));

  await subscribeThreadAuthor({
    threadId: row.id,
    memberId: args.authorMemberId,
  });

  await publishThread(row.id);

  return row;
}
