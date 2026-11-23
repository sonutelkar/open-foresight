ALTER TABLE "report_discovery_attempts" DROP CONSTRAINT "report_discovery_attempts_llm_call_id_llm_calls_id_fk";
--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" DROP COLUMN "llm_call_id";