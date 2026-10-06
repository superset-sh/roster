import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  chatSessionOf,
  emitAgentMessage,
  emitTurn,
  waitFor,
} from "../test/fake-chat";
import { hasDatabase, makeFixture } from "../test/fixtures";
import "../test/mock-superset";

describe.skipIf(!hasDatabase())("asking an agent on your own folder", () => {
  let superset: typeof import("@roster/superset");
  let delegations: typeof import("./delegations");
  let agents: typeof import("./agents");

  beforeAll(async () => {
    superset = await import("@roster/superset");
    delegations = await import("./delegations");
    agents = await import("./agents");
  });

  it("runs it in the thread's worktree, with its brief in the prompt", async () => {
    const fixture = await makeFixture("sharewt");
    const parent = await fixture.thread();

    const pm = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "pm",
      brief: "Own the spec. Ask about scope, not syntax.",
    });

    vi.mocked(superset.createWorkspace).mockClear();
    vi.mocked(superset.createChatSession).mockClear();
    vi.mocked(superset.promptChat).mockClear();

    const result = await delegations.delegate({
      organizationId: fixture.orgId,
      memberId: fixture.memberId,
      role: "owner",
      parentThreadId: parent.threadId,
      handle: pm.handle,
      task: "scope the onboarding change",
    });

    expect(result.sameWorktree).toBe(true);
    expect(result.childThreadId).toBeNull();

    expect(vi.mocked(superset.createWorkspace)).not.toHaveBeenCalled();

    const opened = vi.mocked(superset.createChatSession).mock.calls[0]?.[0];
    expect(opened?.workspaceId).toBe("workspace-1");
    const prompt = vi.mocked(superset.promptChat).mock.calls[0]?.[0].text;
    expect(prompt).toContain("Own the spec. Ask about scope, not syntax.");
    expect(prompt).toContain(`You are @${pm.handle}`);
    expect(prompt).toContain("scope the onboarding change");

    const { db, threadSessions } = await import("@roster/db");
    const { eq } = await import("drizzle-orm");
    const sessions = await db
      .select()
      .from(threadSessions)
      .where(eq(threadSessions.threadId, parent.threadId));

    expect(sessions).toHaveLength(2);
    const joined = sessions.find((row) => row.agentMemberId === pm.id);
    expect(joined?.role).toBe("delegate");
    expect(joined?.supersetWorkspaceId).toBe("workspace-1");

    await fixture.cleanup();
  });

  it("parks the asking agent and wakes it with the answer", async () => {
    const fixture = await makeFixture("shareanswer");
    const parent = await fixture.thread();

    const pm = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "pm",
    });

    await delegations.delegate({
      organizationId: fixture.orgId,
      memberId: fixture.memberId,
      role: "owner",
      parentThreadId: parent.threadId,
      handle: pm.handle,
      task: "scope it",
    });

    const { db, messages, threadSessions } = await import("@roster/db");
    const { and, eq } = await import("drizzle-orm");

    const asker = await db.query.threadSessions.findFirst({
      where: and(
        eq(threadSessions.threadId, parent.threadId),
        eq(threadSessions.role, "main"),
      ),
    });
    expect(asker?.status).toBe("waiting");

    await delegations.settleDelegationFor({
      threadId: parent.threadId,
      agentMemberId: pm.id,
      reply: "three screens, one migration",
    });

    const written = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.threadId, parent.threadId),
          eq(messages.authorMemberId, pm.id),
          eq(messages.kind, "agent"),
        ),
      );

    expect(written.map((row) => row.text)).toContain(
      "three screens, one migration",
    );

    const { delegations: table } = await import("@roster/db");
    const settled = await db.query.delegations.findFirst({
      where: eq(table.parentThreadId, parent.threadId),
    });
    expect(settled?.status).toBe("answered");
    expect(settled?.childThreadId).toBeNull();
    expect(settled?.targetMemberId).toBe(pm.id);

    await fixture.cleanup();
  });

  it("deletes a shared worktree once, not once per agent", async () => {
    const fixture = await makeFixture("sharereap");
    const parent = await fixture.thread();

    const pm = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "pm",
    });

    await delegations.delegate({
      organizationId: fixture.orgId,
      memberId: fixture.memberId,
      role: "owner",
      parentThreadId: parent.threadId,
      handle: pm.handle,
      task: "scope it",
    });

    vi.mocked(superset.deleteWorkspace).mockClear();

    const { reapThread, assertReaped } = await import("./sessions/supervisor");
    await reapThread({ threadId: parent.threadId });

    expect(vi.mocked(superset.deleteWorkspace)).toHaveBeenCalledTimes(1);

    await expect(
      assertReaped({ threadId: parent.threadId }),
    ).resolves.toBeUndefined();

    await fixture.cleanup();
  });

  it("signs what an agent says with that agent, not the channel", async () => {
    const fixture = await makeFixture("whospoke");
    const made = await fixture.thread();

    const pm = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "pm",
    });

    const { persistAgentMessage } = await import("./sessions/supervisor");
    const { db, messages, threads } = await import("@roster/db");
    const { eq } = await import("drizzle-orm");

    const thread = (await db.query.threads.findFirst({
      where: eq(threads.id, made.threadId),
    }))!;

    await persistAgentMessage({
      sessionId: made.sessionId,
      thread,
      text: "the channel's own agent speaking",
      agentMemberId: fixture.agentFor(),
    });
    await persistAgentMessage({
      sessionId: made.sessionId,
      thread,
      text: "the pm speaking",
      agentMemberId: pm.id,
    });

    const written = await db
      .select({ text: messages.text, author: messages.authorMemberId })
      .from(messages)
      .where(eq(messages.threadId, made.threadId))
      .orderBy(messages.seq);

    expect(
      written.find((row) => row.text === "the pm speaking")?.author,
    ).toBe(pm.id);
    expect(
      written.find((row) => row.text === "the channel's own agent speaking")
        ?.author,
    ).toBe(fixture.agentFor());

    await fixture.cleanup();
  });

  it("does not repeat an answer the agent already said in the thread", async () => {
    const fixture = await makeFixture("noecho");
    const parent = await fixture.thread();

    const pm = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "pm",
    });

    await delegations.delegate({
      organizationId: fixture.orgId,
      memberId: fixture.memberId,
      role: "owner",
      parentThreadId: parent.threadId,
      handle: pm.handle,
      task: "scope it",
    });

    const answer = "three screens, one migration";

    const { persistAgentMessage } = await import("./sessions/supervisor");
    const { db, messages, threads } = await import("@roster/db");
    const { and, eq } = await import("drizzle-orm");

    const thread = (await db.query.threads.findFirst({
      where: eq(threads.id, parent.threadId),
    }))!;

    await persistAgentMessage({
      sessionId: parent.sessionId,
      thread,
      text: answer,
      agentMemberId: pm.id,
    });

    await delegations.settleDelegationFor({
      threadId: parent.threadId,
      agentMemberId: pm.id,
      reply: answer,
    });

    const said = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, parent.threadId),
          eq(messages.authorMemberId, pm.id),
          eq(messages.text, answer),
        ),
      );

    expect(said).toHaveLength(1);

    await fixture.cleanup();
  });

  it("says what it asked for before it parks", async () => {
    const fixture = await makeFixture("parksaid");
    const parent = await fixture.thread();

    const pm = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "pm",
    });

    const { startSession } = await import("./sessions");
    await startSession({ threadId: parent.threadId, text: "get going" });

    const spoken = "I asked @parksaid-pm to scope the onboarding change.";
    const chat = await chatSessionOf(parent.sessionId);
    const turnId = "turn-handoff";
    const startedAtMs = Date.now() - 1000;
    await emitTurn(chat, { id: turnId, status: "running", startedAtMs });
    await emitAgentMessage(chat, turnId, spoken);

    const { db, messages, threadSessions } = await import("@roster/db");
    const { and, eq } = await import("drizzle-orm");

    const progressOf = async () =>
      (
        await db.query.threadSessions.findFirst({
          where: eq(threadSessions.id, parent.sessionId),
        })
      )?.lastProgress;
    expect(await waitFor(progressOf, (line) => line === spoken)).toBe(spoken);

    await delegations.delegate({
      organizationId: fixture.orgId,
      memberId: fixture.memberId,
      role: "owner",
      parentThreadId: parent.threadId,
      handle: pm.handle,
      task: "scope it",
    });

    const asker = (await db.query.threadSessions.findFirst({
      where: and(
        eq(threadSessions.threadId, parent.threadId),
        eq(threadSessions.role, "main"),
      ),
    }))!;
    expect(asker.status).toBe("waiting");

    await emitTurn(chat, {
      id: turnId,
      status: "completed",
      startedAtMs,
      completedAtMs: Date.now(),
    });

    const written = await waitFor(
      () =>
        db
          .select({ text: messages.text, author: messages.authorMemberId })
          .from(messages)
          .where(eq(messages.threadId, parent.threadId)),
      (rows) => rows.some((row) => row.text === spoken),
    );

    const said = written.find((row) => row.text === spoken);
    expect(said).toBeDefined();
    expect(said?.author).toBe(fixture.agentFor());

    const still = await db.query.threadSessions.findFirst({
      where: eq(threadSessions.id, asker.id),
    });
    expect(still?.status).toBe("waiting");
    expect(still?.endedAt).toBeNull();

    const { reapThread } = await import("./sessions/supervisor");
    await reapThread({ threadId: parent.threadId });
    await fixture.cleanup();
  });

  it("still cuts a fresh worktree for an agent on another folder", async () => {
    const fixture = await makeFixture("othercwd");
    const parent = await fixture.thread();
    await fixture.channel("othercwd-design");

    vi.mocked(superset.createWorkspace).mockClear();

    const result = await delegations.delegate({
      organizationId: fixture.orgId,
      memberId: fixture.memberId,
      role: "owner",
      parentThreadId: parent.threadId,
      handle: "othercwd-design",
      task: "review the empty states",
    });

    expect(result.sameWorktree).toBe(false);
    expect(result.childThreadId).toBeNull();
    expect(vi.mocked(superset.createWorkspace)).toHaveBeenCalledTimes(1);

    const { db, threadSessions } = await import("@roster/db");
    const { and, eq } = await import("drizzle-orm");
    const joined = await db.query.threadSessions.findFirst({
      where: and(
        eq(threadSessions.threadId, parent.threadId),
        eq(threadSessions.role, "delegate"),
      ),
    });
    expect(joined).toBeDefined();

    await fixture.cleanup();
  });

  it("refuses to let an agent ask itself", async () => {
    const fixture = await makeFixture("selfask");
    const parent = await fixture.thread();

    await expect(
      delegations.delegate({
        organizationId: fixture.orgId,
        memberId: fixture.memberId,
        role: "owner",
        parentThreadId: parent.threadId,
        handle: "selfask",
        task: "do it",
      }),
    ).rejects.toThrow(/just do the work/);

    await fixture.cleanup();
  });
});
