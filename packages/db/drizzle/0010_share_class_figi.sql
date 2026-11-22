CREATE TYPE "public"."mapping_status" AS ENUM('resolved', 'ambiguous', 'unmatched', 'no_isin');--> statement-breakpoint
CREATE TABLE "exchange_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"symbol" text NOT NULL,
	"exchange" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"isin" text,
	"currency" text,
	"status" "mapping_status" NOT NULL,
	"security_id" uuid,
	"share_classes" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "securities" ALTER COLUMN "figi" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "securities" ADD COLUMN "share_class_figi" text;--> statement-breakpoint
UPDATE "securities" s SET "share_class_figi" = m.sc FROM (SELECT DISTINCT ON (security_id) security_id, candidates->0->>'shareClassFIGI' AS sc FROM "figi_mappings" WHERE security_id IS NOT NULL ORDER BY security_id) m WHERE m.security_id = s.id AND m.sc IS NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_listings" ADD CONSTRAINT "exchange_listings_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_listings_identity" ON "exchange_listings" USING btree ("source","symbol");--> statement-breakpoint
ALTER TABLE "securities" ADD CONSTRAINT "securities_share_class_figi_unique" UNIQUE("share_class_figi");