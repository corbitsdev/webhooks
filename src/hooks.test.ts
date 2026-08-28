import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createHookRoutes } from "./hooks";
import type { LoadedHook, LiveRun } from "./resolve";

const JIMMY: LiveRun = {
  address: "run_jimmy@localhost",
  definitionName: "jimmy",
  assetName: "jimmy",
};

function hook(over: Partial<LoadedHook> = {}): LoadedHook {
  const { meta, ...rest } = over;
  return {
    credentialId: "crd_1",
    credentialName: "slack",
    tenantId: "tnt_1",
    secret: "s3cret",
    ...rest,
    meta: { verify: "bearer", ...meta },
  };
}

function mount(opts?: {
  loaded?: LoadedHook | "ambiguous" | undefined;
  runs?: LiveRun[];
  deliver?: (to: string, content: string, tenantId: string) => Promise<void>;
}) {
  const delivered: { to: string; content: string; tenantId: string }[] = [];
  const app = new Hono();
  app.route(
    "/api/hooks",
    createHookRoutes({
      loadHook: async () => opts?.loaded,
      listRuns: async () => opts?.runs ?? [],
      deliver: {
        to: async (to, content, tenantId) => {
          if (opts?.deliver) {
            await opts.deliver(to, content, tenantId);
            return;
          }
          delivered.push({ to, content, tenantId });
        },
      },
    }),
  );
  return { app, delivered };
}

describe("createHookRoutes", () => {
  test("404 without a hook id", async () => {
    const { app } = mount({ loaded: undefined });
    const res = await app.request("/api/hooks", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  test("generic POST /api/hooks via header", async () => {
    const { app, delivered } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks", {
      method: "POST",
      body: `{"text":"hi"}`,
      headers: {
        "x-webhook-hook": "slack",
        authorization: "Bearer s3cret",
      },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, to: JIMMY.address });
    expect(delivered).toEqual([
      { to: JIMMY.address, content: `{"text":"hi"}`, tenantId: "tnt_1" },
    ]);
  });

  test("POST /api/hooks/:id", async () => {
    const { app, delivered } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(202);
    expect(delivered).toHaveLength(1);
  });

  test("POST /api/hooks/:tenantId/:name", async () => {
    const { app, delivered } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/tnt_1/slack", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(202);
    expect(delivered).toHaveLength(1);
  });

  test("404s an unknown hook", async () => {
    const { app } = mount({ loaded: undefined });
    const res = await app.request("/api/hooks/nope", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("401s a bad signature", async () => {
    const { app } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  test("mails a live onTrigger deployment when metadata has no to", async () => {
    const { app, delivered } = mount({
      loaded: hook(),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: "hello",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(202);
    expect(delivered).toEqual([
      { to: JIMMY.address, content: "hello", tenantId: "tnt_1" },
    ]);
  });

  test("does not mail an address that is not a live run in the cred's tenant", async () => {
    const { app, delivered } = mount({
      loaded: hook({
        meta: { verify: "bearer", to: "run_other@localhost" },
      }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(503);
    expect(delivered).toEqual([]);
  });

  test("slack url_verification echoes challenge without mailing", async () => {
    const secret = "signing-secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc",
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`),
    );
    const { app, delivered } = mount({
      loaded: hook({ secret, meta: { verify: "slack", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${Buffer.from(mac).toString("hex")}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc" });
    expect(delivered).toEqual([]);
  });

  test("503 when nothing is listening", async () => {
    const { app } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
      deliver: async () => {
        throw new Error("agent is unreachable");
      },
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(503);
  });

  test("404 when the hook is ambiguous", async () => {
    const { app } = mount({ loaded: "ambiguous" });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
