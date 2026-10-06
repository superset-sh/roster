import type { InboxThread } from "@roster/api";
import { describe, expect, it } from "vitest";

import {
  filterInboxThreads,
  groupInboxThreads,
  inboxBucket,
  isUnread,
  parseInboxFilter,
  showsUnreadDot,
  subscriptionLabel,
  trackOpenThread,
} from "./inbox-threads";

const NOW = new Date("2026-09-20T15:00:00");

function thread(over: Partial<InboxThread> = {}): InboxThread {
  return {
    id: "t1",
    projectId: "p1",
    rootMessageId: "m1",
    backgroundWork: [],
    status: "completed",
    lastProgress: null,
    error: null,
    startedAt: new Date("2026-09-20T09:00:00"),
    endedAt: null,
    rootText: "Ship the threads route",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    replyCount: 2,
    lastReplyAt: null,
    replierNames: ["Ada"],
    waitingOn: [],
    completedAt: null,
    completedByMemberId: null,
    channelSlug: "web",
    channelName: "web",
    lastActivityAt: new Date("2026-09-20T09:00:00"),
    unread: false,
    muted: false,
    reason: "author",
    ...over,
  };
}

describe("inboxBucket", () => {
  it("buckets activity from the same calendar day as today", () => {
    expect(inboxBucket(new Date("2026-09-20T00:05:00"), NOW)).toBe("today");
    expect(inboxBucket(new Date("2026-09-20T14:59:00"), NOW)).toBe("today");
  });

  it("treats a future timestamp as today", () => {
    expect(inboxBucket(new Date("2026-09-21T02:00:00"), NOW)).toBe("today");
  });

  it("buckets the previous calendar day as yesterday", () => {
    expect(inboxBucket(new Date("2026-09-19T23:59:00"), NOW)).toBe("yesterday");
    expect(inboxBucket(new Date("2026-09-19T00:01:00"), NOW)).toBe("yesterday");
  });

  it("buckets the rest of the last week together", () => {
    expect(inboxBucket(new Date("2026-09-18T12:00:00"), NOW)).toBe("week");
    expect(inboxBucket(new Date("2026-09-14T12:00:00"), NOW)).toBe("week");
  });

  it("buckets anything a week or older as earlier", () => {
    expect(inboxBucket(new Date("2026-09-13T23:00:00"), NOW)).toBe("earlier");
    expect(inboxBucket(new Date("2025-01-01T00:00:00"), NOW)).toBe("earlier");
  });
});

