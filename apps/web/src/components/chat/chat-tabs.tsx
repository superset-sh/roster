"use client";

import { cn } from "@roster/ui";
import { X } from "lucide-react";

import { useChatPanel } from "./chat-panel-provider";

export function ChatTabs() {
  const { chats, target, restoreChat, minimizeChat, closeChat } = useChatPanel();
  if (chats.length === 0) return null;

  return (
    <div className="flex min-w-0 items-center gap-1">
      {chats.map((chat) => {
        const active = chat.threadId === target?.threadId;
        return (
          <div
            key={chat.threadId}
            className={cn(
              "group flex max-w-56 min-w-0 items-center rounded-md text-xs transition-colors",
              active ? "bg-grayAlpha-200 text-foreground" : "bg-grayAlpha-100 text-muted-foreground hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => (active ? minimizeChat() : restoreChat(chat.threadId))}
              className="min-w-0 truncate py-1 pr-1 pl-2.5 text-left"
              title={chat.title}
            >
              {chat.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${chat.title}`}
              onClick={() => closeChat(chat.threadId)}
              className="text-muted-foreground hover:text-foreground shrink-0 py-1 pr-2 pl-1"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
