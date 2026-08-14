# Compatibility

This page distinguishes currently supported behavior from code that merely exists or has been proposed.

## Inspected baselines

The following versions and artifacts were inspected on 2026-08-14. They are not
all one end-to-end tested combination: package tests and Claude marketplace
validation ran locally; the shipping app and Codex CLI were checked separately.
OMP 17.3.4 was exercised from an isolated profile through marketplace install,
skill discovery, TUI MCP discovery, and the installed MCP bundle.

| Component | Baseline |
| --- | --- |
| Remarc | 1.0.1 for core OMP; 1.1.0 candidate for OMP badge and instant delivery |
| Remarc plugins | 0.12.0 (this release); 0.11.0 is the prior baseline |
| macOS | Remarc's minimum is macOS 14.0 |
| CI Node.js | 22 |
| Bundle target | Node.js 18 |
| Claude Code | 2.1.226 |
| Codex CLI | 0.146.1 |
| OMP | 17.3.4 at commit `ffd53ff` |

These are not permanent minimum-version guarantees. CI currently exercises
macOS with Node 22, not a Node-version matrix.

The OMP pre-publication smoke uses a local candidate marketplace and confirms
that OMP installs a cached copy rather than a symlink to the checkout. The same
smoke must be repeated against `metedata/remarc-agent-plugins` after merge; that
public Git-marketplace run cannot be completed before the candidate exists on
the remote default branch. Codex support is shipped by Remarc 1.0.1 and its
commands were checked against the CLI baseline above, but Codex manifest,
discovery, and clean-install coverage still need to be added to this
repository's CI.

## Capability matrix

| Capability | Claude Code | Codex | OMP |
| --- | --- | --- | --- |
| Marketplace installation | Supported | Supported | Supported |
| `remarc` skill | Supported | Supported | Supported |
| Remarc MCP tools | Supported | Supported | Supported |
| Create a correctly labelled session | Supported | Supported | Supported; instant pairing remains explicit |
| Automatic start/prompt context injection | Experimental, optional | Not in the supported app flow | No; optional wake queues explicit requests only |
| Instant delivery to an idle agent | Experimental, optional | Not supported | Optional `remarc-wake` extension with Remarc 1.1.0+ |
| Settings install/status UI | Supported | Supported | Not planned for the first integration |

OMP core support is distributed through its own catalog and uses the existing
MCP bundle and skill. Its package root follows Agent Plugins 1.0:
`plugins/remarc/plugin.json` declares the plugin and
`plugins/remarc/mcp.json` launches the bundle from `${PLUGIN_ROOT}`. The
optional wake extension and app-side live reachability remain separately
installable, while the shared schema and MCP runtime preserve native OMP
session origin.

## Supported installation commands

Claude Code:

```sh
claude plugin marketplace add metedata/remarc-agent-plugins
claude plugin install remarc@remarc
```

Optional Claude Code hooks:

```sh
claude plugin install remarc-hooks@remarc
```

Codex:

```sh
codex plugin marketplace add metedata/remarc-agent-plugins
codex plugin marketplace upgrade remarc
codex plugin add remarc@remarc
```

OMP:

```sh
omp plugin marketplace add metedata/remarc-agent-plugins
omp plugin install remarc@remarc
omp plugin install remarc-wake@remarc
```

Refresh with `/reload-plugins`, then verify `/mcp list` shows the
`remarc:remarc` server under `Agent Plugins` and run
`/mcp test remarc:remarc`. OMP converts the server and MCP tool names into
agent-callable identifiers such as
`mcp__remarc_remarc_remarc_list_sessions`. See the
[OMP guide](integrations/omp.md) for scope and lifecycle commands.

These are the commands used by Remarc 1.0.1. Agent CLIs change independently; consult the agent's own help when a newer version rejects a command.

## What “supported” means

The target support bar, including gaps still being closed for current
integrations, is:

1. install from the public marketplace without a source checkout;
2. discover the bundled `remarc` skill and MCP server;
3. list sessions and comments from a current Remarc data file;
4. update statuses without dropping unknown fields;
5. respect document locks and atomic replacement;
6. remove its plugin state without deleting Remarc user data;
7. pass its package tests, bundle-drift check, marketplace validation, and clean-install smoke test.

Lifecycle or instant-delivery support additionally requires session-scoped routing, bounded untrusted-content handling, explicit delivery-boundary and crash tests, and compare-and-set claim behavior.

## Known limitations

- Remarc is a macOS application. Linux and Windows are not supported hosts for the local app data.
- Remote and container agents may not be able to open local screenshot paths.
- Instant delivery is opt-in and off by default.
- Core-only Codex fetches comments on demand through MCP; it does not inject them automatically or wake an idle session.
- The optional hooks are experimental and use agent lifecycle surfaces that can change independently.
- Session origin and attribution still contain legacy Claude-named fields; new harnesses must not silently reuse a false origin.
- OMP-created sessions use native `origin: "omp"`. Run `/remarc-pair` after
  creation when that conversation should receive instant delivery.
- OMP instant delivery requires Remarc 1.1.0 or later. Plugin 0.12.0 may be
  installed alongside Remarc 1.0.1 for core MCP use, but that public app release
  does not understand the version 1 OMP reachability lease or expose its
  harness-neutral Instant delivery setting.
- Status updates retain a summary only for `resolved`; an `inProgress` summary
  supplied by the current skill is discarded by the data writer.

See [Architecture](architecture.md) and the [OMP proposal](omp-integration-proposal.md) for the boundaries behind this matrix.
