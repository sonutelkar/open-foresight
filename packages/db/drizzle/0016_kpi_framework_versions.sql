CREATE TABLE "kpi_framework_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_draft_id" uuid NOT NULL,
	"framework" jsonb NOT NULL,
	"exclusions" jsonb NOT NULL,
	"edited" boolean NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kpi_framework_versions" ADD CONSTRAINT "kpi_framework_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_framework_versions" ADD CONSTRAINT "kpi_framework_versions_source_draft_id_kpi_framework_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."kpi_framework_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_framework_versions_run_version" ON "kpi_framework_versions" USING btree ("run_id","version");--> statement-breakpoint
ALTER TABLE "kpi_framework_versions" ADD CONSTRAINT "kpi_framework_versions_version_positive" CHECK ("version" >= 1);
--> statement-breakpoint
ALTER TABLE "kpi_framework_versions" ADD CONSTRAINT "kpi_framework_versions_approver" CHECK (length(trim("approved_by")) > 0);
--> statement-breakpoint
CREATE TRIGGER immutable_kpi_framework_versions BEFORE UPDATE OR DELETE OR TRUNCATE ON kpi_framework_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
