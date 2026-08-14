# Security Policy

## Supported versions

Only the current public plugin version receives security fixes. Once tagged
releases begin, this means the latest tagged version.

## Reporting a vulnerability

Email **mete@metedata.com** with a description, impact, affected version, and reproduction steps. Do not open a public GitHub issue for security problems.

You can expect an acknowledgement within seven days. Critical issues are prioritized for a coordinated plugin and Remarc app release when necessary.

## Scope

In scope:

- the MCP server and committed distribution bundle;
- Claude Code and Codex plugin manifests;
- lifecycle hooks, marker handling, locking, and automatic delivery;
- parsing and preservation of Remarc's local data;
- installer or marketplace behavior owned by this repository;
- ways untrusted captured content could escape its data boundary and become executable agent instructions.

Third-party agent runtimes and dependencies should normally be reported upstream, but a heads-up is appreciated when Remarc's use is affected.

These plugins execute with the current user's permissions and can read and update `~/Library/Application Support/Remarc/`. Reports involving symlink attacks, unsafe file replacement, lock bypass, prompt injection through captured content, cross-session delivery, or unintended data disclosure are especially valuable.
