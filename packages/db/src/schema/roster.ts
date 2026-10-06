import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { members, organizations } from "./auth";

export const rosterSchema = pgSchema("roster");

export const folders = rosterSchema.table(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    supersetProjectId: text("superset_project_id").notNull(),
    supersetHostId: text("superset_host_id").notNull(),
    supersetOrgId: uuid("superset_org_id").notNull(),

    name: text("name").notNull(),

    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoUrl: text("repo_url"),
    repoPath: text("repo_path"),

    ownerMemberId: uuid("owner_member_id").references(() => members.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("folders_organization_id_idx").on(table.organizationId),
    uniqueIndex("folders_org_superset_id_idx").on(
      table.organizationId,
      table.supersetProjectId,
    ),
  ],
);

export type SelectFolder = typeof folders.$inferSelect;
export type InsertFolder = typeof folders.$inferInsert;

export const projects = rosterSchema.table(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    slug: text("slug").notNull(),

    defaultAgentId: uuid("default_agent_id")
      .notNull()
      .references(() => members.id),

    addedByMemberId: uuid("added_by_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),

    visibility: text("visibility").default("public").notNull(),

    watchEnabled: boolean("watch_enabled").default(true).notNull(),
    watchPausedAt: timestamp("watch_paused_at", { withTimezone: true }),

    lastSeq: bigint("last_seq", { mode: "number" }).default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("projects_organization_id_idx").on(table.organizationId),
    uniqueIndex("projects_org_slug_idx").on(table.organizationId, table.slug),
    index("projects_default_agent_idx").on(table.defaultAgentId),
  ],
);

export type SelectProject = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

export const channelStars = rosterSchema.table(
  "channel_stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("channel_stars_member_project_idx").on(
      table.memberId,
      table.projectId,
    ),
    index("channel_stars_member_id_idx").on(table.memberId),
  ],
);

export type SelectChannelStar = typeof channelStars.$inferSelect;

export const channelReads = rosterSchema.table(
  "channel_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("channel_reads_member_project_idx").on(
      table.memberId,
      table.projectId,
    ),
    index("channel_reads_member_idx").on(table.memberId),
  ],
);

export type SelectChannelRead = typeof channelReads.$inferSelect;

export const messages = rosterSchema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    seq: bigint("seq", { mode: "number" }).notNull(),

    authorMemberId: uuid("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    kind: text("kind").default("user").notNull(),

    agentChannelId: uuid("agent_channel_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    body: jsonb("body").notNull(),
    text: text("text").notNull(),

    clientId: text("client_id"),

    parentMessageId: uuid("parent_message_id"),

    threadId: uuid("thread_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("messages_project_seq_idx").on(table.projectId, table.seq),
    uniqueIndex("messages_project_client_id_idx").on(
      table.projectId,
      table.clientId,
    ),
    index("messages_project_created_idx").on(table.projectId, table.createdAt),
    index("messages_parent_idx").on(table.parentMessageId),
    index("messages_thread_idx").on(table.threadId),
    index("messages_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${table.text})`,
    ),
  ],
);

export type SelectMessage = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

export const attachments = rosterSchema.table(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),

    uploaderMemberId: uuid("uploader_member_id").references(() => members.id, {
      onDelete: "set null",
    }),

    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),

    storageKey: text("storage_key").notNull(),

    width: integer("width"),
    height: integer("height"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("attachments_message_idx").on(table.messageId),
    index("attachments_project_idx").on(table.projectId),
  ],
);

export type SelectAttachment = typeof attachments.$inferSelect;
export type InsertAttachment = typeof attachments.$inferInsert;

export const reactions = rosterSchema.table(
  "reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("reactions_message_member_emoji_idx").on(
      table.messageId,
      table.memberId,
      table.emoji,
    ),
    index("reactions_message_idx").on(table.messageId),
  ],
);

export type SelectReaction = typeof reactions.$inferSelect;
export type InsertReaction = typeof reactions.$inferInsert;

export const threads = rosterSchema.table(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    rootMessageId: uuid("root_message_id").notNull(),

    turnCount: integer("turn_count").default(0).notNull(),

    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByMemberId: uuid("completed_by_member_id").references(
      () => members.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    uniqueIndex("threads_root_message_idx").on(table.rootMessageId),
    index("threads_project_idx").on(table.projectId),
    index("threads_project_activity_idx").on(
      table.projectId,
      table.lastActivityAt.desc(),
    ),
    index("threads_org_activity_idx").on(
      table.organizationId,
      table.lastActivityAt.desc(),
    ),
  ],
);

export type SelectThread = typeof threads.$inferSelect;
export type InsertThread = typeof threads.$inferInsert;

export const THREAD_SESSION_ROLES = ["main", "delegate"] as const;
export type ThreadSessionRole = (typeof THREAD_SESSION_ROLES)[number];

