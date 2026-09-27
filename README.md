# @corbits/webhooks

Signed webhook ingress for Interchange workflows: verifies a Slack, Standard Webhooks or bearer request against a hub credential, then delivers the body as trigger mail to a live workflow run. A Corbits hub module, mounted as Hono routes on the Interchange hub (Interchange's multi-tenant control plane, where a principal is an identity and a grant is a permission it holds) and backed by its Postgres.

## Why @corbits/webhooks?

1. **Secrets stay in the hub.** Each hook is an ordinary Interchange credential with `metadata.webhook`. The only thing this package stores is a short-lived table of seen delivery ids.
2. **Runs never borrow a person's authority.** The workflow runs as its own run principal (the identity Interchange derives for each run) through the hub's mail-triggered grant path, never as the credential owner.
3. **Three verifiers, no unsigned mode.** Slack signatures, Standard Webhooks HMAC and bearer tokens. A credential without a verifier matches no hook.

Use it to start workflows from third-party events. It does not fire on a schedule; `@corbits/cron` does, through a deliverer of the same shape.

## Install

```bash
bun add @corbits/webhooks \
  @intx/crypto @intx/db @intx/hub-api @intx/hub-common @intx/mime @intx/types drizzle-orm hono postgres
```

The `@intx/*` peers are `^0.4.0`, `drizzle-orm` is `^0.45.1`, `hono` is `^4.11.9` and `postgres` is `^3.4.8`.

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

With `standard-webhooks`, the secret is base64-decoded after stripping an optional `whsec_` prefix, as the spec requires. An unprefixed secret also verifies when the sender used it as raw bytes, which is how 0.1 read it. `bearer` rejects an empty secret.

A replayed delivery gets `409`. Standard Webhooks deliveries are keyed on the credential and `webhook-id`, Slack on the credential and signature, each kept until its timestamp leaves the ±300s window. The seen-set is the `replay` table in the `webhooks` schema, created by `runWebhookMigrations` (see [Using with Interchange](#using-with-interchange)), so every replica sharing the database rejects the replay. A failed delivery releases its key so the sender's retry goes through. Bearer requests carry no id and are not deduplicated.

Signatures are checked over the raw request bytes, and the body is forwarded unchanged. Bodies over 1 MiB get `413`; a verified body that is not UTF-8 gets `415`. Bot tokens for chat integrations belong in the workflow's `credentialBindings`, not in the signing secret.

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

### `runWebhookMigrations(dbConfig, { schema })`

From `@corbits/webhooks/migrations`. Run it after Interchange's `runMigrations`, with the same config and the same `schema`: the host schema that holds the `credential` table. The `replay` table always lives in the `webhooks` schema. It is idempotent and takes an advisory lock, so several replicas can start at once.

## Using with Interchange

Run `runWebhookMigrations` at hub start, after `runMigrations`, then build the routes from the hub's database, credential cipher and principal key store:

```ts
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createPrincipalKeyStore, runMigrations } from "@intx/db";
import { hexDecode } from "@intx/types";
import { createHookRoutes, type HookMailRouter } from "@corbits/webhooks";
import { runWebhookMigrations } from "@corbits/webhooks/migrations";

const dbConfig = {
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "interchange",
};
await runMigrations(dbConfig, { schema: "public" });
await runWebhookMigrations(dbConfig, { schema: "public" });

const { db } = createDB(dbConfig);

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
- Run `runWebhookMigrations` at hub start, after `runMigrations`; replay protection needs its table.
- Existing hook credentials and URLs keep working unchanged when the routes stay mounted at `/api/hooks`.

## License

LGPL-2.1-only.
