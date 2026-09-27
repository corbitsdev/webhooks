import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runMigrations } from "@intx/db";
import postgres from "postgres";

import { runWebhookMigrations } from "../src/migrations.js";
import { harnessDbAvailable, harnessDbConfig } from "./helpers.js";

const describeIfDb = harnessDbAvailable() ? describe : describe.skip;

describeIfDb("runWebhookMigrations", () => {
  const admin = harnessDbAvailable()
    ? postgres({ ...harnessDbConfig(), max: 1, onnotice: () => undefined })
    : undefined;
  const target = harnessDbAvailable()
    ? {
        ...harnessDbConfig(),
        database: `webhooks_migrations_${randomUUID().slice(0, 8)}`,
      }
    : undefined;

  beforeAll(async () => {
    if (admin === undefined || target === undefined) return;
    await admin.unsafe(`CREATE DATABASE "${target.database}"`);
    await runMigrations(target, { schema: "public" });
  }, 120_000);

  afterAll(async () => {
    if (admin === undefined || target === undefined) return;
    await admin.unsafe(
      `DROP DATABASE IF EXISTS "${target.database}" WITH (FORCE)`,
    );
    await admin.end({ timeout: 5 });
  });

  test("three concurrent runners converge on one replay table", async () => {
    if (target === undefined) return;
    await Promise.all([
      runWebhookMigrations(target, { schema: "public" }),
      runWebhookMigrations(target, { schema: "public" }),
      runWebhookMigrations(target, { schema: "public" }),
    ]);

    const client = postgres({ ...target, max: 1 });
    try {
      const [fk] = await client`
        SELECT confrelid::regclass::text AS target
        FROM pg_constraint
        WHERE conrelid = 'webhooks.replay'::regclass AND contype = 'f'`;
      expect(fk?.["target"]).toBe("credential");
      const [index] = await client`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'webhooks' AND tablename = 'replay'
          AND indexname = 'webhooks_replay_expires_at_idx'`;
      expect(index).toBeDefined();
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
