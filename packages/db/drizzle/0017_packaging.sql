CREATE TABLE "basket_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"basket_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"score" numeric NOT NULL,
	"confidence" numeric NOT NULL,
	"weight_percent" numeric NOT NULL,
	"at_cap" boolean NOT NULL,
	"unknown_weight" numeric NOT NULL,
	"cap_adjustment" numeric NOT NULL,
	"contributions" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baskets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"unknown_mode" text NOT NULL,
	"rules" jsonb NOT NULL,
	"funnel" jsonb NOT NULL,
	"cap" jsonb NOT NULL,
	"excluded" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baskets_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "run_universe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"name" text,
	"included" boolean NOT NULL,
	"reasons" jsonb NOT NULL,
	"region" text,
	"market_cap_usd" numeric,
	"adv_usd" numeric,
	"security_id" uuid,
	"coverage" text,
	"ciks" jsonb,
	"issuer_keys" jsonb
);
--> statement-breakpoint
ALTER TABLE "basket_members" ADD CONSTRAINT "basket_members_basket_id_baskets_id_fk" FOREIGN KEY ("basket_id") REFERENCES "public"."baskets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basket_members" ADD CONSTRAINT "basket_members_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_framework_version_id_kpi_framework_versions_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."kpi_framework_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_universe" ADD CONSTRAINT "run_universe_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_universe" ADD CONSTRAINT "run_universe_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "basket_members_security" ON "basket_members" USING btree ("basket_id","security_id");--> statement-breakpoint
CREATE UNIQUE INDEX "basket_members_rank" ON "basket_members" USING btree ("basket_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "run_universe_symbol" ON "run_universe" USING btree ("run_id","symbol");
--> statement-breakpoint
-- Phase 1 has no Reviewer or gate 2, so analysing may go straight to packaging. The gate checks for awaiting_kpi_approval and awaiting_flag_review are unchanged.
CREATE OR REPLACE FUNCTION check_run_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'new runs must start in draft'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  allowed := NEW.status IN ('failed', 'cancelled') OR CASE OLD.status
    WHEN 'draft' THEN NEW.status = 'universe_built'
    WHEN 'universe_built' THEN NEW.status = 'designing'
    WHEN 'designing' THEN NEW.status = 'awaiting_kpi_approval'
    WHEN 'awaiting_kpi_approval' THEN NEW.status = 'prescreening'
    WHEN 'prescreening' THEN NEW.status = 'analysing'
    WHEN 'analysing' THEN NEW.status IN ('reviewing', 'packaging')
    WHEN 'reviewing' THEN NEW.status = 'awaiting_flag_review'
    WHEN 'awaiting_flag_review' THEN NEW.status = 'packaging'
    WHEN 'packaging' THEN NEW.status = 'done'
    ELSE false END;
  IF NOT allowed OR OLD.status IN ('done', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid run transition from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('awaiting_kpi_approval', 'awaiting_flag_review') AND NEW.status NOT IN ('failed', 'cancelled') AND NOT EXISTS (
    SELECT 1 FROM human_decisions
    WHERE run_id = OLD.id AND stage = OLD.status AND action = 'approve'
      AND xmin::text = pg_current_xact_id()::text
  ) THEN
    RAISE EXCEPTION 'gate approval must be recorded in the same transaction';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_provisional" CHECK ("status" = 'provisional');
--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_unknown_mode" CHECK ("unknown_mode" IN ('strict', 'lenient'));
--> statement-breakpoint
ALTER TABLE "basket_members" ADD CONSTRAINT "basket_members_weight" CHECK ("weight_percent" > 0 AND "weight_percent" <= 100);
--> statement-breakpoint
ALTER TABLE "basket_members" ADD CONSTRAINT "basket_members_score" CHECK ("score" > 0 AND "score" <= 1);
--> statement-breakpoint
ALTER TABLE "basket_members" ADD CONSTRAINT "basket_members_rank" CHECK ("rank" >= 1);
--> statement-breakpoint
ALTER TABLE "run_universe" ADD CONSTRAINT "run_universe_coverage" CHECK ("coverage" IS NULL OR "coverage" IN ('sec', 'esef', 'none'));
--> statement-breakpoint
CREATE TRIGGER immutable_baskets BEFORE UPDATE OR DELETE OR TRUNCATE ON baskets FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_basket_members BEFORE UPDATE OR DELETE OR TRUNCATE ON basket_members FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
