import type { WaitingOn } from "@roster/api";
import { describe, expect, it } from "vitest";

import {
  isActive,
  markThreadSeen,
  mergeThread,
  parsePublishedThread,
  statusLabel,
  statusTone,
  type ThreadItem,
  turnUnseen,
  waitingOnLabel,
} from "./thread-rows";

const STATUSES = [
  "starting",
  "running",
  "needs_input",
  "waiting",
  "idle",
  "completed",
  "failed",
  "canceled",
];

const waiting: WaitingOn = {
  handle: "sol-superset",
  display: "sol [superset]",
  channelId: "channel-2",
  channelSlug: "superset",
  threadId: "thread-2",
  status: "running",
  lastProgress: "Reading the README template…",
  task: "What is Superset, in one paragraph?",
};

const published = (thread: Record<string, unknown>) => ({
  type: "thread",
  thread: {
    id: "thread-1",
    projectId: "channel-1",
    rootMessageId: "message-1",
    status: "waiting",
    startedAt: "2026-09-18T10:16:00.000Z",
    ...thread,
  },
});

describe("isActive", () => {
  it("counts a parked thread as active — another agent is running for it", () => {
    expect(isActive("waiting")).toBe(true);
    expect(isActive("running")).toBe(true);
    expect(isActive("starting")).toBe(true);
  });

  it("does not count a thread that has stopped", () => {
    expect(isActive("completed")).toBe(false);
    expect(isActive("failed")).toBe(false);
    expect(isActive("canceled")).toBe(false);
  });

  it("counts a thread that is asking someone a question", () => {
    expect(isActive("needs_input")).toBe(true);
  });

  it("does not count an idle thread — it would sit in the sidebar forever", () => {
    expect(isActive("idle")).toBe(false);
  });

  it("settles a completed thread whatever its session was doing", () => {
    const completedAt = new Date("2026-09-18T11:00:00.000Z");
    for (const status of STATUSES) {
      expect(isActive(status, completedAt)).toBe(false);
    }
  });

  it("leaves a thread that was never completed to its session", () => {
    expect(isActive("running", null)).toBe(true);
    expect(isActive("waiting", undefined)).toBe(true);
    expect(isActive("failed", null)).toBe(false);
  });
});

describe("statusLabel", () => {
  it("reads as completed off the completion flag alone", () => {
    const completedAt = new Date("2026-09-18T11:00:00.000Z");
    for (const status of STATUSES) {
      expect(statusLabel(status, completedAt)).toBe("Completed");
    }
  });

  it("still names the session status when nobody completed the thread", () => {
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel("waiting", null)).toBe("Waiting");
    expect(statusLabel("completed")).toBe("Completed");
    expect(statusLabel("canceled", null)).toBe("Canceled");
  });

  it("names the two states a stopped session can be in", () => {
    expect(statusLabel("needs_input")).toBe("Needs input");
    expect(statusLabel("idle")).toBe("Idle");
  });
});

describe("statusTone", () => {
  it("gives every status the thread list can show a dot colour", () => {
    for (const status of STATUSES) {
      expect(statusTone(status)).not.toBeNull();
    }
  });

  it("tells running, needs_input and idle apart", () => {
    const tones = new Set([
      statusTone("running"),
      statusTone("needs_input"),
      statusTone("idle"),
    ]);
    expect(tones.size).toBe(3);
  });

  it("has no colour for a status it does not know", () => {
    expect(statusTone("banana")).toBeNull();
  });
});

describe("waitingOnLabel", () => {
  it("names the agent and what it last said", () => {
    expect(waitingOnLabel(waiting)).toBe(
      "@sol-superset · Reading the README template…",
    );
  });

  it("falls back to its status, so it never reads as an idle agent", () => {
    expect(waitingOnLabel({ ...waiting, lastProgress: null })).toBe(
      "@sol-superset · Running",
    );
    expect(waitingOnLabel({ ...waiting, lastProgress: "   " })).toBe(
      "@sol-superset · Running",
    );
  });

  it("is nothing when the thread is waiting on nobody", () => {
    expect(waitingOnLabel(null)).toBeNull();
  });
});

const READ_AT = new Date("2026-09-18T10:00:00.000Z");
const ENDED_AT = new Date("2026-09-18T10:30:00.000Z");

const row = (thread: Partial<ThreadItem> = {}): ThreadItem => ({
  id: "thread-1",
  projectId: "channel-1",
  rootMessageId: "message-1",
  status: "idle",
  backgroundWork: [],
  lastProgress: null,
  error: null,
  startedAt: new Date("2026-09-18T09:00:00.000Z"),
  endedAt: ENDED_AT,
  rootText: "Draft the README",
  authorName: "Harshith",
  authorEmail: "harshith@tegon.ai",
  replyCount: 2,
  lastReplyAt: ENDED_AT,
  replierNames: ["Harshith"],
  waitingOn: [],
  completedAt: null,
  completedByMemberId: null,
  lastReadAt: READ_AT,
  muted: false,
  ...thread,
});

