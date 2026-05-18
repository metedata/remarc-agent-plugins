# Remarc plugins for Claude Code

Two plugins:

- **`remarc`** (required) - MCP server + skill for managing Remarc comments.
- **`remarc-hooks`** (optional, experimental) - session-lifecycle hooks that auto-link Claude Code sessions to Remarc sessions and inject open comments.

## Install

```sh
/plugin marketplace add metedata/remarc-agent-plugins
/plugin install remarc@remarc
# optional:
/plugin install remarc-hooks@remarc
```

See [Remarc](https://remarc.app) for the macOS app.
