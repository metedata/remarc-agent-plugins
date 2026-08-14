# App ↔ Plugin contracts

Stable surfaces the `remarc-hooks` plugin consumes from the Remarc macOS app. Breaking changes to these require a coordinated app + plugin release.

## File-system contract

- **`~/Library/Application Support/Remarc/comments.json`** — primary data file. Schema documented in [comments-schema.json](./comments-schema.json). The plugin reads this. Falls back to legacy `data.json` if the primary is absent.
- **`~/Library/Application Support/Remarc/claude/markers/<claude_session_id>.json`** — per-session marker the plugin writes/reads. JSON: `remarcSessionId`, `dataFilePath`, `transcriptPath`, `lastActivity`, `wakeCapable` (whether this harness has file-watch + rewake at all), `deliveredIds` (comment ids already injected as context), `wakedAt` (comment id → the `wakeRequestedAt` generation already woken for). `remarcSessionId` is the wake address: wake only ever considers comments filed to that session, and an empty value means this agent is not a wake target. The app reads the same field to decide whether to offer Send Instantly, so both sides agree on which agent a comment can reach. Markers whose `transcriptPath` names a file that does not exist, or whose `lastActivity` is over a day old, are collected at the next SessionStart — non-interactive invocations such as `claude plugin list --json` start a session, get a marker, and never reach SessionEnd. Written under an adjacent `.lock` directory, because two hook firings in one session are separate processes. Legacy `/tmp/remarc-claude-<id>.marker` (two-line text) is still read and migrated. The app does not write these, but its launch sweep may remove stale ones.
- **`<data file>.lock`** — advisory lock directory guarding every read-modify-write of `comments.json`. Created with an atomic `mkdir` (the one primitive Swift and Node share; Node exposes no `flock`), holding `owner.json` with the holder's pid. Reclaimed only when the owner is gone or the lock is older than 10s. **Every writer in both languages must take it** — the app, the MCP tools, and the hook fallback writers.

## `defaults` contract (domain: `com.metepolat.Remarc`)

These keys are read by the plugin via the `defaults read` shell-out. The app owns the Preferences UI that writes them; the plugin reads them at hook fire time. Absent keys fall back to the documented default.

| Key | Type | Values | Default | Read by |
|---|---|---|---|---|
| `claudeCodeAutoCreateSession` | Bool | `0`/`1` or `false`/`true` | `true` | `session-start` hook (startup/resume) — when false, skip creating a Remarc session and skip context injection |
| `claudeCodeSessionEndBehavior` | String | `keep`, `moveUnresolved`, `autoDelete` | `autoDelete` | `session-end` hook — controls what `windDown` does with unresolved comments |
| `wakeOnCommentEnabled` | Bool | `0`/`1` or `false`/`true` | `true` | App only — hides the wake button and stops writing `wakeRequestedAt`. The plugin does not read it; a comment with no `wakeRequestedAt` simply never wakes anything. |

## Comment fields the plugin depends on

| Field | Written by | Meaning |
|---|---|---|
| `commentText` | app | Required string. `""` is a valid reference-only comment for every context-backed type: text selection (`comment`), screenshot, and web element. It must not be dropped or decoded as missing. App writers normalize whitespace-only input to `""`; readers still tolerate whitespace-only values and display them as `(none)`. Quick Notes remain text-required as an app create/edit rule because they carry no separate reference. The field remains required and is never `null` or omitted. |
| `type.comment.text` | app | Complete selected text for a text-selection comment. List views may show a bounded preview, but full-detail and queue delivery must preserve the complete value separately from `commentText`. The user's surrounding request supplies the action for a reference-only batch; absent both an instruction body and a surrounding request, an agent must ask rather than invent an action. |
| `status` | app, MCP | `open` → `handedOff` → `inProgress` → `resolved`. Queue delivery selects `open`, `handedOff` and `inProgress`; the wake path only ever considers `handedOff`. |
| `wakeRequestedAt` | app only | Apple-epoch timestamp set when the user presses "Send instantly & save". Never cleared. The wake hook treats it as a generation: it wakes when the value is newer than the `wakedAt` entry for that comment, so pressing the button again wakes again. |
| `isDeleted` | app, MCP | Soft delete. The wake path must exclude deleted comments at selection **and** after its backoff re-read — a deleted comment keeps its `wakeRequestedAt`, and full-UUID MCP lookup returns deleted records. |
| `sessionID` | app, MCP | The delivery address, for both paths. A session's agent receives that session's comments and no others — not the Inbox's, not another session's. Inbox comments reach an agent only when the user files them to a session or asks for them through `remarc_list_comments`. Earlier builds folded the Inbox into every paired session's queue behind an `includeInboxInSessionContext` preference; that key is now read by nobody, and a value left over from an older build must not resurrect the behaviour. |
| `origin` (Session) | MCP | Which harness created the session: `manual`, `claudeCode`, or `codex`. The MCP server takes it from the `--harness` flag its manifest passes. **Readers must tolerate unknown values** — harnesses ship on the plugin's schedule, so an older app is routinely the one reading a newer name, and decoding straight into a closed enum fails the whole file rather than the one field. |

Wake reminders intentionally contain only the comment ID, session name and
comment body. They never copy `type.comment.text`, a page URL, accessibility
metadata or other selected/page-derived context into the instruction channel.
For a reference-only comment the wake payload therefore says the body is
`(none)` and directs the agent to `remarc_get_comment`; the selected reference
continues to arrive as tool-result data.

## Unknown-field preservation (required)

Both serializers must round-trip fields they do not model, at document, Session and Comment level. Before this was enforced, any plugin write deleted the app's `orphanedImages` and `transcriptions` arrays outright. TypeScript keeps them in `unknownFields` bags; the Swift side preserves its own schema. CI fixtures cover round-tripping unmodeled fields in both directions.

## Status compare-and-set

`remarc_set_status` accepts an optional `expected_status`. The write happens inside the document transaction, so the check and the mutation cannot be split by another writer. The wake payload instructs agents to claim with `expected_status: "handedOff"`, which is what makes "exactly one agent works a comment" true. It is a backstop, not the mechanism: wake addresses a single paired agent, and the claim covers the remaining races (a queue delivery and a wake landing together, or an agent picking up a comment left `inProgress` by a dead claimant).

## Contract versioning

The current schema has **no version field**. Both Swift (`AppState`) and TypeScript (`RawAppState`) decoders permit unknown fields for forward-compatibility, and the plugin's JSON-schema validation in CI only fails on missing-required or type-mismatch (additive optional fields pass).

Until a schema version is added, breaking changes require:
1. Bump `comments-schema.json` to capture the new required fields.
2. Run the cross-decode CI in both repos against a representative `comments.sample.json` until both pass.
3. Ship the app update first (writes the new schema, falls back gracefully for old plugin readers), then the plugin update (parses the new fields).

Adding a `schemaVersion` field is tracked as future work — it would let the plugin decline cleanly when the file is too new instead of silently misparsing.
