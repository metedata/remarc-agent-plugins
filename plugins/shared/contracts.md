# App ↔ Plugin contracts

Stable surfaces the `remarc-hooks` plugin consumes from the Remarc macOS app. Breaking changes to these require a coordinated app + plugin release.

## File-system contract

- **`~/Library/Application Support/Remarc/comments.json`** — primary data file. Schema documented in [comments-schema.json](./comments-schema.json). The plugin reads this. Falls back to legacy `data.json` if the primary is absent.
- **`/tmp/remarc-claude-<claude_session_id>.marker`** — per-session marker the plugin writes/reads. Format: two lines, first is the Remarc session UUID (uppercase), second is the data file path. The app does NOT read or write these.

## `defaults` contract (domain: `com.metepolat.Remarc`)

These keys are read by the plugin via the `defaults read` shell-out. The app owns the Preferences UI that writes them; the plugin reads them at hook fire time. Absent keys fall back to the documented default.

| Key | Type | Values | Default | Read by |
|---|---|---|---|---|
| `claudeCodeAutoCreateSession` | Bool | `0`/`1` or `false`/`true` | `true` | `session-start` hook (startup/resume) — when false, skip creating a Remarc session and skip context injection |
| `claudeCodeSessionEndBehavior` | String | `keep`, `moveUnresolved`, `autoDelete` | `autoDelete` | `session-end` hook — controls what `windDown` does with unresolved comments |

## Contract versioning

The current schema has **no version field**. Both Swift (`AppState`) and TypeScript (`RawAppState`) decoders permit unknown fields for forward-compatibility, and the plugin's JSON-schema validation in CI only fails on missing-required or type-mismatch (additive optional fields pass).

Until a schema version is added, breaking changes require:
1. Bump `comments-schema.json` to capture the new required fields.
2. Run the cross-decode CI in both repos against a representative `comments.sample.json` until both pass.
3. Ship the app update first (writes the new schema, falls back gracefully for old plugin readers), then the plugin update (parses the new fields).

Adding a `schemaVersion` field is tracked as future work — it would let the plugin decline cleanly when the file is too new instead of silently misparsing.
