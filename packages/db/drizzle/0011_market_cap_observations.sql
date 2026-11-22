CREATE TABLE "market_cap_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	"source_symbol" text NOT NULL,
	"market_cap" numeric,
	"shares_outstanding" numeric,
	"price" numeric,
	"currency" text,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "market_cap_observations_lookup" ON "market_cap_observations" USING btree ("symbol","observed_at");--> statement-breakpoint
ALTER TABLE "market_cap_observations" ADD CONSTRAINT "market_cap_observations_has_value" CHECK ("market_cap" IS NOT NULL OR "shares_outstanding" IS NOT NULL);
