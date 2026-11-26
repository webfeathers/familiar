CREATE TABLE "provider_spend_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"amount_usd" real NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "provider_spend_reservations_reserved_at_idx" ON "provider_spend_reservations" USING btree ("reserved_at");