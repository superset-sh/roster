import type {
  ThreadBackgroundWork,
  ThreadStatus,
  ThreadSummary,
  WaitingOn,
} from "@roster/api";

export type ThreadItem = Omit<
  ThreadSummary,
  "startedAt" | "endedAt" | "completedAt" | "completedByMemberId"
> & {
  startedAt: Date;
  endedAt: Date | null;
  completedAt: Date | null;
  completedByMemberId: string | null;
  lastReadAt: Date | null;
  muted: boolean;
};

export type ThreadUpdate = Omit<ThreadItem, "lastReadAt" | "muted">;

export function threadsKey(projectId: string) {
  return ["threads", projectId] as const;
}

export function threadDetailKey(threadId: string) {
  return ["thread", threadId] as const;
}

export function isLive(status: string): boolean {
  return status === "starting" || status === "running";
}

export function isWaiting(status: string): boolean {
  return status === "waiting";
}

export function needsInput(status: string): boolean {
  return status === "needs_input";
}

export function isIdle(status: string): boolean {
  return status === "idle";
}

export function turnFinished(status: string): boolean {
  return status === "idle" || status === "completed";
}

export function turnUnseen(
  thread: Pick<
    ThreadItem,
    "status" | "endedAt" | "lastReadAt" | "completedAt" | "muted"
  >,
): boolean {
  if (thread.muted) return false;
  if (thread.completedAt) return false;
  if (!turnFinished(thread.status)) return false;
  if (!thread.endedAt || !thread.lastReadAt) return false;
  return thread.endedAt > thread.lastReadAt;
}

export function isActive(status: string, completedAt?: Date | null): boolean {
  if (completedAt) return false;
  return isLive(status) || isWaiting(status) || needsInput(status);
}

export function canRetry(status: string, error: string | null): boolean {
  if (status === "failed") return true;
  return isLive(status) && error !== null;
}

export function statusLabel(status: string, completedAt?: Date | null): string {
  if (completedAt) return "Completed";

  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "needs_input":
      return "Needs input";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

/*
 * Typed as a complete record of ThreadStatus, so adding a status in the API
 * without giving it a colour here is a type error rather than a silent grey
 * dot.
 */
const TONE: Record<ThreadStatus, string> = {
  starting: "bg-muted-foreground",
  running: "bg-primary",
  needs_input: "bg-warning",
  waiting: "bg-primary/60",
  idle: "bg-muted-foreground/50",
  completed: "bg-muted-foreground",
  failed: "bg-destructive",
  canceled: "bg-muted-foreground",
};

export function statusTone(status: string): string | null {
  return TONE[status as ThreadStatus] ?? null;
}

export function waitingOnLabel(waiting: WaitingOn | null): string | null {
  if (!waiting) return null;

  const progress = waiting.lastProgress?.trim();
  const state =
    progress && progress.length > 0 ? progress : statusLabel(waiting.status);
  return `@${waiting.handle} · ${state}`;
}

function parseWaitingOnList(value: unknown): WaitingOn[] {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    const waiting = parseWaitingOn(entry);
    return waiting ? [waiting] : [];
  });
}

