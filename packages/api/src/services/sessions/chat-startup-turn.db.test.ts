import { describe, expect, it } from "vitest";

import {
  chatSessionOf,
  completeTurn,
  emitAgentMessage,
  emitTurn,
  waitFor,
} from "../../test/fake-chat";
import "../../test/mock-superset";
import { hasDatabase, makeFixture } from "../../test/fixtures";

describe.skipIf(!hasDatabase())("a chat session that has just started", () => {
  it("ignores the zero-length turn the host reports at startup", async () => {
    const fixture = await makeFixture("startupturn");
    const made = await fixture.thread();
    const { cancelThread, startSession } = await import("./supervisor");

    await startSession({ threadId: made.threadId, text: "go" });
    const chat = await chatSessionOf(made.sessionId);

    const at = Date.now() - 1000;
    await emitAgentMessage(chat, "turn-startup", "warming up");
    await emitTurn(chat, {
      id: "turn-startup",
      status: "completed",
      startedAtMs: at,
      completedAtMs: at,
    });

    const { db, messages, threadSessions } = await import("@roster/db");
    const { and, eq } = await import("drizzle-orm");
    const statusOf = async () =>
      (
        await db.query.threadSessions.findFirst({
          where: eq(threadSessions.id, made.sessionId),
        })
      )?.status;

    expect(await statusOf()).toBe("running");

    await completeTurn(chat, "the real answer");

    const said = await waitFor(
      async () =>
        (
          await db
            .select({ text: messages.text })
            .from(messages)
            .where(and(eq(messages.threadId, made.threadId), eq(messages.kind, "agent")))
        ).map((row) => row.text),
      (texts) => texts.includes("the real answer"),
    );
    expect(said).toEqual(["the real answer"]);

    expect(await statusOf()).toBe("idle");

    await cancelThread({ threadId: made.threadId });
    await fixture.cleanup();
  });

  it("keeps the reply of a turn that ran while the session read idle", async () => {
    const fixture = await makeFixture("idlecatchup");
    const made = await fixture.thread();
    const { cancelThread, startSession } = await import("./supervisor");

    await startSession({ threadId: made.threadId, text: "go" });
    const chat = await chatSessionOf(made.sessionId);
    await completeTurn(chat, "first answer");

    const { db, messages, threadSessions } = await import("@roster/db");
    const { and, eq } = await import("drizzle-orm");
    await waitFor(
      async () =>
        (
          await db.query.threadSessions.findFirst({
            where: eq(threadSessions.id, made.sessionId),
          })
        )?.status,
      (status) => status === "idle",
    );

    const at = Date.now() - 5000;
    await emitAgentMessage(chat, "turn-unseen", "caught up answer");
    await emitTurn(chat, {
      id: "turn-unseen",
      status: "completed",
      startedAtMs: at,
      completedAtMs: at + 4000,
    });

    const said = await waitFor(
      async () =>
        (
          await db
            .select({ text: messages.text })
            .from(messages)
            .where(and(eq(messages.threadId, made.threadId), eq(messages.kind, "agent")))
        ).map((row) => row.text),
      (texts) => texts.includes("caught up answer"),
    );
    expect(said).toEqual(["first answer", "caught up answer"]);

    await cancelThread({ threadId: made.threadId });
    await fixture.cleanup();
  });
});
