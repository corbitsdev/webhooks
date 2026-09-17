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
await installWebhooks({ app, db, credentialCipher, router: sidecarRouter });
```

Jimmy's Giphy / Slack *bot token* are separate `credentialBindings` — not this signing secret.

---

## Webhook triggers: package-owned trigger CRUD + HMAC ingress

The `installWebhooks`/`POST /api/hooks` flow above resolves an inbound
delivery against an existing Interchange **credential** and fires an
already-live run. `mountWebhookTrigger` is a second, independent flow
for hosts that want a package-owned trigger row instead: a
tenant-scoped CRUD surface that mints its own HMAC secret per trigger,
and an ingress endpoint that **launches a new provisioned deployment**
of a workflow definition rather than routing to an already-live run.

Migrations ship in the package, the same way `installWebhooks` expects
no migration step of its own — `mountWebhookTrigger` requires the
`webhook_trigger` schema/table to already exist:

```ts
import { applyWebhookTriggerMigrations, mountWebhookTrigger } from "@corbits/webhook";

await applyWebhookTriggerMigrations(db);

mountWebhookTrigger({
  app,
  mountPath: `${TENANT_PREFIX}/webhook-triggers`,
  ingressPath: "/api/webhooks", // MUST be outside any tenant-resolution middleware
  management: {
    store: createDrizzleWebhookTriggerStore(db, credentialCipher),
    requireGrant,
    generateId: () => generateId("workflowRun"), // any host id scheme
    workflowDefinitionInTenant: (tenantId, definitionId) => /* ... */,
  },
  ingress: {
    store: createDrizzleWebhookTriggerStore(db, credentialCipher),
    launch: (trigger, payload) =>
      launchWebhookTrigger(launchDeps, trigger, payload),
  },
});
```

`launchWebhookTrigger`'s deps (`LaunchWebhookTriggerDeps` in
`trigger-launch.ts`) are all host-supplied callbacks rather than
imports from any workflow-authoring package: `resolveAssetCommitSha`,
`prepareProvisionedDeployment`, `sendUserMessage`,
`prepareDeployContent` (folds a definition's asset projection and
grant requirements into a system prompt + tool-package pins),
`afterProvision` (records the agent session), `deliverWhenRoutable`,
and `onDeliveryError`. A host wires each to its own native
implementation of that concern — this package only orchestrates the
order they run in and owns the trigger row, the HMAC verification, and
the input-template rendering.

**Left behind in Workbench, not ported:** the `repo_review_lease`
table and `RepoReviewLeaseStore` that used to live alongside the
trigger table. That lease closes a concurrency race specific to
Workbench's GitHub connect card (`packages/connections`'
`startReviewingRepos`) and has nothing to do with webhook triggers as
a concept — it stays in Workbench's own `packages/connections`.

## License

LGPL-2.1
