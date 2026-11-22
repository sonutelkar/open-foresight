CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"currency" text NOT NULL,
	"date" date NOT NULL,
	"per_eur" numeric NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_version" ON "fx_rates" USING btree ("source","currency","date","per_eur");