# @corbits/webhooks

Inbound HTTP → check a tenant-owned vault secret → fire a live `onTrigger` as that deployment's run principal. The signing cred is only how you got in. The workflow runs as `deriveRunPrincipalId(tenantId, runId)` — Interchange's mail-triggered grant path, not the credential owner. Credentials stay Interchange's (`POST /credentials`, `credential:*`); this package adds `POST /api/hooks`.

## Runtime support

`package.json` does not declare `engines`. The published entry point is compiled output (`./dist/index.js` with types at `./dist/index.d.ts`); both Bun and native Node consume it directly.

## Quickstart

```sh
npm add @corbits/webhooks
pnpm add @corbits/webhooks
yarn add @corbits/webhooks
bun add @corbits/webhooks
```

The host provides the peers: `@intx/crypto`, `@intx/db`, `@intx/hub-api`, `@intx/hub-common`, `@intx/mime`, `@intx/types` (`^0.4.0`) and `hono` (`^4.11.9`).

`createHookRoutes(deps)` returns a Hono sub-app; mount it outside session and tenant middleware at a path you pick. Every dep is one a hub already has from its own boot sequence:

| `deps` | Type | What the host provides |
| --- | --- | --- |
| `db` | `DB["db"]` (from `@intx/db`) | The host's existing drizzle handle. |
| `credentialCipher` | `CredentialCipher` (from `@intx/types`) | Decrypts the vault secret a hook's credential carries. |
| `principalKeyStore` | `PrincipalKeyStore` (from `@intx/db`) | Signs the trigger mail as the run's own principal. |
| `router` | `HookMailRouter` | Delivers the trigger mail once a hook fires. A hub backs this with its live sidecar router. |

```ts
import { createHookRoutes } from "@corbits/webhooks";

app.route(
  "/api/hooks",
  createHookRoutes({ db, credentialCipher, principalKeyStore, router }),
);
```

Bot tokens for media and chat integrations are separate `credentialBindings` — not this signing secret.

### Lower-level: `createRunTriggerDeliverer` and `createTenantSystemSender`

`createHookRoutes` builds its own deliverer internally from these two exports; a host reaches for them directly only when it is driving trigger mail outside a hook — for example `@corbits/cron`'s ticker points a due schedule at the very same `createRunTriggerDeliverer`, given a `HookMailRouter` and a `PrincipalKeyStore`, so cron and webhooks fire through one system-trigger path. `createTenantSystemSender({ db, principalKeyStore })` gives that deliverer a durable per-tenant identity (`<senderLocalPart>@domain`) the trigger mail is signed and authenticated as. Match a delivery that couldn't route with `isRunTriggerUnroutable(error)`, which narrows to `{ code, address, runId }` — `code` is `RUN_GRANTS_NOT_ROUTABLE` or `RUN_MAIL_NOT_ROUTABLE`.

## How it works

`createHookRoutes` serves the hook POST and builds a durable per-tenant system sender (`webhook@domain`) so the trigger mail's `From` verifies. Match unroutable deliveries with `isRunTriggerUnroutable` so callers that speak the `MailDeliverer` shape (e.g. `@corbits/cron`) see the same `address` and `runId`.

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
