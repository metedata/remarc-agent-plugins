# remarc

The core plugin for connecting supported coding agents to the [Remarc](https://remarc.app) macOS app.

It contains:

- the Remarc MCP server for reading sessions, fetching captured context, and updating comment status;
- the `remarc` skill for read-only, addressing, and status-only workflows;
- harness-specific manifests for Claude Code and Codex, plus the portable Agent
  Plugins 1.0 `plugin.json` and `mcp.json` consumed by OMP.

## Requirements

- Remarc installed on macOS and launched at least once.
- Node.js available as `node`.
- Claude Code, Codex, or OMP with plugin support.

## Install for Claude Code

```sh
claude plugin marketplace add metedata/remarc-agent-plugins
claude plugin install remarc@remarc
```

After installation in an active session, run `/reload-plugins`.

Update or remove it with Claude Code's plugin manager:

```sh
claude plugin marketplace update remarc
claude plugin update remarc@remarc
claude plugin uninstall remarc@remarc
```

## Install for Codex

```sh
codex plugin marketplace add metedata/remarc-agent-plugins
codex plugin marketplace upgrade remarc
codex plugin add remarc@remarc
```

Remove it with:

```sh
codex plugin remove remarc@remarc
```

## Install for OMP

```sh
omp plugin marketplace add metedata/remarc-agent-plugins
omp plugin install remarc@remarc
```

In an active OMP session, run:

```text
/reload-plugins
/mcp list
/mcp test remarc:remarc
/skill:remarc
```

OMP can read and update existing sessions. Create or select the session in the
Remarc app first; the OMP MCP server deliberately rejects linked-session
creation until the app and shared schema support an OMP session origin.

The OMP catalog installs this directory as the package root. OMP 17.3.4 reads
the root `plugin.json`, loads the root `mcp.json`, expands `${PLUGIN_ROOT}` to
the cached installation, and starts the bundled MCP server with
`--harness omp`. In the TUI, `/mcp list` shows that server as
`remarc:remarc` under `Agent Plugins`.

See the [OMP integration guide](../../docs/integrations/omp.md) for scoped
installation, updates, removal, and troubleshooting.

## Verify

Ask the agent to call `remarc_list_sessions`. A returned session list proves that the packaged MCP server can read the current Remarc data.

The server exposes:

- `remarc_list_sessions`
- `remarc_list_comments`
- `remarc_get_comment`
- `remarc_set_status`
- `remarc_bulk_set_status`
- `remarc_rename_session`
- `remarc_create_session`

See the [MCP tools reference](https://docs.remarc.app/agents/mcp-tools-reference/) for inputs and workflow guidance.

Those are the protocol-level MCP names. OMP's agent-facing bridge includes the
sanitized namespaced server name, so `remarc_list_sessions`, for example,
appears to the model as `mcp__remarc_remarc_remarc_list_sessions`. Users can
still ask for the semantic operation by name; they do not need to type the
generated identifier.

## Optional Claude Code lifecycle integration

Install [`remarc-hooks`](../remarc-hooks/README.md) when you explicitly want Claude Code conversations paired with Remarc sessions and eligible for instant delivery:

```sh
claude plugin install remarc-hooks@remarc
```

The core MCP plugin works without hooks.

## Current limits

- Correctly labelled session creation currently supports Claude Code and Codex only.
- OMP core MCP and skill support is available, but linked-session creation and
  instant delivery are not yet supported.
- Screenshot paths are local to the Mac running Remarc and may be unavailable to a remote agent.
- The plugin reads and writes local Remarc data; tool results are processed by the configured agent provider.

The cross-repository data, lock, marker, and status contracts are documented in [`plugins/shared/contracts.md`](../shared/contracts.md).
