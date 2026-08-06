/**
 * Single entrypoint for the Remarc hook events.
 *
 * NOTE: do NOT add a shebang here — esbuild prepends one via --banner. A
 * duplicate shebang on line 2 is invalid ES module syntax.
 *
 * Usage:
 *   node hook.js <session-start | prompt-submit | session-end | cwd-changed | file-changed>
 *
 * Reads the Claude Code hook event JSON from stdin and returns a structured
 * result. Orchestration errors degrade to an empty envelope per the README's
 * "off-when-app-not-running" contract; only the wake path uses a non-zero exit.
 */
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, handoff, windDown, formatComments } from "./operations.js";
import { readBoolDefault } from "./defaults.js";
import { getDataFilePath, readAppState } from "./data.js";
import {
  writeMarker,
  readMarker,
  touchMarker,
  updateMarker,
  pruneIds,
  removeMarker,
} from "./marker.js";
import { runWake, selectQueueComments } from "./wake.js";

type Envelope = Record<string, unknown>;

/**
 * What the CLI should do. `exitCode` 2 with `stderrText` is how a FileChanged
 * hook wakes an idle session (asyncRewake turns that stderr into a system
 * reminder); the previous unconditional exit(0) made waking inexpressible.
 */
export interface HookResult {
  stdout: string;
  stderrText?: string;
  exitCode: number;
}

const EMPTY: HookResult = { stdout: "{}", exitCode: 0 };

/** Queue delivery caps. 9k keeps us under Claude Code's 10k offload threshold,
 * above which the agent gets a file preview instead of the text - and would be
 * marked as having received comments it never saw. */
const MAX_QUEUE_COMMENTS = 20;
const MAX_QUEUE_CHARS = 9000;

