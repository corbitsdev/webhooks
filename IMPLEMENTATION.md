# @corbits/webhooks — Implementation

## Package

- Name: `@corbits/webhooks` `0.1.2`
- License: LGPL-2.1-only
- Published as TypeScript source. `exports` point at `./src/index.ts`;
  there is no build step and no `dist/`.
- `package.json` does not declare `engines`. Bun consumes this source
  directly. Native Node does not load extensionless TypeScript as-is.
- These design docs live at the repository root. The npm tarball
  currently ships `src`, `README.md`, and `LICENSE`.

## Public exports

From `@corbits/webhooks`:

- `installWebhooks`, `InstallWebhooksOpts`
- `createRunTriggerDeliverer`, `CreateRunTriggerDelivererOpts`
- `isRunTriggerUnroutable`, `RunTriggerUnroutableError`,
  `RunTriggerUnroutableCode`
- `RUN_GRANTS_NOT_ROUTABLE` (`"run_grants_not_routable"`)
- `RUN_MAIL_NOT_ROUTABLE` (`"run_mail_not_routable"`)
- `HookMailRouter`, `MailDeliverer`, `RunTriggerMaterialize`
- `createTenantSystemSender`, `CreateTenantSystemSenderOpts`,
  `SystemSender`, `SystemSenderIdentity`

Consumers import only this surface. Hook routes, credential load, and
verify helpers are not exported.

## `installWebhooks`

```ts
await installWebhooks({
  app,                  // { route(path: string, handler: Hono): unknown }
  db,                   // DB["db"] from @intx/db
  credentialCipher,     // CredentialCipher from @intx/types
  principalKeyStore,    // PrincipalKeyStore from @intx/db
  router,               // HookMailRouter (sidecar)
});
```

Composition (returns `void`):

1. `createMailTriggeredRunGrantsMaterializer({ db, principalKeyStore, grantStore: createGrantStore(db) })` from `@intx/hub-api` / `@intx/db`.
2. `createRunTriggerDeliverer` with `senderLocalPart: "webhook"`,
   `tenantDomain` from `db.query.tenant.findFirst` (throws
   `"tenant not found"`), and `createTenantSystemSender({ db, principalKeyStore })`.
3. `app.route("/api/hooks", createHookRoutes({ deliver, loadHook, listRuns }))`.

## Routes

Mounted at `/api/hooks` with Hono `4.11.9`:

| Method | Path | Hook id | Tenant hint |
| --- | --- | --- | --- |
| `POST` | `/` | `x-webhook-hook` or `?hook=` | `x-tenant-id` or `?tenant=` |
| `POST` | `/:id` | path, else headers/query | same |
| `POST` | `/:tenantId/:name` | name | path if it starts with `tnt_`, else headers/query |

JSON responses:

| Status | Body |
| --- | --- |
| 202 | `{ ok: true, to }` |
| 200 | `{ challenge }` (Slack `url_verification` only) |
| 401 | `{ error: "unauthorized" }` |
| 404 | `{ error: "unknown_hook" }` |
| 409 | `{ error: "ambiguous_destination" }` |
| 500 | `{ error: "vault_error" }` or `{ error: "lookup_error" }` |
| 503 | `{ error: "undeliverable" }` |

Empty body is delivered as `"{}"`. Subject is omitted on this path.

## Credential metadata

Interchange credential `metadata.webhook`:

```
verify: "bearer" | "standard-webhooks" | "slack"   // required
to?: string        // live run address
workflow?: string  // definition or asset name
```

Load rules: `status === "active"`, `principalId` null, parseable
metadata. `crd_…` looks up by id; any other id is a name and requires a
tenant hint. Secret decrypt uses `credentialAad(id, "secret")`.

Live runs: `workflowRun` in `deployed` or `running`, non-null address,
`anchorRunId === id`, address passes `isRunAddress`. Names come from
`workflowDefinition` and optional `asset`.

## Verify

`HOOK_VERIFY = ["bearer", "standard-webhooks", "slack"]`. No `none`.

- Bearer: `Authorization: Bearer <secret>` or `x-webhook-secret`,
  compared with `crypto.timingSafeEqual` on equal-length buffers.
- Standard Webhooks: `webhook-id`, `webhook-timestamp`,
  `webhook-signature`. Timestamp must be within 300s. HMAC-SHA-256 over
  `${id}.${timestamp}.${body}`. Secret may be `whsec_` + base64.
  Signature list is space-separated `v1,<base64>` parts.
- Slack: `x-slack-request-timestamp`, `x-slack-signature`. Timestamp
  within 300s. HMAC-SHA-256 over `v0:${timestamp}:${body}`.

## System sender

`createTenantSystemSender` mints `kind: "user"` principals with
`refId` = local part (`webhook` under `installWebhooks`; cron passes
`"cron"` on its own deliverer). Address is `${localPart}@${domain}`.
Sign/public key come from `principalKeyStore`. `createIfAbsent` races
re-read the winner's row.

## Run-trigger mail

`createRunTriggerDeliverer.to(address, content, tenantId, subject)`:

1. `isRunAddress` / `deriveWorkflowRunId` from `@intx/types`.
2. `materialize({ agentAddress, runId })`. `rejected` throws the
   materializer message/code; any other non-`materialized` outcome
   throws `"destination is not a workflow deployment"`.
3. `router.sendRunGrants(address, runId, stepGrants, [{ address, publicKey }])`.
   False → `RunTriggerUnroutableError(RUN_GRANTS_NOT_ROUTABLE, address, runId)`.
4. Assemble MIME with `@intx/mime` (`assembleSignedContent` kind
   `conversation`, `assembleMessage`) and a detached signature from
   `@intx/crypto` (`createDetachedSignatureWithSigner`). Headers:
   `interchangeType: "conversation.message"`,
   `interchangeTenantId: tenantId`, `from: sender.address`.
   `messageId` is `<uuid@domain>`. Body is base64 via `base64Encode`.
5. `router.routeMail(address, raw.base64, sender.address, messageId)`.
   False → `RunTriggerUnroutableError(RUN_MAIL_NOT_ROUTABLE, address, runId)`.

`isRunTriggerUnroutable(error)` is true iff `error` is a non-null object
whose `code` is one of the two constants and whose `address` and
`runId` are strings. Do not use `instanceof`.

Error `message` prefixes: `"run grants not routable for … (run …)"` /
`"run mail not routable for … (run …)"`. `name` is
`RunTriggerUnroutableError`.

## Dependencies

Runtime: `@intx/crypto` `^0.3.0`, `@intx/db` `^0.3.0`,
`@intx/hub-common` `^0.3.0`, `@intx/hub-api` `^0.3.0`, `@intx/mime`
`^0.3.0`, `@intx/types` `^0.3.0`, `hono` `4.11.9`.

Dev: `@types/bun` `1.3.9`, `typescript` `5.9.3`. `tsconfig` is
`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
`allowImportingTsExtensions`, `types: ["bun"]`.

## Tooling

```sh
bun install
bun run typecheck
bun run test
```

`bun run test` is `bun test ./src`. Tests sit next to the module they
cover.

## Not in this package

`mountWebhookTrigger`, `webhook_trigger` schema, and HMAC trigger CRUD
are not on this export surface and are not documented here.
