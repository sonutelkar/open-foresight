CREATE TABLE "sec_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"cik" text NOT NULL,
	"accession" text NOT NULL,
	"taxonomy" text NOT NULL,
	"concept" text NOT NULL,
	"unit" text NOT NULL,
	"value" numeric NOT NULL,
	"period_start" date,
	"period_end" date NOT NULL,
	"filed_at" date NOT NULL,
	"form" text NOT NULL,
	"raw" jsonb NOT NULL,
	"source_id" uuid NOT NULL,
	"source_pointer" text NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sec_facts_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sec_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cik" text NOT NULL,
	"accession" text NOT NULL,
	"form" text NOT NULL,
	"filed_at" date NOT NULL,
	"primary_document" text NOT NULL,
	"submission_source_id" uuid NOT NULL,
	"document_source_id" uuid NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sec_source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"transport_url" text NOT NULL,
	"sha256" text NOT NULL,
	"body" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sec_facts" ADD CONSTRAINT "sec_facts_source_id_sec_source_documents_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sec_source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sec_filings" ADD CONSTRAINT "sec_filings_submission_source_id_sec_source_documents_id_fk" FOREIGN KEY ("submission_source_id") REFERENCES "public"."sec_source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sec_filings" ADD CONSTRAINT "sec_filings_document_source_id_sec_source_documents_id_fk" FOREIGN KEY ("document_source_id") REFERENCES "public"."sec_source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sec_filing_version" ON "sec_filings" USING btree ("cik","accession","submission_source_id","document_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sec_source_documents_version" ON "sec_source_documents" USING btree ("url","transport_url","sha256");