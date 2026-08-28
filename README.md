# @corbits/webhooks

Inbound HTTP → check the vault secret → **mail** a workflow's `onTrigger`.

Credentials are Interchange's (`POST /credentials`). This package only adds `POST /api/hooks/:id`.

---

## 1. Workflow listens on mail

The workflow must already be deployed with an `onTrigger` mail address:

```ts
onTrigger({ on: { type: "mail", to: "jimmy@localhost" } })
```

`ez push` that package. Direct mail to `jimmy@localhost` (or `run_…@domain`) should already fire it. The webhook is just verified ingress onto that same address.

---

## 2. Create the webhook (a credential)

A webhook **is** a vault credential. The secret is the signing key. `metadata.webhook` is what connects it to the trigger.

Provider once (any `api_key` provider is fine):

```bash
curl -X POST "$HUB/api/tenants/$TNT/providers" \
  -H "content-type: application/json" -H "cookie: $COOKIE" \
  -d '{"name":"webhooks","plugin":"api_key"}'
# → { "id": "prv_…" }
```

Then the hook:

```bash
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
        "to": "jimmy@localhost"
      }
    }
  }'
```

That is the whole connection: **`to` is the workflow `onTrigger` address.**

| `metadata.webhook` | |
|---|---|
| `verify` | How to check the POST: `none` \| `bearer` \| `standard-webhooks` \| `slack` |
| `to` | Mail address the workflow listens on (the usual way) |
| `workflow` | Optional. Asset/definition name of a live deploy, if you don't want to hardcode `to` |

Authz is the existing `credential:*` grants. Rotate the secret with `PATCH` on that credential. No host restart.

---

## 3. Point the sender at the hub

```
POST $HUB/api/hooks/slack
```

`:id` is the credential **name** (`slack`) or **id** (`crd_…`).

```
Slack signing secret ──► vault credential "slack"
POST /api/hooks/slack ──► HMAC ──► mail jimmy@localhost ──► jimmy onTrigger
```

If the name isn't unique across tenants, pass `x-tenant-id` or use `crd_…`.

`verify: "slack"` also echoes Slack `url_verification` challenges (no mail).

---

## Host (once)

```ts
import { installWebhooks } from "@corbits/webhooks";

await installWebhooks({ app, db, credentialCipher, sessionService });
```

No hook list. New credentials with `metadata.webhook` start working on the next POST.

Jimmy's Giphy / Slack *bot token* credentials are separate — those are `credentialBindings` on the workflow, not this signing secret.

## License

LGPL-2.1
