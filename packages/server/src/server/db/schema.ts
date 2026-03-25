import { boolean, index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import type { AgentPersistenceHandle, AgentRuntimeInfo, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

export const projects = pgTable("projects", {
  projectId: text("project_id").primaryKey(),
  rootPath: text("root_path").notNull(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  archivedAt: text("archived_at"),
});

export const workspaces = pgTable(
  "workspaces",
  {
    workspaceId: text("workspace_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId, { onDelete: "restrict", onUpdate: "cascade" }),
    cwd: text("cwd").notNull(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (table) => [index("workspaces_project_id_idx").on(table.projectId)],
);

export const agentSnapshots = pgTable("agent_snapshots", {
  agentId: text("agent_id").primaryKey(),
  provider: text("provider").notNull(),
  workspaceId: text("workspace_id").references(() => workspaces.workspaceId, {
    onDelete: "set null",
    onUpdate: "cascade",
  }),
  cwd: text("cwd").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastActivityAt: text("last_activity_at"),
  lastUserMessageAt: text("last_user_message_at"),
  title: text("title"),
  labels: jsonb("labels").$type<StoredAgentRecord["labels"]>().notNull(),
  lastStatus: text("last_status").notNull(),
  lastModeId: text("last_mode_id"),
  config: jsonb("config").$type<StoredAgentRecord["config"]>(),
  runtimeInfo: jsonb("runtime_info").$type<AgentRuntimeInfo>(),
  persistence: jsonb("persistence").$type<AgentPersistenceHandle>(),
  requiresAttention: boolean("requires_attention").notNull(),
  attentionReason: text("attention_reason"),
  attentionTimestamp: text("attention_timestamp"),
  internal: boolean("internal").notNull(),
  archivedAt: text("archived_at"),
});

export const agentTimelineRows = pgTable(
  "agent_timeline_rows",
  {
    agentId: text("agent_id").notNull(),
    seq: integer("seq").notNull(),
    committedAt: text("committed_at").notNull(),
    item: jsonb("item").$type<AgentTimelineItem>().notNull(),
    itemKind: text("item_kind"),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.seq], name: "agent_timeline_rows_pk" }),
  ],
);

export const paseoDbSchema = {
  projects,
  workspaces,
  agentSnapshots,
  agentTimelineRows,
};
