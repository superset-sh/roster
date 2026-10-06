"use client";

import { Button } from "@roster/ui";
import { Minimize2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useChatPanel } from "./chat-panel-provider";
import { ChatSessionView } from "./chat-session-view";

export interface ChatPageProps {
  orgSlug: string;
  channelSlug: string;
  projectId: string;
  threadId: string;
  title: string;
}

export function ChatPage({ orgSlug, channelSlug, projectId, threadId, title }: ChatPageProps) {
  const { openChat } = useChatPanel();
  const router = useRouter();
  const threadHref = `/${orgSlug}/${channelSlug}?thread=${threadId}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatSessionView
        orgSlug={orgSlug}
        projectId={projectId}
        threadId={threadId}
        title={title}
        variant="page"
        actions={
          <>
            <Button
              variant="ghost"
              size="xs"
              className="!rounded-md px-1.5"
              aria-label="Back to the small chat"
              onClick={() => {
                openChat({ projectId, threadId, channelSlug, title });
                router.push(threadHref);
              }}
            >
              <Minimize2 size={13} />
            </Button>
            <Button variant="ghost" size="xs" className="!rounded-md px-1.5" aria-label="Back to the thread" asChild>
              <Link href={threadHref}>
                <X size={14} />
              </Link>
            </Button>
          </>
        }
      />
    </div>
  );
}
