import type { ThreadDetail } from "@roster/api";
import { Button } from "@roster/ui";
import { ChevronLeft, X } from "lucide-react";
import Link from "next/link";

import { OpenChatButton } from "~/components/chat/open-chat-button";

import { CloseOnEscape } from "./close-on-escape";
import { RecordThreadVisit } from "./record-thread-visit";
import { ThreadMenu } from "./thread-menu";
import { ThreadPanel } from "./thread-panel";
import { ThreadReferences } from "./thread-references";

export interface ThreadSidebarProps {
  projectId: string;
  threadId: string;
  channelSlug: string;
  memberId: string;
  authorName: string;
  authorEmail: string;
  detail: ThreadDetail;
  closeHref: string;
}

export function ThreadSidebar({
  projectId,
  threadId,
  channelSlug,
  memberId,
  authorName,
  authorEmail,
  detail,
  closeHref,
}: ThreadSidebarProps) {
  return (
    <aside className="border-border flex h-full w-full min-w-0 flex-1 flex-col sm:border-l">
      <CloseOnEscape href={closeHref} />
      <RecordThreadVisit
        threadId={threadId}
        channelSlug={channelSlug}
        rootText={detail.thread.rootText}
      />
      <header className="pt-safe relative flex shrink-0 flex-col border-b border-gray-300">
        <div className="h-(--header-height) flex items-center gap-1.5 px-2 sm:px-3">
          <Button
            variant="ghost"
            className="-ml-1 !rounded-md px-1.5 sm:hidden"
            aria-label="Back to channel"
            asChild
          >
            <Link href={closeHref}>
              <ChevronLeft size={18} />
            </Link>
          </Button>
          <h2 className="min-w-0 flex-1 truncate text-base">Thread</h2>
          <OpenChatButton
            projectId={projectId}
            threadId={threadId}
            channelSlug={channelSlug}
            title={detail.thread.rootText.split("\n")[0]?.trim() || "Thread"}
          />
          <ThreadReferences
            projectId={projectId}
            threadId={threadId}
            initialDetail={detail}
          />
          <ThreadMenu
            projectId={projectId}
            threadId={threadId}
            status={detail.thread.status}
            completedAt={detail.thread.completedAt}
          />
          <Button
            variant="ghost"
            className="!rounded-md px-1.5 max-sm:hidden"
            aria-label="Close thread"
            asChild
          >
            <Link href={closeHref}>
              <X size={16} />
            </Link>
          </Button>
        </div>
      </header>
      <ThreadPanel
        projectId={projectId}
        threadId={threadId}
        memberId={memberId}
        authorName={authorName}
        authorEmail={authorEmail}
        initialDetail={detail}
      />
    </aside>
  );
}
