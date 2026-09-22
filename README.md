# @corbits/webhooks

Inbound HTTP → check a tenant-owned vault secret → fire a live `onTrigger` as that deployment's run principal. The signing cred is only how you got in. The workflow runs as `deriveRunPrincipalId(tenantId, runId)` — Interchange's mail-triggered grant path, not the credential owner. Credentials stay Interchange's (`POST /credentials`, `credential:*`); this package adds `POST /api/hooks`.

## Runtime support

`package.json` does not declare `engines`. The published export is TypeScript source (`./src/index.ts`); Bun consumes it directly. Native Node does not load this extensionless TypeScript source as-is.

## Quickstart

```sh
npm add @corbits/webhooks
pnpm add @corbits/webhooks
yarn add @corbits/webhooks
bun add @corbits/webhooks
```

Deploy a workflow with `onTrigger({ on: { type: "mail", to } })`. After deploy it has a live address (`run_…@domain`). Setting a hook is creating a tenant org credential (`principalId` null):

```bash
curl -X POST "$HUB/api/tenants/$TNT/providers" \
  -H "content-type: application/json" -H "cookie: $COOKIE" \
  -d '{"name":"webhooks","plugin":"api_key"}'

curl -X POST "$HUB/api/tenants/$TNT/credentials" \
  -H "content-type: application/json" -H "cookie: $COOKIE" \
  -d '{
    "name": "slack",
    "providerId": "prv_…",
    "type": "api_key",
    "secret": "[redacted: looks like a credential]",
    "metadata": {
      "webhook": {
        "verify": "slack",
        "workflow": "jimmy"
      }
    }
  }'
```

`metadata.webhook.verify` is `bearer` | `standard-webhooks` | `slack` (required; there is no `none`). `workflow` is a live deployment whose definition or asset name matches; `to` is a live run address in this tenant.

Prefer the credential id:

```
POST $HUB/api/hooks/crd_…
```

Name is tenant-scoped:

```
POST $HUB/api/hooks/$TNT/slack
```

`verify: "slack"` echoes Slack `url_verification` (no mail).

```ts
import {
  createRunTriggerDeliverer,
  createTenantSystemSender,
  installWebhooks,
  isRunTriggerUnroutable,
  type CreateRunTriggerDelivererOpts,
  type HookMailRouter,
  type InstallWebhooksOpts,
} from "@corbits/webhooks";

// Host-owned: the hub's app, drizzle handle, credential cipher, key store,
// sidecar mail router, grant materializer, tenant-domain lookup, and the
// live trigger target (address/body/tenantId/subject).
declare const app: InstallWebhooksOpts["app"];
declare const db: InstallWebhooksOpts["db"];
declare const credentialCipher: InstallWebhooksOpts["credentialCipher"];
declare const principalKeyStore: InstallWebhooksOpts["principalKeyStore"];
declare const sidecarRouter: HookMailRouter;
declare const materialize: CreateRunTriggerDelivererOpts["materialize"];
declare const tenantDomain: CreateRunTriggerDelivererOpts["tenantDomain"];
declare const address: string;
declare const body: string;
declare const tenantId: string;
declare const subject: string | undefined;

await installWebhooks({
  app,
  db,
  credentialCipher,
  principalKeyStore,
  router: sidecarRouter,
});

const deliver = createRunTriggerDeliverer({
  router: sidecarRouter,
  materialize,
  tenantDomain,
  senderLocalPart: "webhook",
  systemSender: createTenantSystemSender({ db, principalKeyStore }),
});

try {
  await deliver.to(address, body, tenantId, subject);
} catch (error) {
  if (isRunTriggerUnroutable(error)) {
    console.error(error.code, error.address, error.runId);
  }
  throw error;
}
```

Bot tokens for media and chat integrations are separate `credentialBindings` — not this signing secret.

## How it works

`installWebhooks` mounts `POST /api/hooks` and builds a durable per-tenant system sender (`webhook@domain`) so the trigger mail's `From` verifies. Match unroutable deliveries with `isRunTriggerUnroutable` so callers that speak the `MailDeliverer` shape (e.g. `@corbits/cron`) see the same `address` and `runId`.

## Development

```sh
git clone https://github.com/corbitsdev/webhooks.git
cd webhooks
bun install
bun run typecheck
bun run test
```

`bun run test` is `bun test ./src`.

## License

LGPL-2.1-only.
