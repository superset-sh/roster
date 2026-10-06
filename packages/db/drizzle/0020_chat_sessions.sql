ALTER TABLE "roster"."thread_sessions" ADD COLUMN IF NOT EXISTS "superset_chat_session_id" text;--> statement-breakpoint
ALTER TABLE "roster"."thread_sessions" ADD COLUMN IF NOT EXISTS "superset_harness_session_id" text;--> statement-breakpoint
ALTER TABLE "roster"."thread_sessions" ADD COLUMN IF NOT EXISTS "chat_cursor" text;--> statement-breakpoint
ALTER TABLE "roster"."thread_sessions" ADD COLUMN IF NOT EXISTS "background_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL;
