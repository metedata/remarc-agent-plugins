# Releasing Remarc agent plugins

This repository historically distributed versions directly from `main` without Git tags or GitHub Releases. Use this process for traceable releases going forward.

## Version model

One public semantic version covers the `remarc` and `remarc-hooks` plugin manifests and OMP catalog entry:

- `plugins/remarc/.claude-plugin/plugin.json`
- `plugins/remarc/.codex-plugin/plugin.json`
- `plugins/remarc/plugin.json` (Agent Plugins 1.0)
- `plugins/remarc-hooks/.claude-plugin/plugin.json`
- `plugins/remarc-hooks/.codex-plugin/plugin.json`
- `.omp-plugin/marketplace.json` entry `remarc`

The [OMP proposal](docs/omp-integration-proposal.md) keeps that same public
version for future OMP catalog entries and `remarc-wake`.

The private packages are not published to npm. Most package versions are build
metadata, but the MCP server reports its implementation version publicly during
the MCP initialize handshake. Keep these two MCP version declarations equal:

- `plugins/remarc/mcp/package.json`
- `plugins/remarc/mcp/src/index.ts`

That MCP implementation version does not currently equal the marketplace
version (`0.2.0` versus `0.11.0`). Record it in release notes and bump both
declarations together when MCP behavior changes.

Claude Code uses the plugin manifest version as a cache key. Pushing changed plugin files without increasing that version does not update an existing installation.

## Prepare a release

1. Choose the next semantic version and update every public manifest and OMP
   catalog entry together. Run `node scripts/check-public-versions.mjs`.
2. When MCP behavior changed, choose its next implementation version and update both declarations listed above.
3. Move the relevant entries from `Unreleased` into a dated section in [CHANGELOG.md](CHANGELOG.md). Record both versions when the MCP implementation changed.
4. Build and test both packages:

   ```sh
   (cd plugins/remarc/mcp && npm ci && npm test && npm run build)
   (cd plugins/remarc-hooks/cli && npm ci && npm test && npm run build)
   ```

5. Verify that committed distribution files match the build:

   ```sh
   git diff --exit-code -- plugins/remarc/mcp/dist plugins/remarc-hooks/cli/dist
   ```

6. Run the shared schema fixture check from [CONTRIBUTING.md](CONTRIBUTING.md) and validate the marketplace with `claude plugin validate .`.
7. Exercise clean, isolated installs for every supported agent. Record the exact agent versions used. For OMP, use the pinned `omp/17.3.4` binary and the candidate checkout:

   ```sh
   node scripts/smoke-omp-marketplace.mjs \
     --omp /absolute/path/to/omp \
     --marketplace "$(pwd)" \
     --expected-version X.Y.Z
   ```

   This run must prove that OMP copied `plugin.json`, `mcp.json`, the skill, and
   the MCP bundle into its isolated cache rather than executing them through a
   symlink to the checkout. The OMP TUI must list `remarc:remarc` as connected
   under `Agent Plugins`, and the installed server must enforce the OMP
   create-session guard.
8. Merge only after CI passes on the final commit.

## Publish

1. From the merged commit, repeat the OMP smoke against the public Git
   marketplace, changing only `--marketplace`:

   ```sh
   node scripts/smoke-omp-marketplace.mjs \
     --omp /absolute/path/to/omp \
     --marketplace metedata/remarc-agent-plugins \
     --expected-version X.Y.Z
   ```

   The checkout-backed run is the pre-publication packaging gate; this second
   run is the post-merge distribution gate. Confirm its machine-readable plugin
   state points into the isolated marketplace cache and not a source checkout.
2. Create an annotated `vX.Y.Z` tag on the verified release commit.
3. Push the tag without moving or replacing an existing tag.
4. Create a GitHub Release from that tag using the matching changelog section.
5. Update each supported marketplace on a clean profile and confirm every
   released entry resolves to `X.Y.Z`.

The first retrospective tag should be reviewed carefully because existing users may already have the same manifest version cached from an earlier untagged commit.

## Coordinate the Remarc app

When the MCP bundle changed, the app must vendor the exact released artifact from this repository. From a clean, committed plugin checkout, run in the Remarc repository:

```sh
scripts/sync-mcp-vendor.sh /absolute/path/to/remarc-agent-plugins
```

That script rebuilds the MCP server, copies it into `mcp/vendor/`, and records the plugin commit, version, and SHA-256. The resulting Remarc change must pass the app's build-phase hash check and app test suite before release.

Contract changes may require a coordinated ship order. Follow [plugins/shared/contracts.md](plugins/shared/contracts.md): normally ship a tolerant app reader before a plugin starts writing a new required shape.
