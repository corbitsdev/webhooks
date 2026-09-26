# Contributing

## Development

```sh
bun install
bun run check
```

`bun run check` runs typecheck, lint, format check and unit tests. `bun run format` rewrites the tree.

Contributors sign the [CLA](CLA.md) on their first PR; the CLA bot explains how.

`bun run test:e2e` runs the real-Postgres suites in `e2e/`. They run when
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` are all set and skip
otherwise. Each suite migrates a throwaway `wh_*` schema and drops it on exit; a
killed run can leave one behind.

```sh
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres bun run test:e2e
```

## Commit messages

Commit subjects and PR titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `perf`, and `chore(release): x.y.z` for releases.
Add `!` only for public API breaks: removed or renamed exports, changed signatures, newly required params. Peer and dependency range changes are `build(deps):` with no `!`.
Keep subjects imperative, lowercase after the colon, 72 characters or less, and free of ticket IDs.
Every PR links its issue with a `Closes <issue id>` line in the PR body.

## Releasing

Releases are manual. On a clean, up-to-date `main`:

```sh
npm version <patch|minor> -m "chore(release): %s"
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
npm publish
```

Bump minor only for breaking API changes; everything else is a patch. `prepack` builds `dist/` from the tagged commit.
