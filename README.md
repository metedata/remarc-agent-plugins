# Remarc agent plugins

Official agent-side integrations for [Remarc](https://remarc.app), the local-first macOS app for contextual comments.

This repository is the source of truth for Remarc's MCP server, agent skill, and optional lifecycle integrations. The Remarc app vendors the built MCP server from this repository; supported agent clients install the same code through their plugin marketplace.

The repository is public under the [MIT License](LICENSE). Remarc itself is also [open source](https://github.com/metedata/Remarc).

## Support status

| Agent | MCP server and skill | Lifecycle integration | Instant delivery |
| --- | --- | --- | --- |
| Claude Code | Supported | Optional `remarc-hooks` plugin, experimental | Supported when hooks are paired and the user enables it |
| Codex | Supported | Not part of the supported app install flow | On demand when the agent calls the MCP tools |
| OMP | Supported | Optional `remarc-wake` plugin | Supported with Remarc 1.1.0+ when explicitly paired and enabled |

The current verified baseline is recorded in [Compatibility](docs/compatibility.md).

## Requirements

- macOS with [Remarc](https://github.com/metedata/Remarc/releases/latest)
  installed and launched at least once. Core OMP MCP access works with 1.0.1;
  native OMP badges and `remarc-wake` instant delivery require Remarc 1.1.0 or
  later.
- Node.js available as `node`. The committed bundles target Node 18; CI currently builds and tests with Node 22.
- A supported agent CLI for marketplace installation.

Remarc data and screenshot paths live under `~/Library/Application Support/Remarc/`. A remote or containerized agent needs access to those local paths to inspect screenshot comments.

## Install

### Claude Code

You can install from Remarc's Settings window, or run:

```sh
claude plugin marketplace add metedata/remarc-agent-plugins
claude plugin install remarc@remarc
```

The optional Claude Code lifecycle integration is an explicit opt-in:

```sh
claude plugin install remarc-hooks@remarc
```

After changing plugins in an active Claude Code session, run `/reload-plugins`.

See the [Claude Code guide](https://docs.remarc.app/agents/claude-code/) and [`remarc-hooks` documentation](plugins/remarc-hooks/README.md) for delivery behavior and removal instructions.

### Codex

You can install from Remarc's Settings window, or run:

```sh
codex plugin marketplace add metedata/remarc-agent-plugins
codex plugin marketplace upgrade remarc
codex plugin add remarc@remarc
```

See the [Codex guide](https://docs.remarc.app/agents/codex/) for repair and removal instructions.

### OMP

```sh
omp plugin marketplace add metedata/remarc-agent-plugins
omp plugin install remarc@remarc
omp plugin install remarc-wake@remarc
```

Then run `/reload-plugins` in OMP and verify the namespaced MCP server with
`/mcp list` and `/mcp test remarc:remarc`. On the verified OMP 17.3.4 baseline,
the TUI lists `remarc:remarc` as connected under `Agent Plugins`. See the
[OMP guide](docs/integrations/omp.md) for project-scoped installation, generated
tool names, native session creation, explicit pairing, updates, and removal.
Restart OMP after installing or upgrading `remarc-wake`, then run
`/remarc-pair` while the intended Remarc session is active.

### Verify the connection

Ask the agent to call `remarc_list_sessions`. A successful response listing the active Remarc sessions proves that the MCP server can read the app's current data.

## What is included

- **`remarc`** - the required MCP server and workflow skill. It lists sessions and comments, fetches captured context, updates statuses with compare-and-set support, renames sessions, and creates linked sessions for currently supported harnesses.
- **`remarc-hooks`** - an optional, experimental lifecycle plugin. Claude Code can pair a conversation with one Remarc session, inject outstanding comments, and receive an explicit instant-delivery request.
- **`remarc-wake`** - an optional OMP extension for explicit token-leased
  pairing, heartbeat-based liveness, and durable replay of instant-delivery
  requests across interrupted sessions.
- **Shared contracts** - the schema, locking, marker, and forward-compatibility rules used across the app and plugins.

See [Architecture](docs/architecture.md) for the ownership boundary and runtime data flow. The MCP tool behavior is documented in the [Remarc MCP tools reference](https://docs.remarc.app/agents/mcp-tools-reference/).

## Data and security

The MCP server and hooks read and update Remarc's local data file. They do not send Remarc data to a Remarc-operated service and contain no telemetry. Tool results and injected context are still processed by the agent provider you chose, under that provider's policies.

Comments may contain text captured from web pages, applications, screenshots, or transcriptions. The integrations treat that material as untrusted source content, preserve unknown data fields, and use bounded, delimited payloads for automatic delivery.

Plugins execute with your user account's permissions. Review the source before installation and report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/marketplace.json` | Marketplace catalog consumed by Claude Code and Codex |
| `.omp-plugin/marketplace.json` | OMP catalog for the core `remarc` and optional `remarc-wake` packages |
| `plugins/remarc/plugin.json` | Portable Agent Plugins 1.0 manifest consumed by OMP |
| `plugins/remarc/mcp.json` | Agent Plugins 1.0 MCP definition; launches the bundled server from `${PLUGIN_ROOT}` |
| `plugins/remarc/` | MCP server, harness manifests, and the shared Remarc skill |
| `plugins/remarc-hooks/` | Optional lifecycle and instant-delivery integration |
| `plugins/remarc-wake/` | Optional OMP pairing and instant-delivery extension |
| `plugins/shared/` | Data parser, marker protocol, schema fixture, locks, and cross-plugin tests |
| `docs/` | Architecture, compatibility, and integration proposals |

Built JavaScript under `dist/` is committed because plugin managers execute the packaged artifact without building it locally. CI rebuilds the bundles and fails if committed output has drifted from source.

## Development

The shortest local verification loop is:

```sh
(cd plugins/remarc/mcp && npm ci && npm test && npm run build)
(cd plugins/remarc-hooks/cli && npm ci && npm test && npm run build)
(cd plugins/remarc-wake && npm ci && npm run typecheck && npm test && npm run build)
node scripts/check-public-versions.mjs
git diff --exit-code -- plugins/remarc/mcp/dist plugins/remarc-hooks/cli/dist plugins/remarc-wake/dist
claude plugin validate .
```

The OMP smoke script requires the pinned `omp/17.3.4` binary and creates its
own temporary HOME, XDG roots, project, and Remarc fixture:

```sh
node scripts/smoke-omp-marketplace.mjs \
  --omp /absolute/path/to/omp \
  --marketplace "$(pwd)" \
  --expected-version 0.12.0
```

That local-source run proves packaging before publication. After the candidate
commit is merged, repeat it with
`--marketplace metedata/remarc-agent-plugins` to prove the public Git
marketplace path and cached installed artifact. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full contract and fixture checks. Do
not run a marketplace installation smoke test against your normal agent
profile. Codex clean-install coverage remains a documented gap.

## Releases

The public distribution version is shared by every supported-harness manifest,
the portable Agent Plugins manifest, and the OMP catalog entry. The MCP server
also exposes its own implementation version in the initialize handshake;
private npm packages are not independently published.

See [CHANGELOG.md](CHANGELOG.md) and [RELEASING.md](RELEASING.md). The repository did not historically publish tags or GitHub Releases; the documented process is the baseline for making future versions traceable.

## Contributing and support

Focused bug reports and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the shared data or wake contracts.

- End-user documentation: [docs.remarc.app](https://docs.remarc.app)
- Bug reports: [GitHub Issues](https://github.com/metedata/remarc-agent-plugins/issues)
- Security reports: [SECURITY.md](SECURITY.md)