export const threadSessions = rosterSchema.table(
  "thread_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    role: text("role")
      .$type<ThreadSessionRole>()
      .default("main")
      .notNull(),

    agentMemberId: uuid("agent_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),

    runAsMemberId: uuid("run_as_member_id").references(() => members.id, {
      onDelete: "set null",
    }),

    supersetWorkspaceId: text("superset_workspace_id"),
    supersetHostKey: text("superset_host_key"),
    supersetChatSessionId: text("superset_chat_session_id"),
    supersetHarnessSessionId: text("superset_harness_session_id"),
    chatCursor: text("chat_cursor"),
    backgroundTasks: jsonb("background_tasks")
      .$type<ThreadBackgroundTask[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    status: text("status").default("starting").notNull(),

    lastProgress: text("last_progress"),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    workspaceReapedAt: timestamp("workspace_reaped_at", { withTimezone: true }),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("thread_sessions_thread_agent_idx").on(
      table.threadId,
      table.agentMemberId,
    ),
    index("thread_sessions_thread_idx").on(table.threadId),
    index("thread_sessions_status_idx").on(table.status),
  ],
);

export interface ThreadBackgroundTask {
  id: string;
  kind: "process" | "subagent";
  name: string;
  detail?: string;
  canStop: boolean;
  startedAtMs: number;
}

export type SelectThreadSession = typeof threadSessions.$inferSelect;
export type InsertThreadSession = typeof threadSessions.$inferInsert;

export const THREAD_SUBSCRIPTION_REASONS = [
  "author",
  "replied",
  "mentioned",
  "manual",
] as const;
export type ThreadSubscriptionReason =
  (typeof THREAD_SUBSCRIPTION_REASONS)[number];

export const threadSubscriptions = rosterSchema.table(
  "thread_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),

    reason: text("reason").$type<ThreadSubscriptionReason>().notNull(),

    lastReadAt: timestamp("last_read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    mutedAt: timestamp("muted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("thread_subscriptions_thread_member_idx").on(
      table.threadId,
      table.memberId,
    ),
    index("thread_subscriptions_member_idx").on(table.memberId),
  ],
);

export type SelectThreadSubscription = typeof threadSubscriptions.$inferSelect;
export type InsertThreadSubscription = typeof threadSubscriptions.$inferInsert;

export const tasks = rosterSchema.table(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    threadId: uuid("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),

    title: text("title").notNull(),

    status: text("status").default("todo").notNull(),

    rrule: text("rrule"),
    timezone: text("timezone").default("UTC").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    recurrenceDisabledReason: text("recurrence_disabled_reason"),

    createdByMemberId: uuid("created_by_member_id").references(
      () => members.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("tasks_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("tasks_project_created_idx").on(table.projectId, table.createdAt),
    index("tasks_organization_status_idx").on(
      table.organizationId,
      table.status,
    ),
    uniqueIndex("tasks_thread_idx").on(table.threadId),
    index("tasks_due_idx")
      .on(table.nextRunAt)
      .where(sql`rrule is not null and next_run_at is not null`),
    index("tasks_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${table.title})`,
    ),
  ],
);

export type SelectTask = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

export const orgInviteLinks = rosterSchema.table(
  "org_invite_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    token: text("token").notNull(),

    role: text("role").default("member").notNull(),

    createdByMemberId: uuid("created_by_member_id").references(
      () => members.id,
      { onDelete: "set null" },
    ),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("org_invite_links_organization_idx").on(table.organizationId),
    uniqueIndex("org_invite_links_token_idx").on(table.token),
  ],
);

export type SelectOrgInviteLink = typeof orgInviteLinks.$inferSelect;
export type InsertOrgInviteLink = typeof orgInviteLinks.$inferInsert;

export const apiKeys = rosterSchema.table(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),

    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_keys_hash_idx").on(table.hash),
    index("api_keys_member_id_idx").on(table.memberId),
  ],
);

export type SelectApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

export const delegations = rosterSchema.table(
  "delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    parentThreadId: uuid("parent_thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    originMemberId: uuid("origin_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    targetMemberId: uuid("target_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    childThreadId: uuid("child_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),

    task: text("task").notNull(),
    status: text("status").default("open").notNull(),
    reply: text("reply"),

    depth: bigint("depth", { mode: "number" }).default(1).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("delegations_one_open_per_target_idx")
      .on(table.parentThreadId, table.targetMemberId)
      .where(sql`status = 'open'`),
    index("delegations_parent_thread_idx").on(table.parentThreadId),
    index("delegations_child_thread_idx").on(table.childThreadId),
    index("delegations_target_idx").on(table.targetMemberId),
  ],
);

export type SelectDelegation = typeof delegations.$inferSelect;
export type InsertDelegation = typeof delegations.$inferInsert;

export const NOTIFICATION_TYPES = [
  "agent_replied",
  "agent_needs_input",
  "agent_waiting",
  "agent_failed",
  "human_replied",
  "mentioned",
  "delegation_received",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notifications = rosterSchema.table(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),

    messageId: uuid("message_id"),

    dedupeKey: text("dedupe_key"),

    type: text("type").$type<NotificationType>().notNull(),

    actorMemberId: uuid("actor_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    actorChannelId: uuid("actor_channel_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("notifications_member_created_idx").on(
      table.memberId,
      table.createdAt.desc(),
    ),
    index("notifications_member_unread_idx")
      .on(table.memberId)
      .where(sql`read_at is null`),
    uniqueIndex("notifications_member_message_idx")
      .on(table.memberId, table.messageId)
      .where(sql`message_id is not null`),
    uniqueIndex("notifications_member_dedupe_idx")
      .on(table.memberId, table.dedupeKey)
      .where(sql`dedupe_key is not null`),
  ],
);

export type SelectNotification = typeof notifications.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;

export const taskRuns = rosterSchema.table(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),

    slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),

    outcome: text("outcome").notNull(),
    detail: text("detail"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("task_runs_slot_idx").on(table.taskId, table.slotAt),
    index("task_runs_recent_idx").on(table.taskId, table.createdAt.desc()),
  ],
);

export type SelectTaskRun = typeof taskRuns.$inferSelect;
export type InsertTaskRun = typeof taskRuns.$inferInsert;
