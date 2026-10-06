import {
  getChannelBySlug,
  listChannelThreads,
  listMessages,
  listTasks,
  pausedMessageCount,
  threadDetail,
  upcomingTasks,
} from "@roster/api";
import { Button } from "@roster/ui";
import { Settings } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "~/components/app-shell/app-shell";
import { ChannelPlaceholder } from "~/components/channels/channel-placeholder";
import { ChannelTabs } from "~/components/channels/channel-tabs";
import { UpcomingTaskChip } from "~/components/channels/upcoming-task-chip";
import { CollapseCompletedToggle } from "~/components/channels/collapse-completed-toggle";
import { WatchToggle } from "~/components/channels/watch-toggle";
import { ChannelMark } from "~/components/logo/channel-mark";
import { MessagePanel } from "~/components/messages/message-panel";
import { ChannelSearch } from "~/components/search/channel-search";
import { ThreadSidebar } from "~/components/threads/thread-sidebar";
import { TaskList } from "~/components/tasks/task-list";
import { loadShell } from "~/lib/shell";
import type { ChannelTab } from "~/types";

const TABS: ChannelTab[] = ["messages", "tasks", "memory"];

const EMPTY_STATES: Record<string, { title: string; description: string }> = {
  memory: {
    title: "Coming soon",
    description: "What the channel learns will show up here.",
  },
};

export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; channelSlug: string }>;
  searchParams: Promise<{ tab?: string; thread?: string }>;
}) {
  const { slug, channelSlug } = await params;
  const { tab, thread: openThreadId } = await searchParams;
  const { session, organization, member, shell } = await loadShell(slug);

  const channel = await getChannelBySlug({
    organizationId: organization.id,
    memberId: member.id,
    role: member.role,
    slug: channelSlug,
  });
  if (!channel) notFound();

  const activeTab: ChannelTab = TABS.includes(tab as ChannelTab)
    ? (tab as ChannelTab)
    : "messages";

  const [messages, tasks, threads, pausedCount, upcoming] = await Promise.all([
    activeTab === "messages"
      ? listMessages({ projectId: channel.id, limit: 50 })
      : [],
    activeTab === "tasks"
      ? listTasks({
          organizationId: organization.id,
          memberId: member.id,
          role: member.role,
        })
      : [],
    activeTab === "messages"
      ? listChannelThreads({ projectId: channel.id, memberId: member.id })
      : [],
    activeTab === "messages" && channel.watchEnabled
      ? pausedMessageCount(channel.id)
      : 0,
    upcomingTasks({
      organizationId: organization.id,
      memberId: member.id,
      role: member.role,
      projectId: channel.id,
    }),
  ]);

  const openThread =
    activeTab === "messages" && openThreadId
      ? await threadDetail({ projectId: channel.id, threadId: openThreadId })
      : null;

  const basePath = `/${organization.slug}/${channel.slug}`;
  const placeholder = EMPTY_STATES[activeTab];

  return (
    <>
    <AppShell
      shell={shell}
      section="channels"
      activeChannelSlug={channel.slug}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ChannelMark className="text-muted-foreground" />
          <span className="truncate">{channel.slug}</span>
        </span>
      }
      actions={
        <span className="flex items-center gap-1">
          {activeTab === "messages" ? (
            <CollapseCompletedToggle projectId={channel.id} />
          ) : null}
          <WatchToggle
            projectId={channel.id}
            enabled={channel.watchEnabled}
          />
          {shell.can("channel:update") ? (
            <Button
              variant="ghost"
              className="!rounded-md px-1.5"
              aria-label="Channel settings"
              asChild
            >
              <Link href={`/${organization.slug}/${channel.slug}/settings`}>
                <Settings size={16} />
              </Link>
            </Button>
          ) : null}
        </span>
      }
      tabs={
        <span className="flex w-full items-center gap-0.5">
          <ChannelTabs
            basePath={basePath}
            channelSlug={channel.slug}
            active={activeTab}
          />
          <UpcomingTaskChip
            projectId={channel.id}
            tasksHref={`${basePath}?tab=tasks&channel=${encodeURIComponent(channel.slug)}`}
            initial={upcoming
              .filter((task) => task.nextRunAt)
              .map((task) => ({
                id: task.id,
                title: task.title,
                nextRunAt: task.nextRunAt!.toISOString(),
              }))}
          />
          <ChannelSearch
            projectId={channel.id}
            orgSlug={organization.slug}
            channelSlug={channel.slug}
          />
        </span>
      }
      flush
      rail={
        openThread && openThreadId ? (
          <ThreadSidebar
            projectId={channel.id}
            threadId={openThreadId}
            channelSlug={channel.slug}
            memberId={member.id}
            authorName={session.user.name}
            authorEmail={session.user.email}
            detail={openThread}
            closeHref={basePath}
          />
        ) : null
      }
    >
      {placeholder ? (
        <ChannelPlaceholder
          title={placeholder.title}
          description={placeholder.description}
        />
      ) : activeTab === "tasks" ? (
        <TaskList tasks={tasks} channels={shell.channels} orgSlug={slug} />
      ) : (
        <MessagePanel
          projectId={channel.id}
          channelName={channel.slug}
          basePath={basePath}
          memberId={member.id}
          authorName={session.user.name}
          authorEmail={session.user.email}
          initialMessages={messages}
          initialThreads={threads}
          pausedCount={pausedCount}
        />
      )}
    </AppShell>
    </>
  );
}
