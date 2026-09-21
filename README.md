# @corbits/webhooks

Inbound HTTP → check a tenant-owned vault secret → fire a live `onTrigger` as that deployment's run principal. The signing cred is only how you got in. The workflow runs as `deriveRunPrincipalId(tenantId, runId)` — Interchange's mail-triggered grant path, not the credential owner. Credentials stay Interchange's (`POST /credentials`, `credential:*`); this package adds `POST /api/hooks`.

## Install

```sh
npm add @corbits/webhooks
pnpm add @corbits/webhooks
yarn add @corbits/webhooks
bun add @corbits/webhooks
```

## Use

Deploy a workflow with `onTrigger({ on: { type: "mail", to } })`. After `ez push` it has a live address (`run_…@domain`). Setting a hook is creating a tenant org credential (`principalId` null):

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
    "secret": "<vault secret>",
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

## Full example

```ts
import {
  createRunTriggerDeliverer,
  createTenantSystemSender,
  installWebhooks,
  isRunTriggerUnroutable,
} from "@corbits/webhooks";

await installWebhooks({
  app,
  db,
  credentialCipher,
  principalKeyStore,
  router: sidecarRouter,
});

const deliver = createRunTriggerDeliverer({
  router,
  materialize,
  tenantDomain,
  senderLocalPart: "cron",
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

Jimmy's Giphy / Slack bot token are separate `credentialBindings` — not this signing secret.

## How it works

`installWebhooks` mounts `POST /api/hooks` and builds a durable per-tenant system sender (`webhook@domain`) so the trigger mail's `From` verifies. Match unroutable deliveries with `isRunTriggerUnroutable` — not `instanceof` — so callers that only speak the `MailDeliverer` shape (e.g. `@corbits/cron`) see the same `address` and `runId`.

## Contributing

```sh
bun install
bun run typecheck
bun run test
```

`bun run test` is `bun test ./src`.

## License

LGPL-2.1-only.
