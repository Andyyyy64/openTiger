import { pgTable, uuid, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { runs } from "../schema";

// TigerResearch plugin tables
export const tigerResearchJobs = pgTable("research_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  query: text("query").notNull(),
  qualityProfile: text("quality_profile").default("high_precision").notNull(),
  status: text("status").default("queued").notNull(), // queued/running/blocked/done/failed/cancelled
  latestReportId: uuid("latest_report_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tigerResearchClaims = pgTable("research_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .references(() => tigerResearchJobs.id)
    .notNull(),
  claimText: text("claim_text").notNull(),
  stance: text("stance").default("provisional").notNull(), // provisional/confirmed/refuted
  confidence: integer("confidence").default(0).notNull(), // 0..100
  originRunId: uuid("origin_run_id").references(() => runs.id),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tigerResearchEvidence = pgTable("research_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .references(() => tigerResearchJobs.id)
    .notNull(),
  claimId: uuid("claim_id").references(() => tigerResearchClaims.id),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
  snippet: text("snippet"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  reliability: integer("reliability").default(0).notNull(), // 0..100
  stance: text("stance").default("supporting").notNull(), // supporting/contradicting/neutral
  originRunId: uuid("origin_run_id").references(() => runs.id),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tigerResearchReports = pgTable("research_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .references(() => tigerResearchJobs.id)
    .notNull(),
  summary: text("summary").notNull(),
  findings: jsonb("findings"),
  limitations: text("limitations"),
  confidence: integer("confidence").default(0).notNull(), // 0..100
  originRunId: uuid("origin_run_id").references(() => runs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TigerResearchJobRecord = typeof tigerResearchJobs.$inferSelect;
export type NewTigerResearchJobRecord = typeof tigerResearchJobs.$inferInsert;

export type TigerResearchClaimRecord = typeof tigerResearchClaims.$inferSelect;
export type NewTigerResearchClaimRecord = typeof tigerResearchClaims.$inferInsert;

export type TigerResearchEvidenceRecord = typeof tigerResearchEvidence.$inferSelect;
export type NewTigerResearchEvidenceRecord = typeof tigerResearchEvidence.$inferInsert;

export type TigerResearchReportRecord = typeof tigerResearchReports.$inferSelect;
export type NewTigerResearchReportRecord = typeof tigerResearchReports.$inferInsert;
