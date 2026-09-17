// Exercises `createWebhookTriggerRoutes`' HTTP surface: request
// parsing, the secret-exposure contract (present on create/rotate
// only), and grant-check wiring. Mounted into a bare `Hono` with an
// in-memory store fake — no database involved, our wiring only.
import { describe, expect, test } from "bun:test";
import type { RequireGrant } from "@intx/hub-api";
import { createWebhookTriggerRoutes } from "./trigger-management-routes";
import {
  createInMemoryWebhookTriggerStore,
  mountAs,
} from "./trigger-test-support";

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

let nextId = 0;

function buildApp(overrides: { requireGrant?: RequireGrant } = {}) {
  const store = createInMemoryWebhookTriggerStore();
  const requireGrant = overrides.requireGrant ?? allowAll;
  const app = mountAs(
    createWebhookTriggerRoutes({
      store,
      requireGrant,
      generateId: () => `trg_${++nextId}`,
    }),
    "prn_alice",
  );
  return { app, store };
}

describe("POST /", () => {
  test("creates a trigger and returns its secret exactly once", async () => {
    const { app } = buildApp();
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Granola note-taker",
        workflowDefinitionId: "def_1",
        inputTemplate: "New note: {{note.title}}",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      secret: string;
      name: string;
    };
    expect(typeof body.secret).toBe("string");
    expect(body.secret.length).toBeGreaterThan(0);
    expect(body.name).toBe("Granola note-taker");
  });

  test("rejects a malformed body", async () => {
    const { app } = buildApp();
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "missing fields" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("a second create for the same name/definition 409s rather than duplicating", async () => {
    const { app } = buildApp();
    const post = () =>
      app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Granola note-taker",
          workflowDefinitionId: "def_1",
          inputTemplate: "New note: {{note.title}}",
        }),
      });

    const first = await post();
    expect(first.status).toBe(201);

    const second = await post();
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("conflict");
  });
});

describe("GET / and GET /:id", () => {
  test("list and get never include the secret", async () => {
    const { app } = buildApp();
    const createResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "trigger",
        workflowDefinitionId: "def_1",
        inputTemplate: "{{a}}",
      }),
    });
    const created = (await createResponse.json()) as { id: string };

    const listResponse = await app.request("/");
    const list = (await listResponse.json()) as {
      items: Record<string, unknown>[];
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty("secret");

    const getResponse = await app.request(`/${created.id}`);
    const got = (await getResponse.json()) as Record<string, unknown>;
    expect(got).not.toHaveProperty("secret");
  });

  test("get on an unknown id 404s", async () => {
    const { app } = buildApp();
    const response = await app.request("/missing");
    expect(response.status).toBe(404);
  });
});

describe("POST /:id/rotate-secret", () => {
  test("returns a new secret different from the original", async () => {
    const { app } = buildApp();
    const createResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "trigger",
        workflowDefinitionId: "def_1",
        inputTemplate: "{{a}}",
      }),
    });
    const created = (await createResponse.json()) as {
      id: string;
      secret: string;
    };

    const rotateResponse = await app.request(`/${created.id}/rotate-secret`, {
      method: "POST",
    });
    expect(rotateResponse.status).toBe(200);
    const rotated = (await rotateResponse.json()) as { secret: string };
    expect(rotated.secret).not.toBe(created.secret);
  });
});

describe("POST /:id/enabled and DELETE /:id", () => {
  test("disable then delete round-trip", async () => {
    const { app } = buildApp();
    const createResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "trigger",
        workflowDefinitionId: "def_1",
        inputTemplate: "{{a}}",
      }),
    });
    const created = (await createResponse.json()) as { id: string };

    const disableResponse = await app.request(`/${created.id}/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableResponse.status).toBe(200);
    const disabled = (await disableResponse.json()) as { enabled: boolean };
    expect(disabled.enabled).toBe(false);

    const deleteResponse = await app.request(`/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(204);

    const getResponse = await app.request(`/${created.id}`);
    expect(getResponse.status).toBe(404);
  });

  test("a denied grant is rejected before any store mutation", async () => {
    const { app, store } = buildApp({
      requireGrant: () => async (c) => c.json({ error: "forbidden" }, 403),
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "trigger",
        workflowDefinitionId: "def_1",
        inputTemplate: "{{a}}",
      }),
    });

    expect(response.status).toBe(403);
    expect(await store.list("tnt_1")).toHaveLength(0);
  });
});
