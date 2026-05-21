import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/pg-core";

export const debateStatusEnum = pgEnum("debate_status", [
  "queued",
  "framing",
  "researching",
  "debating",
  "judging",
  "complete",
  "failed",
  "partial"
]);

export const topicKindEnum = pgEnum("topic_kind", ["policy", "value", "empirical", "decision", "comparison"]);
export const sideEnum = pgEnum("perspective_side", ["pro", "con", "neutral"]);

export const debates = pgTable("debates", {
  id: varchar("id", { length: 48 }).primaryKey(),
  subject: text("subject").notNull(),
  context: text("context"),
  mode: varchar("mode", { length: 32 }).notNull().default("hybrid_council"),
  evidence: varchar("evidence", { length: 32 }).notNull().default("cited"),
  status: debateStatusEnum("status").notNull().default("queued"),
  resolution: text("resolution").notNull(),
  topicKind: topicKindEnum("topic_kind").notNull(),
  highStakes: jsonb("high_stakes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const debateRuns = pgTable("debate_runs", {
  id: varchar("id", { length: 48 }).primaryKey(),
  debateId: varchar("debate_id", { length: 48 })
    .notNull()
    .references(() => debates.id, { onDelete: "cascade" }),
  status: debateStatusEnum("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  trace: jsonb("trace").notNull().default([])
});

export const agentRuns = pgTable("agent_runs", {
  id: varchar("id", { length: 48 }).primaryKey(),
  runId: varchar("run_id", { length: 48 })
    .notNull()
    .references(() => debateRuns.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  side: sideEnum("side").notNull(),
  role: text("role").notNull(),
  model: text("model").notNull(),
  thesis: text("thesis").notNull(),
  metadata: jsonb("metadata").notNull().default({})
});

export const evidenceSources = pgTable(
  "evidence_sources",
  {
    id: varchar("id", { length: 48 }).primaryKey(),
    runId: varchar("run_id", { length: 48 })
      .notNull()
      .references(() => debateRuns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    publisher: text("publisher").notNull(),
    publishedAt: text("published_at"),
    snippet: text("snippet").notNull(),
    quality: varchar("quality", { length: 32 }).notNull(),
    retrievedVia: varchar("retrieved_via", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull()
  },
  (table) => ({
    uniqueRunUrl: uniqueIndex("evidence_sources_run_url_idx").on(table.runId, table.url)
  })
);

export const claims = pgTable("claims", {
  id: varchar("id", { length: 48 }).primaryKey(),
  runId: varchar("run_id", { length: 48 })
    .notNull()
    .references(() => debateRuns.id, { onDelete: "cascade" }),
  side: sideEnum("side").notNull(),
  text: text("text").notNull(),
  warrant: text("warrant").notNull(),
  evidenceSourceIds: jsonb("evidence_source_ids").notNull().default([]),
  confidence: doublePrecision("confidence").notNull()
});

export const argumentNodes = pgTable("argument_nodes", {
  id: varchar("id", { length: 64 }).primaryKey(),
  runId: varchar("run_id", { length: 48 })
    .notNull()
    .references(() => debateRuns.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 32 }).notNull(),
  side: sideEnum("side").notNull(),
  label: text("label").notNull(),
  detail: text("detail").notNull(),
  sourceId: varchar("source_id", { length: 48 })
});

export const roundTurns = pgTable("round_turns", {
  id: varchar("id", { length: 48 }).primaryKey(),
  runId: varchar("run_id", { length: 48 })
    .notNull()
    .references(() => debateRuns.id, { onDelete: "cascade" }),
  round: varchar("round", { length: 48 }).notNull(),
  agentId: varchar("agent_id", { length: 48 }).notNull(),
  agentName: text("agent_name").notNull(),
  side: sideEnum("side").notNull(),
  content: text("content").notNull(),
  claimIds: jsonb("claim_ids").notNull().default([]),
  sourceIds: jsonb("source_ids").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const scorecards = pgTable("scorecards", {
  id: varchar("id", { length: 48 }).primaryKey(),
  runId: varchar("run_id", { length: 48 })
    .notNull()
    .references(() => debateRuns.id, { onDelete: "cascade" }),
  recommendation: varchar("recommendation", { length: 48 }).notNull(),
  confidence: doublePrecision("confidence").notNull(),
  categories: jsonb("categories").notNull()
});

export const summaries = pgTable("summaries", {
  id: varchar("id", { length: 48 }).primaryKey(),
  runId: varchar("run_id", { length: 48 })
    .notNull()
    .references(() => debateRuns.id, { onDelete: "cascade" }),
  headline: text("headline").notNull(),
  recommendation: text("recommendation").notNull(),
  strongestPro: jsonb("strongest_pro").notNull().default([]),
  strongestCon: jsonb("strongest_con").notNull().default([]),
  unresolvedUncertainties: jsonb("unresolved_uncertainties").notNull().default([]),
  whatWouldChangeMind: jsonb("what_would_change_mind").notNull().default([]),
  confidence: doublePrecision("confidence").notNull(),
  highStakesDisclaimer: text("high_stakes_disclaimer")
});

export const modelSnapshots = pgTable("model_snapshots", {
  id: varchar("id", { length: 64 }).primaryKey(),
  runId: varchar("run_id", { length: 48 })
    .notNull()
    .references(() => debateRuns.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  model: text("model").notNull(),
  role: text("role").notNull(),
  configured: boolean("configured").notNull().default(false),
  latencyMs: integer("latency_ms"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  estimatedCostUsd: doublePrecision("estimated_cost_usd"),
  failure: text("failure")
});

export const productNotes = pgTable("product_notes", {
  id: varchar("id", { length: 64 }).primaryKey(),
  title: text("title").notNull(),
  mode: varchar("mode", { length: 48 }).notNull(),
  note: text("note").notNull(),
  priority: varchar("priority", { length: 32 }).notNull()
});

export const debateRecords = pgTable("debate_records", {
  id: varchar("id", { length: 48 }).primaryKey(),
  record: jsonb("record").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const userFeedback = pgTable("user_feedback", {
  id: varchar("id", { length: 48 }).primaryKey(),
  app: varchar("app", { length: 64 }).notNull(),
  message: text("message").notNull(),
  debateId: varchar("debate_id", { length: 48 }),
  pagePath: text("page_path"),
  userAgent: text("user_agent"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
