import { getChannelBySlug, threadSummary } from "@roster/api";
import { notFound } from "next/navigation";

import { AppShell } from "~/components/app-shell/app-shell";
import { ChatPage } from "~/components/chat/chat-page";
import { CHAT_PAGE_ACTIONS_ID } from "~/components/chat/constants";
import { loadShell } from "~/lib/shell";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ThreadChatPage({
  params,
}: {
  params: Promise<{ slug: string; channelSlug: string; threadId: string }>;
}) {
  const { slug, channelSlug, threadId } = await params;
  if (!UUID.test(threadId)) notFound();
  const { organization, member, shell } = await loadShell(slug);

  const channel = await getChannelBySlug({
    organizationId: organization.id,
    memberId: member.id,
    role: member.role,
    slug: channelSlug,
  });
  if (!channel) notFound();

  const thread = await threadSummary({ projectId: channel.id, threadId });
  if (!thread) notFound();

  const title = thread.rootText.split("\n")[0]?.trim() || "Thread";

  return (
    <AppShell
      shell={shell}
      section="channels"
      activeChannelSlug={channel.slug}
      title={<span className="truncate">{title}</span>}
      actions={<span id={CHAT_PAGE_ACTIONS_ID} className="flex items-center gap-1" />}
      flush
    >
      <ChatPage
        orgSlug={organization.slug}
        channelSlug={channel.slug}
        projectId={channel.id}
        threadId={threadId}
        title={title}
      />
    </AppShell>
  );
}
