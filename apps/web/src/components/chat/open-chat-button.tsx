"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@roster/ui";
import { MessagesSquare } from "lucide-react";

import { useChatPanel } from "./chat-panel-provider";
import { trpc } from "~/utils/trpc";

export interface OpenChatButtonProps {
  projectId: string;
  threadId: string;
  channelSlug: string;
  title: string;
}

export function OpenChatButton({
  projectId,
  threadId,
  channelSlug,
  title,
}: OpenChatButtonProps) {
  const { openChat } = useChatPanel();

  const { data: chats } = useQuery({
    queryKey: ["chat", "sessions", threadId],
    queryFn: () => trpc.chat.sessions.query({ projectId, threadId }),
    refetchInterval: 15_000,
  });

  if (!chats?.length) return null;

  return (
    <Button
      variant="ghost"
      className="!rounded-md gap-1.5 px-1.5 text-xs"
      aria-label="Open this thread's session"
      onClick={() => openChat({ projectId, threadId, channelSlug, title })}
    >
      <MessagesSquare size={14} />
      <span className="max-sm:hidden">Session</span>
    </Button>
  );
}
