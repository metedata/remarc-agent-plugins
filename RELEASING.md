# Releasing Remarc agent plugins

This repository historically distributed versions directly from `main` without Git tags or GitHub Releases. Use this process for traceable releases going forward.

## Version model

One public semantic version covers the `remarc` and `remarc-hooks` plugin manifests:

- `plugins/remarc/.claude-plugin/plugin.json`
- `plugins/remarc/.codex-plugin/plugin.json`
- `plugins/remarc-hooks/.claude-plugin/plugin.json`
- `plugins/remarc-hooks/.codex-plugin/plugin.json`

The [OMP proposal](docs/omp-integration-proposal.md) keeps that same public
version for the future core OMP manifest, OMP catalog entries, and
`remarc-wake`. When those files land, add them to the synchronized-version check
and this release checklist.

The private packages are not published to npm. Most package versions are build
metadata, but the MCP server reports its implementation version publicly during
the MCP initialize handshake. Keep these two MCP version declarations equal:

- `plugins/remarc/mcp/package.json`
- `plugins/remarc/mcp/src/index.ts`

That MCP implementation version does not currently equal the marketplace
version (`0.1.0` versus `0.10.0`). Record it in release notes and bump both
declarations together when MCP behavior changes.

Claude Code uses the plugin manifest version as a cache key. Pushing changed plugin files without increasing that version does not update an existing installation.

## Prepare a release

1. Choose the next semantic version and update all four public manifests together.
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
7. Exercise clean, isolated installs for every supported agent. Record the exact agent versions used.
8. Merge only after CI passes on the final commit.

## Publish

1. Create an annotated `vX.Y.Z` tag on the verified release commit.
2. Push the tag without moving or replacing an existing tag.
3. Create a GitHub Release from that tag using the matching changelog section.
4. Update the marketplace on a clean profile and confirm both plugins resolve to `X.Y.Z`.

The first retrospective tag should be reviewed carefully because existing users may already have the same manifest version cached from an earlier untagged commit.

## Coordinate the Remarc app

When the MCP bundle changed, the app must vendor the exact released artifact from this repository. From a clean, committed plugin checkout, run in the Remarc repository:

```sh
scripts/sync-mcp-vendor.sh /absolute/path/to/remarc-agent-plugins
```

That script rebuilds the MCP server, copies it into `mcp/vendor/`, and records the plugin commit, version, and SHA-256. The resulting Remarc change must pass the app's build-phase hash check and app test suite before release.

Contract changes may require a coordinated ship order. Follow [plugins/shared/contracts.md](plugins/shared/contracts.md): normally ship a tolerant app reader before a plugin starts writing a new required shape.