describe("groupInboxThreads", () => {
  it("returns groups in recency order and skips empty buckets", () => {
    const groups = groupInboxThreads(
      [
        thread({ id: "a", lastActivityAt: new Date("2026-09-20T10:00:00") }),
        thread({ id: "b", lastActivityAt: new Date("2026-09-17T10:00:00") }),
        thread({ id: "c", lastActivityAt: new Date("2026-08-01T10:00:00") }),
      ],
      NOW,
    );

    expect(groups.map((group) => group.bucket)).toEqual([
      "today",
      "week",
      "earlier",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Earlier this week",
      "Older",
    ]);
  });

  it("keeps the incoming order of threads inside a group", () => {
    const groups = groupInboxThreads(
      [
        thread({ id: "a", lastActivityAt: new Date("2026-09-20T12:00:00") }),
        thread({ id: "b", lastActivityAt: new Date("2026-09-20T08:00:00") }),
      ],
      NOW,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty inbox", () => {
    expect(groupInboxThreads([], NOW)).toEqual([]);
  });
});

describe("isUnread", () => {
  it("is true only when the thread is unread and not muted", () => {
    expect(isUnread({ unread: true, muted: false })).toBe(true);
    expect(isUnread({ unread: true, muted: true })).toBe(false);
    expect(isUnread({ unread: false, muted: false })).toBe(false);
    expect(isUnread({ unread: false, muted: true })).toBe(false);
  });
});

describe("parseInboxFilter", () => {
  it("defaults to unread", () => {
    expect(parseInboxFilter(null)).toBe("unread");
    expect(parseInboxFilter("")).toBe("unread");
    expect(parseInboxFilter("nonsense")).toBe("unread");
  });

  it("recognizes all", () => {
    expect(parseInboxFilter("all")).toBe("all");
  });

  it("recognizes needs-input", () => {
    expect(parseInboxFilter("needs-input")).toBe("needs-input");
  });
});

describe("filterInboxThreads", () => {
  const rows = [
    thread({ id: "unread", unread: true }),
    thread({ id: "read", unread: false }),
    thread({ id: "muted", unread: true, muted: true }),
  ];

  it("keeps only unread, unmuted threads for the unread filter", () => {
    expect(filterInboxThreads(rows, "unread").map((row) => row.id)).toEqual([
      "unread",
    ]);
  });

  it("keeps everything for the all filter", () => {
    expect(filterInboxThreads(rows, "all").map((row) => row.id)).toEqual([
      "unread",
      "read",
      "muted",
    ]);
  });

  it("keeps only threads waiting on input for the needs-input filter", () => {
    const mixed = [
      thread({ id: "waiting", status: "needs_input" }),
      thread({ id: "done", status: "completed" }),
      thread({ id: "waiting-read", status: "needs_input", unread: false }),
    ];
    expect(
      filterInboxThreads(mixed, "needs-input").map((row) => row.id),
    ).toEqual(["waiting", "waiting-read"]);
  });

  it("keeps threads that were unread when the page opened", () => {
    const pinned = new Set(["read"]);
    expect(
      filterInboxThreads(rows, "unread", pinned).map((row) => row.id),
    ).toEqual(["unread", "read"]);
  });
});

describe("showsUnreadDot", () => {
  const none = new Set<string>();

  it("shows the dot for an unread thread nobody opened yet", () => {
    expect(showsUnreadDot(thread({ unread: true }), none, none)).toBe(true);
  });

  it("keeps the dot when the server marks it read but it was unread at page open", () => {
    const pinned = new Set(["t1"]);
    expect(showsUnreadDot(thread({ unread: false }), pinned, none)).toBe(true);
  });

  it("clears the dot once the thread has been opened this session", () => {
    const pinned = new Set(["t1"]);
    const opened = new Set(["t1"]);
    expect(showsUnreadDot(thread({ unread: true }), pinned, opened)).toBe(
      false,
    );
  });

  it("never shows the dot for a read thread that was not pinned", () => {
    expect(showsUnreadDot(thread({ unread: false }), none, none)).toBe(false);
  });

  it("never shows the dot for a muted thread", () => {
    expect(
      showsUnreadDot(thread({ unread: true, muted: true }), none, none),
    ).toBe(false);
  });
});

describe("trackOpenThread", () => {
  const state = (pinned: string[], opened: string[]) => ({
    pinned: new Set(pinned),
    opened: new Set(opened),
  });

  it("records the open thread while the pane is up", () => {
    const next = trackOpenThread(state(["t1", "t2"], []), "t1");
    expect([...next.opened]).toEqual(["t1"]);
    expect([...next.pinned]).toEqual(["t1", "t2"]);
  });

  it("unpins every thread opened this session when the pane closes", () => {
    const next = trackOpenThread(state(["t1", "t2"], ["t1", "t2"]), null);
    expect([...next.pinned]).toEqual([]);
  });

  it("keeps untouched threads pinned when the pane closes", () => {
    const next = trackOpenThread(state(["t1", "t2"], ["t1"]), null);
    expect([...next.pinned]).toEqual(["t2"]);
  });

  it("forgets opened threads on close so later activity shows a dot again", () => {
    const next = trackOpenThread(state(["t1"], ["t1"]), null);
    expect(next.opened.size).toBe(0);
    expect(showsUnreadDot(thread({ unread: true }), next.pinned, next.opened)).toBe(
      true,
    );
  });

  it("returns the same state when nothing changes", () => {
    const open = state(["t1"], ["t1"]);
    expect(trackOpenThread(open, "t1")).toBe(open);
    const closed = state(["t1"], []);
    expect(trackOpenThread(closed, null)).toBe(closed);
  });
});

describe("subscriptionLabel", () => {
  it("names why the thread landed in the inbox", () => {
    expect(subscriptionLabel("author")).toBe("You started this");
    expect(subscriptionLabel("replied")).toBe("You replied");
    expect(subscriptionLabel("mentioned")).toBe("You were mentioned");
    expect(subscriptionLabel("manual")).toBe("Following");
  });
});
