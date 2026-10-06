"use client";

import { Bot, SquareTerminal } from "lucide-react";
import Link from "next/link";

import { useNow } from "~/hooks/use-now";
import { relativeTime } from "~/utils/relative-time";
import {
  isActive,
  replyCountLabel,
  type ThreadItem,
  turnUnseen,
} from "~/utils/thread-rows";

import { ReplyAvatars } from "./reply-avatars";
import { ThreadStatus, TurnCompleted } from "./thread-status";

export interface ThreadAffordanceProps {
  thread: ThreadItem;
  href: string;
}

export function ThreadAffordance({ thread, href }: ThreadAffordanceProps) {
  const live = isActive(thread.status, thread.completedAt);
  const now = useNow(live);

  return (
    <Link
      href={href}
      className="hover:bg-grayAlpha-50 hover:border-border -ml-1 mt-1 flex w-full max-w-2xl items-center gap-2 rounded-md border border-transparent px-1 py-1"
    >
      <ReplyAvatars names={thread.replierNames} />
      <span className="text-primary text-sm font-medium">
        {thread.replyCount > 0
          ? replyCountLabel(thread.replyCount)
          : "View thread"}
      </span>
      {thread.lastReplyAt ? (
        <span
          className="text-muted-foreground truncate text-xs"
          suppressHydrationWarning
        >
          {`Last reply ${relativeTime(thread.lastReplyAt, now)}`}
        </span>
      ) : null}
      {live ? <ThreadStatus status={thread.status} /> : null}
      {!live && turnUnseen(thread) ? <TurnCompleted /> : null}
      <BackgroundWorkBadge work={thread.backgroundWork} />
      {thread.waitingOn.length > 0 ? (
        <span className="text-muted-foreground truncate text-xs">
          {`on ${thread.waitingOn.map((waiting) => `@${waiting.handle}`).join(", ")}`}
        </span>
      ) : null}
    </Link>
  );
}

function BackgroundWorkBadge({ work }: { work: ThreadItem["backgroundWork"] }) {
  if (work.length === 0) return null;
  const subagents = work.filter((task) => task.kind === "subagent").length;
  const processes = work.length - subagents;

  return (
    <span
      className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs"
      title={work.map((task) => task.name).join(", ")}
    >
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
      {subagents > 0 ? (
        <span className="flex items-center gap-0.5">
          <Bot size={12} />
          {subagents === 1 ? "1 subagent" : `${subagents} subagents`}
        </span>
      ) : null}
      {processes > 0 ? (
        <span className="flex items-center gap-0.5">
          <SquareTerminal size={12} />
          {processes === 1 ? "1 process" : `${processes} processes`}
        </span>
      ) : null}
    </span>
  );
}
