CREATE TABLE "research_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"claim_text" text NOT NULL,
	"stance" text DEFAULT 'provisional' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"origin_run_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"claim_id" uuid,
	"source_url" text,
	"source_title" text,
	"snippet" text,
	"published_at" timestamp with time zone,
	"reliability" integer DEFAULT 0 NOT NULL,
	"stance" text DEFAULT 'supporting' NOT NULL,
	"origin_run_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query" text NOT NULL,
	"quality_profile" text DEFAULT 'high_precision' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"latest_report_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"findings" jsonb,
	"limitations" text,
	"confidence" integer DEFAULT 0 NOT NULL,
	"origin_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "research_claims" ADD CONSTRAINT "research_claims_job_id_research_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."research_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_claims" ADD CONSTRAINT "research_claims_origin_run_id_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_evidence" ADD CONSTRAINT "research_evidence_job_id_research_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."research_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_evidence" ADD CONSTRAINT "research_evidence_claim_id_research_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."research_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_evidence" ADD CONSTRAINT "research_evidence_origin_run_id_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_job_id_research_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."research_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_reports" ADD CONSTRAINT "research_reports_origin_run_id_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;