describe("turnUnseen", () => {
  it("is true for a turn that finished after you last looked", () => {
    expect(turnUnseen(row())).toBe(true);
    expect(turnUnseen(row({ status: "completed" }))).toBe(true);
  });

  it("is false once you have opened the thread since it finished", () => {
    expect(
      turnUnseen(row({ lastReadAt: new Date("2026-09-18T10:45:00.000Z") })),
    ).toBe(false);
  });

  it("is false while the agent is still working", () => {
    expect(turnUnseen(row({ status: "running", endedAt: null }))).toBe(false);
    expect(turnUnseen(row({ status: "needs_input", endedAt: null }))).toBe(
      false,
    );
    expect(turnUnseen(row({ status: "waiting", endedAt: null }))).toBe(false);
  });

  it("is false for a turn that ended badly — green would be a lie", () => {
    expect(turnUnseen(row({ status: "failed" }))).toBe(false);
    expect(turnUnseen(row({ status: "canceled" }))).toBe(false);
  });

  it("is false once somebody has settled the thread", () => {
    expect(turnUnseen(row({ completedAt: ENDED_AT }))).toBe(false);
  });

  it("is false for a thread you do not follow — it is not yours to open", () => {
    expect(turnUnseen(row({ lastReadAt: null }))).toBe(false);
  });

  it("is false for a thread you muted, as the inbox already reads mute", () => {
    expect(turnUnseen(row({ muted: true }))).toBe(false);
  });
});

describe("mergeThread", () => {
  it("keeps the mute you set, which the broadcast payload cannot carry", () => {
    const list = [row({ status: "running", endedAt: null, muted: true })];
    const parsed = parsePublishedThread(
      published({ status: "idle", endedAt: ENDED_AT.toISOString() }),
    );
    const merged = mergeThread(list, parsed!);

    expect(merged[0]?.muted).toBe(true);
    expect(turnUnseen(merged[0]!)).toBe(false);
  });

  it("keeps your read mark, which the broadcast payload cannot carry", () => {
    const list = [row({ status: "running", endedAt: null })];
    const parsed = parsePublishedThread(
      published({ status: "idle", endedAt: ENDED_AT.toISOString() }),
    );
    const merged = mergeThread(list, parsed!);

    expect(merged[0]?.lastReadAt).toEqual(READ_AT);
    expect(turnUnseen(merged[0]!)).toBe(true);
  });

  it("leaves a thread it has never seen unread-by-nobody", () => {
    const parsed = parsePublishedThread(published({ status: "idle" }));
    expect(mergeThread([], parsed!)[0]?.lastReadAt).toBeNull();
  });
});

describe("markThreadSeen", () => {
  it("clears the dot the moment the thread is opened", () => {
    const seenAt = new Date("2026-09-18T11:00:00.000Z");
    const marked = markThreadSeen([row()], "thread-1", seenAt);

    expect(marked[0]?.lastReadAt).toEqual(seenAt);
    expect(turnUnseen(marked[0]!)).toBe(false);
  });

  it("leaves a list without that thread alone", () => {
    const list = [row()];
    expect(markThreadSeen(list, "thread-9", new Date())).toBe(list);
  });
});

describe("parsePublishedThread", () => {
  it("carries the agent the thread is waiting on", () => {
    const parsed = parsePublishedThread(published({ waitingOn: [waiting] }));
    expect(parsed?.waitingOn).toEqual([waiting]);
  });

  it("carries every agent a thread fanned its asks out to", () => {
    const parsed = parsePublishedThread(
      published({
        waitingOn: [waiting, { ...waiting, handle: "fern-core" }],
      }),
    );
    expect(parsed?.waitingOn.map((one) => one.handle)).toEqual([
      "sol-superset",
      "fern-core",
    ]);
  });

  it("keeps a missing child thread id, so the card still renders unlinked", () => {
    const parsed = parsePublishedThread(
      published({ waitingOn: [{ ...waiting, threadId: null }] }),
    );
    expect(parsed?.waitingOn[0]?.threadId).toBeNull();
    expect(parsed?.waitingOn[0]?.handle).toBe("sol-superset");
  });

  it("is empty when the payload carries no delegation", () => {
    expect(parsePublishedThread(published({}))?.waitingOn).toEqual([]);
    expect(
      parsePublishedThread(
        published({ waitingOn: [{ handle: "sol-superset" }] }),
      )?.waitingOn,
    ).toEqual([]);
  });

  it("carries the completion across the wire, so other viewers see it", () => {
    const parsed = parsePublishedThread(
      published({
        completedAt: "2026-09-18T11:00:00.000Z",
        completedByMemberId: "member-1",
      }),
    );
    expect(parsed?.completedAt).toEqual(new Date("2026-09-18T11:00:00.000Z"));
    expect(parsed?.completedByMemberId).toBe("member-1");
    expect(isActive(parsed?.status ?? "", parsed?.completedAt)).toBe(false);
  });

  it("leaves an open thread uncompleted", () => {
    const parsed = parsePublishedThread(published({}));
    expect(parsed?.completedAt).toBeNull();
    expect(parsed?.completedByMemberId).toBeNull();
  });

  it("refuses a completion it cannot read", () => {
    const parsed = parsePublishedThread(
      published({ completedAt: "not a date", completedByMemberId: 7 }),
    );
    expect(parsed?.completedAt).toBeNull();
    expect(parsed?.completedByMemberId).toBeNull();
    expect(
      parsePublishedThread(published({ completedAt: {} }))?.completedAt,
    ).toBeNull();
  });
});
