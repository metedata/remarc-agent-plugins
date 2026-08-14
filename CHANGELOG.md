# Changelog

All notable user-visible changes to the Remarc agent plugins are documented here.

The public distribution version is shared by the Claude Code and Codex manifests for both plugins. The private packages are not published to npm, but the MCP server's implementation version is publicly visible in its initialize handshake and is recorded separately when it changes.

## Unreleased

### Documentation

- Reframed the repository around all supported agent integrations.
- Added architecture, compatibility, contribution, security, and release documentation.
- Documented a phased external OMP integration proposal without claiming current OMP support.
- Corrected the published defaults and delivery guarantees in the app-plugin contract.
- Documented the current Codex clean-install CI gap and marker forward-compatibility limitation.

## 0.10.0 - 2026-08-07

### Changed

- Agent callers can declare the harness recorded on newly created sessions.
- Normal agent shutdown unlinks the live pairing without deleting the Remarc session or its comments.
- Destructive session wind-down behavior is limited to an explicit conversation-clear event.

Earlier development history remains available in Git, but versions before 0.10.0 were not published as tagged GitHub Releases.