export async function runHook(event: string, rawInput: string): Promise<HookResult> {
  try {
    let input: any;
    try {
      input = JSON.parse(rawInput || "{}");
    } catch {
      return EMPTY;
    }

    switch (event) {
      case "session-start":
        return json(await onSessionStart(input));
      case "prompt-submit":
        return json(await onPromptSubmit(input));
      case "session-end":
        return json(await onSessionEnd(input));
      case "cwd-changed":
        return json(onCwdChanged(input));
      case "file-changed":
        return await onFileChanged(input);
      default:
        return EMPTY;
    }
  } catch (err) {
    process.stderr.write(
      `remarc-hooks: ${event} failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return EMPTY;
  }
}

function json(envelope: Envelope): HookResult {
  return { stdout: JSON.stringify(envelope), exitCode: 0 };
}

/** The file whose changes should wake this session. */
function watchPaths(): string[] {
  return [getDataFilePath()];
}

/**
 * Codex reads this same plugin repo natively, but validates hook output
 * strictly: its SessionStart schema allows only `hookEventName` and
 * `additionalContext` (additionalProperties: false), so emitting `watchPaths`
 * or `sessionTitle` makes it reject the ENTIRE payload - the hook is reported
 * as failed and the comment context never arrives.
 *
 * Codex also has no FileChanged/CwdChanged events and skips `async` hooks, so
 * those extra fields buy nothing there anyway. Detect it from the transcript
 * path (Codex writes ~/.codex/sessions/...) rather than env vars: Codex sets
 * CLAUDE_PLUGIN_ROOT for compatibility, so env cannot distinguish them.
 */
function isStrictHarness(input: { transcript_path?: string }): boolean {
  const p = input.transcript_path ?? "";
  return p.includes("/.codex/") || p.includes("/.codex\\");
}

async function onSessionStart(input: {
  source?: string;
  session_id?: string;
  cwd?: string;
  agent_type?: string;
  transcript_path?: string;
}): Promise<Envelope> {
  if (input.agent_type || !input.session_id) return {};
  const source = input.source ?? "startup";

  // Watch registration is deliberately independent of pairing. Claude Code
  // only registers dynamic watch paths when SessionStart output is non-empty,
  // so returning {} on any pairing path (auto-create disabled, no marker after
  // /clear, unknown source) would leave wake permanently disarmed for that
  // session.
  // Harnesses that reject unknown output keys get the portable subset.
  const strict = isStrictHarness(input);
  const base: Envelope = strict
    ? {}
    : {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          watchPaths: watchPaths(),
        },
      };

  const withContext = (extra: Record<string, unknown>): Envelope => {
    if (strict) {
      // additionalContext is the only field Codex accepts here, and it is the
      // one that actually carries the comments.
      const context = extra.additionalContext;
      if (typeof context !== "string" || !context) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        watchPaths: watchPaths(),
        ...extra,
      },
    };
  };

  // `fork` needs its own case: a matcher alone would let forked sessions fall
  // through to the default return and start life with no pairing or backlog.
  if (source === "startup" || source === "resume" || source === "fork") {
    const autoCreate = await readBoolDefault("claudeCodeAutoCreateSession");
    if (autoCreate === false) return base;

    const name = basename(input.cwd ?? process.cwd()) || "Session";
    const result = await createSession({
      name,
      claudeSessionId: input.session_id,
      source,
    });
    await writeMarker(input.session_id, {
      remarcSessionId: result.remarcSessionId,
      dataFilePath: result.dataFilePath,
      transcriptPath: input.transcript_path ?? null,
      lastActivity: new Date().toISOString(),
    });
    const context = await handoff({
      remarcSessionId: result.remarcSessionId,
      claudeSessionId: input.session_id,
      recovery: true,
    });
    return withContext({
      ...(context ? { additionalContext: context } : {}),
      sessionTitle: result.sessionName,
    });
  }

  if (source === "compact" || source === "clear") {
    const marker = await readMarker(input.session_id);
    if (!marker) return base;
    const context = await handoff({
      remarcSessionId: marker.remarcSessionId,
      claudeSessionId: input.session_id,
      recovery: true,
    });
    return withContext(context ? { additionalContext: context } : {});
  }

  return base;
}

/**
 * Re-register the watch paths after a working-directory change.
 *
 * Claude Code replaces (not merges) the dynamic watch list whenever the cwd
 * changes, taking it from CwdChanged hook output. With no CwdChanged hook the
 * list empties and the data file stops being watched, so wake dies silently -
 * and a shell `cd` is routine.
 */
function onCwdChanged(input: { session_id?: string; transcript_path?: string }): Envelope {
  if (!input.session_id || isStrictHarness(input)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "CwdChanged",
      watchPaths: watchPaths(),
    },
  };
}

/** Wake path. Exits 2 with a system reminder when this session should wake. */
async function onFileChanged(input: {
  session_id?: string;
  file_path?: string;
}): Promise<HookResult> {
  if (!input.session_id) return EMPTY;
  const wake = await runWake(input.session_id);
  if (!wake) return EMPTY;
  return { stdout: "{}", stderrText: wake.stderrText, exitCode: wake.exitCode };
}

async function onPromptSubmit(input: {
  session_id?: string;
  prompt?: string;
}): Promise<Envelope> {
  if (!input.session_id) return {};
  const marker = await readMarker(input.session_id);
  if (!marker) return {};

  const state = await readAppState();
  if (!state) return {};

  const eligible = selectQueueComments(state, marker.remarcSessionId, marker);
  if (eligible.length === 0) {
    await touchMarker(input.session_id);
    return {};
  }

  const selected = eligible.slice(0, MAX_QUEUE_COMMENTS);
  const context = formatComments(selected, state, MAX_QUEUE_CHARS);
  if (!context.text) {
    await touchMarker(input.session_id);
    return {};
  }

  // Record only what the formatter actually included, and only after building
  // the payload the caller is about to emit.
  const liveIds = new Set(state.comments.filter((c) => !c.isDeleted).map((c) => c.id));
  await updateMarker(input.session_id, (m) => {
    m.deliveredIds = pruneIds(
      [...new Set([...m.deliveredIds, ...context.includedIds])],
      liveIds
    );
    m.lastActivity = new Date().toISOString();
  });

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context.text,
    },
  };
}

async function onSessionEnd(input: { session_id?: string }): Promise<Envelope> {
  if (!input.session_id) return {};
  const marker = await readMarker(input.session_id);
  if (!marker) return {};
  try {
    await windDown({ remarcSessionId: marker.remarcSessionId });
  } catch {
    /* swallow — observability only */
  }
  await removeMarker(input.session_id);
  return {};
}

// CLI entrypoint. fileURLToPath() handles paths with spaces correctly, unlike
// the naive `import.meta.url === \`file://\${process.argv[1]}\`` form.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const event = process.argv[2] ?? "";
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const result = await runHook(event, raw);
  if (result.stdout !== "{}") process.stdout.write(result.stdout);
  if (result.stderrText) process.stderr.write(result.stderrText);
  process.exit(result.exitCode);
}
