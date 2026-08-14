# remarc-hooks (experimental)

Optional lifecycle hooks for [Remarc](https://remarc.app). Installing this plugin is an explicit opt-in to automatic context injection and, when separately enabled in Remarc, instant delivery.

The supported end-user installation is currently Claude Code. A reduced Codex hook manifest exists in source for portable lifecycle behavior, but Remarc's supported Codex Settings flow installs only the core `remarc` plugin and does not offer instant delivery.

## Install for Claude Code

Install the core plugin first, then the hooks:

```sh
claude plugin marketplace add metedata/remarc-agent-plugins
claude plugin install remarc@remarc
claude plugin install remarc-hooks@remarc
```

The Claude manifest also declares `remarc` as a dependency, but installing it explicitly keeps the setup and removal behavior clear.

Run `/reload-plugins` in an active Claude Code session after installation.

## Lifecycle behavior

| Event | Behavior |
| --- | --- |
| `SessionStart` | Creates or resumes a pairing, injects recovery context, and registers the data-file watch when supported |
| `UserPromptSubmit` | Injects newly available comments and recovery context when requested |
| `CwdChanged` | Re-registers the watched Remarc data path for Claude Code |
| `FileChanged` | Evaluates an explicit instant-delivery generation for the paired session |
| `SessionEnd` | Unlinks on normal exit; applies configured wind-down only when the conversation is explicitly cleared |

Delivery is scoped to the paired Remarc session. Inbox comments and another session's comments are not automatically folded into that queue.

Current automatic delivery is best-effort and pre-emission deduplicated. Marker
generations and locks suppress routine duplicates, but a hook crash after the
generation is recorded and before its payload is emitted can lose that wake.
After delivery, `expected_status: "handedOff"` lets only one cooperative caller
successfully claim the status transition to `inProgress`.

## Remarc settings and defaults

| Setting | Default | Effect |
| --- | --- | --- |
| Auto-create session for new conversations | On | Creates and pairs a Remarc session at startup/resume |
| Allow comments to wake Claude Code sessions (Instant delivery) | Off | Lets Remarc write `wakeRequestedAt` and show the instant-delivery action for a live pairing |
| When a conversation is cleared | Keep session | Keeps the session and its comments unless the user selects another policy |

Turning off auto-create does not silently pair the agent to Inbox. Instant delivery requires an explicit paired Remarc session.

## Uninstall

```sh
claude plugin uninstall remarc-hooks@remarc
```

Uninstalling the hooks stops future lifecycle execution. The core `remarc` plugin remains installed when it was installed directly. Remove it separately if wanted:

```sh
claude plugin uninstall remarc@remarc
```

Plugin removal does not delete Remarc's sessions, comments, screenshots, or local data file.

## Limits

- The hooks require macOS because they read Remarc preferences with `defaults`.
- They do not start Remarc.app. With auto-create enabled, the hooks can
  initialize the local data file, create a paired session, and emit integration
  context even while the app is not running; captured comments exist only after
  Remarc writes them.
- Claude Code currently provides the `FileChanged` and asynchronous re-wake behavior used for instant delivery; the supported Codex path does not.
- Remote workers may not be able to read screenshot paths stored on the Mac.
- Hooks execute with the current user's permissions and consume local comments as agent context. See [SECURITY.md](../../SECURITY.md).

The normative file, preference, marker, and locking rules are in [`plugins/shared/contracts.md`](../shared/contracts.md).
