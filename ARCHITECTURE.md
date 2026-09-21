# @corbits/webhooks — Architecture

## Overview

`installWebhooks` is the host mount for credential-verified ingress. It
does not own credentials and it does not provision deployments. It
wires five pieces the host already has — HTTP app, database, credential
cipher, principal key store, sidecar mail router — into one path:

1. Resolve a tenant-owned credential that carries webhook metadata.
2. Verify the request with that secret.
3. Choose a live mail-triggered run in that tenant.
4. Deliver as a durable system sender (`webhook@domain`) so the run
   principal's grants and the trigger mail both verify.

Unroutable delivery is a first-class failure of step 4: the sidecar
refused grants or mail because the address has no live socket and no
disconnect queue. The error carries the address and run id so the
caller can settle the dead run.

Package-owned trigger CRUD and provisioned-launch ingress are a
separate product surface and are not part of this mount.

## Components

```
Host app + db + cipher + principal keys + sidecar router
        │
        ▼
┌─────────────────────┐
│ installWebhooks     │  materializer, system sender, deliverer, routes
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐     ┌──────────────────────┐
│ POST /api/hooks     │────▶│ load tenant-owned    │
│ (id / tenant+name)  │     │ credential + decrypt │
└──────────┬──────────┘     └──────────┬───────────┘
           │ verify                    │
           ▼                           ▼
┌─────────────────────┐     ┌──────────────────────┐
│ pick live run       │────▶│ MailDeliverer.to     │
│ (to / workflow /    │     │ createRunTrigger…    │
│  credential name)   │     └──────────┬───────────┘
└─────────────────────┘                │
                                       ▼
                        ┌──────────────────────────┐
                        │ materialize run grants   │
                        │ sendRunGrants + routeMail│
                        │ From: webhook@domain     │
                        └──────────┬───────────────┘
                                   │
                    false ◀────────┴────────▶ true
                    unroutable               delivered
                    (address, runId)
```

| Piece | Role |
| --- | --- |
| `installWebhooks` | One-shot composition. Builds the mail-triggered grants materializer, a per-tenant system sender with local part `webhook`, a run-trigger deliverer, and mounts hook routes at `/api/hooks`. Returns nothing; the HTTP path is the product. |
| Hook routes | Identify the hook, decrypt, verify, pick a destination, deliver. Slack URL verification short-circuits with a challenge and no mail. |
| Credential load | Tenant-owned (`principalId` null), active, with `metadata.webhook`. Personal credentials are not ingress keys. Name lookup is tenant-scoped; no cross-tenant scan. Collisions and misses are the same unknown. |
| Destination pick | Prefer explicit `to`, else workflow/asset name, else a unique live run whose definition or asset name matches the credential name. Zero matches and many matches both refuse delivery. Eligible addresses come only from already-live, tenant-scoped runs. |
| Run-trigger deliverer | Speaks `MailDeliverer`. Materializes grants as the run principal, co-delivers the system sender's public key on the grants barrier, then routes signed trigger mail. Shared with other system triggers (e.g. cron) through that shape alone. |
| System sender | One durable principal per tenant and local part, reused after mint. Kind is `user` so a non-run `From` still resolves to a hub-custodied key; any other kind would make recipient verification miss. |
| Unroutable error | Structural failure object: `code`, `address`, `runId`. Not an HTTP status. The HTTP handler maps any `deliver.to` throw to undeliverable. |

Persistence of credentials, tenants, and workflow runs is Interchange's.
This package reads them; it does not introduce a hook table.

## Install control flow

1. Construct a mail-triggered run-grants materializer from the host
   database, principal key store, and grant store.
2. Construct a deliverer whose sender local part is `webhook` and whose
   tenant domain is loaded from the tenant row. Missing tenant is a
   hard failure (no domain, no `From`).
3. Mount hook routes on the host app at `/api/hooks`.
4. On each POST: resolve hook identity from path, `x-webhook-hook`, or
   `hook` query; resolve tenant hint from `tnt_…` path segment,
   `x-tenant-id`, or `tenant` query; load; verify; pick; deliver.

`installWebhooks` does not return the deliverer. Hosts that need the
same `MailDeliverer` (cron, scripts) construct `createRunTriggerDeliverer`
themselves with their own local part.

## Run-trigger delivery

Destination must be a live run address. The deliverer derives the run
id, materializes grants, and refuses anything that is not a materialized
workflow deployment.

On success it:

1. Resolves `localPart@domain` and the matching durable key.
2. Calls `sendRunGrants` with the step grants **and** the system
   sender's address/public key, so the recipient can verify the
   following mail against a key the hub vouches for — the same shape as
   a person-originated trigger.
3. Assembles signed conversation mail (`From` the system sender, `To`
   the run) and calls `routeMail`.

Grants are a barrier: if grants are unroutable, mail is not sent. If
grants succeed and mail is unroutable, the grants already left; the
error still names the same address and run.

## Unroutable error

A system trigger the sidecar could not route: no live socket and no
disconnect queue (sidecar gone — e.g. a stale `running` anchor from a
previous stack).

Two codes, one matcher:

- Grants barrier refused → grants-not-routable.
- Mail route refused after grants → mail-not-routable.

Match with `isRunTriggerUnroutable`, not `instanceof`. Cron and other
callers stay on the `MailDeliverer` shape and must not take a package
dependency just to recognize the failure. The matcher is structural:
object with a known `code` and string `address` and `runId`.

The error message keeps the legacy `"run grants not routable"` /
`"run mail not routable"` prefix so existing logs still grep.

This is distinct from:

- Destination is not a run address.
- Grants materialize as rejected / not a workflow deployment.
- HTTP undeliverable/ambiguous when no unique live run matches the hook.

Those stay ordinary errors. Only sidecar-routing false is unroutable.

## HTTP vs library

The mounted routes never leak unroutable fields to the webhook client.
A failed `deliver.to` is undeliverable. Vault decrypt failures and run
lookup failures are server errors. Unknown or colliding hooks are
unknown (no tenant leak). Failed verify is unauthorized.

Library callers of `MailDeliverer.to` see the typed unroutable object
and can settle the run.

## Failure modes

| Condition | Behavior |
| --- | --- |
| No hook id | Unknown hook. |
| Missing / inactive / personal / no webhook metadata | Unknown hook. |
| Name without tenant hint | No scan; unknown hook. |
| Multiple matching hooks | Unknown hook (do not leak collision). |
| Decrypt failure | Vault error. |
| Verify miss or unknown verify | Unauthorized. No `none` verify. |
| Slack URL verification after verify | Echo challenge; no mail. |
| Live-run lookup failure | Lookup error. |
| Zero matching live runs | Undeliverable. |
| Several matching live runs | Ambiguous destination. |
| Tenant row missing at send | Deliver throws; HTTP undeliverable. |
| `sendRunGrants` false | `RunTriggerUnroutable` grants code; no mail. |
| `routeMail` false | `RunTriggerUnroutable` mail code; grants already sent. |
| Other deliver throw | HTTP undeliverable; library sees the error. |

## Out of scope

- `mountWebhookTrigger` and a package-owned trigger table
- Minting HMAC secrets as a CRUD resource
- Provisioning a new workflow deployment from a hook
- Credential create/rotate/revoke APIs
- Binding tokens used *inside* a workflow (bot tokens, Giphy, …)
