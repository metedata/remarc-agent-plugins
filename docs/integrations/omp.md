# OMP integration

Remarc's core OMP integration provides the `remarc` workflow skill and MCP
tools for reading and updating existing Remarc sessions. It is intentionally
independent of the optional instant-delivery extension described in the
[phased proposal](../omp-integration-proposal.md).

## Requirements

- macOS with Remarc installed and launched at least once (1.0.1 supports the
  core MCP path; 1.1.0 or later is required for the OMP badge and instant
  delivery);
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

1. Ask OMP to create a correctly labelled Remarc session, or select an existing
   session in the app.
2. Ask OMP to call `remarc_list_sessions` and identify that session.
3. List or fetch its comments.
4. When addressing handed-off work, claim it with
   `expected_status: "handedOff"` before acting.
5. Resolve completed work with a concise summary.

The shared skill describes read-only, addressing, and status-only workflows.
The MCP server preserves unknown document, session, comment, and web-context
fields during supported updates.

## Session creation and pairing

The OMP-owned MCP process can create sessions with native `origin: "omp"`.
Its trusted launch identity wins over any model-controlled Claude Code or Codex
override. OMP leaves the legacy `claudeCodeSessionId` field empty and does not
write an ownerless marker.

Session creation and instant pairing are intentionally separate. Remarc 1.1.0
or later is required for the app to validate the OMP lease and show Instant
delivery. Install the
optional `remarc-wake` extension, make the intended Remarc session active, and
run `/remarc-pair` in the OMP conversation that should receive comments. This
explicitly publishes a token-owned, heartbeat-renewed lease. `/remarc-unpair`
removes only the current owner's lease.

```sh
omp plugin install --scope user remarc-wake@remarc
```

Restart OMP after installing or upgrading an extension module. Enable **Allow
comments to wake paired agent sessions** in Remarc. Core-only OMP continues to
read comments on demand without a background wake connection.

## Update, disable, or remove

```sh
omp plugin marketplace update remarc
omp plugin upgrade --scope user remarc@remarc
omp plugin upgrade --scope user remarc-wake@remarc
omp plugin disable --scope user remarc@remarc
omp plugin disable --scope user remarc-wake@remarc
omp plugin enable --scope user remarc@remarc
omp plugin enable --scope user remarc-wake@remarc
omp plugin uninstall --scope user remarc-wake@remarc
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
cached package shape, native OMP session creation, and marker isolation:

```sh
node scripts/smoke-omp-marketplace.mjs \
  --omp /absolute/path/to/omp \
  --marketplace "$(pwd)" \
  --expected-version 0.12.0
```

The script requires the exact `omp/17.3.4` version output and removes only the
temporary profile it created. A checkout-backed run proves the candidate
package, but not public distribution. After the commit is merged, repeat the
same script with
`--marketplace metedata/remarc-agent-plugins`; that post-merge run is the Git
marketplace acceptance gate. The [0.12.0
release](https://github.com/metedata/remarc-agent-plugins/releases/tag/v0.12.0)
completed that public Git-marketplace gate on 2026-08-15.

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
