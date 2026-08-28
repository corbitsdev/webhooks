# @corbits/webhooks

Inbound HTTP → check a **tenant-owned** vault secret → mail a **live** `onTrigger` in that same tenant.

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
await installWebhooks({ app, db, credentialCipher, sessionService });
```

Jimmy's Giphy / Slack *bot token* are separate `credentialBindings` — not this signing secret.

## License

LGPL-2.1
