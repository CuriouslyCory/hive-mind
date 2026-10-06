CREATE TABLE "adr" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" text NOT NULL,
	"slug" text NOT NULL,
	"path" text,
	"content_sha256" text,
	"commit_sha" text,
	"synced_at" timestamp with time zone,
	"reserved_title" text,
	"reserved_slug" text,
	"git_branch" text,
	"reserved_by_kind" text,
	"reserved_by_user_id" uuid,
	"reserved_by_key_id" uuid,
	"reserved_session_id" uuid,
	"creation_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adr_project_id_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "adr_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "adr_number_check" CHECK (number between 1 and 9999),
	CONSTRAINT "adr_state_check" CHECK (state in ('reserved', 'published', 'removed')),
	CONSTRAINT "adr_slug_check" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "adr_copy_check" CHECK ((state = 'reserved' and path is null and content_sha256 is null and commit_sha is null and synced_at is null) or (state in ('published', 'removed') and path is not null and content_sha256 is not null and commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' and synced_at is not null)),
	CONSTRAINT "adr_reservation_check" CHECK ((reserved_by_kind is null and reserved_by_user_id is null and reserved_by_key_id is null and reserved_title is null and reserved_slug is null and git_branch is null and reserved_session_id is null and creation_fingerprint is null) or (reserved_title is not null and reserved_slug is not null and creation_fingerprint is not null and ((reserved_by_kind = 'user' and reserved_by_user_id is not null and reserved_by_key_id is null) or (reserved_by_kind = 'project_key' and reserved_by_key_id is not null and reserved_by_user_id is null)))),
	CONSTRAINT "adr_unreserved_check" CHECK (reserved_by_kind is not null or state <> 'reserved'),
	CONSTRAINT "adr_reserved_title_check" CHECK (reserved_title is null or char_length(reserved_title) between 1 and 200),
	CONSTRAINT "adr_creation_fingerprint_check" CHECK (creation_fingerprint is null or creation_fingerprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "adr_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"content_md" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"date" date NOT NULL,
	"supersedes" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adr_content_project_id_content_sha256_unique" UNIQUE("project_id","content_sha256"),
	CONSTRAINT "adr_content_sha256_check" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "adr_content_status_check" CHECK (status in ('proposed', 'accepted', 'superseded', 'deprecated')),
	CONSTRAINT "adr_content_title_check" CHECK (title <> ''),
	CONSTRAINT "adr_content_size_check" CHECK (octet_length(content_md) <= 65536),
	CONSTRAINT "adr_content_supersedes_check" CHECK (0 < all (supersedes) and 9999 >= all (supersedes))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "next_adr_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "adr_synced_commit_sha" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "adr_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "adr_synced_by_kind" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "adr_synced_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "adr_synced_by_key_id" uuid;--> statement-breakpoint
ALTER TABLE "adr" ADD CONSTRAINT "adr_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adr" ADD CONSTRAINT "adr_reserved_by_user_id_user_id_fk" FOREIGN KEY ("reserved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adr" ADD CONSTRAINT "adr_content_sha256_fk" FOREIGN KEY ("project_id","content_sha256") REFERENCES "public"."adr_content"("project_id","content_sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adr" ADD CONSTRAINT "adr_reserved_session_fk" FOREIGN KEY ("reserved_session_id","project_id") REFERENCES "public"."agent_session"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adr_content" ADD CONSTRAINT "adr_content_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_adr_synced_by_user_id_user_id_fk" FOREIGN KEY ("adr_synced_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_next_adr_number_check" CHECK (next_adr_number >= 1);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_adr_synced_check" CHECK ((adr_synced_commit_sha is null and adr_synced_at is null and adr_synced_by_kind is null and adr_synced_by_user_id is null and adr_synced_by_key_id is null) or (adr_synced_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' and adr_synced_at is not null and ((adr_synced_by_kind = 'user' and adr_synced_by_user_id is not null and adr_synced_by_key_id is null) or (adr_synced_by_kind = 'project_key' and adr_synced_by_key_id is not null and adr_synced_by_user_id is null))));