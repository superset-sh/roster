"use client";

import { Button, cn } from "@roster/ui";
import { Maximize2, Minus, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { useChatPanel } from "./chat-panel-provider";
import { ChatSessionView } from "./chat-session-view";

export function ChatPanel() {
  const { orgSlug, target, closeChat, minimizeChat } = useChatPanel();
  const router = useRouter();

  if (!target) return null;

  return (
    <div
      className="bg-background border-border fixed right-4 bottom-11 z-40 flex h-[min(600px,75vh)] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border shadow-2xl"
      role="dialog"
      aria-label="Agent session"
    >
      <ChatSessionView
        key={target.threadId}
        orgSlug={orgSlug}
        projectId={target.projectId}
        threadId={target.threadId}
        title={target.title}
        variant="panel"
        actions={
          <>
            <Button variant="ghost" size="xs" className="!rounded-md px-1.5" aria-label="Minimize" onClick={minimizeChat}>
              <Minus size={14} />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="!rounded-md px-1.5"
              aria-label="Open full page"
              onClick={() => {
                minimizeChat();
                router.push(`/${orgSlug}/${target.channelSlug}/thread/${target.threadId}/chat`);
              }}
            >
              <Maximize2 size={13} />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className={cn("!rounded-md px-1.5")}
              aria-label="Close"
              onClick={() => closeChat(target.threadId)}
            >
              <X size={14} />
            </Button>
          </>
        }
      />
    </div>
  );
}
