CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"score_id" uuid NOT NULL,
	"llm_call_id" uuid NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"provider" text,
	"verdict" text NOT NULL,
	"issue" text NOT NULL,
	"note" text NOT NULL,
	"suggested_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_score_id_kpi_scores_id_fk" FOREIGN KEY ("score_id") REFERENCES "public"."kpi_scores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_score" ON "reviews" USING btree ("score_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_verdict" CHECK ("verdict" IN ('accept', 'retry', 'escalate'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_issue" CHECK ("issue" IN ('none', 'unsupported_level', 'wrong_entity', 'stale_evidence', 'talk_not_numbers', 'conflict', 'other'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_note" CHECK (char_length("note") <= 400);--> statement-breakpoint
CREATE TRIGGER immutable_reviews BEFORE UPDATE OR DELETE OR TRUNCATE ON reviews FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
