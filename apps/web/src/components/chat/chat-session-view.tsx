"use client";

import type { ChatApprovalRequest, ThreadBackgroundWork } from "@roster/api";
import { Button, cn } from "@roster/ui";
import { useQuery } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { BackgroundWorkGroups } from "~/components/threads/thread-background-work";
import { useThreadChat } from "~/hooks/use-thread-chat";
import { runningTurn } from "~/utils/chat-session";
import { trpc } from "~/utils/trpc";

import { ChatComposer } from "./chat-composer";
import { ChatTranscript } from "./chat-transcript";
import { CHAT_PAGE_ACTIONS_ID } from "./constants";

const STICK_THRESHOLD_PX = 80;

function plainDoc(text: string) {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line.length > 0 ? [{ type: "text", text: line }] : [],
    })),
  };
}

export function ChatSessionView({
  orgSlug,
  projectId,
  threadId,
  title,
  variant,
  actions,
}: {
  orgSlug: string;
  projectId: string;
  threadId: string;
  title: string;
  variant: "panel" | "page";
  actions: ReactNode;
}) {
  const { snapshot, connection, loadOlder, loadingOlder, reachedStart } = useThreadChat({
    orgSlug,
    projectId,
    threadId,
    enabled: true,
  });
  const [showWork, setShowWork] = useState(false);

  const { data: chats } = useQuery({
    queryKey: ["chat", "sessions", threadId],
    queryFn: () => trpc.chat.sessions.query({ projectId, threadId }),
  });
  const rosterSessionId =
    chats?.find((chat) => chat.role === "main")?.rosterSessionId ?? chats?.[0]?.rosterSessionId;

  const turn = runningTurn(snapshot);
  const status = snapshot.session?.status;
  const running = turn !== null || status === "running" || status === "starting";

  const work: ThreadBackgroundWork[] = useMemo(
    () =>
      rosterSessionId
        ? (snapshot.session?.backgroundTasks ?? []).map((task) => ({
            rosterSessionId,
            ...task,
          }))
        : [],
    [snapshot.session?.backgroundTasks, rosterSessionId],
  );

  useEffect(() => {
    if (work.length === 0) setShowWork(false);
  }, [work.length]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const heightRef = useRef(0);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const grew = element.scrollHeight - heightRef.current;
    if (stickRef.current) {
      element.scrollTop = element.scrollHeight;
    } else if (grew > 0 && element.scrollTop < STICK_THRESHOLD_PX) {
      element.scrollTop += grew;
    }
    heightRef.current = element.scrollHeight;
  }, [snapshot]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
    if (element.scrollTop < STICK_THRESHOLD_PX) void loadOlder();
  }, [loadOlder]);

  async function send(text: string): Promise<boolean> {
    try {
      await trpc.messages.send.mutate({
        projectId,
        body: plainDoc(text),
        text,
        clientId: crypto.randomUUID(),
        threadId,
      });
      stickRef.current = true;
      return true;
    } catch {
      console.warn("[chat] send failed");
      return false;
    }
  }

  function stop() {
    void trpc.threads.cancel.mutate({ projectId, threadId }).catch(() => {
      console.warn("[chat] stop failed");
    });
  }

  function answer(approval: ChatApprovalRequest, allow: boolean, optionId?: string) {
    void trpc.chat.answer
      .mutate({ projectId, threadId, approvalId: approval.id, allow, optionId })
      .catch(() => console.warn("[chat] answer failed"));
  }

  const empty = snapshot.items.size === 0;

  const [pageActions, setPageActions] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (variant === "page") setPageActions(document.getElementById(CHAT_PAGE_ACTIONS_ID));
  }, [variant]);

  const statusDot = (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        running ? "animate-pulse bg-blue-500" : status === "awaiting_input" ? "bg-amber-500" : "bg-gray-400",
      )}
    />
  );

  const controls = (
    <>
      {work.length > 0 ? (
        <Button
          variant="ghost"
          size="xs"
          className={cn("text-muted-foreground gap-1 !rounded-md px-1.5 text-xs", showWork && "bg-grayAlpha-100")}
          aria-label="Background work"
          onClick={() => setShowWork((current) => !current)}
        >
          <Bot size={13} />
          {work.length}
        </Button>
      ) : null}
      {actions}
    </>
  );

  return (
    <>
      {variant === "panel" ? (
        <header className="border-border flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
          {statusDot}
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {snapshot.session?.title ?? title}
          </h2>
          {controls}
        </header>
      ) : pageActions ? (
        createPortal(
          <>
            {statusDot}
            {controls}
          </>,
          pageActions,
        )
      ) : null}

      {showWork && work.length > 0 ? (
        <div className="border-border bg-background-2 max-h-56 shrink-0 divide-y overflow-y-auto border-b p-1">
          <BackgroundWorkGroups
            projectId={projectId}
            threadId={threadId}
            work={work}
            details={snapshot.backgroundDetail}
            showEmpty={false}
          />
        </div>
      ) : null}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <div className={cn("flex min-h-full flex-col", variant === "page" && "mx-auto w-full max-w-3xl")}>
        {loadingOlder ? (
          <div className="flex justify-center py-2">
            <Loader2 size={14} className="text-muted-foreground animate-spin" />
          </div>
        ) : null}
        {!reachedStart && !empty && !loadingOlder ? <div className="h-2" /> : null}
        {connection === "unavailable" ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm">
            Could not reach this thread&apos;s session. Its machine may be offline.
          </div>
        ) : empty ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
            <Loader2 size={14} className="animate-spin" />
            {connection === "open" ? "Waiting for the agent…" : "Connecting to the session…"}
          </div>
        ) : (
          <ChatTranscript snapshot={snapshot} onAnswer={answer} />
        )}
        {running && !empty ? (
          <div className="text-muted-foreground flex items-center gap-1.5 pt-2 text-xs">
            <Loader2 size={12} className="animate-spin" /> Working…
          </div>
        ) : null}
        </div>
      </div>

      <div className={cn("shrink-0 px-3 pt-1 pb-3", variant === "page" && "mx-auto w-full max-w-3xl pb-5")}>
        <ChatComposer
          running={running}
          disabled={connection === "unavailable"}
          placeholder={running ? "Steer the agent…" : "Reply to the agent…"}
          onSend={send}
          onStop={stop}
        />
      </div>
    </>
  );
}
