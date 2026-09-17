// Shared test harness for `createWebhookTriggerRoutes`' HTTP surface:
// an in-memory `WebhookTriggerStore` fake and a tenant/principal-
// injecting mount. Not a production module — imported only from this
// package's own `*.test.ts` files.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { WebhookTriggerRow } from "./trigger-schema";
import type {
  CreateWebhookTriggerInput,
  WebhookTriggerStore,
} from "./trigger-store";

export const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function createInMemoryWebhookTriggerStore(): WebhookTriggerStore {
  const rows = new Map<string, WebhookTriggerRow>();

  function findByName(
    tenantId: string,
    workflowDefinitionId: string,
    name: string,
  ): WebhookTriggerRow | undefined {
    return [...rows.values()].find(
      (row) =>
        row.tenantId === tenantId &&
        row.workflowDefinitionId === workflowDefinitionId &&
        row.name === name,
    );
  }

  function newRow(input: CreateWebhookTriggerInput): WebhookTriggerRow {
    return {
      id: input.id,
      tenantId: input.tenantId,
      name: input.name,
      workflowDefinitionId: input.workflowDefinitionId,
      inputTemplate: input.inputTemplate,
      secret: input.secret,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: new Date(),
      lastFiredAt: null,
    };
  }

  return {
    async create(input) {
      if (findByName(input.tenantId, input.workflowDefinitionId, input.name)) {
        throw Object.assign(
          new Error(
            `webhook trigger ${input.name} already exists for this workflow definition`,
          ),
          { code: "23505" },
        );
      }
      const row = newRow(input);
      rows.set(row.id, row);
      return row;
    },
    async ensure(input) {
      const existing = findByName(
        input.tenantId,
        input.workflowDefinitionId,
        input.name,
      );
      if (existing) return existing;
      const row = newRow(input);
      rows.set(row.id, row);
      return row;
    },
    async get(tenantId, triggerId) {
      const row = rows.get(triggerId);
      return row?.tenantId === tenantId ? row : undefined;
    },
    async getById(triggerId) {
      return rows.get(triggerId);
    },
    async list(tenantId) {
      return [...rows.values()].filter((row) => row.tenantId === tenantId);
    },
    async rotateSecret(tenantId, triggerId, secret) {
      const row = rows.get(triggerId);
      if (row === undefined || row.tenantId !== tenantId) return undefined;
      const updated = { ...row, secret };
      rows.set(triggerId, updated);
      return updated;
    },
    async setEnabled(tenantId, triggerId, enabled) {
      const row = rows.get(triggerId);
      if (row === undefined || row.tenantId !== tenantId) return undefined;
      const updated = { ...row, enabled };
      rows.set(triggerId, updated);
      return updated;
    },
    async recordFired(triggerId, firedAt) {
      const row = rows.get(triggerId);
      if (row === undefined) return;
      rows.set(triggerId, { ...row, lastFiredAt: firedAt });
    },
    async remove(tenantId, triggerId) {
      const row = rows.get(triggerId);
      if (row === undefined || row.tenantId !== tenantId) return false;
      rows.delete(triggerId);
      return true;
    },
  };
}

export function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}
