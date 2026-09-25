import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  asset,
  credential,
  grant,
  principal,
  provider,
  workflowDefinition,
  workflowDefinitionVersion,
  workflowRun,
} from "@intx/db/schema";
import { credentialAad, type GrantWalkSnapshot } from "@intx/types";

import {
  createTestDb,
  HARNESS_SETUP_TIMEOUT_MS,
  harnessDbAvailable,
  mountHookRoutes,
  recordingRouter,
  seedTenant,
  seedUser,
  testCredentialCipher,
  type TestDb,
} from "./helpers.js";

const TENANT = "tnt_e2e";
const CREATOR = "prn_creator";
const DEFINITION = "wfd_hook";
const DEPLOYMENT = "run_hook";
const ADDRESS = "run_hook@tnt_e2e.example.test";
const HOOK = "crd_hook";
const SECRET = "whsec_c2VjcmV0LWtleS1ieXRlcw==";

const SNAPSHOT: GrantWalkSnapshot = {
  perStep: [
    {
      stepId: "work",
      grants: ["tool:read_file"],
      grantEffects: { "tool:read_file": "allow" },
    },
  ],
  grantRequirements: [],
};

async function seedDeployment(db: TestDb["db"]): Promise<void> {
  await seedTenant(db, TENANT);
  await seedUser(db, TENANT, CREATOR);
  await db.insert(asset).values({
    id: "ast_hook",
    tenantId: TENANT,
    kind: "workflow",
    name: "my-workflow",
    creatorPrincipalId: CREATOR,
  });
  await db.insert(workflowDefinition).values({
    id: DEFINITION,
    tenantId: TENANT,
    name: "my-workflow",
    assetId: "ast_hook",
  });
  await db.insert(workflowDefinitionVersion).values({
    id: `wdv_${DEFINITION}`,
    definitionId: DEFINITION,
    version: "1",
    status: "active",
    approvedWireHash: "a".repeat(64),
    grantSnapshot: SNAPSHOT,
  });
  await db.insert(workflowRun).values({
    id: DEPLOYMENT,
    tenantId: TENANT,
    anchorRunId: DEPLOYMENT,
    definitionId: DEFINITION,
    address: ADDRESS,
    status: "deployed",
  });
  await db.insert(provider).values({
    id: "prv_hooks",
    tenantId: TENANT,
    name: "webhooks",
    plugin: "api_key",
  });
  await db.insert(credential).values({
    id: HOOK,
    tenantId: TENANT,
    providerId: "prv_hooks",
    name: "my-hook",
    type: "api_key",
    secret: await testCredentialCipher.encrypt(
      SECRET,
      credentialAad(HOOK, "secret"),
    ),
    metadata: { webhook: { verify: "standard-webhooks", workflow: "my-workflow" } },
  });
}

async function standardWebhooksHeaders(
  body: string,
): Promise<Record<string, string>> {
  const id = "msg_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(SECRET.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${Buffer.from(mac).toString("base64")}`,
  };
}

async function runGrants(db: TestDb["db"]) {
  const runPrincipals = await db
    .select()
    .from(principal)
    .where(eq(principal.kind, "workflow"));
  const grants = await db.select().from(grant);
  return { runPrincipals, grants };
}

describe.skipIf(!harnessDbAvailable())("POST /api/hooks (real Postgres)", () => {
  let h: TestDb | undefined;
  const db = () => {
    if (h === undefined) throw new Error("harness setup failed");
    return h.db;
  };

  beforeAll(async () => {
    h = await createTestDb();
  }, HARNESS_SETUP_TIMEOUT_MS);

  beforeEach(async () => {
    await h?.reset();
    await seedDeployment(db());
  }, HARNESS_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await h?.close();
  });

  test("a tampered signature is 401 and triggers nothing", async () => {
    const recorded = recordingRouter();
    const app = mountHookRoutes({ db: db(), router: recorded.router });
    const body = `{"text":"hi"}`;
    const headers = await standardWebhooksHeaders(body);

    const res = await app.request(`/api/hooks/${HOOK}`, {
      method: "POST",
      headers,
      body: `{"text":"bye"}`,
    });

    expect(res.status).toBe(401);
    expect(recorded.grants).toEqual([]);
    expect(recorded.mail).toEqual([]);
    const { runPrincipals, grants } = await runGrants(db());
    expect(runPrincipals).toEqual([]);
    expect(grants).toEqual([]);
  });

  test("a signed POST triggers the run and materializes its grants", async () => {
    const recorded = recordingRouter();
    const app = mountHookRoutes({ db: db(), router: recorded.router });
    const body = `{"text":"hi"}`;

    const res = await app.request(`/api/hooks/${HOOK}`, {
      method: "POST",
      headers: await standardWebhooksHeaders(body),
      body,
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, to: ADDRESS });
    const { runPrincipals, grants } = await runGrants(db());
    const [runPrincipal] = runPrincipals;
    expect(runPrincipals).toHaveLength(1);
    expect(grants.map((g) => [g.principalId, g.resource, g.action])).toEqual([
      [runPrincipal?.id ?? "", "tool:read_file", "invoke"],
    ]);
    const [frame] = recorded.grants;
    expect(frame?.[0]).toBe(ADDRESS);
    expect(frame?.[2]).toHaveLength(1);
    expect(recorded.mail).toHaveLength(1);
  });

  test("the tenant-scoped name path resolves only inside that tenant", async () => {
    const recorded = recordingRouter();
    const app = mountHookRoutes({ db: db(), router: recorded.router });
    await seedTenant(db(), "tnt_other");
    const body = `{"text":"hi"}`;

    const miss = await app.request("/api/hooks/tnt_other/my-hook", {
      method: "POST",
      headers: await standardWebhooksHeaders(body),
      body,
    });
    const hit = await app.request(`/api/hooks/${TENANT}/my-hook`, {
      method: "POST",
      headers: await standardWebhooksHeaders(body),
      body,
    });

    expect(miss.status).toBe(404);
    expect(hit.status).toBe(202);
    expect(recorded.mail).toHaveLength(1);
  });
});
