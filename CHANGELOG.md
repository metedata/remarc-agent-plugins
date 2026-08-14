# Changelog

All notable user-visible changes to the Remarc agent plugins are documented here.

The public distribution version is shared by the supported-harness manifests
and marketplace entries. The private packages are not published to npm, but the
MCP server's implementation version is publicly visible in its initialize
handshake and is recorded separately when it changes.

## Unreleased

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
