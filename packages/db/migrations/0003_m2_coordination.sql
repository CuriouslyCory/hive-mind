CREATE TABLE "agent_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"user_id" uuid,
	"key_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"agent" text NOT NULL,
	"intent" text NOT NULL,
	"machine" text,
	"git_branch" text,
	"git_commit" text,
	"worktree_path" text,
	"attached_plan_id" uuid,
	"attached_task_id" uuid,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"summary" text,
	"summary_fingerprint" text,
	"collection_id" uuid,
	"collection_expected_batches" integer,
	"collection_path_count" integer,
	"collection_content_hash" text,
	"collection_complete" boolean DEFAULT false NOT NULL,
	"scope_history_incomplete" boolean DEFAULT false NOT NULL,
	"creation_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "agent_session_status_check" CHECK (status in ('active', 'idle', 'stale', 'ended', 'abandoned')),
	CONSTRAINT "agent_session_owner_check" CHECK ((owner_kind = 'user' and user_id is not null and key_id is null) or (owner_kind = 'key' and key_id is not null and user_id is null)),
	CONSTRAINT "agent_session_attached_task_check" CHECK (attached_task_id is null or attached_plan_id is not null),
	CONSTRAINT "agent_session_ended_check" CHECK ((status in ('ended', 'abandoned')) = (ended_at is not null)),
	CONSTRAINT "agent_session_summary_check" CHECK ((summary is null and summary_fingerprint is null) or (summary is not null and summary_fingerprint ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "agent_session_collection_manifest_check" CHECK ((collection_expected_batches is null and collection_path_count is null and collection_content_hash is null) or (collection_id is not null and collection_expected_batches >= 0 and collection_path_count >= 0 and collection_content_hash is not null)),
	CONSTRAINT "agent_session_collection_complete_check" CHECK (not collection_complete or collection_content_hash is not null),
	CONSTRAINT "agent_session_creation_fingerprint_check" CHECK (creation_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"owner_user_id" uuid,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"created_by_key_id" uuid,
	"creation_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_project_id_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "plan_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "plan_status_check" CHECK (status in ('draft', 'active', 'paused', 'done', 'abandoned')),
	CONSTRAINT "plan_number_check" CHECK ("plan"."number" > 0),
	CONSTRAINT "plan_creation_fingerprint_check" CHECK (creation_fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "plan_created_by_check" CHECK ((created_by_kind = 'user' and created_by_user_id is not null and created_by_key_id is null) or (created_by_kind = 'project_key' and created_by_key_id is not null and created_by_user_id is null))
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"block_reason" text,
	"claimed_by_session_id" uuid,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"created_by_key_id" uuid,
	"creation_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "task_id_plan_id_project_id_unique" UNIQUE("id","plan_id","project_id"),
	CONSTRAINT "task_status_check" CHECK (status in ('todo', 'in_progress', 'blocked', 'done')),
	CONSTRAINT "task_claim_check" CHECK ((claimed_by_session_id is null and claimed_at is null and lease_expires_at is null) or (claimed_by_session_id is not null and claimed_at is not null and lease_expires_at is not null)),
	CONSTRAINT "task_done_unclaimed_check" CHECK (status <> 'done' or claimed_by_session_id is null),
	CONSTRAINT "task_block_reason_check" CHECK ((status = 'blocked') = (block_reason is not null)),
	CONSTRAINT "task_creation_fingerprint_check" CHECK (creation_fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "task_created_by_check" CHECK ((created_by_kind = 'user' and created_by_user_id is not null and created_by_key_id is null) or (created_by_kind = 'project_key' and created_by_key_id is not null and created_by_user_id is null))
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"writer_xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"actor_key_id" uuid,
	"actor_session_id" uuid,
	"plan_id" uuid,
	"task_id" uuid,
	"session_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"creation_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_seq_unique" UNIQUE("seq"),
	CONSTRAINT "event_actor_kind_check" CHECK (actor_kind in ('user', 'project_key', 'system')),
	CONSTRAINT "event_actor_check" CHECK ((actor_kind = 'user' and actor_user_id is not null and actor_key_id is null) or (actor_kind = 'project_key' and actor_key_id is not null and actor_user_id is null) or (actor_kind = 'system' and actor_user_id is null and actor_key_id is null and actor_session_id is null)),
	CONSTRAINT "event_payload_version_check" CHECK ("event"."payload_version" > 0),
	CONSTRAINT "event_creation_fingerprint_check" CHECK (creation_fingerprint is null or creation_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "scope" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_session_id_source_value_unique" UNIQUE("session_id","source","value"),
	CONSTRAINT "scope_source_check" CHECK (source in ('declared', 'touched'))
);
--> statement-breakpoint
CREATE TABLE "scope_collection_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"batch_index" integer NOT NULL,
	"paths" text[] NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_collection_batch_session_collection_index_unique" UNIQUE("session_id","collection_id","batch_index"),
	CONSTRAINT "scope_collection_batch_index_check" CHECK ("scope_collection_batch"."batch_index" >= 0),
	CONSTRAINT "scope_collection_batch_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "next_plan_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "coordination_swept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_attached_plan_fk" FOREIGN KEY ("attached_plan_id","project_id") REFERENCES "public"."plan"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_attached_task_fk" FOREIGN KEY ("attached_task_id","attached_plan_id","project_id") REFERENCES "public"."task"("id","plan_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_plan_fk" FOREIGN KEY ("plan_id","project_id") REFERENCES "public"."plan"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_claimed_by_session_fk" FOREIGN KEY ("claimed_by_session_id","project_id") REFERENCES "public"."agent_session"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_actor_session_fk" FOREIGN KEY ("actor_session_id","project_id") REFERENCES "public"."agent_session"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_plan_fk" FOREIGN KEY ("plan_id","project_id") REFERENCES "public"."plan"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_task_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."task"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_session_fk" FOREIGN KEY ("session_id","project_id") REFERENCES "public"."agent_session"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_session_fk" FOREIGN KEY ("session_id","project_id") REFERENCES "public"."agent_session"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_collection_batch" ADD CONSTRAINT "scope_collection_batch_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_collection_batch" ADD CONSTRAINT "scope_collection_batch_session_fk" FOREIGN KEY ("session_id","project_id") REFERENCES "public"."agent_session"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_project_id_status_idx" ON "agent_session" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "agent_session_project_id_last_heartbeat_at_idx" ON "agent_session" USING btree ("project_id","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "agent_session_user_id_idx" ON "agent_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_session_key_id_idx" ON "agent_session" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "plan_project_id_status_idx" ON "plan" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "task_plan_id_position_idx" ON "task" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "task_project_id_status_idx" ON "task" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "task_claimed_by_session_id_idx" ON "task" USING btree ("claimed_by_session_id") WHERE "task"."claimed_by_session_id" is not null;--> statement-breakpoint
CREATE INDEX "task_project_id_lease_expires_at_idx" ON "task" USING btree ("project_id","lease_expires_at") WHERE "task"."lease_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "event_project_id_seq_idx" ON "event" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "event_project_id_writer_xid_seq_idx" ON "event" USING btree ("project_id","writer_xid","seq");--> statement-breakpoint
CREATE INDEX "event_plan_id_seq_idx" ON "event" USING btree ("plan_id","seq");--> statement-breakpoint
CREATE INDEX "event_task_id_seq_idx" ON "event" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "event_session_id_seq_idx" ON "event" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "event_actor_session_id_seq_idx" ON "event" USING btree ("actor_session_id","seq");--> statement-breakpoint
CREATE INDEX "scope_project_id_idx" ON "scope" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_coordination_swept_at_idx" ON "project" USING btree ("coordination_swept_at" NULLS FIRST,"id");