function parseWaitingOn(value: unknown): WaitingOn | null {
  if (typeof value !== "object" || value === null) return null;

  const raw = value as Record<string, unknown>;
  if (
    typeof raw.handle !== "string" ||
    typeof raw.display !== "string" ||
    typeof raw.channelId !== "string" ||
    typeof raw.channelSlug !== "string" ||
    typeof raw.status !== "string" ||
    typeof raw.task !== "string"
  ) {
    return null;
  }

  return {
    handle: raw.handle,
    display: raw.display,
    channelId: raw.channelId,
    channelSlug: raw.channelSlug,
    threadId: typeof raw.threadId === "string" ? raw.threadId : null,
    status: raw.status,
    lastProgress:
      typeof raw.lastProgress === "string" ? raw.lastProgress : null,
    task: raw.task,
  };
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parsePublishedThread(data: unknown): ThreadUpdate | null {
  if (typeof data !== "object" || data === null) return null;

  const envelope = data as { type?: unknown; thread?: unknown };
  if (envelope.type !== "thread") return null;
  if (typeof envelope.thread !== "object" || envelope.thread === null) {
    return null;
  }

  const raw = envelope.thread as Record<string, unknown>;
  const startedAt = asDate(raw.startedAt);
  if (
    typeof raw.id !== "string" ||
    typeof raw.projectId !== "string" ||
    typeof raw.rootMessageId !== "string" ||
    typeof raw.status !== "string" ||
    !startedAt
  ) {
    return null;
  }

  return {
    id: raw.id,
    projectId: raw.projectId,
    rootMessageId: raw.rootMessageId,
    status: raw.status,
    lastProgress:
      typeof raw.lastProgress === "string" ? raw.lastProgress : null,
    error: typeof raw.error === "string" ? raw.error : null,
    startedAt,
    endedAt: asDate(raw.endedAt),
    rootText: typeof raw.rootText === "string" ? raw.rootText : "",
    authorName: typeof raw.authorName === "string" ? raw.authorName : null,
    authorEmail: typeof raw.authorEmail === "string" ? raw.authorEmail : null,
    replyCount: typeof raw.replyCount === "number" ? raw.replyCount : 0,
    lastReplyAt: asDate(raw.lastReplyAt),
    replierNames: Array.isArray(raw.replierNames)
      ? raw.replierNames.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
    waitingOn: parseWaitingOnList(raw.waitingOn),
    completedAt: asDate(raw.completedAt),
    completedByMemberId:
      typeof raw.completedByMemberId === "string"
        ? raw.completedByMemberId
        : null,
    backgroundWork: parseBackgroundWork(raw.backgroundWork),
  };
}

function parseBackgroundWork(value: unknown): ThreadBackgroundWork[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.rosterSessionId !== "string" ||
      typeof raw.id !== "string" ||
      (raw.kind !== "process" && raw.kind !== "subagent") ||
      typeof raw.name !== "string"
    ) {
      return [];
    }
    return [
      {
        rosterSessionId: raw.rosterSessionId,
        id: raw.id,
        kind: raw.kind,
        name: raw.name,
        ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
        canStop: raw.canStop === true,
        startedAtMs: typeof raw.startedAtMs === "number" ? raw.startedAtMs : Date.now(),
      },
    ];
  });
}

export function mergeThread(
  list: ThreadItem[],
  incoming: ThreadUpdate,
): ThreadItem[] {
  const index = list.findIndex((thread) => thread.id === incoming.id);
  if (index === -1) {
    return [{ ...incoming, lastReadAt: null, muted: false }, ...list];
  }

  const previous = list[index];
  const merged: ThreadItem = {
    ...incoming,
    lastReadAt: previous?.lastReadAt ?? null,
    muted: previous?.muted ?? false,
    rootText: incoming.rootText || (previous?.rootText ?? ""),
    authorName: incoming.authorName ?? previous?.authorName ?? null,
    authorEmail: incoming.authorEmail ?? previous?.authorEmail ?? null,
    replyCount: Math.max(incoming.replyCount, previous?.replyCount ?? 0),
    lastReplyAt: incoming.lastReplyAt ?? previous?.lastReplyAt ?? null,
    replierNames:
      incoming.replierNames.length > 0
        ? incoming.replierNames
        : (previous?.replierNames ?? []),
  };

  const next = [...list];
  next[index] = merged;
  return next;
}

export function removeThread(
  list: ThreadItem[],
  threadId: string,
): ThreadItem[] {
  const kept = list.filter((thread) => thread.id !== threadId);
  return kept.length === list.length ? list : kept;
}

export function countReply(
  list: ThreadItem[],
  args: { threadId: string; createdAt: Date; replierName: string },
): ThreadItem[] {
  const index = list.findIndex((thread) => thread.id === args.threadId);
  if (index === -1) return list;

  const previous = list[index];
  if (!previous) return list;

  const next = [...list];
  next[index] = {
    ...previous,
    replyCount: previous.replyCount + 1,
    lastReplyAt:
      previous.lastReplyAt && previous.lastReplyAt > args.createdAt
        ? previous.lastReplyAt
        : args.createdAt,
    replierNames: previous.replierNames.includes(args.replierName)
      ? previous.replierNames
      : [...previous.replierNames, args.replierName],
  };
  return next;
}

export function markThreadSeen(
  list: ThreadItem[],
  threadId: string,
  seenAt: Date,
): ThreadItem[] {
  const index = list.findIndex((thread) => thread.id === threadId);
  if (index === -1) return list;

  const previous = list[index];
  if (!previous) return list;

  const next = [...list];
  next[index] = { ...previous, lastReadAt: seenAt };
  return next;
}

export function replyCountLabel(count: number): string {
  return count === 1 ? "1 reply" : `${count} replies`;
}
