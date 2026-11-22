CREATE TABLE "kpi_framework_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"llm_call_id" uuid NOT NULL,
	"draft" jsonb NOT NULL,
	"errors" jsonb NOT NULL,
	"valid" boolean NOT NULL,
	"framework" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kpi_framework_drafts" ADD CONSTRAINT "kpi_framework_drafts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_framework_drafts" ADD CONSTRAINT "kpi_framework_drafts_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_framework_drafts_attempt" ON "kpi_framework_drafts" USING btree ("run_id","attempt");--> statement-breakpoint
ALTER TABLE "kpi_framework_drafts" ADD CONSTRAINT "kpi_framework_drafts_framework_when_valid" CHECK (("valid" AND "framework" IS NOT NULL) OR (NOT "valid" AND "framework" IS NULL));
--> statement-breakpoint
CREATE TRIGGER immutable_kpi_framework_drafts BEFORE UPDATE OR DELETE OR TRUNCATE ON kpi_framework_drafts FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
