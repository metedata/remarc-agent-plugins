# OMP integration

Remarc's core OMP integration provides the `remarc` workflow skill and MCP
tools for reading and updating existing Remarc sessions. It is intentionally
independent of the optional instant-delivery extension described in the
[phased proposal](../omp-integration-proposal.md).

## Requirements

- macOS with Remarc installed and launched at least once;
- OMP 17.3.4, the currently verified baseline;
- Node.js available as `node` in the environment that launches OMP;
- local filesystem access to `~/Library/Application Support/Remarc/`.

## Install

The default installation is available to every project for the current user:

```sh
omp plugin marketplace add metedata/remarc-agent-plugins
omp plugin install --scope user remarc@remarc
```

For a project-only installation, run this from the project directory:

```sh
omp plugin install --scope project remarc@remarc
```

After installing or updating the core plugin in an active OMP session, run:

```text
/reload-plugins
/mcp list
/mcp test remarc:remarc
/skill:remarc
```

OMP namespaces the MCP server as `remarc:remarc`. The skill keeps its normal
name, `remarc`.

## Package shape and tool names

`.omp-plugin/marketplace.json` is the OMP catalog. Its `remarc` entry selects
`plugins/remarc`, whose root files use the portable Agent Plugins 1.0 format:

- `plugin.json` declares the `remarc` package and public integration version;
- `mcp.json` declares the stdio server and starts
  `${PLUGIN_ROOT}/mcp/dist/index.js --harness omp`;
- `skills/remarc/SKILL.md` supplies the workflow guidance.

OMP expands `${PLUGIN_ROOT}` to the cached installed package, not the source
repository. On the verified OMP 17.3.4 baseline, `/mcp list` displays
`remarc:remarc` as connected under the `Agent Plugins` provider.

The server continues to expose protocol-level tool names such as
`remarc_list_sessions`. OMP's agent-facing bridge combines the namespaced
server and tool names, so that example is registered as
`mcp__remarc_remarc_remarc_list_sessions`. This generated identifier is useful
for diagnostics and approval rules; users can simply ask OMP to list Remarc
sessions.

## Use Remarc from OMP

1. Create or select a session in the Remarc app.
2. Ask OMP to call `remarc_list_sessions` and identify that session.
3. List or fetch its comments.
4. When addressing handed-off work, claim it with
   `expected_status: "handedOff"` before acting.
5. Resolve completed work with a concise summary.

The shared skill describes read-only, addressing, and status-only workflows.
The MCP server preserves unknown document, session, comment, and web-context
fields during supported updates.

## Current limitation: session creation

OMP cannot create a correctly labelled linked Remarc session yet. The OMP MCP
process rejects `remarc_create_session` before reading or writing the Remarc
document, even if a caller attempts to pass `harness: "claudeCode"` or
`harness: "codex"`.

This restriction avoids writing false session provenance while older Remarc
versions and the shared schema do not yet support `origin: "omp"`. Reading,
renaming, handing off, claiming, reopening, and resolving existing sessions and
comments remain available.

Instant delivery and live OMP pairing are not part of the core plugin yet.
Until the optional wake extension and generic app reachability changes ship,
OMP reads new comments when asked rather than waking an idle session.

## Update, disable, or remove

```sh
omp plugin marketplace update remarc
omp plugin upgrade --scope user remarc@remarc
omp plugin disable --scope user remarc@remarc
omp plugin enable --scope user remarc@remarc
omp plugin uninstall --scope user remarc@remarc
omp plugin marketplace remove remarc
```

Use `--scope project` from the project directory for a project-scoped copy.
Removing the plugin changes only OMP's plugin state; it does not delete Remarc
sessions, comments, or screenshots.

## Release verification

The pre-publication smoke installs from a candidate checkout into a completely
isolated OMP profile and verifies user/project scopes, project shadowing,
enable/disable, uninstall/reinstall, skill discovery, TUI MCP discovery, the
cached package shape, and the installed create-session guard:

```sh
node scripts/smoke-omp-marketplace.mjs \
  --omp /absolute/path/to/omp \
  --marketplace "$(pwd)" \
  --expected-version 0.11.0
```

The script requires the exact `omp/17.3.4` version output and removes only the
temporary profile it created. A checkout-backed run proves the candidate
package, but not public distribution. After the commit is merged, repeat the
same script with
`--marketplace metedata/remarc-agent-plugins`; that post-merge run is the Git
marketplace acceptance gate.

## Troubleshooting

- Run `omp plugin list --json` to confirm the expected scope is enabled.
- Run `omp plugin doctor` for plugin-manager diagnostics.
- Run `/mcp list` and `/mcp test remarc:remarc` in a fresh OMP process to prove
  runtime discovery; plugin-manager health alone is not an MCP connection test.
- Confirm `node` is on OMP's `PATH`.
- Confirm Remarc has been launched and its data file exists.
- A project-scoped copy shadows an enabled user-scoped copy of the same plugin.

## Data and security

The plugin runs locally with the current user's permissions and communicates
with OMP over stdio. It contains no Remarc telemetry or Remarc-operated network
service. MCP results are still processed by the model provider configured in
OMP, and captured page text or application content should be treated as
untrusted input.
