// Exercises `createWebhookTriggerIngressRoutes`' HTTP surface:
// signature verification (valid/invalid/missing/stale), unknown/
// disabled-trigger handling, and payload parsing — with a fake
// `launch` seam so no database or launch machinery is involved. This
// is the trust-boundary route: no session, no tenant middleware.
// Unknown trigger, disabled trigger, bad signature, and a stale/
// replayed timestamp must all come back as the same generic 401 so a
// probe can't tell them apart.
import { describe, expect, test } from "bun:test";
import { createWebhookTriggerIngressRoutes } from "./trigger-ingress-routes";
import {
  signPayload,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./trigger-signature";
import { createInMemoryWebhookTriggerStore } from "./trigger-test-support";

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function seedTrigger(
  store: ReturnType<typeof createInMemoryWebhookTriggerStore>,
  overrides: { enabled?: boolean } = {},
) {
  const row = await store.create({
    id: "ins_trigger1",
    tenantId: "tnt_1",
    name: "Granola",
    workflowDefinitionId: "def_1",
    inputTemplate: "{{note.title}}",
    secret: "s3cr3t",
    createdBy: "prn_alice",
  });
  if (overrides.enabled === false) {
    await store.setEnabled("tnt_1", row.id, false);
  }
  return row;
}

function buildApp(
  launch: Parameters<
    typeof createWebhookTriggerIngressRoutes
  >[0]["launch"] = async () => ({
    instanceId: "ins_x",
    triggerAddress: "ins_x@acme.example",
  }),
) {
  const store = createInMemoryWebhookTriggerStore();
  const app = createWebhookTriggerIngressRoutes({ store, launch });
  return { app, store };
}

describe("POST /:triggerId", () => {
  test("launches on a validly signed payload with a fresh timestamp", async () => {
    let launchedWith: unknown;
    const { app, store } = buildApp(async (_trigger, payload) => {
      launchedWith = payload;
      return { instanceId: "ins_new", triggerAddress: "ins_new@acme.example" };
    });
    await seedTrigger(store);

    const body = JSON.stringify({ note: { title: "Q3 planning" } });
    const timestamp = nowSeconds();
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(launchedWith).toEqual({ note: { title: "Q3 planning" } });
    const trigger = await store.getById("ins_trigger1");
    expect(trigger?.lastFiredAt).not.toBeNull();
  });

  async function expectUnauthorized(response: Response): Promise<void> {
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  }

  test("rejects a missing signature header", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_TIMESTAMP_HEADER]: nowSeconds(),
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    await expectUnauthorized(response);
  });

  test("rejects a missing timestamp header", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const body = "{}";
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", nowSeconds(), body),
      },
      body,
    });

    expect(response.status).toBe(401);
    await expectUnauthorized(response);
  });

  test("rejects a stale timestamp (a replayed delivery)", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const body = "{}";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_TIMESTAMP_HEADER]: staleTimestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", staleTimestamp, body),
      },
      body,
    });

    expect(response.status).toBe(401);
    await expectUnauthorized(response);
  });

  test("rejects a signature computed with the wrong secret", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const body = "{}";
    const timestamp = nowSeconds();
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(
          "wrong-secret",
          timestamp,
          body,
        ),
      },
      body,
    });

    expect(response.status).toBe(401);
    await expectUnauthorized(response);
  });

  test("responds to an unknown trigger id with the same generic unauthorized response, not a 404", async () => {
    const { app } = buildApp();
    const response = await app.request("/no-such-trigger", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
    await expectUnauthorized(response);
  });

  test("responds to a disabled trigger with the same generic unauthorized response even with a valid signature", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store, { enabled: false });

    const body = "{}";
    const timestamp = nowSeconds();
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(401);
    await expectUnauthorized(response);
  });

  test("400s on a validly signed but non-JSON body", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const body = "not json";
    const timestamp = nowSeconds();
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(400);
  });
});
