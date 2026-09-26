import type { Hono } from "hono";
import { createGrantStore, type DB, type PrincipalKeyStore } from "@intx/db";
import { createMailTriggeredRunGrantsMaterializer } from "@intx/hub-api";
import type { CredentialCipher } from "@intx/types";

import {
  createRunTriggerDeliverer,
  type HookMailRouter,
} from "./deliver.js";
import { createHookApp } from "./hooks.js";
import { createTenantSystemSender } from "./system-sender.js";
import { listLiveMailRuns, loadWebhook } from "./resolve.js";

export type CreateHookRoutesDeps = {
  db: DB["db"];
  credentialCipher: CredentialCipher;
  principalKeyStore: PrincipalKeyStore;
  router: HookMailRouter;
};

/**
 * Signature-authenticated hook ingress. Credentials stay Interchange's; the
 * trigger fires as the run principal. Mount it outside the host's session
 * and tenant middleware: senders carry a signature, not a session, and the
 * tenant comes from the hook's credential.
 */
export function createHookRoutes({
  db,
  credentialCipher,
  principalKeyStore,
  router,
}: CreateHookRoutesDeps): Hono {
  const materialize = createMailTriggeredRunGrantsMaterializer({
    db,
    principalKeyStore,
    grantStore: createGrantStore(db),
  });
  const deliver = createRunTriggerDeliverer({
    router,
    materialize,
    tenantDomain: async (tenantId) => {
      const row = await db.query.tenant.findFirst({
        where: (t, { eq }) => eq(t.id, tenantId),
      });
      if (!row) throw new Error("tenant not found");
      return row.domain;
    },
    senderLocalPart: "webhook",
    systemSender: createTenantSystemSender({
      db,
      principalKeyStore,
    }),
  });
  return createHookApp({
    deliver,
    loadHook: (id, tenantHint) =>
      loadWebhook(db, credentialCipher, id, tenantHint),
    listRuns: (tenantId) => listLiveMailRuns(db, tenantId),
  });
}
