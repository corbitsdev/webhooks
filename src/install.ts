import type { Hono } from "hono";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";

import { createMailDeliverer } from "./deliver";
import { createHookRoutes } from "./hooks";
import { listLiveMailRuns, loadWebhook } from "./resolve";

export type InstallWebhooksOpts = {
  app: { route(path: string, handler: Hono): unknown };
  db: DB["db"];
  credentialCipher: CredentialCipher;
  sessionService: Parameters<typeof createMailDeliverer>[0]["sessionService"];
};

/** Mount POST /api/hooks. Credentials and authz stay Interchange's. */
export async function installWebhooks(
  opts: InstallWebhooksOpts,
): Promise<void> {
  const deliver = await createMailDeliverer({
    sessionService: opts.sessionService,
  });
  opts.app.route(
    "/api/hooks",
    createHookRoutes({
      deliver,
      loadHook: (id, tenantHint) =>
        loadWebhook(opts.db, opts.credentialCipher, id, tenantHint),
      listRuns: (tenantId) => listLiveMailRuns(opts.db, tenantId),
    }),
  );
}
