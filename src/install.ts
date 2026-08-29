import type { Hono } from "hono";
import { createGrantStore, type DB } from "@intx/db";
import { createMailTriggeredRunGrantsMaterializer } from "@intx/hub-api";
import type { CredentialCipher } from "@intx/types";

import {
  createRunTriggerDeliverer,
  type HookMailRouter,
} from "./deliver";
import { createHookRoutes } from "./hooks";
import { listLiveMailRuns, loadWebhook } from "./resolve";

export type InstallWebhooksOpts = {
  app: { route(path: string, handler: Hono): unknown };
  db: DB["db"];
  credentialCipher: CredentialCipher;
  router: HookMailRouter;
};

/** Mount POST /api/hooks. Credentials stay Interchange's; trigger is the run principal. */
export async function installWebhooks(
  opts: InstallWebhooksOpts,
): Promise<void> {
  const materialize = createMailTriggeredRunGrantsMaterializer({
    db: opts.db,
    grantStore: createGrantStore(opts.db),
  });
  const deliver = createRunTriggerDeliverer({
    router: opts.router,
    materialize,
    tenantDomain: async (tenantId) => {
      const row = await opts.db.query.tenant.findFirst({
        where: (t, { eq }) => eq(t.id, tenantId),
      });
      if (!row) throw new Error("tenant not found");
      return row.domain;
    },
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
