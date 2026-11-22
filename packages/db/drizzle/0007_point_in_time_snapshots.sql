CREATE TABLE "data_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingested_cutoff" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_facts" (
	"snapshot_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	CONSTRAINT "snapshot_facts_snapshot_id_fact_id_pk" PRIMARY KEY("snapshot_id","fact_id")
);
--> statement-breakpoint
CREATE TABLE "snapshot_filings" (
	"snapshot_id" uuid NOT NULL,
	"filing_id" uuid NOT NULL,
	CONSTRAINT "snapshot_filings_snapshot_id_filing_id_pk" PRIMARY KEY("snapshot_id","filing_id")
);
--> statement-breakpoint
ALTER TABLE "snapshot_facts" ADD CONSTRAINT "snapshot_facts_snapshot_id_data_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."data_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_facts" ADD CONSTRAINT "snapshot_facts_fact_id_sec_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."sec_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_filings" ADD CONSTRAINT "snapshot_filings_snapshot_id_data_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."data_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_filings" ADD CONSTRAINT "snapshot_filings_filing_id_sec_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."sec_filings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER immutable_data_snapshots BEFORE UPDATE OR DELETE OR TRUNCATE ON data_snapshots FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_snapshot_filings BEFORE UPDATE OR DELETE OR TRUNCATE ON snapshot_filings FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_snapshot_facts BEFORE UPDATE OR DELETE OR TRUNCATE ON snapshot_facts FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
