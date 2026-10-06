ALTER TABLE "plan" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "event_project_id_type_effective_at_idx" ON "event" USING btree ("project_id","type","effective_at");--> statement-breakpoint
CREATE INDEX "scope_collection_batch_project_id_created_at_idx" ON "scope_collection_batch" USING btree ("project_id","created_at");--> statement-breakpoint
-- Backfill: a Task blocked before blocked_at existed became blocked at its
-- latest task.blocked Event from another status; a paused Plan, at its latest
-- plan.status_changed Event to paused. Rows with no such Event stay null.
UPDATE "task" AS t SET "blocked_at" = (
  SELECT max(e."effective_at") FROM "event" AS e
  WHERE e."project_id" = t."project_id" AND e."task_id" = t."id"
    AND e."type" = 'task.blocked' AND e."payload"->>'from' <> 'blocked'
) WHERE t."status" = 'blocked' AND t."blocked_at" IS NULL;--> statement-breakpoint
UPDATE "plan" AS p SET "paused_at" = (
  SELECT max(e."effective_at") FROM "event" AS e
  WHERE e."project_id" = p."project_id" AND e."plan_id" = p."id"
    AND e."type" = 'plan.status_changed' AND e."payload"->>'to' = 'paused'
) WHERE p."status" = 'paused' AND p."paused_at" IS NULL;
