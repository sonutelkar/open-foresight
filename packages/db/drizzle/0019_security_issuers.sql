CREATE TABLE "security_issuers" (
	"security_id" uuid NOT NULL,
	"issuer_key" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_issuers_security_id_issuer_key_pk" PRIMARY KEY("security_id","issuer_key")
);
--> statement-breakpoint
ALTER TABLE "security_issuers" ADD CONSTRAINT "security_issuers_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;