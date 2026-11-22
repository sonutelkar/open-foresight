CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_kind" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"issuer_key" text NOT NULL,
	"available_on" date NOT NULL,
	"section" text NOT NULL,
	"ordinal" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"index_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"provider" text,
	"purpose" text NOT NULL,
	"input_count" integer NOT NULL,
	"input_hash" text NOT NULL,
	"tokens" integer,
	"cost" numeric,
	"latency_ms" integer,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_identity" ON "document_chunks" USING btree ("doc_kind","doc_id","index_version","ordinal");--> statement-breakpoint
CREATE INDEX "document_chunks_issuer" ON "document_chunks" USING btree ("index_version","issuer_key","available_on");
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED;
--> statement-breakpoint
CREATE INDEX "document_chunks_tsv" ON "document_chunks" USING gin ("tsv");
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_offsets" CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset");
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_doc_kind" CHECK ("doc_kind" IN ('sec_filing', 'esef_filing'));
--> statement-breakpoint
CREATE TRIGGER immutable_document_chunks BEFORE UPDATE OR DELETE OR TRUNCATE ON document_chunks FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_embedding_batches BEFORE UPDATE OR DELETE OR TRUNCATE ON embedding_batches FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
