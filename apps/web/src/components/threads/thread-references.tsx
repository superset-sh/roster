"use client";

import type {
  ThreadDetail,
  ThreadFile,
  ThreadLink,
  ThreadPage,
  ThreadPullRequest,
  ThreadReferences as References,
} from "@roster/api";
import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@roster/ui";
import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  FileText,
  GitPullRequest,
  Image as ImageIcon,
  ListTree,
  Link2,
  Loader2,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { attachmentKind } from "~/utils/attachments";
import { threadDetailKey } from "~/utils/thread-rows";
import { trpc } from "~/utils/trpc";

import { BackgroundWorkGroups, EmptyRow, MenuGroup } from "./thread-background-work";

export interface ThreadReferencesProps {
  projectId: string;
  threadId: string;
  initialDetail: ThreadDetail;
  className?: string;
}

export function ThreadReferences({
  projectId,
  threadId,
  initialDetail,
  className,
}: ThreadReferencesProps) {
  const [open, setOpen] = useState(false);

  const { data: detail } = useQuery({
    queryKey: threadDetailKey(threadId),
    queryFn: () => trpc.threads.get.query({ projectId, threadId }),
    initialData: initialDetail,
    enabled: false,
  });
  const work = detail.thread.backgroundWork ?? [];

  const { data, isError } = useQuery({
    queryKey: ["thread-references", threadId],
    queryFn: () => trpc.threads.references.query({ projectId, threadId }),
    enabled: open,
    staleTime: 30_000,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          aria-label="Thread activity"
          title="Background work and what's shared in this thread"
          className={cn(
            "text-muted-foreground hover:text-foreground !rounded-md shrink-0 gap-1.5 px-1.5 text-xs",
            open && "bg-grayAlpha-100 text-foreground",
            className,
          )}
        >
          <ListTree size={14} className="shrink-0" />
          {work.length > 0 ? (
            <>
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
              <span className="tabular-nums">{work.length}</span>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverPortal>
        <PopoverContent align="end" sideOffset={6} className="w-80 p-1">
          <div className="divide-border max-h-[480px] divide-y overflow-y-auto">
            <BackgroundWorkGroups projectId={projectId} threadId={threadId} work={work} />
            {isError ? (
              <MenuGroup title="Shared in this thread">
                <EmptyRow>Could not read this thread.</EmptyRow>
              </MenuGroup>
            ) : data ? (
              <ReferenceList references={data} />
            ) : (
              <span className="flex items-center justify-center py-4">
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              </span>
            )}
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}

function ReferenceList({ references }: { references: References }) {
  const { files, pullRequests, pages, links } = references;
  const total =
    files.length + pullRequests.length + pages.length + links.length;

  if (total === 0) {
    return (
      <MenuGroup title="Shared in this thread">
        <EmptyRow>Nothing shared yet</EmptyRow>
      </MenuGroup>
    );
  }

  return (
    <>
      <Section heading="Files" count={files.length}>
        {files.map((file) => (
          <FileRow key={file.id} file={file} />
        ))}
      </Section>

      <Section heading="Pull requests" count={pullRequests.length}>
        {pullRequests.map((pull) => (
          <PullRequestRow key={pull.href} pull={pull} />
        ))}
      </Section>

      <Section heading="Pages" count={pages.length}>
        {pages.map((page) => (
          <PageRow key={page.href} page={page} />
        ))}
      </Section>

      <Section heading="Links" count={links.length}>
        {links.map((link) => (
          <LinkRow key={link.href} link={link} />
        ))}
      </Section>
    </>
  );
}

function Section({
  heading,
  count,
  children,
}: {
  heading: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;

  return (
    <MenuGroup
      title={heading}
      actions={
        <span className="text-muted-foreground/70 pr-1 text-[11px] tabular-nums">{count}</span>
      }
    >
      {children}
    </MenuGroup>
  );
}

function Row({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={detail ? `${label} · ${detail}` : label}
      className="hover:bg-accent group flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5"
    >
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      {detail ? (
        <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-xs">
          {detail}
        </span>
      ) : null}
      <SquareArrowOutUpRight
        size={12}
        className="text-muted-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </a>
  );
}

function FileRow({ file }: { file: ThreadFile }) {
  const image = attachmentKind(file.mimeType) === "image";

  return (
    <Row
      href={file.url}
      icon={image ? <ImageIcon size={14} /> : <FileText size={14} />}
      label={file.filename}
    />
  );
}

function PullRequestRow({ pull }: { pull: ThreadPullRequest }) {
  return (
    <Row
      href={pull.href}
      icon={<GitPullRequest size={14} />}
      label={pull.label}
      detail={pull.owner}
    />
  );
}

function PageRow({ page }: { page: ThreadPage }) {
  return (
    <Row href={page.href} icon={<AppWindow size={14} />} label={page.label} />
  );
}

function LinkRow({ link }: { link: ThreadLink }) {
  return <Row href={link.href} icon={<Link2 size={14} />} label={link.label} />;
}
