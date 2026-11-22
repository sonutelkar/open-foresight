CREATE TABLE "esef_documents" (
	"filing_id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"body" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esef_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fxo_id" text NOT NULL,
	"lei" text NOT NULL,
	"entity_name" text NOT NULL,
	"country" text NOT NULL,
	"period_end" date NOT NULL,
	"available_on" date NOT NULL,
	"available_source" text NOT NULL,
	"published_at" timestamp with time zone,
	"date_added_at" timestamp with time zone NOT NULL,
	"report_url" text NOT NULL,
	"package_sha256" text NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lei_isins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lei" text NOT NULL,
	"isin" text NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_esef_filings" (
	"snapshot_id" uuid NOT NULL,
	"filing_id" uuid NOT NULL,
	CONSTRAINT "snapshot_esef_filings_snapshot_id_filing_id_pk" PRIMARY KEY("snapshot_id","filing_id")
);
--> statement-breakpoint
ALTER TABLE "esef_documents" ADD CONSTRAINT "esef_documents_filing_id_esef_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."esef_filings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_esef_filings" ADD CONSTRAINT "snapshot_esef_filings_snapshot_id_data_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."data_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_esef_filings" ADD CONSTRAINT "snapshot_esef_filings_filing_id_esef_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."esef_filings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "esef_filings_version" ON "esef_filings" USING btree ("fxo_id","package_sha256");--> statement-breakpoint
CREATE INDEX "esef_filings_lei" ON "esef_filings" USING btree ("lei");--> statement-breakpoint
CREATE UNIQUE INDEX "lei_isins_identity" ON "lei_isins" USING btree ("lei","isin","source");--> statement-breakpoint
CREATE INDEX "lei_isins_isin" ON "lei_isins" USING btree ("isin");--> statement-breakpoint
CREATE TRIGGER immutable_snapshot_esef_filings BEFORE UPDATE OR DELETE OR TRUNCATE ON snapshot_esef_filings FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
