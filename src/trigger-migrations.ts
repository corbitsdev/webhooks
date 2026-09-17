// Package-owned migrations for `@corbits/webhook`'s trigger table.
// Mount + migrations is the entire install story for this half of the
// package, mirroring `@corbits/mailbox`'s own `migrations.ts`: its own
// schema, its own ledger table, its own advisory lock, so mounting
// never collides with (or depends on) the host's own migration
// bookkeeping or drizzle journal.
import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const SCHEMA = "webhook_trigger";
const LEDGER_TABLE = "webhook_trigger_migrations";

// A fixed, package-specific advisory-lock key so several host
// instances booting at once serialize here instead of racing the same
// CREATE TABLE.
const LOCK_KEY = 0x7765_6268; // "web" in ASCII, truncated to fit an int4

export type WebhookTriggerMigration = {
  id: string;
  statements: SQL[];
};

export const WEBHOOK_TRIGGER_MIGRATIONS: WebhookTriggerMigration[] = [
  {
    id: "0001_webhook_trigger",
    statements: [
      sql`CREATE SCHEMA IF NOT EXISTS "webhook_trigger"`,
      sql`CREATE TABLE IF NOT EXISTS "webhook_trigger"."webhook_trigger" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "workflow_definition_id" text NOT NULL,
        "input_template" text NOT NULL,
        "secret" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "created_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_fired_at" timestamptz
      )`,
      sql`CREATE INDEX IF NOT EXISTS "webhook_trigger_tenant_id_idx"
        ON "webhook_trigger"."webhook_trigger" ("tenant_id")`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "webhook_trigger_tenant_definition_name_unique"
        ON "webhook_trigger"."webhook_trigger" ("tenant_id", "workflow_definition_id", "name")`,
    ],
  },
];

export type ApplyWebhookTriggerMigrationsReport = {
  applied: string[];
  skipped: string[];
};

/**
 * Applies `WEBHOOK_TRIGGER_MIGRATIONS` against `db`, idempotently: a
 * migration already recorded in the ledger is skipped, never re-run.
 * Serialized across concurrent host replicas via a session-level
 * Postgres advisory lock, released whether the run succeeds or throws.
 */
export async function applyWebhookTriggerMigrations(
  db: PostgresJsDatabase,
): Promise<ApplyWebhookTriggerMigrationsReport> {
  const applied: string[] = [];
  const skipped: string[] = [];

  await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY})`);
  try {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.raw(`"${SCHEMA}"`)}`);
    await db.execute(
      sql`CREATE TABLE IF NOT EXISTS ${sql.raw(`"${SCHEMA}"."${LEDGER_TABLE}"`)} (
        "id" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );

    for (const migration of WEBHOOK_TRIGGER_MIGRATIONS) {
      const already = await db.execute(
        sql`SELECT 1 FROM ${sql.raw(`"${SCHEMA}"."${LEDGER_TABLE}"`)} WHERE "id" = ${migration.id}`,
      );
      if (already.length > 0) {
        skipped.push(migration.id);
        continue;
      }

      await db.transaction(async (tx) => {
        for (const statement of migration.statements) {
          await tx.execute(statement);
        }
        await tx.execute(
          sql`INSERT INTO ${sql.raw(`"${SCHEMA}"."${LEDGER_TABLE}"`)} ("id") VALUES (${migration.id})`,
        );
      });
      applied.push(migration.id);
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY})`);
  }

  return { applied, skipped };
}
