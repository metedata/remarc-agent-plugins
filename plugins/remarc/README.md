# remarc

The core plugin for connecting supported coding agents to the [Remarc](https://remarc.app) macOS app.

It contains:

- the Remarc MCP server for reading sessions, fetching captured context, and updating comment status;
- the `remarc` skill for read-only, addressing, and status-only workflows;
- harness-specific manifests for Claude Code and Codex.

## Requirements

- Remarc installed on macOS and launched at least once.
- Node.js available as `node`.
- Claude Code or Codex with plugin support.

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

## Optional Claude Code lifecycle integration

Install [`remarc-hooks`](../remarc-hooks/README.md) when you explicitly want Claude Code conversations paired with Remarc sessions and eligible for instant delivery:

```sh
claude plugin install remarc-hooks@remarc
```

The core MCP plugin works without hooks.

## Current limits

- Correctly labelled session creation currently supports Claude Code and Codex only.
- OMP support is [proposed, not shipped](../../docs/omp-integration-proposal.md). An unsupported harness must not create a session by pretending to be Claude Code.
- Screenshot paths are local to the Mac running Remarc and may be unavailable to a remote agent.
- The plugin reads and writes local Remarc data; tool results are processed by the configured agent provider.

The cross-repository data, lock, marker, and status contracts are documented in [`plugins/shared/contracts.md`](../shared/contracts.md).
