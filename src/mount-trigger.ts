// Single mount point for the trigger-CRUD half of `@corbits/webhook`,
// mirroring `@corbits/mailbox`'s own single `mountMailbox` entry
// point: one call wires the tenant-scoped management routes at
// `mountPath` and the unauthenticated ingress routes at
// `ingressPath` (default `/api/webhooks`), so a host never has to know
// which internal route modules exist to bring this feature online.
import type { Hono } from "hono";

import {
  createWebhookTriggerIngressRoutes,
  type CreateWebhookTriggerIngressRoutesDeps,
} from "./trigger-ingress-routes";
import {
  createWebhookTriggerRoutes,
  type CreateWebhookTriggerRoutesDeps,
} from "./trigger-management-routes";

export type MountWebhookTriggerOpts = {
  /** The host's top-level Hono app (or a tenant-scoped sub-app it composes into one). */
  app: { route(path: string, handler: Hono<any>): unknown };
  /**
   * Where the tenant-scoped management CRUD mounts, e.g.
   * `${TENANT_PREFIX}/webhook-triggers`.
   */
  mountPath: string;
  management: CreateWebhookTriggerRoutesDeps;
  ingress: CreateWebhookTriggerIngressRoutesDeps;
  /**
   * Where the unauthenticated ingress endpoint mounts. Defaults to
   * `/api/webhooks` — MUST be outside any tenant-resolution
   * middleware, since the ingress route resolves its own tenant scope
   * by trigger id.
   */
  ingressPath?: string;
};

export function mountWebhookTrigger(opts: MountWebhookTriggerOpts): void {
  opts.app.route(opts.mountPath, createWebhookTriggerRoutes(opts.management));
  opts.app.route(
    opts.ingressPath ?? "/api/webhooks",
    createWebhookTriggerIngressRoutes(opts.ingress),
  );
}
