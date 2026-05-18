# remarc-hooks (experimental)

Optional session-lifecycle hooks for [Remarc](https://remarc.app). Off by default — installing this plugin is your explicit opt-in.

## What it does

- **SessionStart**: creates a Remarc session linked to the Claude Code session (named after `cwd`), injects outstanding comments as `additionalContext`.
- **UserPromptSubmit**: incremental handoff — if the Remarc data file changed since the last hook fire, injects new comments. Also fires when your prompt mentions "remarc", "my comments", or "open comments".
- **SessionEnd**: runs the user-configured wind-down (auto-delete the linked session, keep it, or move unresolved comments to Inbox).

## Install

```sh
/plugin marketplace add metedata/remarc-agent-plugins
/plugin install remarc-hooks@remarc
```

Installs `remarc` too if not already present (declared as a dependency).

## Uninstall

```sh
/plugin uninstall remarc-hooks@remarc
```

Hooks are removed immediately. The `remarc` plugin stays installed unless you also `/plugin uninstall remarc@remarc --prune`.

## What it does NOT do

- Does not work on Linux/Windows (shell-outs to macOS `defaults`).
- Does not start the Remarc.app process. If Remarc isn't running, hooks degrade silently.
