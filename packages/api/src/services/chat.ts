import { db, threadSessions, threads, type ThreadBackgroundTask } from "@roster/db";
import {
  type ChatCursor,
  type ChatItemsPage,
  chatStreamUrl,
  getChatItems,
  respondToChatApproval,
  stopChatBackgroundTask,
} from "@roster/superset";
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { requireOrgProject } from "./channels";
import { resolveOrgAccess } from "./org";
import { hostConnection } from "./sessions/connection";

export interface ThreadChat {
  rosterSessionId: string;
  chatSessionId: string;
  role: string;
  status: string;
  backgroundTasks: ThreadBackgroundTask[];
}

interface ThreadScope {
  organizationId: string;
  memberId: string;
  role: string;
  projectId: string;
  threadId: string;
}

async function chatRows(scope: ThreadScope) {
  const project = await requireOrgProject({
    organizationId: scope.organizationId,
    memberId: scope.memberId,
    role: scope.role,
    projectId: scope.projectId,
  });
  if (!project) return [];

  return db
    .select({
      id: threadSessions.id,
      role: threadSessions.role,
      status: threadSessions.status,
      chatSessionId: threadSessions.supersetChatSessionId,
      hostKey: threadSessions.supersetHostKey,
      agentMemberId: threadSessions.agentMemberId,
      runAsMemberId: threadSessions.runAsMemberId,
      backgroundTasks: threadSessions.backgroundTasks,
      organizationId: threads.organizationId,
    })
    .from(threadSessions)
    .innerJoin(threads, eq(threadSessions.threadId, threads.id))
    .where(
      and(
        eq(threadSessions.threadId, scope.threadId),
        eq(threads.projectId, project.id),
        isNotNull(threadSessions.supersetChatSessionId),
      ),
    )
    .orderBy(desc(threadSessions.role), desc(threadSessions.startedAt));
}

type ChatRow = Awaited<ReturnType<typeof chatRows>>[number];

export async function listThreadChats(scope: ThreadScope): Promise<ThreadChat[]> {
  const rows = await chatRows(scope);
  return rows.map((row) => ({
    rosterSessionId: row.id,
    chatSessionId: row.chatSessionId as string,
    role: row.role,
    status: row.status,
    backgroundTasks: row.backgroundTasks ?? [],
  }));
}

async function pickRow(
  scope: ThreadScope & { rosterSessionId?: string },
): Promise<ChatRow | null> {
  const rows = await chatRows(scope);
  if (scope.rosterSessionId) {
    return rows.find((row) => row.id === scope.rosterSessionId) ?? null;
  }
  return rows.find((row) => row.role === "main") ?? rows[0] ?? null;
}

async function hostFor(row: ChatRow) {
  const connection = await hostConnection({
    organizationId: row.organizationId,
    agentMemberId: row.agentMemberId,
    asMemberId: row.runAsMemberId,
    supersetHostKey: row.hostKey,
  });
  return { jwt: connection.jwt, routingKey: row.hostKey ?? connection.hostKey };
}

export async function threadChatItems(
  scope: ThreadScope & { rosterSessionId?: string; before?: ChatCursor | null },
): Promise<ChatItemsPage | null> {
  const row = await pickRow(scope);
  if (!row?.chatSessionId) return null;
  const host = await hostFor(row);
  return getChatItems({
    ...host,
    sessionId: row.chatSessionId,
    before: scope.before ?? null,
    limit: 100,
  });
}

export async function answerThreadApproval(
  scope: ThreadScope & {
    rosterSessionId?: string;
    approvalId: string;
    optionId?: string;
    allow: boolean;
  },
): Promise<boolean> {
  const row = await pickRow(scope);
  if (!row?.chatSessionId) return false;
  const host = await hostFor(row);
  await respondToChatApproval({
    ...host,
    sessionId: row.chatSessionId,
    approvalId: scope.approvalId,
    decision: scope.optionId
      ? { type: "option", optionId: scope.optionId }
      : scope.allow
        ? { type: "accept" }
        : { type: "decline" },
  });
  return true;
}

export async function stopThreadBackgroundTask(
  scope: ThreadScope & { rosterSessionId: string; taskId: string },
): Promise<boolean> {
  const row = await pickRow(scope);
  if (!row?.chatSessionId) return false;
  const host = await hostFor(row);
  return stopChatBackgroundTask({
    ...host,
    sessionId: row.chatSessionId,
    taskId: scope.taskId,
  });
}

export async function authorizeChatStream(args: {
  userId: string;
  slug: string;
  projectId: string;
  threadId: string;
  rosterSessionId?: string;
}): Promise<{ url: string; chatSessionId: string } | null> {
  const access = await resolveOrgAccess({ userId: args.userId, slug: args.slug });
  if (!access) return null;

  const row = await pickRow({
    organizationId: access.organization.id,
    memberId: access.member.id,
    role: access.member.role,
    projectId: args.projectId,
    threadId: args.threadId,
    rosterSessionId: args.rosterSessionId,
  });
  if (!row?.chatSessionId) return null;

  const host = await hostFor(row);
  return {
    chatSessionId: row.chatSessionId,
    url: chatStreamUrl({
      routingKey: host.routingKey,
      sessionId: row.chatSessionId,
      jwt: host.jwt,
    }),
  };
}
