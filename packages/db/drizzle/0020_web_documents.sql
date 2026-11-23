CREATE TABLE "report_discovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer_key" text NOT NULL,
	"entity_name" text NOT NULL,
	"outcome" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"rejected" jsonb NOT NULL,
	"model" text,
	"llm_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_web_documents" (
	"snapshot_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "snapshot_web_documents_snapshot_id_document_id_pk" PRIMARY KEY("snapshot_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "web_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"raw_sha256" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"text" text NOT NULL,
	"headings" jsonb NOT NULL,
	"extractor" text NOT NULL,
	"issuer_key" text NOT NULL,
	"entity_name" text NOT NULL,
	"period_end" date,
	"fetched_at" timestamp with time zone NOT NULL,
	"available_on" date NOT NULL,
	"attempt_id" uuid
);
--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD CONSTRAINT "report_discovery_attempts_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_web_documents" ADD CONSTRAINT "snapshot_web_documents_snapshot_id_data_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."data_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_web_documents" ADD CONSTRAINT "snapshot_web_documents_document_id_web_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."web_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_discovery_issuer" ON "report_discovery_attempts" USING btree ("issuer_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "web_documents_version" ON "web_documents" USING btree ("url","raw_sha256");--> statement-breakpoint
CREATE INDEX "web_documents_issuer" ON "web_documents" USING btree ("issuer_key");