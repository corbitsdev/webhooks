# @corbits/webhooks

[![npm](https://img.shields.io/npm/v/@corbits/webhooks.svg)](https://www.npmjs.com/package/@corbits/webhooks) [![License: LGPL-2.1](https://img.shields.io/badge/license-LGPL--2.1-green.svg)](https://github.com/corbitsdev/webhooks/blob/main/LICENSE)

Signed webhook ingress for Interchange workflows: verifies a Slack, Standard Webhooks or bearer request against a hub credential, then delivers the body as trigger mail to a live workflow run. A Corbits hub module, mounted as Hono routes on the Interchange hub (Interchange's multi-tenant control plane, where a principal is an identity and a grant is a permission it holds) and backed by its Postgres.

## Why @corbits/webhooks?

1. **Secrets stay in the hub.** Each hook is an ordinary Interchange credential with `metadata.webhook`; this package stores nothing of its own.
2. **Runs never borrow a person's authority.** The workflow runs as its own run principal (the identity Interchange derives for each run) through the hub's mail-triggered grant path, never as the credential owner.
3. **Three verifiers, no unsigned mode.** Slack signatures, Standard Webhooks HMAC and bearer tokens. A credential without a verifier matches no hook.

Use it to start workflows from third-party events. It does not fire on a schedule; `@corbits/cron` does, through a deliverer of the same shape.

## Install

```bash
bun add @corbits/webhooks \
  @intx/crypto @intx/db @intx/hub-api @intx/hub-common @intx/mime @intx/types hono
```

The `@intx/*` peers are `^0.4.0`; `hono` is `^4.11.9`.

## Where it fits

- **Hub side.** Routes mount on the hub's Hono app. Credentials and tenants come from `@intx/db`; run grants come from `@intx/hub-api`'s mail-triggered materializer.
- **Sidecar side.** Trigger mail and run grants reach the run's sidecar (the agent runtime) through the hub's router.
- **Siblings.** [`@corbits/cron`](https://github.com/corbitsdev/corbits-cron) fires scheduled runs through the same `MailDeliverer` contract; `createRunTriggerDeliverer` builds one.

## Reference

### Routes

| Route                             | Resolves the hook by                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/hooks/:id`             | Credential id (`crd_…`). Preferred.                                           |
| `POST /api/hooks/:tenantId/:name` | Credential name, scoped to the tenant.                                        |
| `POST /api/hooks`                 | `x-webhook-hook` header or `?hook=`; tenant from `x-tenant-id` or `?tenant=`. |

Responses: `202` delivered, `200 { challenge }` for Slack `url_verification`, `401` bad signature, `404` unknown hook (misses and name collisions look the same), `409` more than one live run matches, `503` no live run or delivery failed, `500` credential lookup failed.

### `metadata.webhook`

| Field      | Value                                                          |
| ---------- | -------------------------------------------------------------- |
| `verify`   | `"bearer"`, `"standard-webhooks"` or `"slack"`. Required.      |
| `workflow` | Name of a live deployment's definition or asset in the tenant. |
| `to`       | A live run address in the tenant, instead of `workflow`.       |

With neither set, the credential name is matched against definition and asset names, then the tenant's only live run. A live run has status `deployed` or `running`.

With `standard-webhooks`, a `whsec_…` secret is base64-decoded before use as the HMAC key; any other secret is used as-is. Bot tokens for chat integrations belong in the workflow's `credentialBindings`, not in the signing secret.

### Exports

| Export                                                | Purpose                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `createHookRoutes(deps)`                              | The hook routes as a Hono sub-app.                                         |
| `createRunTriggerDeliverer(opts)`                     | Delivers trigger mail to a live run as its run principal.                  |
| `createTenantSystemSender({ db, principalKeyStore })` | Durable per-tenant sender (`<localPart>@domain`) that signs trigger mail.  |
| `isRunTriggerUnroutable(error)`                       | Narrows to `{ code, address, runId }` when the router has no route.        |
| `RUN_GRANTS_NOT_ROUTABLE`, `RUN_MAIL_NOT_ROUTABLE`    | The two `code` values.                                                     |
| `RunTriggerUnroutableError`                           | The error `isRunTriggerUnroutable` matches.                                |
| `HookMailRouter`                                      | Router type the host passes in: `routeMail` and `sendRunGrants`.           |
| `MailDeliverer`                                       | `{ to(address, content, tenantId, subject) }`, what the deliverer returns. |

## Using with Interchange

Build the routes from the hub's database, credential cipher and principal key store:

```ts
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createPrincipalKeyStore } from "@intx/db";
import { hexDecode } from "@intx/types";
import { createHookRoutes, type HookMailRouter } from "@corbits/webhooks";

const { db } = createDB({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "interchange",
});

export const hookRoutes = (router: HookMailRouter) =>
  createHookRoutes({
    db,
    credentialCipher: createEnvKeyCredentialCipher(
      hexDecode(String(process.env["CREDENTIAL_ENCRYPTION_KEY"])),
    ),
    principalKeyStore: createPrincipalKeyStore({
      db,
      cipher: createEnvKeyCredentialCipher(
        hexDecode(String(process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"])),
      ),
    }),
    router,
  });
```

`router` is the hub's sidecar mail router. Mount the result at `/api/hooks` outside the hub's session and tenant middleware: senders carry a signature, not a session, and the tenant comes from the hook's credential.

Deploy a workflow that uses `onTrigger({ on: { type: "mail", to } })` from `@intx/workflow`. Then create a provider and a tenant credential that points at it:

```bash
curl -X POST "$HUB/api/tenants/$TNT/providers" \
  -H "content-type: application/json" -H "cookie: $COOKIE" \
  -d '{"name":"webhooks","plugin":"api_key"}'

curl -X POST "$HUB/api/tenants/$TNT/credentials" \
  -H "content-type: application/json" -H "cookie: $COOKIE" \
  -d '{
    "name": "my-hook",
    "providerId": "prv_…",
    "type": "api_key",
    "secret": "'"$SECRET"'",
    "metadata": { "webhook": { "verify": "standard-webhooks", "workflow": "my-workflow" } }
  }'
```

Send a signed POST to the credential id the second call returned:

```bash
ID=msg_1 TS=$(date +%s) BODY='{"text":"hi"}'
SIG=$(printf '%s' "$ID.$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -X POST "$HUB/api/hooks/crd_…" \
  -H "content-type: application/json" \
  -H "webhook-id: $ID" -H "webhook-timestamp: $TS" -H "webhook-signature: v1,$SIG" \
  -d "$BODY"
```

The hub answers `202 { "ok": true, "to": "run_…@acme.example" }` and the run starts.

## Upgrading from 0.1

- `installWebhooks(opts)` is removed. Call `app.route("/api/hooks", createHookRoutes(deps))` with the same `db`, `credentialCipher`, `principalKeyStore` and `router`; drop `app` from the options.
- `@intx/*` and `hono` moved to peer dependencies. Add them to the host.
- Existing hook credentials and URLs keep working unchanged when the routes stay mounted at `/api/hooks`.

## License

LGPL-2.1-only.
