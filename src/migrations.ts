import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DBConfig } from "@intx/db";
import postgres from "postgres";

// The packed layout keeps <pkg>/migrations next to <pkg>/dist and <pkg>/src.
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Applies the shipped SQL idempotently, inside one advisory-locked
 * transaction so concurrent hub replicas cannot race the same DDL. `schema`
 * is where the host's Interchange tables live, as passed to Interchange's
 * `runMigrations`; the `credential_id` FK is pointed at its `credential` table.
 * Every file re-runs on every boot, with no record of what already ran, so
 * each migration must be idempotent.
 */
export async function runWebhookMigrations(
  config: DBConfig,
  options: { schema: string },
): Promise<void> {
  if (options.schema.length === 0) {
    throw new Error("runWebhookMigrations: schema name must not be empty");
  }
  const schemaIdent = quoteIdentifier(options.schema);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `runWebhookMigrations: no .sql files found in ${MIGRATIONS_DIR}`,
    );
  }
  const statements: string[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of raw
      .replace(/"public"\.(?=")/g, `${schemaIdent}.`)
      .split("--> statement-breakpoint")) {
      if (stmt.trim().length > 0) statements.push(stmt);
    }
  }

  const client = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ?? false,
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('corbits_webhooks'))`,
      );
      for (const stmt of statements) await tx.unsafe(stmt);
    });
  } catch (error) {
    throw new Error(
      `@corbits/webhooks migration failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}
