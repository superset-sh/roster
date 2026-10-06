import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { fakeChatUrl } from "../test/fake-chat";
import { runSessionsInThisProcess } from "./sessions/dispatch";
import { hasDatabase, makeFixture } from "../test/fixtures";

runSessionsInThisProcess();

vi.mock("@roster/superset", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@roster/superset")>();

  return {
    ...actual,
    mintJwt: vi.fn(async () => ({
      jwt: "jwt",
      claims: { exp: Math.floor(Date.now() / 1000) + 3600 },
    })),
    createWorkspace: vi.fn(async () => ({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    })),
    createChatSession: vi.fn(async () => ({
      sessionId: `chat-${randomUUID()}`,
      epoch: "epoch-1",
    })),
    promptChat: vi.fn(async () => ({ itemId: randomUUID(), queued: false })),
    getChatSession: vi.fn(async () => ({ session: null, cursor: null, live: true })),
    cancelChatTurn: vi.fn(async () => undefined),
    closeChatSession: vi.fn(async () => undefined),
    chatStreamUrl: vi.fn((args: { sessionId: string }) => fakeChatUrl(args.sessionId)),
    deleteWorkspace: vi.fn(async () => undefined),
  };
});

vi.mock("./sessions/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessions/connection")>()),
  jwtForMember: vi.fn(async () => ({ jwt: "jwt" })),
}));

async function connectSuperset(memberId: string, supersetOrgId: string) {
  const { db, members } = await import("@roster/db");
  const { eq } = await import("drizzle-orm");
  const { encryptApiKey } = await import("@roster/superset");

  await db
    .update(members)
    .set({ supersetOrgId, supersetKeyEncrypted: encryptApiKey("sk-test") })
    .where(eq(members.id, memberId));
}

async function addTeammate(
  orgId: string,
): Promise<{ memberId: string; userId: string }> {
  const { db, members, users } = await import("@roster/db");

  const userId = randomUUID();
  const memberId = randomUUID();

  await db.insert(users).values({
    id: userId,
    name: "Teammate",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(members).values({
    id: memberId,
    organizationId: orgId,
    userId,
    role: "member",
    agentName: "teammate",
    createdAt: new Date(),
  });

  return { memberId, userId };
}

async function addChannelOwnedBy(args: {
  orgId: string;
  slug: string;
  memberId: string;
}): Promise<{ channelId: string; agentId: string; folderId: string }> {
  const { db, folders, members, projects } = await import("@roster/db");

  const channelId = randomUUID();
  const folderId = randomUUID();
  await db.insert(folders).values({
    id: folderId,
    organizationId: args.orgId,
    supersetProjectId: `superset-${args.slug}-${channelId.slice(0, 8)}`,
    supersetHostId: "host-2",
    supersetOrgId: args.orgId,
    name: args.slug,
    ownerMemberId: args.memberId,
  });

  const [agent] = await db
    .insert(members)
    .values({
      organizationId: args.orgId,
      userId: null,
      role: "member",
      type: "agent",
      agentName: args.slug,
      folderId,
      createdAt: new Date(),
    })
    .returning({ id: members.id });

  await db.insert(projects).values({
    id: channelId,
    organizationId: args.orgId,
    name: args.slug,
    slug: args.slug,
    defaultAgentId: agent!.id,
    addedByMemberId: args.memberId,
  });

  return { channelId, agentId: agent!.id, folderId };
}

async function sessionOf(threadId: string, agentMemberId: string) {
  const { db, threadSessions } = await import("@roster/db");
  const { and, eq } = await import("drizzle-orm");
  const [row] = await db
    .select({
      status: threadSessions.status,
      runAsMemberId: threadSessions.runAsMemberId,
      error: threadSessions.error,
      supersetWorkspaceId: threadSessions.supersetWorkspaceId,
    })
    .from(threadSessions)
    .where(
      and(
        eq(threadSessions.threadId, threadId),
        eq(threadSessions.agentMemberId, agentMemberId),
      ),
    );
  return row;
}

async function agentRepliesIn(threadId: string): Promise<string[]> {
  const { db, messages } = await import("@roster/db");
  const { and, eq } = await import("drizzle-orm");
  const rows = await db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.kind, "agent")));
  return rows.map((row) => row.text ?? "");
}

describe.skipIf(!hasDatabase())("a delegated run", () => {
  it("runs as the member who owns the answering agent's folder", async () => {
    const fixture = await makeFixture("runas");
    await connectSuperset(fixture.memberId, fixture.orgId);

    const owner = await addTeammate(fixture.orgId);
    await connectSuperset(owner.memberId, fixture.orgId);
    const target = await addChannelOwnedBy({
      orgId: fixture.orgId,
      slug: "target",
      memberId: owner.memberId,
    });

    const parent = await fixture.thread();

    const { delegate } = await import("./delegations");
    const result = await delegate({
      organizationId: fixture.orgId,
      memberId: fixture.memberId,
      role: "owner",
      parentThreadId: parent.threadId,
      handle: "target",
      task: "look at the logs",
    });

    expect(result.childThreadId).toBeNull();
    expect(result.sameWorktree).toBe(false);

    const child = await sessionOf(parent.threadId, target.agentId);

    expect(child?.runAsMemberId).toBe(owner.memberId);
    expect(child?.error).toBeNull();
    expect(child?.status).toBe("running");

    const { jwtForMember } = await import("./sessions/connection");
    await vi.waitFor(() =>
      expect(vi.mocked(jwtForMember)).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: owner.memberId }),
      ),
    );

    expect(await sessionOf(parent.threadId, fixture.agentFor())).toMatchObject({
      status: "waiting",
    });

    const { settleDelegationFor } = await import("./delegations");
    await settleDelegationFor({
      threadId: parent.threadId,
      agentMemberId: target.agentId,
      reply: "the logs say the disk filled up",
    });

    expect(await agentRepliesIn(parent.threadId)).toEqual([
      "the logs say the disk filled up",
    ]);
    expect(await sessionOf(parent.threadId, fixture.agentFor())).toMatchObject({
      status: "running",
      error: null,
    });

    await fixture.cleanup();

    const { db, users } = await import("@roster/db");
    const { eq } = await import("drizzle-orm");
    await db.delete(users).where(eq(users.id, owner.userId));
  });
});
