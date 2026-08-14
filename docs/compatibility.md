# Compatibility

This page distinguishes currently supported behavior from code that merely exists or has been proposed.

## Inspected baselines

The following versions and artifacts were inspected on 2026-08-14. They are not
all one end-to-end tested combination: package tests and Claude marketplace
validation ran locally; the shipping app, CLI commands, and source baselines
were checked separately; OMP is a research target only.

| Component | Baseline |
| --- | --- |
| Remarc | 1.0.1 |
| Remarc plugins | 0.10.0 |
| macOS | Remarc's minimum is macOS 14.0 |
| CI Node.js | 22 |
| Bundle target | Node.js 18 |
| Claude Code | 2.1.226 |
| Codex CLI | 0.146.1 |
| OMP research target | 17.3.4 at commit `ffd53ff` |

These are not permanent minimum-version guarantees. CI currently exercises
macOS with Node 22, not a Node-version matrix.

The current clean-install smoke test covers Claude Code only. Codex support is
shipped by Remarc 1.0.1 and its commands were checked against the CLI baseline
above, but Codex manifest, discovery, and clean-install coverage still need to
be added to this repository's CI.

## Capability matrix

| Capability | Claude Code | Codex | OMP |
| --- | --- | --- | --- |
| Marketplace installation | Supported | Supported | Proposed |
| `remarc` skill | Supported | Supported | Proposed |
| Remarc MCP tools | Supported | Supported | Proposed |
| Create a correctly labelled linked session | Supported | Supported | Not supported |
| Automatic start/prompt context injection | Experimental, optional | Not in the supported app flow | Not proposed in phase 1 |
| Instant delivery to an idle agent | Experimental, optional | Not supported | Proposed |
| Settings install/status UI | Supported | Supported | Not planned for the first integration |

OMP is listed because a source-grounded path has been designed. No OMP manifest, extension, compatibility CI, or supported install flow exists in this repository yet.

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
- The installed shared skill still uses legacy automatic-attachment wording.
  Core-only Codex must fetch comments on demand; automatic prompt attachment
  requires a lifecycle integration.
- Status updates retain a summary only for `resolved`; an `inProgress` summary
  supplied by the current skill is discarded by the data writer.

See [Architecture](architecture.md) and the [OMP proposal](omp-integration-proposal.md) for the boundaries behind this matrix.
