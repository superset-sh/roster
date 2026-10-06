import { describe, expect, it } from "vitest";

import { parseChatEnvelope } from "./chat-protocol";

const base = { v: 1, sessionId: "s1", ts: 0 };

describe("parseChatEnvelope", () => {
  it("accepts a durable event with a cursor and a well-formed payload", () => {
    const raw = JSON.stringify({
      ...base,
      cursor: { epoch: "e1", seq: 3 },
      event: { type: "turn", turn: { id: "t1", status: "completed", startedAtMs: 1 } },
    });
    expect(parseChatEnvelope(raw)).not.toBeNull();
  });

  it("rejects a durable event whose payload is missing, so its cursor is never saved", () => {
    expect(
      parseChatEnvelope(JSON.stringify({ ...base, cursor: { epoch: "e1", seq: 3 }, event: { type: "turn" } })),
    ).toBeNull();
    expect(parseChatEnvelope(JSON.stringify({ ...base, event: { type: "session", session: { status: "idle" } } }))).toBeNull();
    expect(parseChatEnvelope(JSON.stringify({ ...base, delta: { type: "text" } }))).toBeNull();
  });
});
