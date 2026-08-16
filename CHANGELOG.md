# Changelog

All notable user-visible changes to the Remarc agent plugins are documented here.

The public distribution version is shared by the supported-harness manifests
and marketplace entries. The private packages are not published to npm, but the
MCP server's implementation version is publicly visible in its initialize
handshake and is recorded separately when it changes.

## Unreleased

No entries yet.

## 0.13.0 - 2026-08-16

### Added

- Screenshot comments now return the captured image inline. `remarc_get_comment`
  attaches the screenshot as an image block alongside its text, so an agent sees
  it directly instead of being handed a file path. This makes screenshot
  comments usable in clients that cannot read an arbitrary local path (for
  example Claude Desktop), and saves a file-read round-trip in clients that can.
  An oversized, missing, or unsupported image falls back to the path-only text
  result.

### Changed

- Reconciled the reference-only comment support and readable screenshot paths
  with the 0.12.1 OMP integration line; the two had been developed in parallel
  and never combined. The MCP server implementation version moves to 0.4.0.

## 0.12.1 - 2026-08-15

### Added

- Added package-local MIT license files and canonical third-party notices for
  the dependencies bundled into the installed MCP artifact.
- Added automated notice validation and cached-package smoke assertions so
  release packages cannot omit their license material.

### Changed

- Bumped the public integration version to 0.12.1 across the supported
  manifests and marketplace entries. The MCP implementation remains 0.3.0 and
  the runtime bundles are unchanged from 0.12.0.
- Added self-describing package metadata to the optional OMP wake extension.

### Documentation

- Recorded the Remarc 1.1.0 release and the completed public Git-marketplace
  acceptance smoke for OMP plugins 0.12.0 and 0.12.1.
- Updated the repository's public description, topics, and root release
  documentation to surface OMP and the current tagged releases.
- Brought contributor, security, and OMP architecture documentation in line
  with the shipped wake package, unknown-field preservation, Remarc 1.1.0, and
  the completed public marketplace rollout.
- Added OMP-specific issue and pull-request support paths plus current
  development and release verification commands.

## 0.12.0 - 2026-08-15

### Added

- Added the optional `remarc-wake` OMP extension with explicit
  `/remarc-pair` and `/remarc-unpair` commands, managed lifecycle timers,
  session-scoped file watching, and next-turn delivery. Instant delivery
  requires Remarc 1.1.0 or later; Remarc 1.0.1 remains compatible with the
  core OMP MCP integration.
- Added a versioned OMP lease with token/PID/heartbeat ownership, atomic
  cross-marker pairing claims, owner-token compare-and-set cleanup, and a
  durable pending-wake outbox that replays after interruption.
- Added native OMP session creation and `origin: "omp"` across the MCP runtime,
  shared schema, cross-language fixtures, workflow skill, and installed-runtime
  smoke tests.
- Added adversarial coverage for lock contention, unsafe marker paths, competing
  owners, lease expiry, generation ordering, payload limits, restart replay,
  and bounded shutdown.

### Changed

- Bumped the public integration version to 0.12.0 and the MCP implementation
  version to 0.3.0.
- Moved wake selection and marker serialization into shared, forward-compatible
  modules used by Claude Code and OMP.
- OMP session creation now trusts only the OMP-owned server identity, ignores
  model-controlled Claude/Codex origin spoofing, leaves the legacy session-id
  field empty, and avoids ownerless historical markers.
- Extended CI and the pinned OMP 17.3.4 marketplace smoke to build, install,
  discover, disable, re-enable, and remove the optional wake extension.

### Documentation

- Published OMP core, native-session, instant-delivery, update, removal, data,
  security, compatibility, and release-verification instructions.
- Recorded the external plugin-manager architecture that replaces the
  app-coupled PR #3 prototype.

## 0.11.0 - 2026-08-14

### Added

- Added an OMP-specific marketplace catalog, manifest, MCP launch identity, and
  installation guide for on-demand Remarc comment workflows.
- Added synchronized public-version validation across Claude Code, Codex, and
  OMP distribution metadata.

### Changed

- Bumped the public integration version to 0.11.0 and the MCP implementation
  version to 0.2.0.
- OMP-owned MCP processes now reject linked-session creation before opening a
  document transaction, including caller attempts to spoof Claude Code or Codex.
- MCP resolutions now record `claude`, `codex`, or `omp` from the trusted server
  launch identity instead of attributing every agent resolution to Claude.
- Refreshed package locks and added high-severity dependency-audit gates for all
  repository packages.

### Documentation

- Reframed the repository around all supported agent integrations.
- Added architecture, compatibility, contribution, security, and release documentation.
- Documented the phased external OMP design and the shipped Phase 1 core support
  boundary.
- Corrected the published defaults and delivery guarantees in the app-plugin contract.
- Documented the current Codex clean-install CI gap and marker forward-compatibility limitation.

## 0.10.0 - 2026-08-07

### Changed

- Agent callers can declare the harness recorded on newly created sessions.
- Normal agent shutdown unlinks the live pairing without deleting the Remarc session or its comments.
- Destructive session wind-down behavior is limited to an explicit conversation-clear event.

Earlier development history remains available in Git, but versions before 0.10.0 were not published as tagged GitHub Releases.
