ALTER TABLE "kpi_scores" ADD COLUMN "route" text;--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD COLUMN "jev_answer" jsonb;--> statement-breakpoint
ALTER TABLE "kpi_scores" ADD CONSTRAINT "kpi_scores_route" CHECK ("route" IS NULL OR ("route" IN ('jev', 'luna-fallback') AND "jev_answer" IS NOT NULL));
