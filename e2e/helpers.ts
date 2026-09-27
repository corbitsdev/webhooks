import { Hono } from "hono";
import { sql } from "drizzle-orm";
import {
  createDB,
  createPrincipalKeyStore,
  dropSchema,
  runMigrations,
  type DBConfig,
} from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { principal, tenant } from "@intx/db/schema";

import { createHookRoutes, type HookMailRouter } from "../src/index.js";

const PG_ENV = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"] as const;

/** Real-Postgres suites run when every libpq `PG_ENV` key is set and skip otherwise. */
export function harnessDbAvailable(): boolean {
  return PG_ENV.every((key) => process.env[key] !== undefined);
}

function requireEnv(key: (typeof PG_ENV)[number]): string {
  const value = process.env[key];
  if (value === undefined) throw new Error(`db-harness: ${key} is not set`);
  return value;
}

function harnessDbConfig(): DBConfig {
  return {
    host: requireEnv("PGHOST"),
    port: Number(requireEnv("PGPORT")),
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    database: requireEnv("PGDATABASE"),
  };
}

/** Migrating or truncating the schema outlasts bun's default 5s hook timeout. */
export const HARNESS_SETUP_TIMEOUT_MS = 120_000;

export type TestDb = {
  db: ReturnType<typeof createDB>["db"];
  /** Truncate every table so each test starts from an empty schema. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

/** A freshly migrated Interchange schema, truncated on `reset` and dropped on `close`. */
export async function createTestDb(): Promise<TestDb> {
  const config = harnessDbConfig();
  const schema = `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await runMigrations(config, { schema });
  } catch (error) {
    await dropSchema(config, { schema });
    throw error;
  }
  const handle = createDB({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    schema,
  });
  return {
    db: handle.db,
    reset: async () => {
      const tables = await handle.db.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = ${schema}`,
      );
      const targets = tables.map((t) => `"${schema}"."${t.tablename}"`);
      await handle.db.execute(
        sql.raw(`TRUNCATE ${targets.join(", ")} RESTART IDENTITY CASCADE`),
      );
    },
    close: async () => {
      await handle.close();
      await dropSchema(config, { schema });
    },
  };
}

export const testCredentialCipher = createEnvKeyCredentialCipher(
  new Uint8Array(32).fill(7),
);

/** A sidecar router that records every frame and routes all of them. */
export function recordingRouter() {
  const grants: Parameters<HookMailRouter["sendRunGrants"]>[] = [];
  const mail: Parameters<HookMailRouter["routeMail"]>[] = [];
  const router: HookMailRouter = {
    sendRunGrants: (...args) => {
      grants.push(args);
      return true;
    },
    routeMail: (...args) => {
      mail.push(args);
      return true;
    },
  };
  return { router, grants, mail };
}

/**
 * Mount `createHookRoutes` at `/api/hooks` on a bare host app with no session
 * or tenant middleware, as the README tells hosts to.
 */
export function mountHookRoutes(opts: {
  db: TestDb["db"];
  router: HookMailRouter;
}): Hono {
  const app = new Hono();
  app.route(
    "/api/hooks",
    createHookRoutes({
      db: opts.db,
      credentialCipher: testCredentialCipher,
      principalKeyStore: createPrincipalKeyStore({
        db: opts.db,
        cipher: testCredentialCipher,
      }),
      router: opts.router,
    }),
  );
  return app;
}

export async function seedTenant(
  db: TestDb["db"],
  id: string,
): Promise<void> {
  await db.insert(tenant).values({
    id,
    name: id,
    slug: id,
    domain: `${id}.example.test`,
  });
}

export async function seedUser(
  db: TestDb["db"],
  tenantId: string,
  id: string,
): Promise<void> {
  await db.insert(principal).values({
    id,
    tenantId,
    kind: "user",
    refId: id,
    status: "active",
  });
}
