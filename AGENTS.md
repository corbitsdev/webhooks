# AGENTS.md

## Purpose

`@corbits/webhooks` is signed webhook ingress for Interchange workflows. It
owns the hook routes, the Slack, Standard Webhooks and bearer verifiers, hook
resolution, and delivery of the body as trigger mail to a live run. It does not
own credentials (they are Interchange credentials with `metadata.webhook`),
storage of its own, or scheduling (`@corbits/cron`).

## Layout

- `src/routes.ts`: `createHookRoutes`, the Hono sub-app for `/api/hooks`.
- `src/verify.ts`: the three signature verifiers.
- `src/resolve.ts`: credential lookup and target run resolution.
- `src/hooks.ts`: the request handler that ties verify, resolve and deliver.
- `src/deliver.ts`: `createRunTriggerDeliverer` and the unroutable errors.
- `src/system-sender.ts`: `createTenantSystemSender`, the per-tenant signer of
  trigger mail.
- `src/index.ts`: the only module consumers import from.
- `e2e/`: real-Postgres suites, gated on the libpq `PG*` variables.

## Rules

- The signing credential only authenticates the request. The workflow runs as
  its own run principal, `deriveRunPrincipalId(tenantId, runId)`, through
  Interchange's mail-triggered grant path, never as the credential owner.
- Trigger mail is signed by the durable per-tenant system sender
  (`webhook@domain`), whose key is co-delivered on the run-grants barrier.
- No unsigned mode: a credential without a verifier matches no hook.
- Unknown hooks and name collisions both answer `404`.
- `exactOptionalPropertyTypes` is on: omit optional keys, never assign
  `undefined` to them.

## Local development

```sh
bun install
bun run check
```
