# @corbits/webhooks — Product

## What it is

A mount that turns inbound HTTP into a live Interchange `onTrigger`. The
caller proves a tenant-owned vault secret; the workflow then runs as that
deployment's run principal, not as the credential owner and not as a
session user. The signing credential is only how you got in.

This document covers `installWebhooks` and the unroutable-delivery
signal that callers use when a live address has no sidecar. It is intent
and scope, not a route catalog. The shipped export surface is in
`README.md`.

## Why it exists

Hosts already store Interchange credentials (`POST /credentials`,
`credential:*`). They should not grow a second secret table just to
accept a webhook. They also should not fire a workflow as the vault
principal that signed the request — mail-triggered grants exist so the
run is the principal.

When the destination sidecar is gone, a bare "not routable" log is not
enough. Operators and sibling packages (`@corbits/cron` on the same
deliverer shape) need the address and run id so they can fail the tick
and settle the dead run instead of retrying forever.

## Who it is for

- Interchange hub operators who mount inbound hooks on an existing app
  and database.
- Hosts that already own credential create/list/revoke and only need
  `POST /api/hooks`.
- Callers that speak the `MailDeliverer` shape and must distinguish a
  dead sidecar from other delivery failures.

## What users can do

- Mount `installWebhooks` so `POST /api/hooks` verifies a tenant-owned
  credential and delivers trigger mail to a live run address.
- Point a hook at a live deployment by credential id, tenant-scoped
  name, explicit `to` address, or workflow/asset name.
- Treat Slack `url_verification` as a handshake (echo the challenge; no
  mail).
- Catch unroutable deliveries with `isRunTriggerUnroutable` and read
  `code`, `address`, and `runId` — including from a process that never
  imported this package.

## What it is not

- Not credential CRUD. Credentials stay Interchange's.
- Not a second trigger product. Package-owned `webhook_trigger` rows,
  HMAC-minted trigger CRUD, and `mountWebhookTrigger` (Workbench-ported
  provisioned launches) are out of this document's scope.
- Not unsigned ingress. `metadata.webhook.verify` is required; there is
  no `none`.
- Not a session-scoped user send. The run principal is the actor.

## Goals

1. One mount: inbound HTTP in, mail-triggered run grants out.
2. Keep the signing secret off the run. The workflow runs as
   `deriveRunPrincipalId(tenantId, runId)`.
3. Fail a dead sidecar with identity (`address`, `runId`), not a
   string-only log, and match that failure structurally so
   dependency-free callers see the same contract.

## Out of scope (this stack)

- Creating, listing, rotating, or deleting webhook-trigger rows.
- Launching a *new* provisioned deployment from a hook (this mount
  routes to an already-live run).
- Binding Slack/Giphy bot tokens; those are separate
  `credentialBindings`, not the signing secret.
