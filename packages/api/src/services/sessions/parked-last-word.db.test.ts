import { describe, expect, it } from "vitest";

import { chatSessionOf, completeTurn, waitFor } from "../../test/fake-chat";
import "../../test/mock-superset";
import { hasDatabase, makeFixture } from "../../test/fixtures";

const HANDOFF = "I asked @agent-target for the logs — ending my turn.";

async function agentSaid(threadId: string): Promise<string | null> {
  const { db, messages } = await import("@roster/db");
  const { and, eq } = await import("drizzle-orm");

  const row = await waitFor(() =>
    db.query.messages.findFirst({
      where: and(eq(messages.threadId, threadId), eq(messages.kind, "agent")),
    }),
  );
  return row?.text ?? null;
}

async function statusOf(sessionId: string): Promise<string | undefined> {
  const { db, threadSessions } = await import("@roster/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ status: threadSessions.status })
    .from(threadSessions)
    .where(eq(threadSessions.id, sessionId));
  return row?.status;
}

describe.skipIf(!hasDatabase())("an agent parked on a delegate", () => {
  it("records the last thing it said before handing the work over", async () => {
    const fixture = await makeFixture("parkedword");
    const made = await fixture.thread();
    const { cancelThread, markWaiting, startSession } = await import(
      "./supervisor"
    );

    await startSession({ threadId: made.threadId, text: "go" });
    await markWaiting({ threadId: made.threadId, waitingOn: ["agent-target"] });
    await completeTurn(await chatSessionOf(made.sessionId), HANDOFF);

    expect(await agentSaid(made.threadId)).toBe(HANDOFF);
    expect(await statusOf(made.sessionId)).toBe("waiting");

    await cancelThread({ threadId: made.threadId });
    await fixture.cleanup();
  }, 20_000);
});
