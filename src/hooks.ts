import { Hono, type Context } from "hono";

import type { MailDeliverer } from "./deliver";
import type { LoadedHook, LiveRun } from "./resolve";
import { pickDestination } from "./resolve";
import {
  verifyBearer,
  verifySlack,
  verifyStandardWebhooks,
} from "./verify";

export type LoadHook = (
  id: string,
  tenantHint: string | undefined,
) => Promise<LoadedHook | "ambiguous" | undefined>;

export type ListRuns = (tenantId: string) => Promise<LiveRun[]>;

export function createHookRoutes(opts: {
  deliver: MailDeliverer;
  loadHook: LoadHook;
  listRuns: ListRuns;
}): Hono {
  const app = new Hono();
  app.post("/", (c) => handle(c, opts));
  app.post("/:id", (c) => handle(c, opts));
  return app;
}

async function handle(
  c: Context,
  opts: {
    deliver: MailDeliverer;
    loadHook: LoadHook;
    listRuns: ListRuns;
  },
) {
    const id =
      emptyToUndef(c.req.param("id")) ??
      emptyToUndef(c.req.header("x-webhook-hook")) ??
      emptyToUndef(c.req.query("hook"));
    if (!id) {
      return c.json(
        {
          error: "missing_hook",
          message:
            "Pass /api/hooks/:id, header x-webhook-hook, or query hook=<credential name or id>",
        },
        400,
      );
    }

    const tenantHint =
      emptyToUndef(c.req.header("x-tenant-id")) ??
      emptyToUndef(c.req.query("tenant"));

    let loaded: LoadedHook | "ambiguous" | undefined;
    try {
      loaded = await opts.loadHook(id, tenantHint);
    } catch {
      return c.json({ error: "vault_error" }, 500);
    }
    if (loaded === "ambiguous") {
      return c.json(
        {
          error: "ambiguous_hook",
          message: "Multiple webhook credentials match; pass x-tenant-id or use crd_… id",
        },
        409,
      );
    }
    if (!loaded) return c.json({ error: "unknown_hook" }, 404);

    const body = await c.req.text();
    if (loaded.meta.verify !== "none") {
      let ok = false;
      if (loaded.meta.verify === "bearer") {
        ok = verifyBearer(loaded.secret, c.req.raw.headers);
      } else if (loaded.meta.verify === "standard-webhooks") {
        ok = await verifyStandardWebhooks(
          loaded.secret,
          c.req.raw.headers,
          body,
        );
      } else if (loaded.meta.verify === "slack") {
        ok = await verifySlack(loaded.secret, c.req.raw.headers, body);
      }
      if (!ok) return c.json({ error: "unauthorized" }, 401);
    }

    if (loaded.meta.verify === "slack") {
      const challenge = slackChallenge(body);
      if (challenge !== undefined) {
        return c.json({ challenge }, 200);
      }
    }

    let runs: LiveRun[] = [];
    if (loaded.meta.to === undefined) {
      try {
        runs = await opts.listRuns(loaded.tenantId);
      } catch {
        return c.json({ error: "lookup_error" }, 500);
      }
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
      if (dest.code === "none") {
        return c.json(
          {
            error: "undeliverable",
            message:
              "No live deployment to trigger. Deploy a workflow with onTrigger mail, or set metadata.webhook.to / metadata.webhook.workflow on the credential.",
          },
          503,
        );
      }
      return c.json(
        {
          error: "ambiguous_destination",
          message:
            "Multiple live deployments. Set metadata.webhook.to or metadata.webhook.workflow on the credential.",
          candidates: dest.candidates,
        },
        409,
      );
    }

    try {
      await opts.deliver.to(
        dest.to,
        body === "" ? "{}" : body,
        loaded.tenantId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: "undeliverable",
          message:
            "No live deployment is listening at this address. Deploy a workflow with onTrigger mail.",
          to: dest.to,
          detail: message,
        },
        503,
      );
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
