# Proposal: OMP integration

**Status:** Proposed. OMP is not currently a supported Remarc integration.

**Target reviewed:** OMP 17.3.4 at commit [`ffd53ff`](https://github.com/can1357/oh-my-pi/tree/ffd53ff92a6f575d499730475a73460dd7cc2eea), reviewed 2026-08-14.

**Prototype:** [Remarc PR #3](https://github.com/metedata/Remarc/pull/3) at `733bf843`. The prototype is useful protocol and test evidence, but its installer and app-coupled package shape are not the proposed architecture.

## Decision

Ship OMP support from this repository through OMP's plugin manager. Do not make Remarc.app install files into `~/.omp`, scan OMP profile directories, or own OMP update state.

Use two OMP marketplace entries:

- `remarc` - the existing MCP server and Remarc workflow skill, with the Phase 1 harness guard;
- `remarc-wake` - an optional OMP-only executable extension for explicit pairing and instant delivery.

Keep Claude Code's catalog focused on `remarc` and `remarc-hooks`. Add a separate `.omp-plugin/marketplace.json`, which OMP prefers over the Claude-compatible fallback, so Claude users are not offered an OMP-only extension.

Declare explicit versions for both entries in the OMP catalog. OMP can infer an
install version from a plugin manifest or package, but its upgrade-all path
compares catalog entries that declare `version`.

Use one public integration version across the four current plugin manifests,
the future core OMP manifest, both OMP catalog entries, and the `remarc-wake`
package. CI must reject a version mismatch. This keeps one repository tag and
changelog authoritative; the separately advertised MCP implementation version
remains governed by [RELEASING.md](../RELEASING.md).

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

## Proposed package layout

```text
remarc-agent-plugins/
├── .claude-plugin/
│   └── marketplace.json
├── .omp-plugin/
│   └── marketplace.json
└── plugins/
    ├── remarc/
    │   ├── .claude-plugin/plugin.json
    │   ├── .omp-plugin/plugin.json
    │   ├── .mcp.json
    │   ├── omp-mcp.json
    │   ├── skills/remarc/SKILL.md
    │   └── mcp/dist/index.js
    └── remarc-wake/
        ├── package.json
        ├── README.md
        ├── src/index.ts
        ├── dist/index.js
        └── test/
```

The wake package declares a built JavaScript entry point so an installation never depends on a source checkout or an npm install:

```json
{
  "name": "@metedata/remarc-wake",
  "version": "0.11.0",
  "private": true,
  "type": "module",
  "omp": {
    "extensions": ["./dist/index.js"]
  }
}
```

`0.11.0` is illustrative, not a committed release number. The implemented
package must use the integration release version selected for that change.

OMP's current marketplace installer can load `omp.extensions` from a marketplace package. Skills use the conventional `skills/<name>/SKILL.md` layout, and OMP substitutes both `${OMP_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` in plugin MCP definitions.

## Phase 1: basic MCP and skill

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

OMP namespaces marketplace MCP servers as `<plugin>:<server>`, hence `remarc:remarc`.

### Session-creation limitation

Phase 1 supports reading and updating existing Remarc sessions. It must reject
`remarc_create_session` from OMP before any file write; prompt guidance alone is
not a safety boundary.

Today an MCP process with no recognized harness falls back to `claudeCode`. The
tool input schema accepts only `claudeCode` and `codex`, the app enum has no OMP
presentation, and the JSON Schema closes `origin` to the same known values. An
OMP caller can therefore create incorrect durable data unless the runtime is
changed.

Give OMP an explicit process identity without yet making it a durable session
origin:

1. declare `.omp-plugin/plugin.json` with `mcpServers: "./omp-mcp.json"`;
2. have `omp-mcp.json` launch the existing bundle with `--harness omp`;
3. recognize `omp` as an MCP caller identity;
4. in `remarc_create_session`, reject an OMP-owned process before entering the
   document transaction, regardless of any caller-supplied harness value;
5. tell OMP in the skill to create or select a session in Remarc and reuse it.

This guard leaves all read and update tools available while making false Claude
session creation impossible through the OMP server.

The OMP MCP override is explicit:

```json
{
  "mcpServers": {
    "remarc": {
      "command": "node",
      "args": [
        "${OMP_PLUGIN_ROOT}/mcp/dist/index.js",
        "--harness",
        "omp"
      ]
    }
  }
}
```

Correctly labelled OMP-created sessions require a coordinated later change:

1. widen the shared origin schema and cross-decode fixture;
2. allow `omp` as a persisted origin and tool-input value, then remove the OMP creation guard;
3. make resolution attribution harness-aware;
4. add an OMP origin/badge in the app while preserving unknown values for older builds;
5. update the skill only after both sides can round-trip the result.

### Phase 1 acceptance

- Install from a Git marketplace in an isolated user profile without symlinks to a checkout.
- Discover the `remarc` skill.
- List and test `remarc:remarc`.
- Exercise list, get, handoff, compare-and-set claim, resolve, reopen, and rename against a fixture copy.
- Prove unknown document, session, comment, and web-context fields survive writes.
- Call `remarc_create_session` both without a harness and with an attempted
  `claudeCode` override; prove both return an OMP-specific error and leave the
  fixture and marker directory byte-identical.
- Uninstall and reinstall without touching Remarc user data.
- Test OMP's user and project scopes.

## Phase 2: optional `remarc-wake` extension

Port the useful protocol logic and adversarial tests from PR #3 into `plugins/remarc-wake`; do not copy its packaging unchanged.

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
- Add raw-field preservation to the shared marker serializer before introducing
  OMP lease fields; the current serializer keeps only its known keys.
- Implement the exact token, PID, heartbeat cadence, and TTL predicate above in
  both languages; do not maintain alternate PID-only or heartbeat-only paths.
- Pin `@oh-my-pi/pi-coding-agent` to exact version 17.3.4 in the wake package and
  commit its lockfile. Typecheck against that dependency; run a scheduled
  compatibility canary against current OMP separately from the required release
  gate.

### Phase 2 acceptance

Tests must cover:

- first pair, re-pair, explicit unpair, resume, normal shutdown within the
  two-second OMP budget, and forced-death expiry;
- two processes attempting to own one Remarc session;
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

When coordinated origin support lands, use OMP's official full-color favicon for
the session badge. The live [`omp.sh/favicon.svg`](https://omp.sh/favicon.svg)
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

## Pull-request sequence

1. **OSS baseline and RFC** - documentation and contract corrections only.
2. **OMP core support** - OMP catalog, basic install tests, skill limitation, and compatibility CI.
3. **OMP wake package** - external extension, protocol fixtures, and adversarial tests.
4. **Minimal app enablement** - neutral toggle/copy and generic lease-aware reachability.
5. **Origin support** - only when session creation is coordinated across schema, plugin, app model, badge, and tests.

After equivalent external tests pass, close or replace PR #3 rather than merging its 4,500-line app-centered shape.

## Verification gates

Repository packages:

```sh
node scripts/check-public-versions.mjs
(cd plugins/remarc/mcp && npm ci && npm test && npm run build)
(cd plugins/remarc-hooks/cli && npm ci && npm test && npm run build)
(cd plugins/remarc-wake && npm ci && npm run typecheck && npm test && npm run build)
git diff --exit-code -- plugins/remarc/mcp/dist plugins/remarc-hooks/cli/dist plugins/remarc-wake/dist
```

The local pre-publication smoke test must pin 17.3.4 for the required gate and
run a separate non-blocking canary against the latest OMP. Assert and record
`omp --version` before testing. Isolate HOME and every XDG root because OMP may
prefer existing XDG state over `~/.omp`:

```sh
OMP_TEST_ROOT="$(mktemp -d)"
OMP_MARKETPLACE_ROOT="$(pwd)"
mkdir -p \
  "$OMP_TEST_ROOT/home/Library/Application Support/Remarc" \
  "$OMP_TEST_ROOT/xdg-config" \
  "$OMP_TEST_ROOT/xdg-data" \
  "$OMP_TEST_ROOT/xdg-state" \
  "$OMP_TEST_ROOT/xdg-cache" \
  "$OMP_TEST_ROOT/project"
cp plugins/shared/fixtures/comments.sample.json \
  "$OMP_TEST_ROOT/home/Library/Application Support/Remarc/comments.json"

run_omp() {
  env \
    HOME="$OMP_TEST_ROOT/home" \
    XDG_CONFIG_HOME="$OMP_TEST_ROOT/xdg-config" \
    XDG_DATA_HOME="$OMP_TEST_ROOT/xdg-data" \
    XDG_STATE_HOME="$OMP_TEST_ROOT/xdg-state" \
    XDG_CACHE_HOME="$OMP_TEST_ROOT/xdg-cache" \
    omp "$@"
}

OMP_TEST_VERSION="$(run_omp --version)"
printf '%s\n' "$OMP_TEST_VERSION" | tee "$OMP_TEST_ROOT/omp-version.txt"
test "$OMP_TEST_VERSION" = "17.3.4"
run_omp plugin marketplace add "$OMP_MARKETPLACE_ROOT"
run_omp plugin install remarc@remarc
run_omp plugin install remarc-wake@remarc
run_omp plugin list --json
run_omp plugin doctor

(
  cd "$OMP_TEST_ROOT/project"
  run_omp plugin install --scope project remarc@remarc
  run_omp plugin list --json
)
```

From a fresh OMP process under the same isolated environment, verify skill and
MCP discovery, `/mcp test remarc:remarc`, extension restart/discovery, user and
project scopes, project-over-user shadowing, enable/disable, upgrade, uninstall,
fixture and marker hashes around the rejected create-session calls, and an N-1
to current version upgrade. The test must delete only its validated temporary
directory when complete; it must never point cleanup at a real home or profile.

The local-directory source above does not satisfy the Git-marketplace acceptance
gate. Before release, repeat the clean install with `metedata/remarc-agent-plugins`
or an HTTPS Git fixture containing the exact candidate commit. Assert from the
machine-readable plugin state that OMP installed the package into its isolated
marketplace cache, not from the source checkout, then repeat discovery,
upgrade, uninstall, and user/project-scope checks.

App validation for the later app PR:

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
- [Marketplace package layout and MCP manifests](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/skills/authoring-marketplaces.md)
- [Extension lifecycle, managed timers, and message delivery](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/extensions.md)
- [Extension runner shutdown budget](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/extensibility/extensions/runner.ts#L95-L114)
- [`sendMessage` API](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/extensibility/extensions/types.ts#L1310-L1320)
- [In-memory `nextTurn` queue behavior](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/session/agent-session.ts#L5950-L5980)
- [`nextTurn` queue drain](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/coding-agent/src/session/agent-session.ts#L6134-L6137)
- [MCP discovery, namespacing, reload, and testing](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/mcp-config.md)
- [Plugin manager installation and scopes](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/docs/plugin-manager-installer-plumbing.md)
- [Official OMP session-badge SVG](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/packages/collab-web/public/favicon.svg)
- [OMP MIT license](https://github.com/can1357/oh-my-pi/blob/ffd53ff92a6f575d499730475a73460dd7cc2eea/LICENSE)
