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

The program below is complete: it opens a handle with `createDB`, mounts `POST /api/hooks` on a fresh Hono app, and fires a demo trigger through the same deliverer a hook uses. No sidecar is connected here, so the demo trigger reports unroutable — the `catch` shows how a host matches that case.

```ts
import { createNoopCredentialCipher } from "@intx/crypto";
import { createDB } from "@intx/db";
import { Hono } from "hono";
import {
  createRunTriggerDeliverer,
  createTenantSystemSender,
  installWebhooks,
  isRunTriggerUnroutable,
  type HookMailRouter,
} from "@corbits/webhooks";

// Stubbed connection: this program is typechecked, never run, against it.
const { db } = createDB({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "webhooks",
  schema: "webhooks",
});

// No sidecar is connected here, so both router hooks decline delivery.
const sidecarRouter: HookMailRouter = {
  routeMail: () => false,
  sendRunGrants: () => false,
};

// The two-method key shape this package calls. A real hub backs it with
// its principal keys.
const principalKeyStore = {
  getPublicKey: async (): Promise<string> => "00",
  sign: async (_principalId: string, input: Uint8Array): Promise<Uint8Array> =>
    input,
};

const app = new Hono();
await installWebhooks({
  app,
  db,
  credentialCipher: createNoopCredentialCipher(),
  principalKeyStore,
  router: sidecarRouter,
});

const deliver = createRunTriggerDeliverer({
  router: sidecarRouter,
  materialize: async () => ({ outcome: "materialized", stepGrants: {} }),
  tenantDomain: async () => "example",
  senderLocalPart: "webhook",
  systemSender: createTenantSystemSender({ db, principalKeyStore }),
});

try {
  await deliver.to("run_demo@example", "hello from a hook", "demo", undefined);
} catch (error) {
  if (isRunTriggerUnroutable(error)) {
    console.error(error.code, error.address, error.runId);
  }
  throw error;
}

export default app;
```

The inline `principalKeyStore` implements exactly the two methods this package calls (`getPublicKey`/`sign`). `createNoopCredentialCipher` is the local-development cipher — production uses an env-key cipher. The inline router declines everything because there is no sidecar; a real hub wires its own mail router in its place.

Bot tokens for media and chat integrations are separate `credentialBindings` — not this signing secret.

## How it works

`installWebhooks` mounts `POST /api/hooks` and builds a durable per-tenant system sender (`webhook@domain`) so the trigger mail's `From` verifies. Match unroutable deliveries with `isRunTriggerUnroutable` so callers that speak the `MailDeliverer` shape (e.g. `@corbits/cron`) see the same `address` and `runId`.

Setting a hook is creating a tenant org credential (`principalId` null) on a workflow deployed with `onTrigger({ on: { type: "mail", to } })`. After deploy it has a live address (`run_…@domain`):

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

`metadata.webhook.verify` is `bearer` | `standard-webhooks` | `slack` (required; there is no `none`). `workflow` is a live deployment whose definition or asset name matches; `to` is a live run address in this tenant. Prefer the credential id (`POST $HUB/api/hooks/crd_…`); the name form is tenant-scoped (`POST $HUB/api/hooks/$TNT/slack`). `verify: "slack"` echoes Slack `url_verification` (no mail).

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
