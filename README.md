# @corbits/webhooks

Adds **one** thing: `POST /api/hooks/:id`.

Credentials, vault, and authz are Interchange's (`POST /credentials`, `credential:*`). This package does not add a credential API.

```ts
await installWebhooks({ app, db, credentialCipher, sessionService });
```

`id` is an Interchange credential name or `crd_…`. The row's **secret** is the signing key. Opt a credential in with existing metadata:

```json
{
  "name": "slack",
  "secret": "…",
  "metadata": { "webhook": { "verify": "slack", "workflow": "jimmy" } }
}
```

`verify`: `none` | `bearer` | `standard-webhooks` | `slack`. After that check, mail a live `onTrigger` deployment (`metadata.webhook.to`, or `workflow`, or the tenant's only live run).

```
POST /api/hooks/slack
POST /api/hooks          + x-webhook-hook: slack
```

## License

LGPL-2.1
