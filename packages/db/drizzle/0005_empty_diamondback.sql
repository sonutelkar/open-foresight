CREATE TABLE "figi_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"security_id" uuid,
	"candidates" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "figi_mappings_listing_id_unique" UNIQUE("listing_id")
);
--> statement-breakpoint
CREATE TABLE "sec_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cik" text NOT NULL,
	"ticker" text NOT NULL,
	"exchange" text NOT NULL,
	"name" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "securities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"figi" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "securities_figi_unique" UNIQUE("figi")
);
--> statement-breakpoint
ALTER TABLE "figi_mappings" ADD CONSTRAINT "figi_mappings_listing_id_sec_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."sec_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figi_mappings" ADD CONSTRAINT "figi_mappings_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sec_listings_identity" ON "sec_listings" USING btree ("cik","ticker","exchange");