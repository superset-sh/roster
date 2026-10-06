import type { ChatEnvelope } from "@roster/api";
import { describe, expect, it } from "vitest";

import {
  emptyChatSnapshot,
  itemText,
  orderedItems,
  reduceChat,
  visibleUserText,
} from "./chat-session";

const base = { v: 1 as const, sessionId: "s1", ts: 0 };

function item(seq: number, value: object, turnId = "t1"): ChatEnvelope {
  return {
    ...base,
    cursor: { epoch: "e1", seq },
    event: { type: "item", turnId, item: value },
  } as ChatEnvelope;
}

describe("reduceChat", () => {
  it("streams text into an agent message until the item lands, keeping journal order", () => {
    const agent = { id: "a1", kind: "agent_message", text: "", startedAtMs: 0 };
    let snapshot = reduceChat(emptyChatSnapshot(), [
      item(5, agent),
      { ...base, delta: { type: "text", itemId: "a1", append: "Hel" } },
      { ...base, delta: { type: "text", itemId: "a1", append: "lo" } },
    ]);
    expect(itemText(snapshot, agent as never)).toBe("Hello");

    snapshot = reduceChat(snapshot, [
      item(6, { ...agent, text: "Hello there" }),
      item(2, { id: "u1", kind: "user_message", content: [], startedAtMs: 0 }),
    ]);
    expect(itemText(snapshot, snapshot.items.get("a1")!.item)).toBe("Hello there");
    expect(orderedItems(snapshot).map((entry) => entry.item.id)).toEqual(["u1", "a1"]);
    expect(snapshot.oldest).toEqual({ epoch: "e1", seq: 2 });
  });

  it("hides the roster brief from a user message", () => {
    expect(
      visibleUserText({
        id: "u1",
        kind: "user_message",
        startedAtMs: 0,
        content: [{ type: "text", text: "<roster>\nYou are @a\n</roster>\n\nFix the bug" }],
      }),
    ).toBe("Fix the bug");
  });
});
