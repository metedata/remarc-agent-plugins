# Contributing to Remarc agent plugins

Thanks for helping improve Remarc's agent integrations.

## Prerequisites

- macOS. The optional hooks read Remarc preferences with the macOS `defaults` command, and CI runs on macOS.
- Node.js 22 to match CI. Runtime bundles are currently built with a Node 18 target.
- npm.
- Claude Code only when running marketplace validation locally.
- OMP 17.3.4 only when running the pinned OMP marketplace smoke.
- The Remarc app when doing an end-to-end integration check.

## Set up and test

The repository is not a root npm workspace. Install and test each package independently:

```sh
(cd plugins/remarc/mcp && npm ci && npm test && npm run build)
(cd plugins/remarc-hooks/cli && npm ci && npm test && npm run build)
(cd plugins/remarc-wake && npm ci && npm run typecheck && npm test && npm run build)
node scripts/check-public-versions.mjs
node scripts/check-third-party-notices.mjs
```

All three packages consume code from `plugins/shared/`; the MCP and hooks
packages expose that source through checked-in symlinks, while `remarc-wake`
bundles it through relative imports. Make shared data, marker, wake-selection,
and notification changes in `plugins/shared/`, not in a package-local copy.

The built files are committed distribution artifacts. After building, confirm that they match source:

```sh
git diff --exit-code -- plugins/remarc/mcp/dist plugins/remarc-hooks/cli/dist plugins/remarc-wake/dist
```

If a source change intentionally changes a bundle, commit the corresponding `dist/` update in the same pull request.

## Validate the shared schema fixture

```sh
(cd plugins/shared && npm ci)
node - <<'NODE'
const sample = require("./plugins/shared/fixtures/comments.sample.json");
const Ajv = require("./plugins/shared/node_modules/ajv").default;
const schema = require("./plugins/shared/comments-schema.json");
const ajv = new Ajv({ allowUnionTypes: true });
if (!ajv.validate(schema, sample)) {
  console.error(ajv.errors);
  process.exit(1);
}
console.log("schema valid against fixture");
NODE
```

Validate the marketplace when Claude Code is installed:

```sh
claude plugin validate .
```

Run the OMP packaging smoke only with its exact pinned binary and disposable
profile:

```sh
node scripts/smoke-omp-marketplace.mjs \
  --omp /absolute/path/to/omp \
  --marketplace "$(pwd)" \
  --expected-version 0.12.1
```

Do not exercise marketplace installation against your normal Claude Code,
Codex, or OMP profile during routine development. Installation mutates the
agent's plugin registry and cache. CI performs the Claude Code and local-source
OMP smoke tests in disposable environments; Codex clean-install coverage
remains to be added.

## App and plugin contracts

The canonical cross-repository contract is [plugins/shared/contracts.md](plugins/shared/contracts.md). Changes to any of the following require coordinated review with the [Remarc app](https://github.com/metedata/Remarc):

- `comments.json` fields, date encoding, or status values;
- document locking and atomic-write behavior;
- marker location, fields, locking, liveness, or wake generations;
- session origins and agent-session identifiers;
- app preference keys read by a plugin;
- the MCP bundle vendored into the app.

Preserve unknown `comments.json` document, session, comment, and web-context
fields on every read-modify-write path. Marker writers must also preserve
unknown keys by using the shared parser/serializer and owner-token
compare-and-set helpers. Any marker-contract extension requires coordinated
fixtures and readers across this repository and the Remarc app. Add adversarial
concurrency tests for a contract change; do not rely only on a happy-path unit
test.

Current Claude automatic delivery is best-effort and records its generation
before payload emission, so a crash at that boundary can lose a wake. New
delivery implementations should make the boundary explicit and prefer
durable at-least-once wake attempts over silent loss. Use a write-ahead outbox
and clear it only after a durable work claim; then use `expected_status`
compare-and-set to prevent two cooperative agents from successfully claiming the
same handed-off comment.

## Pull requests

Keep pull requests focused. Before opening one:

1. Run all package test/build commands.
2. Confirm committed `dist/` output matches source and third-party notices
   match the bundled dependency locks.
3. Run the shared schema fixture check when data contracts changed.
4. Run `claude plugin validate .` when marketplace or Claude manifests changed.
5. Update [CHANGELOG.md](CHANGELOG.md) for a user-visible change.
6. Link the coordinated Remarc app change when a cross-repository contract changed.
7. Include the exact agent versions and profiles used for any live integration claim.

Do not include credentials, private Remarc comments, screenshots, transcripts, or unsanitized local data in tests, logs, or issues.
