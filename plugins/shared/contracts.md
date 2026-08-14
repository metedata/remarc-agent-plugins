# App ↔ Plugin contracts

Stable surfaces the `remarc-hooks` plugin consumes from the Remarc macOS app. Breaking changes to these require a coordinated app + plugin release.

## File-system contract

- **`~/Library/Application Support/Remarc/comments.json`** — primary data file. Schema documented in [comments-schema.json](./comments-schema.json). The plugin reads this. Falls back to legacy `data.json` if the primary is absent.
- **`~/Library/Application Support/Remarc/claude/markers/<agent_session_id>.json`** — per-agent-session marker the plugin writes/reads. The `claude` path component is historical and remains part of the compatibility contract. JSON: `remarcSessionId`, `dataFilePath`, `transcriptPath`, `lastActivity`, `wakeCapable` (whether this harness has file-watch + re-wake at all), `deliveredIds` (comment ids already injected as context), `wakedAt` (comment id → the `wakeRequestedAt` generation already woken for). `remarcSessionId` is the wake address: wake only ever considers comments filed to that session, and an empty value means this agent is not a wake target. The app reads the same field to decide whether to offer Instant Delivery, so both sides agree on which agent a comment can reach. Markers whose `transcriptPath` names a file that does not exist, or whose `lastActivity` is over a day old, are collected at the next SessionStart — non-interactive invocations can start a session, create a marker, and never reach SessionEnd. Written under an adjacent `.lock` directory, because two hook firings in one session are separate processes. Legacy `/tmp/remarc-claude-<id>.marker` files are read as a compatibility fallback. They are not eagerly rewritten; a later marker update writes the JSON form, and the app's launch sweep may remove stale legacy files.
- **`<data file>.lock`** — advisory lock directory guarding every read-modify-write of `comments.json`. Created with an atomic `mkdir` (the one primitive Swift and Node share; Node exposes no `flock`), holding `owner.json` with the holder's pid. Reclaimed only when the owner is gone or the lock is older than 10s. **Every writer in both languages must take it** — the app, the MCP tools, and the hook fallback writers.

## `defaults` contract (domain: `com.metepolat.Remarc`)

These keys are read by the plugin via the `defaults read` shell-out. The app owns the Preferences UI that writes them; the plugin reads them at hook fire time. Absent keys fall back to the documented default.

| Key | Type | Values | Default | Read by |
|---|---|---|---|---|
| `claudeCodeAutoCreateSession` | Bool | `0`/`1` or `false`/`true` | `true` | `session-start` hook (startup/resume) — when false, skip creating a Remarc session and skip context injection |
| `claudeCodeSessionEndBehavior` | String | `keep`, `moveUnresolved`, `autoDelete` | `keep` | `session-end` hook — controls what `windDown` does with unresolved comments when the conversation is explicitly cleared |
| `wakeOnCommentEnabled` | Bool | `0`/`1` or `false`/`true` | `false` | App only — hides the instant-delivery action and stops writing `wakeRequestedAt`. The plugin does not read it; a comment with no `wakeRequestedAt` never wakes anything. |

## Comment fields the plugin depends on

| Field | Written by | Meaning |
|---|---|---|
| `status` | app, MCP | `open` → `handedOff` → `inProgress` → `resolved`. Queue delivery selects `open`, `handedOff` and `inProgress`; the wake path only ever considers `handedOff`. |
| `wakeRequestedAt` | app only | Apple-epoch timestamp set when the user presses "Send instantly & save". Never cleared. The wake hook treats it as a generation: it wakes when the value is newer than the `wakedAt` entry for that comment, so pressing the button again wakes again. |
| `isDeleted` | app, MCP | Soft delete. The wake path must exclude deleted comments at selection **and** after its backoff re-read — a deleted comment keeps its `wakeRequestedAt`, and full-UUID MCP lookup returns deleted records. |
| `sessionID` | app, MCP | The delivery address, for both paths. A session's agent receives that session's comments and no others — not the Inbox's, not another session's. Inbox comments reach an agent only when the user files them to a session or asks for them through `remarc_list_comments`. Earlier builds folded the Inbox into every paired session's queue behind an `includeInboxInSessionContext` preference; that key is now read by nobody, and a value left over from an older build must not resurrect the behaviour. |
| `origin` (Session) | MCP | Which harness created the session. Known values are `manual`, `claudeCode`, and `codex`; the MCP server takes the supported agent value from its manifest or tool input. Runtime readers preserve unknown strings so an older app can round-trip a newer harness. The current JSON Schema still closes this field to the three known values, so a new harness must widen the schema and cross-decode fixture before it writes a new origin. |

## Unknown-field preservation (required)

Both serializers must round-trip fields they do not model, at document, Session and Comment level. Before this was enforced, any plugin write deleted the app's `orphanedImages` and `transcriptions` arrays outright. TypeScript keeps them in `unknownFields` bags; the Swift side preserves its own schema. CI fixtures cover round-tripping unmodeled fields in both directions.

## Status compare-and-set

`remarc_set_status` accepts an optional `expected_status`. The write happens inside the document transaction, so the check and mutation cannot be split by another writer. The wake payload instructs agents to claim with `expected_status: "handedOff"`; at most one cooperative caller can successfully perform that transition from the expected state. Current Claude wake delivery is best-effort: it records the generation before the hook process emits its payload, so a crash at that boundary can lose a notification. A caller can also crash after claiming. The compare-and-set therefore prevents two cooperative callers from winning the same status transition; it does not make delivery or agent execution exactly-once.

## Contract versioning

The current schema has **no version field**. Both Swift (`AppState`) and TypeScript (`RawAppState`) decoders permit unknown fields for forward-compatibility, and the plugin's JSON-schema validation in CI only fails on missing-required or type-mismatch (additive optional fields pass). Session origins are a known exception: runtime decoders preserve unknown strings, but `comments-schema.json` currently enumerates only the known origins.

Until a schema version is added, breaking changes require:
1. Bump `comments-schema.json` to capture the new required fields.
2. Run the cross-decode CI in both repos against a representative `comments.sample.json` until both pass.
3. Ship the app update first (writes the new schema, falls back gracefully for old plugin readers), then the plugin update (parses the new fields).

Adding a `schemaVersion` field is tracked as future work — it would let the plugin decline cleanly when the file is too new instead of silently misparsing.
