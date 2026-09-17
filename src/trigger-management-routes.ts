// Tenant-scoped CRUD over triggers, intended to be mounted inside the
// host's own tenant middleware (its `tenant`/`principal` context vars
// must already be resolved before any handler here runs). This is a
// management surface, not the trust boundary — that is
// `./trigger-ingress-routes.ts`, mounted separately and unauthenticated
// by design.
//
// The secret is generated here (server-side, `crypto.randomBytes` via
// `./trigger-signature.ts`) and returned exactly once: in the create
// response and in the rotate response. Every other response — get,
// list — omits it entirely, never even a redacted form.
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import { pgErrorCode, PG_UNIQUE_VIOLATION } from "@intx/db";

import { generateWebhookSecret } from "./trigger-signature";
import type { WebhookTriggerRow } from "./trigger-schema";
import type { WebhookTriggerStore } from "./trigger-store";

/**
 * True for a Postgres unique-violation (`23505`) — the shape a
 * duplicate `(tenant, workflow definition, name)` raises through the
 * `webhook_trigger_tenant_definition_name_unique` index
 * (`./trigger-migrations.ts`). `pgErrorCode` walks Drizzle's wrapped
 * cause chain, since a real insert failure arrives as a
 * `DrizzleQueryError` rather than the raw driver error; this package's
 * in-memory test fake stamps `.code` directly to match. Never silently
 * retried as an `ensure`: this route's `create` promises a genuinely
 * new row, so a collision is reported to the caller as a conflict
 * rather than handed back someone else's trigger.
 */
function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_UNIQUE_VIOLATION;
}

const CreateTriggerBody = type({
  name: "string",
  workflowDefinitionId: "string",
  inputTemplate: "string",
});

const SetEnabledBody = type({
  enabled: "boolean",
});

/**
 * Every field of a trigger except its secret — the shape returned by
 * list/get/enable/disable, and by create/rotate alongside a one-time
 * `secret` field those two responses add.
 */
function publicView(row: WebhookTriggerRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    workflowDefinitionId: row.workflowDefinitionId,
    inputTemplate: row.inputTemplate,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
  };
}

export type CreateWebhookTriggerRoutesDeps = {
  store: WebhookTriggerStore;
  requireGrant: RequireGrant;
  /** Generates a fresh id for a newly created trigger row. */
  generateId: () => string;
  /**
   * When provided, `POST /` rejects with 404 if the workflow definition
   * is not in the request tenant. Tests may omit (always-allow).
   */
  workflowDefinitionInTenant?: (
    tenantId: string,
    definitionId: string,
  ) => Promise<boolean>;
};

export function createWebhookTriggerRoutes(
  deps: CreateWebhookTriggerRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post("/", deps.requireGrant("webhook-trigger:*", "create"), async (c) => {
    const parsed = CreateTriggerBody(await c.req.json().catch(() => undefined));
    if ("summary" in parsed) {
      return c.json(
        { error: "bad_request", message: `invalid trigger body: ${parsed.summary}` },
        400,
      );
    }
    const body = parsed;

    const tenant = c.get("tenant");
    const principal = c.get("principal");

    if (deps.workflowDefinitionInTenant !== undefined) {
      const owned = await deps.workflowDefinitionInTenant(
        tenant.id,
        body.workflowDefinitionId,
      );
      if (!owned) {
        return c.json({ error: "not_found", message: "definition not found" }, 404);
      }
    }

    const secret = generateWebhookSecret();

    let row: WebhookTriggerRow;
    try {
      row = await deps.store.create({
        id: deps.generateId(),
        tenantId: tenant.id,
        name: body.name,
        workflowDefinitionId: body.workflowDefinitionId,
        inputTemplate: body.inputTemplate,
        secret,
        createdBy: principal.id,
      });
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        return c.json(
          {
            error: "conflict",
            message:
              "a trigger with this name already exists for this workflow definition",
          },
          409,
        );
      }
      throw cause;
    }

    return c.json({ ...publicView(row), secret }, 201);
  });

  app.get("/", deps.requireGrant("webhook-trigger:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const rows = await deps.store.list(tenant.id);
    return c.json({ items: rows.map(publicView) });
  });

  app.get(
    "/:id",
    deps.requireGrant(idResource("webhook-trigger", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const row = await deps.store.get(tenant.id, c.req.param("id"));
      if (row === undefined) {
        return c.json({ error: "not_found", message: "trigger not found" }, 404);
      }
      return c.json(publicView(row));
    },
  );

  app.post(
    "/:id/rotate-secret",
    deps.requireGrant(idResource("webhook-trigger", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const secret = generateWebhookSecret();
      const row = await deps.store.rotateSecret(
        tenant.id,
        c.req.param("id"),
        secret,
      );
      if (row === undefined) {
        return c.json({ error: "not_found", message: "trigger not found" }, 404);
      }
      return c.json({ ...publicView(row), secret });
    },
  );

  app.post(
    "/:id/enabled",
    deps.requireGrant(idResource("webhook-trigger", "id"), "write"),
    async (c) => {
      const parsed = SetEnabledBody(await c.req.json().catch(() => undefined));
      if ("summary" in parsed) {
        return c.json(
          { error: "bad_request", message: `invalid enabled body: ${parsed.summary}` },
          400,
        );
      }
      const body = parsed;
      const tenant = c.get("tenant");
      const row = await deps.store.setEnabled(
        tenant.id,
        c.req.param("id"),
        body.enabled,
      );
      if (row === undefined) {
        return c.json({ error: "not_found", message: "trigger not found" }, 404);
      }
      return c.json(publicView(row));
    },
  );

  app.delete(
    "/:id",
    deps.requireGrant(idResource("webhook-trigger", "id"), "delete"),
    async (c) => {
      const tenant = c.get("tenant");
      const removed = await deps.store.remove(tenant.id, c.req.param("id"));
      if (!removed) {
        return c.json({ error: "not_found", message: "trigger not found" }, 404);
      }
      return c.body(null, 204);
    },
  );

  return app;
}
