import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { MailDeliverer } from "./deliver.js";
import type { LoadedHook, LiveRun } from "./resolve.js";
import { pickDestination } from "./resolve.js";
import type { ReplayStore } from "./replay.js";
import {
  TIMESTAMP_TOLERANCE_S,
  verifyBearer,
  verifySlack,
  verifyStandardWebhooks,
} from "./verify.js";

export type LoadHook = (
  id: string,
  tenantHint: string | undefined,
) => Promise<LoadedHook | "ambiguous" | undefined>;

export type ListRuns = (tenantId: string) => Promise<LiveRun[]>;

type HookAppOptions = {
  deliver: MailDeliverer;
  loadHook: LoadHook;
  listRuns: ListRuns;
  replay: ReplayStore;
};

/** Largest request body accepted, checked before anything is hashed. */
export const MAX_BODY_BYTES = 1024 * 1024;

export function createHookApp(opts: HookAppOptions): Hono {
  const app = new Hono();
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );
  app.post("/", (c) => handle(c, opts));
  app.post("/:id", (c) => handle(c, opts));
  app.post("/:tenantId/:name", (c) => handle(c, opts));
  return app;
}

async function handle(c: Context, opts: HookAppOptions) {
  const pathTenant = emptyToUndef(c.req.param("tenantId"));
  const pathName = emptyToUndef(c.req.param("name"));
  const id =
    pathName ??
    emptyToUndef(c.req.param("id")) ??
    emptyToUndef(c.req.header("x-webhook-hook")) ??
    emptyToUndef(c.req.query("hook"));
  if (!id) {
    return c.json({ error: "unknown_hook" }, 404);
  }

  const tenantHint =
    (pathTenant?.startsWith("tnt_") ? pathTenant : undefined) ??
    emptyToUndef(c.req.header("x-tenant-id")) ??
    emptyToUndef(c.req.query("tenant"));

  let loaded: LoadedHook | "ambiguous" | undefined;
  try {
    loaded = await opts.loadHook(id, tenantHint);
  } catch {
    return c.json({ error: "vault_error" }, 500);
  }
  // Don't leak name collisions or tenant misses.
  if (!loaded || loaded === "ambiguous") {
    return c.json({ error: "unknown_hook" }, 404);
  }

  const raw = new Uint8Array(await c.req.arrayBuffer());
  let ok = false;
  if (loaded.meta.verify === "bearer") {
    ok = verifyBearer(loaded.secret, c.req.raw.headers);
  } else if (loaded.meta.verify === "standard-webhooks") {
    ok = await verifyStandardWebhooks(loaded.secret, c.req.raw.headers, raw);
  } else if (loaded.meta.verify === "slack") {
    ok = await verifySlack(loaded.secret, c.req.raw.headers, raw);
  }
  if (!ok) return c.json({ error: "unauthorized" }, 401);

  // Trigger mail carries text, so a body that is not UTF-8 cannot be forwarded
  // unchanged; refuse it rather than substitute replacement characters.
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  } catch {
    return c.json({ error: "unsupported_body" }, 415);
  }

  const replayKey = replayClaim(loaded, c.req.raw.headers);
  if (replayKey !== undefined) {
    let fresh: boolean;
    try {
      fresh = await opts.replay.claim(
        loaded.credentialId,
        replayKey.nonce,
        replayKey.expiresAt,
      );
    } catch {
      return c.json({ error: "replay_error" }, 500);
    }
    if (!fresh) return c.json({ error: "replayed" }, 409);
  }

  const res = await forward(c, opts, loaded, body);
  // A failed delivery must not burn the id, or the sender's retry is lost.
  if (!res.ok && replayKey !== undefined) {
    await opts.replay
      .release(loaded.credentialId, replayKey.nonce)
      .catch(() => undefined);
  }
  return res;
}

/**
 * Standard Webhooks senders reuse `webhook-id` across retries; Slack has no id,
 * so its signature stands in. Each key lives as long as its timestamp would
 * still verify. Bearer hooks carry no nonce and cannot be deduplicated.
 */
function replayClaim(
  loaded: LoadedHook,
  headers: Headers,
): { nonce: string; expiresAt: Date } | undefined {
  const [nonce, timestamp] =
    loaded.meta.verify === "standard-webhooks"
      ? [headers.get("webhook-id"), headers.get("webhook-timestamp")]
      : loaded.meta.verify === "slack"
        ? [
            headers.get("x-slack-signature"),
            headers.get("x-slack-request-timestamp"),
          ]
        : [];
  if (!nonce || !timestamp) return undefined;
  return {
    nonce: `${loaded.meta.verify}:${nonce}`,
    expiresAt: new Date((Number(timestamp) + TIMESTAMP_TOLERANCE_S) * 1000),
  };
}

async function forward(
  c: Context,
  opts: HookAppOptions,
  loaded: LoadedHook,
  body: string,
): Promise<Response> {
  if (loaded.meta.verify === "slack") {
    const challenge = slackChallenge(body);
    if (challenge !== undefined) {
      return c.json({ challenge }, 200);
    }
  }

  let runs: LiveRun[] = [];
  try {
    runs = await opts.listRuns(loaded.tenantId);
  } catch {
    return c.json({ error: "lookup_error" }, 500);
  }
  const dest = pickDestination(
    {
      credentialName: loaded.credentialName,
      ...(loaded.meta.to !== undefined ? { to: loaded.meta.to } : {}),
      ...(loaded.meta.workflow !== undefined
        ? { workflow: loaded.meta.workflow }
        : {}),
    },
    runs,
  );
  if (!dest.ok) {
    return c.json(
      {
        error: dest.code === "none" ? "undeliverable" : "ambiguous_destination",
      },
      dest.code === "none" ? 503 : 409,
    );
  }

  try {
    await opts.deliver.to(
      dest.to,
      body === "" ? "{}" : body,
      loaded.tenantId,
      undefined,
    );
  } catch {
    return c.json({ error: "undeliverable" }, 503);
  }
  return c.json({ ok: true, to: dest.to }, 202);
}

function emptyToUndef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function slackChallenge(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { type?: unknown; challenge?: unknown };
    if (
      parsed.type === "url_verification" &&
      typeof parsed.challenge === "string"
    ) {
      return parsed.challenge;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
