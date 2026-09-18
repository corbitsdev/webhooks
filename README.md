# @corbits/webhooks

Inbound HTTP → check a **tenant-owned** vault secret → fire a **live** `onTrigger` as that deployment's **run principal**.

The signing cred is only how you got in. The workflow runs as `deriveRunPrincipalId(tenantId, runId)` — Interchange's mail-triggered grant path, not the credential owner.

Credentials, grants, and authz are Interchange's (`POST /credentials`, `credential:*`). This package only adds `POST /api/hooks`.

---

## 1. Workflow listens on mail

Deploy a workflow with `onTrigger({ on: { type: "mail", to } })`. After `ez push` it has a live address (`run_…@domain`).

---

## 2. Create the webhook (a credential)

Setting a hook **is** creating a tenant credential. That write is already gated by `credential:*` / `create`.

```bash
curl -X POST "$HUB/api/tenants/$TNT/providers" \
  -H "content-type: application/json" -H "cookie: $COOKIE" \
  -d '{"name":"webhooks","plugin":"api_key"}'
# → { "id": "prv_…" }

curl -X POST "$HUB/api/tenants/$TNT/credentials" \
  -H "content-type: application/json" -H "cookie: $COOKIE" \
  -d '{
    "name": "slack",
    "providerId": "prv_…",
    "type": "api_key",
    "secret": "YOUR_SIGNING_SECRET",
    "metadata": {
      "webhook": {
        "verify": "slack",
        "workflow": "jimmy"
      }
    }
  }'
# → { "id": "crd_…" }
```

| `metadata.webhook` | |
|---|---|
| `verify` | `bearer` \| `standard-webhooks` \| `slack` (required; there is no `none`) |
| `workflow` | Live deployment whose definition or asset name matches |
| `to` | Live run **address in this tenant** (`run_…@domain`). Foreign addresses are ignored. |

Org credentials only (`principalId` null). Personal creds are not ingress keys. Rotate with `PATCH` on that credential.

---

## 3. Point the sender at the hub

Prefer the credential id (unguessable, unique):

```
POST $HUB/api/hooks/crd_…
```

Name is tenant-scoped — put the tenant in the path (or `x-tenant-id`):

```
POST $HUB/api/hooks/$TNT/slack
```

```
HMAC with vault "slack"
  → live jimmy run in that tenant
  → onTrigger mail
```

`verify: "slack"` echoes Slack `url_verification` (no mail).

---

## Host (once)

```ts
await installWebhooks({
  app,
  db,
  credentialCipher,
  principalKeyStore,
  router: sidecarRouter,
});
```

Jimmy's Giphy / Slack *bot token* are separate `credentialBindings` — not this signing secret.

## System sender identity

A system trigger (webhook, cron) is signed by a **durable per-tenant sender**,
not a throwaway key: one `kind: "user"` principal per tenant and local part
(`webhook@domain`, `cron@domain`), minted on first use with its key in the
principal key store. That address is the mail's `From`, the
`authenticatedSender` on `routeMail`, and the `senderIdentities` entry
co-delivered on the run's grants barrier — so the recipient verifies the
signature against the key the hub vouches for. A throwaway key resolves to
`unknown`/`invalid`, which the default admission policy rejects.

`installWebhooks` builds it. A host wiring `createRunTriggerDeliverer`
directly (cron) passes it too:

```ts
createRunTriggerDeliverer({
  router,
  materialize,
  tenantDomain,
  senderLocalPart: "cron",
  systemSender: createTenantSystemSender({ db, principalKeyStore }),
});
```

## License

LGPL-2.1
