# OMP integration architecture

**Status:** Core MCP and skill support shipped in 0.11.0. Version 0.12.0 adds
the optional wake extension, native OMP session origin, and the coordinated
Remarc app lease reader and badge described here.

**Target reviewed:** OMP 17.3.4 at commit [`ffd53ff`](https://github.com/can1357/oh-my-pi/tree/ffd53ff92a6f575d499730475a73460dd7cc2eea), reviewed 2026-08-14.

**Prototype:** [Remarc PR #3](https://github.com/metedata/Remarc/pull/3) at `733bf843`. The prototype is useful protocol and test evidence, but its installer and app-coupled package shape are not the proposed architecture.

## Decision

Ship OMP support from this repository through OMP's plugin manager. Do not make Remarc.app install files into `~/.omp`, scan OMP profile directories, or own OMP update state.

Use two OMP marketplace entries so on-demand MCP use stays independent of
instant delivery:

- `remarc` - the existing MCP server and Remarc workflow skill;
- `remarc-wake` - an optional OMP-only executable extension for explicit pairing and instant delivery.

Keep Claude Code's catalog focused on `remarc` and `remarc-hooks`. The separate
`.omp-plugin/marketplace.json` publishes both without offering the OMP-only
wake extension to Claude users.

Declare explicit versions for both entries in the OMP catalog. OMP can infer an
install version from a plugin manifest or package, but its upgrade-all path
compares catalog entries that declare `version`.

Use one public integration version across the Claude Code and Codex manifests,
the core Agent Plugins 1.0 `plugin.json`, both OMP catalog entries, and the
`remarc-wake` package. CI rejects a version
mismatch. This keeps one repository tag and changelog authoritative; the
separately advertised MCP implementation version remains governed by
[RELEASING.md](../RELEASING.md).

## Goals

- Install and update through the supported OMP plugin manager.
- Reuse the existing MCP bundle, skill, data parser, marker protocol, and tests.
- Keep basic comment workflows independent of instant delivery.
- Pair one OMP session explicitly to one Remarc session.
- Strengthen OMP to durable at-least-once wake attempts, then use compare-and-set work claims.
- Keep OMP-specific runtime code and compatibility testing out of the macOS app.

## Non-goals

- No Remarc-owned task tracker, memory system, or OMP orchestration policy.
- No bundled assumptions about Reverie, Beads, Shepherd, or OMP Verifier.
- No app-side OMP installer, profile scanner, repair button, or package-version detector.
- No claim of exactly-once notification or agent execution.
- No silent pairing to whichever Remarc session happens to be active.

The prototype's `remarc-review` skill is therefore deferred. The generic `remarc` skill already owns comment semantics; optional project-management workflows should be separate packages if users request them.

## Ownership boundary

| Owner | Responsibilities |
| --- | --- |
| Remarc app | `comments.json`, `wakeRequestedAt`, marker/reachability contract, selected-session Instant Delivery UI |
| This repository | OMP catalogs, MCP bundle, skill, wake extension, release/versioning, protocol fixtures, compatibility CI |
| OMP | Plugin scopes, installation, updates, discovery, extension lifecycle, message delivery runtime |
| Both Remarc repositories | Versioned cross-language data and marker compatibility |

The app should understand a generic live pairing marker. It should not need to understand where OMP installed a plugin.

## Package layout

```text
remarc-agent-plugins/
├── .claude-plugin/
│   └── marketplace.json
├── .omp-plugin/
│   └── marketplace.json
└── plugins/
    ├── remarc/
    │   ├── .claude-plugin/plugin.json
    │   ├── .codex-plugin/plugin.json
    │   ├── plugin.json
    │   ├── mcp.json
    │   ├── skills/remarc/SKILL.md
    │   └── mcp/dist/index.js
    └── remarc-wake/
        ├── package.json
        ├── README.md
        ├── src/index.ts
        ├── src/*.test.ts
        ├── dist/index.js
```

The wake package declares a built JavaScript entry point so an installation never depends on a source checkout or an npm install:

```json
{
  "name": "@metedata/remarc-wake",
  "version": "0.12.0",
  "private": true,
  "type": "module",
  "omp": {
    "extensions": ["./dist/index.js"]
  }
}
```

Phase 1 uses OMP 17.3.4's Agent Plugins 1.0 support: a root `plugin.json`, a
root `mcp.json`, conventional `skills/<name>/SKILL.md`, and `${PLUGIN_ROOT}`
expansion into the cached installed package. The wake package uses OMP's
native `omp.extensions` package field because executable extensions are outside
the two portable Agent Plugins 1.0 capability types implemented by this OMP
baseline.

## Phase 1: basic MCP and skill (released in 0.11.0)

Publish the existing `plugins/remarc` package through the OMP catalog before adding wake behavior.

Installation:

```sh
omp plugin marketplace add metedata/remarc-agent-plugins
omp plugin install remarc@remarc
```

Refresh and verify inside OMP:

```text
/reload-plugins
/mcp list
/mcp test remarc:remarc
```

OMP's Agent Plugins provider namespaces MCP servers as `<plugin>:<server>`,
hence `remarc:remarc`. Its tool bridge then exposes protocol tool names through
generated agent-callable identifiers; for example, `remarc_list_sessions`
becomes `mcp__remarc_remarc_remarc_list_sessions`.

### Native session creation (0.12.0)

The 0.11.0 core release used a pre-transaction create guard while the app and
schema did not yet know OMP origin. Version 0.12.0 completes that coordination:

1. the shared schema and cross-language fixture include `origin: "omp"`;
2. the OMP-owned MCP process forces native OMP origin from its trusted launch
   identity, regardless of model-controlled Claude Code or Codex overrides;
3. OMP creation may omit the legacy `claude_session_id` field;
4. OMP leaves `claudeCodeSessionId` empty and does not write an ownerless
   historical marker;
5. the Remarc app decodes and displays OMP origin with the official badge.

Claude Code and Codex keep their existing session-id and override behavior.
The native OMP origin is provenance only; instant delivery still requires an
explicit `/remarc-pair` from the optional wake extension.

The OMP MCP override is explicit:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "remarc": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${PLUGIN_ROOT}/mcp/dist/index.js",
        "--harness",
        "omp"
      ]
    }
  }
}
```

Status writes are attributed from the trusted MCP launch
identity, so OMP resolutions persist `resolvedBy: "omp"` without depending on
the caller's tool arguments.

### Phase 1 acceptance

- Install from a Git marketplace in an isolated user profile without symlinks to a checkout.
- Discover the `remarc` skill.
- List and test `remarc:remarc`.
- Exercise list, get, handoff, compare-and-set claim, resolve, reopen, and rename against a fixture copy.
- Prove unknown document, session, comment, and web-context fields survive writes.
- Call `remarc_create_session` without the legacy session ID and with attempted
  Claude Code/Codex overrides; prove all persist `origin: "omp"`, preserve
  unknown fields, and leave the marker directory byte-identical.
- Uninstall and reinstall without touching Remarc user data.
- Test OMP's user and project scopes.

The implemented local Phase 1 smoke uses an exact `omp/17.3.4` binary. It has
verified user-only and project-shadowed installation, cached-copy provenance,
enable/disable, uninstall/reinstall, `skill:remarc` discovery, and fresh TUI
`/mcp list` results showing `remarc:remarc` connected under `Agent Plugins` in
both scopes. A direct client probe of each cached bundle exercises all seven
tools: list/get, compare-and-set claim, resolve/reopen/handoff, bulk resolve,
rename, and native create calls with no harness plus spoofed Claude Code and
Codex inputs. It also proves `resolvedBy: "omp"`, preservation of unknown
document/session/comment/web-context fields, and restoration of byte-identical
Remarc data and marker sentinels around the isolated test. The equivalent public
Git marketplace run remains a post-merge release gate; a local checkout cannot
prove that distribution path.

## Phase 2: optional `remarc-wake` extension (0.12.0)

The external package ports the useful protocol logic and adversarial tests from
PR #3 without copying its app-owned installer or package shape.

Required behavior:

- `/remarc-pair` explicitly pairs the current OMP session to the selected active Remarc session.
- `/remarc-unpair` disables and removes that pairing.
- Only one live OMP owner may lease a Remarc session pairing.
- Markers use the historical `Remarc/claude/markers` location for app compatibility.
- Writes use adjacent atomic directory locks and preserve unknown marker fields.
- Eligible comments are non-deleted, `handedOff`, session-matched, and have a newer `wakeRequestedAt` generation.
- A durable `pendingWake[commentId]` outbox records the generation before
  `sendMessage`. Its return value is not a delivery receipt.
- Pending generations replay after resume until a correlated durable work claim
  or later status proves that comment is no longer `handedOff`; only then may
  `wakedAt[commentId]` advance and the outbox entry clear.
- Payloads contain full IDs, cap comments and characters, and wrap captured text in unpredictable sentinels.
- The recipient claims work with `expected_status: "handedOff"` before acting.
- Explicit unpair and normal shutdown stop advertising reachability promptly;
  forced death is recovered by lease expiry rather than impossible cleanup.

### Normative lease predicate

The first OMP marker revision must add `protocolVersion`, `harness: "omp"`,
`ownerPid`, `ownerToken`, and `leaseHeartbeatAt`. Generate at least 128 random
bits for `ownerToken`, refresh the heartbeat at least every 15 seconds, and use a
60-second lease TTL.

The app considers the pairing live only when the protocol version is supported,
the harness is `omp`, the token is non-empty, the PID is currently live, and the
heartbeat age is between -30 and 60 seconds. A heartbeat further in the future
is invalid rather than immortal. Missing fields, the wrong harness, and unknown
protocol versions are not live OMP leases. Historical Claude markers continue
under their existing rules but can never satisfy the OMP predicate. Ownership
changes and heartbeats must match the current token under the marker lock.
Normal shutdown and unpair must abandon a blocked cleanup attempt within one
second so the whole callback remains inside OMP's two-second `session_shutdown`
handler budget. A forced death may remain visible only until the heartbeat TTL
expires. PID reuse inside that window can cause a bounded false-positive, but a
reused process cannot refresh the lease without the token.

### Required changes from the prototype

- Import current types from `@oh-my-pi/pi-coding-agent`, not the older `@earendil-works` package name.
- Replace the prototype's `agent_settled` dependency with documented `turn_end`, `agent_end`, or current `sendMessage` continuation semantics.
- Use `ctx.setInterval` and `ctx.setTimeout`. OMP extensions run in-process; an uncaught raw-timer callback can terminate the whole session.
- Prefer `sendMessage(..., { deliverAs: "nextTurn", triggerTurn: true })` for an idle wake or safe continuation rather than maintaining a second competing queue model. The API returns `void`; during a streaming turn it may only enqueue in process memory, so never infer durable delivery from its return.
- Bundle shared marker and parsing code into committed `dist/index.js`; do not duplicate the protocol or import files outside the installed plugin root at runtime.
- The prototype serializer kept only known marker keys. The shared serializer
  now preserves unknown fields before adding OMP lease data.
- Implement the exact token, PID, heartbeat cadence, and TTL predicate above in
  both languages; do not maintain alternate PID-only or heartbeat-only paths.
- Pin `@oh-my-pi/pi-coding-agent` to exact version 17.3.4 in the wake package and
  commit its lockfile. Typecheck against that dependency; run a scheduled
  compatibility canary against current OMP separately from the required release
  gate.

### Phase 2 acceptance

Tests must cover:

- first pair, re-pair, explicit unpair, resume, branch/session switch, normal
  shutdown within the two-second OMP budget, and forced-death expiry;
- two processes attempting to own one Remarc session;
- a stale but still-running owner being token-fenced before takeover;
- live owner, dead owner, ownerless legacy marker, stale heartbeat, and PID reuse scenarios;
- missing token, wrong harness, unknown protocol, fresh/stale/far-future
  heartbeat, wrong Remarc session, and unknown-field preservation fixtures in
  both Swift and TypeScript;
- concurrent marker writers, lock timeout, abandoned lock, malformed JSON, symlinks, and wrong file types;
- same-generation dedup and a later explicit re-wake generation;
- crash before the outbox write, immediately after the outbox write, immediately
  after an in-memory `nextTurn` enqueue, before claim, and after durable claim;
- `SIGKILL` during streaming followed by resuming the same OMP session, proving
  the pending generation is offered again rather than silently cleared;
- idle delivery, delivery while a turn is active, and shutdown during delivery;
- session isolation, deleted/resolved filtering, payload caps, truncation, and prompt-like captured text;
- a held marker lock during `session_shutdown`, proving cleanup times out safely
  and heartbeat expiry still removes reachability;
- marketplace install, discovery, enable/disable, upgrade, and removal.

After installing or upgrading `remarc-wake`, restart the OMP session. OMP can
reload skills and MCP servers in place, but newly installed extension modules
are initialized only for a new session.

## Phase 3: minimal Remarc app enablement

Release the wake extension only with the small app changes that make it usable and truthful:

- move the opt-in Instant Delivery toggle out of the Claude-hooks-only section;
- describe delivery to a “paired agent session” rather than only Claude Code;
- recognize the versioned OMP token + live PID + 60-second heartbeat predicate
  above, with no PID-only or heartbeat-only fallback;
- require a live marker paired to the selected Remarc session before showing the CTA;
- add the OMP session origin and official badge when OMP-created sessions are enabled;
- link to this repository's OMP setup documentation.

Do not add the prototype's `OMPIntegrationDetector` or scan `~/.omp/agent` and named profiles. OMP supports user/project scopes and plugin-managed roots; installed files are not proof of a live pairing. OMP owns installation status, while the marker proves runtime reachability.

The app patch should stay independent of OMP package layout: generic marker fields in, generic paired-agent UI out.

Coordinated origin support uses OMP's official full-color favicon for the
session badge. The live [`omp.sh/favicon.svg`](https://omp.sh/favicon.svg)
matches [`packages/collab-web/public/favicon.svg`](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/collab-web/public/favicon.svg)
at the reviewed commit byte for byte (SHA-256
`9419975a0c24961341221c4cec18703db26a989fa037768f92cda74e3769fe05`).
Vendor that SVG as `OMPLogo.imageset` with
`preserves-vector-representation: true`, `template-rendering-intent: original`,
and `.renderingMode(.original)`. Record its upstream path, commit, hash, and MIT
notice in both Remarc copies of `THIRD-PARTY-NOTICES.md`. Preserve the dark
rounded-square background and pink-purple-cyan gradient; unlike the current
template-rendered Claude Code and Codex marks, it must render in its original
colors.

That badge reports session provenance (`Created by OMP`), matching
`SessionOriginBadge`; it is not evidence of a currently live pairing. Any live
OMP indicator must remain marker-driven and visually distinct.

## Delivery sequence

1. **OSS baseline and RFC** - completed.
2. **OMP core support** - released in 0.11.0.
3. **OMP wake and native origin** - implemented externally for 0.12.0.
4. **Remarc app enablement** - coordinated lease-aware reachability, neutral UI,
   native origin, official badge, fixtures, and tests for Remarc 1.1.0.
5. **Coordinated publication** - public Git marketplace smoke, released plugin,
   released compatible app, and replacement notice on the prototype PR.

After equivalent external tests pass, close or replace PR #3 rather than merging its 4,500-line app-centered shape.

## Verification gates

Current repository gates:

```sh
node scripts/check-public-versions.mjs
(cd plugins/remarc/mcp && npm ci && npm test && npm run build)
(cd plugins/remarc-hooks/cli && npm ci && npm test && npm run build)
(cd plugins/remarc-wake && npm ci && npm run typecheck && npm test && npm run build)
git diff --exit-code -- plugins/remarc/mcp/dist plugins/remarc-hooks/cli/dist plugins/remarc-wake/dist
```

The marketplace smoke must receive the exact pinned binary; it rejects any
`omp --version` output other than `omp/17.3.4`. It creates an isolated HOME,
XDG roots, project, Remarc fixture, and marker sentinel, then deletes only that
validated temporary root:

```sh
node scripts/smoke-omp-marketplace.mjs \
  --omp /absolute/path/to/omp \
  --marketplace "$(pwd)" \
  --expected-version 0.12.0
