ALTER TABLE "report_discovery_attempts" ADD COLUMN "prompt_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "zdr" boolean;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "params" jsonb;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "response" jsonb;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "tokens" jsonb;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "cost" numeric;--> statement-breakpoint
ALTER TABLE "report_discovery_attempts" ADD COLUMN "latency_ms" integer;