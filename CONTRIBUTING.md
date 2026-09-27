# Contributing

## Running the tests

```sh
git clone https://github.com/corbitsdev/webhooks.git
cd webhooks
bun install
bun run typecheck
bun run test
bun run test:e2e
```

`bun run test` runs the `./src` units and `bun run test:e2e` the `./e2e` real-Postgres suites, which run when `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` are all set and skip otherwise. Each suite migrates a throwaway `wh_*` schema and drops it on exit; a killed run can leave one behind.

## How a hook fires

The signing credential only authenticates the inbound request. The workflow runs as its own run principal, `deriveRunPrincipalId(tenantId, runId)`, through Interchange's mail-triggered grant path (`createMailTriggeredRunGrantsMaterializer`), never as the credential owner. Credentials stay Interchange's (`POST /credentials`, `credential:*`); this package only adds the hook routes.

The trigger mail is signed by a durable per-tenant system sender (`webhook@domain`), a `kind: "user"` principal whose key is co-delivered on the run-grants barrier so the recipient verifies the mail's `From`.

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.
