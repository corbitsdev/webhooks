CREATE SCHEMA IF NOT EXISTS "webhooks";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhooks"."replay" (
  "credential_id" text NOT NULL REFERENCES "public"."credential"("id") ON DELETE CASCADE,
  "nonce" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("credential_id", "nonce")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhooks_replay_expires_at_idx" ON "webhooks"."replay" ("expires_at");
