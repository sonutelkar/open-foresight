CREATE TABLE "label_source_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"issuer_key" text NOT NULL,
	"entity_name" text NOT NULL,
	"outcome" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"rejected" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text,
	"provider" text,
	"zdr" boolean,
	"params" jsonb,
	"response" jsonb,
	"error" text,
	"tokens" jsonb,
	"cost" numeric,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "label_sources" (
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
	"fetched_at" timestamp with time zone NOT NULL,
	"attempt_id" uuid
);
--> statement-breakpoint
CREATE INDEX "label_source_attempts_subject" ON "label_source_attempts" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "label_sources_version" ON "label_sources" USING btree ("url","raw_sha256");