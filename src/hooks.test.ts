import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";

import { createHookApp, MAX_BODY_BYTES } from "./hooks.js";
import type { LoadedHook, LiveRun } from "./resolve.js";

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

function memoryReplay() {
  const seen = new Set<string>();
  return {
    claim: async (credentialId: string, nonce: string) =>
      !seen.has(`${credentialId}:${nonce}`) &&
      !!seen.add(`${credentialId}:${nonce}`),
    release: async (credentialId: string, nonce: string) =>
      void seen.delete(`${credentialId}:${nonce}`),
  };
}

async function slackRequest(secret: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
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
  return {
    method: "POST",
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${Buffer.from(mac).toString("hex")}`,
    },
  };
}

const GITHUB_HEADERS = {
  signature: "x-hub-signature-256",
  event: "x-github-event",
  delivery: "x-github-delivery",
};

function githubRequest(secret: string, body: string, delivery = "del-1") {
  return {
    method: "POST",
    body,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      "x-github-event": "pull_request",
      "x-github-delivery": delivery,
    },
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
    createHookApp({
      loadHook: async () => opts?.loaded,
      replay: memoryReplay(),
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

describe("createHookApp", () => {
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

  test("413s a body over the size limit before verifying", async () => {
    const { app, delivered } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: "x".repeat(MAX_BODY_BYTES + 1),
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(413);
    expect(delivered).toEqual([]);
  });

  test("forwards the verified body unchanged", async () => {
    const { app, delivered } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const body = '  {"n":"é"}\r\n';
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: new TextEncoder().encode(body),
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(202);
    expect(delivered[0]?.content).toBe(body);
  });

  test("415s a verified body that is not UTF-8", async () => {
    const { app, delivered } = mount({
      loaded: hook({ meta: { verify: "bearer", to: JIMMY.address } }),
      runs: [JIMMY],
    });
    const res = await app.request("/api/hooks/slack", {
      method: "POST",
      body: new Uint8Array([0x7b, 0xe9, 0x7d]),
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(415);
    expect(delivered).toEqual([]);
  });

  test("409s a replayed Slack delivery", async () => {
    const { app, delivered } = mount({
      loaded: hook({
        secret: "signing-secret",
        meta: { verify: "slack", to: JIMMY.address },
      }),
      runs: [JIMMY],
    });
    const init = await slackRequest("signing-secret", "{}");
    const first = await app.request("/api/hooks/slack", init);
    const again = await app.request("/api/hooks/slack", init);
    expect(first.status).toBe(202);
    expect(again.status).toBe(409);
    expect(delivered).toHaveLength(1);
  });

  test("accepts a sender retry after a failed delivery", async () => {
    let fail = true;
    const { app } = mount({
      loaded: hook({
        secret: "signing-secret",
        meta: { verify: "slack", to: JIMMY.address },
      }),
      runs: [JIMMY],
      deliver: async () => {
        if (fail) throw new Error("agent is unreachable");
      },
    });
    const init = await slackRequest("signing-secret", "{}");
    expect((await app.request("/api/hooks/slack", init)).status).toBe(503);
    fail = false;
    expect((await app.request("/api/hooks/slack", init)).status).toBe(202);
  });

  test("mails an x-hub-signature delivery with its event and id, once", async () => {
    const { app, delivered } = mount({
      loaded: hook({
        meta: {
          verify: "x-hub-signature",
          headers: GITHUB_HEADERS,
          to: JIMMY.address,
        },
      }),
      runs: [JIMMY],
    });
    const init = githubRequest("s3cret", `{"action":"opened"}`);
    expect((await app.request("/api/hooks/crd_1", init)).status).toBe(202);
    expect((await app.request("/api/hooks/crd_1", init)).status).toBe(409);
    expect(delivered).toEqual([
      {
        to: JIMMY.address,
        content: `{"event":"pull_request","deliveryId":"del-1","payload":{"action":"opened"}}`,
        tenantId: "tnt_1",
      },
    ]);
  });

  test("401s an x-hub-signature delivery signed with another secret", async () => {
    const { app, delivered } = mount({
      loaded: hook({
        meta: { verify: "x-hub-signature", headers: GITHUB_HEADERS },
      }),
      runs: [JIMMY],
    });
    const res = await app.request(
      "/api/hooks/crd_1",
      githubRequest("other", "{}"),
    );
    expect(res.status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  test("400s an x-hub-signature delivery without its id or with a body that is not JSON", async () => {
    const { app, delivered } = mount({
      loaded: hook({
        meta: { verify: "x-hub-signature", headers: GITHUB_HEADERS },
      }),
      runs: [JIMMY],
    });
    const missing = await app.request(
      "/api/hooks/crd_1",
      githubRequest("s3cret", "{}", ""),
    );
    const notJson = await app.request(
      "/api/hooks/crd_1",
      githubRequest("s3cret", "not json"),
    );
    expect(missing.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(delivered).toHaveLength(0);
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
