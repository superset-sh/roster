import { agentsRouter } from "./routers/agents";
import { apiKeysRouter } from "./routers/api-keys";
import { channelsRouter } from "./routers/channels";
import { chatRouter } from "./routers/chat";
import { cliRouter } from "./routers/cli";
import { inviteLinksRouter } from "./routers/invite-links";
import { messagesRouter } from "./routers/messages";
import { notificationsRouter } from "./routers/notifications";
import { onboardingRouter } from "./routers/onboarding";
import { reactionsRouter } from "./routers/reactions";
import { realtimeRouter } from "./routers/realtime";
import { searchRouter } from "./routers/search";
import { supersetRouter } from "./routers/superset";
import { tasksRouter } from "./routers/tasks";
import { threadsRouter } from "./routers/threads";
import { listUserOrganizations } from "./services/org";
import { createTRPCRouter, protectedProcedure } from "./trpc";

export const appRouter = createTRPCRouter({
  me: protectedProcedure.query(async ({ ctx }) => ({
    user: ctx.session.user,
    organizations: await listUserOrganizations(ctx.session.user.id),
  })),
  superset: supersetRouter,
  onboarding: onboardingRouter,
  agents: agentsRouter,
  channels: channelsRouter,
  chat: chatRouter,
  cli: cliRouter,
  apiKeys: apiKeysRouter,
  inviteLinks: inviteLinksRouter,
  messages: messagesRouter,
  tasks: tasksRouter,
  threads: threadsRouter,
  notifications: notificationsRouter,
  reactions: reactionsRouter,
  search: searchRouter,
  realtime: realtimeRouter,
});

export type AppRouter = typeof appRouter;
