CREATE TABLE "agent_snapshots" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"workspace_id" text,
	"cwd" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_activity_at" text,
	"last_user_message_at" text,
	"title" text,
	"labels" jsonb NOT NULL,
	"last_status" text NOT NULL,
	"last_mode_id" text,
	"config" jsonb,
	"runtime_info" jsonb,
	"persistence" jsonb,
	"requires_attention" boolean NOT NULL,
	"attention_reason" text,
	"attention_timestamp" text,
	"internal" boolean NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "agent_timeline_rows" (
	"agent_id" text NOT NULL,
	"seq" integer NOT NULL,
	"committed_at" text NOT NULL,
	"item" jsonb NOT NULL,
	"item_kind" text,
	CONSTRAINT "agent_timeline_rows_pk" PRIMARY KEY("agent_id","seq")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"root_path" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"cwd" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
ALTER TABLE "agent_snapshots" ADD CONSTRAINT "agent_snapshots_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "workspaces_project_id_idx" ON "workspaces" USING btree ("project_id");