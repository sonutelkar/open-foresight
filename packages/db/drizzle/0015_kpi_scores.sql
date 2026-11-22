CREATE TABLE "kpi_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"framework_draft_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"kpi_id" text NOT NULL,
	"as_of" date NOT NULL,
	"attempt" integer NOT NULL,
	"method" text NOT NULL,
	"prompt_version" text,
	"llm_call_id" uuid,
	"level" text NOT NULL,
	"extracted_value" numeric,
	"unit" text,
	"quant_value" numeric,
	"quant_inputs" jsonb,
	"citations" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"conflicts" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"raw" jsonb,
	"confidence" numeric NOT NULL,
	"valid" boolean NOT NULL,
	"errors" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_framework_draft_id_kpi_framework_drafts_id_fk" FOREIGN KEY ("framework_draft_id") REFERENCES "public"."kpi_framework_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_snapshot_id_data_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."data_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_scores_attempt" ON "kpi_scores" USING btree ("run_id","security_id","kpi_id","attempt");--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_level" CHECK ("level" IN ('0', '1', '2', '3', '4', 'unknown'));
--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_method" CHECK ("method" IN ('quant', 'extract_then_quant', 'judgement'));
--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_unknown_when_invalid" CHECK ("valid" OR "level" = 'unknown');
--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_confidence" CHECK ("confidence" >= 0 AND "confidence" <= 1);
--> statement-breakpoint
CREATE TRIGGER immutable_kpi_scores BEFORE UPDATE OR DELETE OR TRUNCATE ON kpi_scores FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
