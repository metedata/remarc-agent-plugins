# Remarc agent plugins privacy policy

Last updated: August 21, 2026

This policy covers the open-source Remarc agent plugins published by Metedata,
including the core `remarc` plugin for Claude Code. It supplements the Remarc
app's [data and privacy documentation](https://docs.remarc.app/reference/data-and-privacy/).

## Data the core plugin can access

The core plugin runs locally on the user's Mac. When a user or agent invokes a
Remarc MCP tool, the plugin can read the Remarc data needed for that call from
`~/Library/Application Support/Remarc/`, including:

- session names, identifiers, timestamps, origins, and comment counts;
- comment text, selected text, source-app metadata, web-element context, and
  status or resolution metadata; and
- screenshot files referenced by screenshot comments.

Write tools can create or rename a session and update comment statuses and
resolution summaries. The core plugin does not expose a tool that deletes
comments, sessions, or files.

## Processing and network disclosure

The core plugin is a local stdio MCP server. It has no Metedata- or
Remarc-operated backend, sends no telemetry, serves no advertising, and does
not sell user data.

MCP tool results are returned to the agent the user connected. That means the
selected comment data, including an inline screenshot when requested, may be
included in the user's agent conversation and processed by Anthropic or the
other agent provider the user chose. The provider's privacy and retention
terms apply to that processing. Metedata does not receive those tool results.

Installing or updating the plugin downloads its public source package from
GitHub through the user's agent marketplace. The bundled MCP server does not
download runtime code or instructions from third parties.

The optional Remarc app webhooks and the separate experimental lifecycle or
wake plugins are not required by the core plugin. Their behavior is documented
where users enable them.

## Storage and retention

The core plugin does not maintain an independent copy of Remarc comments or
screenshots. Its writes go back to Remarc's local data file. Remarc's retention
settings control that local data. Copies included in an agent conversation are
retained under the user's agreement with that agent provider.

## User control and security

Users choose what they capture in Remarc, which agent they connect, and when
the agent invokes a tool. The plugin runs with the current macOS user's file
permissions. Captured context is treated as untrusted data rather than as
instructions for the agent.

The source is available at
[github.com/metedata/remarc-agent-plugins](https://github.com/metedata/remarc-agent-plugins).
Security issues should be reported privately as described in
[SECURITY.md](SECURITY.md).

## Contact and changes

Privacy or support questions can be sent to **mete@metedata.com**. Material
changes to this policy will be published in this repository with an updated
date.
