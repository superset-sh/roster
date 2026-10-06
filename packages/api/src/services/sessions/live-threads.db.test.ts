import { describe, expect, it } from "vitest";

import "../../test/mock-superset";
import { type Fixture, hasDatabase, makeFixture } from "../../test/fixtures";

const ENDED_AT = new Date("2026-09-20T10:00:00.000Z");
const BEFORE = new Date("2026-09-20T09:00:00.000Z");
const AFTER = new Date("2026-09-20T11:00:00.000Z");

async function finishTurn(threadId: string, endedAt = ENDED_AT) {
  const { db, threadSessions } = await import("@roster/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(threadSessions)
    .set({ status: "idle", endedAt })
    .where(eq(threadSessions.threadId, threadId));
}

async function subscribe(
  fixture: Fixture,
  threadId: string,
  args: { lastReadAt: Date; mutedAt?: Date },
) {
  const { db, threadSubscriptions } = await import("@roster/db");
  await db.insert(threadSubscriptions).values({
    threadId,
    memberId: fixture.memberId,
    reason: "author",
    lastReadAt: args.lastReadAt,
    mutedAt: args.mutedAt ?? null,
  });
}

async function live(fixture: Fixture) {
  const { listLiveThreads } = await import("./queries");
  return listLiveThreads({
    organizationId: fixture.orgId,
    memberId: fixture.memberId,
    role: "owner",
  });
}

describe.skipIf(!hasDatabase())("listLiveThreads", () => {
  it("includes a finished turn the subscriber has not read", async () => {
    const fixture = await makeFixture("liveunseen");
    const made = await fixture.thread();
    await finishTurn(made.threadId);
    await subscribe(fixture, made.threadId, { lastReadAt: BEFORE });

    const rows = await live(fixture);

    expect(rows.map((row) => row.id)).toEqual([made.threadId]);
    expect(rows[0]?.turnUnseen).toBe(true);
    expect(rows[0]?.status).toBe("idle");

    await fixture.cleanup();
  });

  it("drops a finished turn once the subscriber has read it", async () => {
    const fixture = await makeFixture("liveread");
    const made = await fixture.thread();
    await finishTurn(made.threadId);
    await subscribe(fixture, made.threadId, { lastReadAt: AFTER });

    expect(await live(fixture)).toEqual([]);

    await fixture.cleanup();
  });

  it("drops a finished turn on a muted thread", async () => {
    const fixture = await makeFixture("livemuted");
    const made = await fixture.thread();
    await finishTurn(made.threadId);
    await subscribe(fixture, made.threadId, {
      lastReadAt: BEFORE,
      mutedAt: BEFORE,
    });

    expect(await live(fixture)).toEqual([]);

    await fixture.cleanup();
  });

  it("drops a finished turn the member never subscribed to", async () => {
    const fixture = await makeFixture("livenosub");
    const made = await fixture.thread();
    await finishTurn(made.threadId);

    expect(await live(fixture)).toEqual([]);

    await fixture.cleanup();
  });

  it("drops a finished turn once the thread is marked complete", async () => {
    const fixture = await makeFixture("livedone");
    const made = await fixture.thread();
    await finishTurn(made.threadId);
    await subscribe(fixture, made.threadId, { lastReadAt: BEFORE });

    const { db, threads } = await import("@roster/db");
    const { eq } = await import("drizzle-orm");
    await db
      .update(threads)
      .set({ completedAt: AFTER, completedByMemberId: fixture.memberId })
      .where(eq(threads.id, made.threadId));

    expect(await live(fixture)).toEqual([]);

    await fixture.cleanup();
  });

  it("keeps a running thread and does not call its turn unseen", async () => {
    const fixture = await makeFixture("liverunning");
    const made = await fixture.thread();
    await subscribe(fixture, made.threadId, { lastReadAt: BEFORE });

    const rows = await live(fixture);

    expect(rows.map((row) => row.id)).toEqual([made.threadId]);
    expect(rows[0]?.turnUnseen).toBe(false);

    await fixture.cleanup();
  });

  it("keeps a thread whose lead rests while another session runs", async () => {
    const fixture = await makeFixture("livemixed");
    const made = await fixture.thread();
    await finishTurn(made.threadId);
    await subscribe(fixture, made.threadId, { lastReadAt: AFTER });

    const { db, threadSessions } = await import("@roster/db");
    const subChannel = await fixture.channel("livemixed-sub");
    await db.insert(threadSessions).values({
      threadId: made.threadId,
      projectId: subChannel,
      agentMemberId: fixture.agentFor(subChannel),
      role: "delegate",
      runAsMemberId: fixture.memberId,
      status: "running",
      supersetWorkspaceId: "workspace-2",
      supersetChatSessionId: `chat-sub-${made.threadId}`,
      supersetHostKey: "host-1",
    });

    const rows = await live(fixture);

    expect(rows.map((row) => row.id)).toEqual([made.threadId]);
    expect(rows[0]?.turnUnseen).toBe(false);

    await fixture.cleanup();
  });
});
