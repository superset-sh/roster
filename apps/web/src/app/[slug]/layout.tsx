import { loadOnboardingState, resolveStep } from "@roster/api";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AgentStatusBar } from "~/components/chat/agent-status-bar";
import { ChatPanel } from "~/components/chat/chat-panel";
import { ChatPanelProvider } from "~/components/chat/chat-panel-provider";
import { requireOrg } from "~/lib/session";

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { session, organization } = await requireOrg(slug);

  const state = await loadOnboardingState({
    userId: session.user.id,
    email: session.user.email,
    organizationId: organization.id,
  });
  if (resolveStep(state) !== "done") redirect("/onboarding");

  return (
    <ChatPanelProvider orgSlug={organization.slug}>
      <div className="bg-background flex h-dvh flex-col">
        <div className="min-h-0 flex-1">{children}</div>
        <AgentStatusBar orgSlug={organization.slug} />
      </div>
      <ChatPanel />
    </ChatPanelProvider>
  );
}
