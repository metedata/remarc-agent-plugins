# remarc

The required plugin for connecting Claude Code to the [Remarc](https://remarc.app) macOS app.

## Install

```sh
/plugin marketplace add metedata/remarc-agent-plugins
/plugin install remarc@remarc
```

## What it does

- Exposes the Remarc MCP server (read/write comments, sessions, statuses)
- Adds the `remarc` skill for natural-language workflows

## Optional: session-lifecycle hooks

For automatic context injection on session start, install the companion plugin:

```sh
/plugin install remarc-hooks@remarc
```

This is experimental and off by default.
