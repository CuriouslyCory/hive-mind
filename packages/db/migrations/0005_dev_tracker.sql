CREATE TABLE "tracker_backlog_issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_number" integer NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"state" text DEFAULT 'open' NOT NULL,
	"github_updated_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"phase_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_backlog_issue_issue_number_unique" UNIQUE("issue_number"),
	CONSTRAINT "tracker_backlog_issue_state_check" CHECK (state in ('open', 'closed')),
	CONSTRAINT "tracker_backlog_issue_number_check" CHECK ("tracker_backlog_issue"."issue_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "tracker_backlog_phase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_backlog_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"prompt" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_backlog_step_issue_id_key_unique" UNIQUE("issue_id","key")
);
--> statement-breakpoint
CREATE TABLE "tracker_blog_idea" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"pitch" text NOT NULL,
	"notes" text,
	"pr_numbers" integer[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'idea' NOT NULL,
	"published_at" date,
	"published_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_blog_idea_status_check" CHECK (status in ('idea', 'draft', 'published')),
	CONSTRAINT "tracker_blog_idea_published_at_check" CHECK ((status = 'published') = (published_at is not null)),
	CONSTRAINT "tracker_blog_idea_published_url_check" CHECK (published_url is null or status = 'published')
);
--> statement-breakpoint
CREATE TABLE "tracker_changelog_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"pr_numbers" integer[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_scan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"through_at" timestamp with time zone NOT NULL,
	"through_sha" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_scan_kind_check" CHECK (kind in ('git_history', 'backlog')),
	CONSTRAINT "tracker_scan_through_sha_check" CHECK ((kind = 'git_history' and through_sha ~ '^[0-9a-f]{40}$') or (kind = 'backlog' and through_sha is null))
);
--> statement-breakpoint
ALTER TABLE "tracker_backlog_issue" ADD CONSTRAINT "tracker_backlog_issue_phase_id_tracker_backlog_phase_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."tracker_backlog_phase"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_backlog_step" ADD CONSTRAINT "tracker_backlog_step_issue_id_tracker_backlog_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."tracker_backlog_issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracker_backlog_issue_phase_id_sort_order_idx" ON "tracker_backlog_issue" USING btree ("phase_id","sort_order");--> statement-breakpoint
CREATE INDEX "tracker_backlog_step_issue_id_sort_order_idx" ON "tracker_backlog_step" USING btree ("issue_id","sort_order");--> statement-breakpoint
CREATE INDEX "tracker_changelog_entry_date_idx" ON "tracker_changelog_entry" USING btree ("date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tracker_scan_kind_completed_at_idx" ON "tracker_scan" USING btree ("kind","completed_at" DESC NULLS LAST);