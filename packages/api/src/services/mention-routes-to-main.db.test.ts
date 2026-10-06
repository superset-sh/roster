import { beforeAll, describe, expect, it, vi } from "vitest";

import { waitFor } from "../test/fake-chat";
import { hasDatabase, makeFixture } from "../test/fixtures";
import "../test/mock-superset";

async function threadFor(messageId: string): Promise<string | null> {
  const { threadIdForMessage } = await import("./messages");

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const threadId = await threadIdForMessage(messageId);
    if (threadId) return threadId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function sessionsIn(threadId: string) {
  const { db, threadSessions } = await import("@roster/db");
  const { eq } = await import("drizzle-orm");

  const read = () =>
    db
      .select({
        agentMemberId: threadSessions.agentMemberId,
        role: threadSessions.role,
      })
      .from(threadSessions)
      .where(eq(threadSessions.threadId, threadId));

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await read();
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return read();
}

async function promptsSent(): Promise<string> {
  const superset = await import("@roster/superset");

  return waitFor(
    () =>
      vi
        .mocked(superset.promptChat)
        .mock.calls.map((call) => call[0].text)
        .join("\n"),
    (said) => said.length > 0,
  );
}

describe.skipIf(!hasDatabase())("tagging another agent in a channel", () => {
  let superset: typeof import("@roster/superset");
  let messages: typeof import("./messages");

  beforeAll(async () => {
    superset = await import("@roster/superset");
    messages = await import("./messages");
  });

  it("still runs the thread as the channel's own agent", async () => {
    const fixture = await makeFixture("mentionmain");
    await fixture.channel("target");

    vi.mocked(superset.promptChat).mockClear();

    const sent = await messages.sendMessage({
      organizationId: fixture.orgId,
      projectId: fixture.projectId,
      authorMemberId: fixture.memberId,
      role: "owner",
      body: { type: "doc", content: [] },
      text: "@target can you look at the logs",
      clientId: "mention-main-1",
    });

    const threadId = await threadFor(sent.id);
    expect(threadId).not.toBeNull();

    const sessions = await sessionsIn(threadId!);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agentMemberId).toBe(fixture.agentFor());
    expect(sessions[0]?.role).toBe("main");

    const { cancelThread } = await import("./sessions");
    await cancelThread({ threadId: threadId! });
    await fixture.cleanup();
  }, 20_000);

  it("tells that agent to pass the work on, naming everyone tagged", async () => {
    const fixture = await makeFixture("mentionrelay");
    await fixture.channel("target");
    await fixture.channel("second");

    vi.mocked(superset.promptChat).mockClear();

    const sent = await messages.sendMessage({
      organizationId: fixture.orgId,
      projectId: fixture.projectId,
      authorMemberId: fixture.memberId,
      role: "owner",
      body: { type: "doc", content: [] },
      text: "@target and @second, split the logs between you",
      clientId: "mention-relay-1",
    });

    const threadId = await threadFor(sent.id);
    expect(threadId).not.toBeNull();

    const prompt = await promptsSent();
    expect(prompt).toContain("split the logs between you");
    expect(prompt).toContain("@target and @second");
    expect(prompt).toContain(`roster ask target`);
    expect(prompt).toContain(`roster ask second`);
    expect(prompt).toContain(`--thread ${threadId}`);

    const { cancelThread } = await import("./sessions");
    await cancelThread({ threadId: threadId! });
    await fixture.cleanup();
  }, 20_000);

  it("does not pull a tagged agent into a thread over the main agent's head", async () => {
    const fixture = await makeFixture("mentionreply");
    const made = await fixture.thread();
    await fixture.channel("target");

    vi.mocked(superset.promptChat).mockClear();

    await messages.sendMessage({
      organizationId: fixture.orgId,
      projectId: fixture.projectId,
      authorMemberId: fixture.memberId,
      role: "owner",
      body: { type: "doc", content: [] },
      text: "@target has the logs for this",
      clientId: "mention-reply-1",
      threadId: made.threadId,
    });

    const said = await promptsSent();
    expect(said).toContain("@target has the logs for this");
    expect(said).toContain("roster ask target");

    expect(await sessionsIn(made.threadId)).toHaveLength(1);

    const { cancelThread } = await import("./sessions");
    await cancelThread({ threadId: made.threadId });
    await fixture.cleanup();
  }, 20_000);
});
