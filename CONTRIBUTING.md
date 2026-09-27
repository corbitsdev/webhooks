# Contributing

## Running the tests

```sh
git clone https://github.com/corbitsdev/webhooks.git
cd webhooks
bun install
bun run typecheck
bun run test
```

## How a hook fires

The signing credential only authenticates the inbound request. The workflow runs as its own run principal, `deriveRunPrincipalId(tenantId, runId)`, through Interchange's mail-triggered grant path (`createMailTriggeredRunGrantsMaterializer`), never as the credential owner. Credentials stay Interchange's (`POST /credentials`, `credential:*`); this package only adds the hook routes.

The trigger mail is signed by a durable per-tenant system sender (`webhook@domain`), a `kind: "user"` principal whose key is co-delivered on the run-grants barrier so the recipient verifies the mail's `From`.