```

That run verifies the candidate checkout's Agent Plugins 1.0 package shape,
cached installation, user/project scopes and shadowing, skill and wake-command
discovery, fresh TUI discovery of connected server `remarc:remarc`, installed
MCP behavior, extension enable/disable, uninstall/reinstall, and Remarc-data preservation. A separate
non-blocking canary may run against the latest OMP, but it does not replace the
pinned release gate.

The local-directory source does not satisfy the Git-marketplace acceptance
gate. After merge, repeat the same script with
`--marketplace metedata/remarc-agent-plugins`. Assert from machine-readable
plugin state that OMP installed the package into its isolated marketplace cache
and not from a source checkout. A future release should also add an N-1 to
current upgrade fixture.

App validation for the coordinated Remarc change:

```sh
cd app/RemarcPackage
swift test --filter WakeReachabilityTests
```

Then perform the clean Debug build and mandatory relaunch required by the Remarc repository instructions, followed by an end-to-end pair, wake, re-wake, busy-turn, unpair, and forced-process-death check.

## Principal risks

- **OMP API drift:** pin a supported baseline and run a separate latest-version canary.
- **In-process extension failure:** use managed timers, contained callbacks, bounded work, and shutdown cleanup.
- **MCP precedence:** imported or project configs may shadow a same-named server; verify provenance with `/mcp list` and test the namespaced server.
- **Stale ownership:** PID alone is insufficient because of PID reuse; use the
  single versioned token + live PID + heartbeat predicate above and let forced
  death expire within the bounded TTL.
- **At-least-once wake attempts:** `sendMessage` has no durable receipt. Keep the
  outbox pending through enqueue, restart, and resume until a durable status
  transition acknowledges the work; duplicates remain possible around crashes.
  Status compare-and-set prevents two successful cooperative claims, not
  duplicate reads or arbitrary work.
- **Untrusted captured content:** keep sentinels, payload caps, explicit tool fetches, and security tests.
- **Remote filesystem boundaries:** screenshot paths may be unavailable outside the Mac running Remarc.
- **Cross-repository drift:** add shared marker fixtures and coordinated tests before changing the wire contract.

## Authoritative OMP references

- [Marketplace behavior and commands](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/marketplace.md)
- [Marketplace catalogs and package sources](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/skills/authoring-marketplaces.md)
- [Agent Plugins 1.0 discovery (`plugin.json`, `mcp.json`, and `${PLUGIN_ROOT}`)](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/discovery/agent-plugins.ts)
- [Agent Plugins 1.0 format validation](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/discovery/agent-plugin-format.ts)
- [Extension lifecycle, managed timers, and message delivery](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/extensions.md)
- [Extension runner shutdown budget](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/extensibility/extensions/runner.ts#L95-L114)
- [`sendMessage` API](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/extensibility/extensions/types.ts#L1310-L1320)
- [In-memory `nextTurn` queue behavior](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/session/agent-session.ts#L5950-L5980)
- [`nextTurn` queue drain](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/session/agent-session.ts#L6134-L6137)
- [MCP discovery, namespacing, reload, and testing](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/mcp-config.md)
- [Plugin manager installation and scopes](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/plugin-manager-installer-plumbing.md)
- [Official OMP session-badge SVG](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/collab-web/public/favicon.svg)
- [OMP MIT license](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/LICENSE)
