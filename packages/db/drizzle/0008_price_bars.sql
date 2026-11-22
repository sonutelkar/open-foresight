CREATE TABLE "price_bars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"open" numeric,
	"high" numeric,
	"low" numeric,
	"close" numeric NOT NULL,
	"adjusted_close" numeric,
	"volume" numeric,
	"content_hash" text NOT NULL,
	"raw" jsonb NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "price_bars_version" ON "price_bars" USING btree ("source","symbol","date","content_hash");--> statement-breakpoint
CREATE INDEX "price_bars_lookup" ON "price_bars" USING btree ("symbol","date");