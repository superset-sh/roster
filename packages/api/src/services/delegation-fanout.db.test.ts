import { beforeAll, describe, expect, it, vi } from "vitest";

import { hasDatabase, makeFixture } from "../test/fixtures";
import "../test/mock-superset";

async function mainSessionOf(threadId: string) {
  const { db, threadSessions } = await import("@roster/db");
  const { and, eq } = await import("drizzle-orm");

  return db.query.threadSessions.findFirst({
    where: and(
      eq(threadSessions.threadId, threadId),
      eq(threadSessions.role, "main"),
    ),
  });
}

/*
 * Any session left running is adopted by whichever supervisor starts next —
 * including another test file's, which then finishes it out from under us. The
 * delegates have done their part once the ask is recorded, so they stand down.
 */
async function standDown(threadId: string): Promise<void> {
  const { db, threadSessions } = await import("@roster/db");
  const { and, eq, ne } = await import("drizzle-orm");

  await db
    .update(threadSessions)
    .set({ status: "idle" })
    .where(
      and(eq(threadSessions.threadId, threadId), ne(threadSessions.role, "main")),
    );
}

async function delegationsOf(parentThreadId: string) {
  const { db, delegations } = await import("@roster/db");
  const { eq } = await import("drizzle-orm");

  return db
    .select()
    .from(delegations)
    .where(eq(delegations.parentThreadId, parentThreadId))
    .orderBy(delegations.createdAt);
}

describe.skipIf(!hasDatabase())("asking two agents at once", () => {
  let superset: typeof import("@roster/superset");
  let delegations: typeof import("./delegations");
  let agents: typeof import("./agents");

  beforeAll(async () => {
    superset = await import("@roster/superset");
    delegations = await import("./delegations");
    agents = await import("./agents");
  });

  it("waits on both, then resumes the asker with both answers", async () => {
    const fixture = await makeFixture("fanout");
    const parent = await fixture.thread();

    const alpha = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "alpha",
    });
    const beta = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "beta",
    });

    const ask = (handle: string, task: string) =>
      delegations.delegate({
        organizationId: fixture.orgId,
        memberId: fixture.memberId,
        role: "owner",
        parentThreadId: parent.threadId,
        handle,
        task,
        asHandle: "fanout",
      });

    const first = await ask(alpha.handle, "read the api logs");
    await standDown(parent.threadId);
    const second = await ask(beta.handle, "read the worker logs");
    await standDown(parent.threadId);

    expect(first.pending).toEqual(["alpha"]);
    expect(second.pending).toEqual(["alpha", "beta"]);

    const open = await delegationsOf(parent.threadId);
    expect(open.filter((row) => row.status === "open")).toHaveLength(2);

    const parked = await mainSessionOf(parent.threadId);
    expect(parked?.status).toBe("waiting");
    expect(parked?.lastProgress).toBe("Waiting on @alpha and @beta…");

    vi.mocked(superset.promptChat).mockClear();

    await delegations.settleDelegationFor({
      threadId: parent.threadId,
      agentMemberId: alpha.id,
      reply: "the api is clean",
    });

    const halfway = await mainSessionOf(parent.threadId);
    expect(halfway?.status).toBe("waiting");
    expect(halfway?.lastProgress).toBe("Waiting on @beta…");
    expect(vi.mocked(superset.promptChat)).not.toHaveBeenCalled();

    const [answered] = (await delegationsOf(parent.threadId)).filter(
      (row) => row.targetMemberId === alpha.id,
    );
    expect(answered?.status).toBe("answered");
    expect(answered?.reportedAt).toBeNull();

    await delegations.settleDelegationFor({
      threadId: parent.threadId,
      agentMemberId: beta.id,
      reply: "the worker retried twice",
    });

    const resumed = vi
      .mocked(superset.promptChat)
      .mock.calls.map((call) => call[0].text)
      .join("\n");

    expect(resumed).toContain("@alpha replied:\n\nthe api is clean");
    expect(resumed).toContain("@beta replied:\n\nthe worker retried twice");
    expect(resumed).toContain("That is everyone you asked.");

    const settled = await delegationsOf(parent.threadId);
    expect(settled.every((row) => row.status === "answered")).toBe(true);
    expect(settled.every((row) => row.reportedAt !== null)).toBe(true);

    const { cancelThread } = await import("./sessions");
    await cancelThread({ threadId: parent.threadId });
    await fixture.cleanup();
  }, 30_000);

  it("answers a delegate that passed work on, without waiting on its own asker", async () => {
    const fixture = await makeFixture("fanoutnested");
    const parent = await fixture.thread();

    const alpha = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "alpha",
    });
    const beta = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "beta",
    });

    const ask = (handle: string, asHandle: string) =>
      delegations.delegate({
        organizationId: fixture.orgId,
        memberId: fixture.memberId,
        role: "owner",
        parentThreadId: parent.threadId,
        handle,
        task: `look at ${handle}'s part`,
        asHandle,
      });

    await ask(alpha.handle, "fanoutnested");
    await ask(beta.handle, alpha.handle);
    await standDown(parent.threadId);

    vi.mocked(superset.promptChat).mockClear();

    await delegations.settleDelegationFor({
      threadId: parent.threadId,
      agentMemberId: beta.id,
      reply: "beta is done",
    });

    const resumed = vi
      .mocked(superset.promptChat)
      .mock.calls.map((call) => call[0].text)
      .join("\n");
    expect(resumed).toContain("@beta replied:\n\nbeta is done");

    const rows = await delegationsOf(parent.threadId);
    const toAlpha = rows.find((row) => row.targetMemberId === alpha.id);
    expect(toAlpha?.status).toBe("open");
    expect(toAlpha?.reportedAt).toBeNull();

    const { cancelThread } = await import("./sessions");
    await cancelThread({ threadId: parent.threadId });
    await fixture.cleanup();
  }, 30_000);

  it("refuses a second open ask to the same agent", async () => {
    const fixture = await makeFixture("fanoutdupe");
    const parent = await fixture.thread();

    const alpha = await agents.createAgent({
      organizationId: fixture.orgId,
      folderId: fixture.folderId,
      name: "alpha",
    });

    const ask = (task: string) =>
      delegations.delegate({
        organizationId: fixture.orgId,
        memberId: fixture.memberId,
        role: "owner",
        parentThreadId: parent.threadId,
        handle: alpha.handle,
        task,
        asHandle: "fanoutdupe",
      });

    await ask("read the api logs");
    await standDown(parent.threadId);
    await expect(ask("and the worker logs")).rejects.toThrow(
      /already asked @alpha/,
    );

    const { cancelThread } = await import("./sessions");
    await cancelThread({ threadId: parent.threadId });
    await fixture.cleanup();
  }, 30_000);
});
