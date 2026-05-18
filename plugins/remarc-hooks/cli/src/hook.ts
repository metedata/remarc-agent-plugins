/**
 * Single entrypoint for all three Remarc hook events.
 *
 * NOTE: do NOT add a shebang here — esbuild prepends one via --banner. A
 * duplicate shebang on line 2 is invalid ES module syntax.
 *
 * Usage:
 *   node hook.js <session-start | prompt-submit | session-end>
 *
 * Reads the Claude Code hook event JSON from stdin, runs the corresponding
 * orchestration (port of the original bash + cli.js scripts), and writes the
 * hook output envelope to stdout. Always exits 0 — errors during orchestration
 * degrade silently to {} per the README's "off-when-app-not-running" contract.
 */
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, handoff, windDown } from "./operations.js";
import { readBoolDefault } from "./defaults.js";
import {
  writeMarker,
  readMarker,
  touchMarker,
  dataNewerThanMarker,
  removeMarker,
} from "./marker.js";

type Envelope = Record<string, unknown>;

export async function runHook(event: string, rawInput: string): Promise<string> {
  // Enforce the "hooks degrade silently" contract: if anything inside the
  // orchestration throws — createSession, handoff, marker IO, defaults shell-out —
  // emit {} so Claude Code continues without injection.
  try {
    let input: any;
    try {
      input = JSON.parse(rawInput || "{}");
    } catch {
      return "{}";
    }

    switch (event) {
      case "session-start":
        return JSON.stringify(await onSessionStart(input));
      case "prompt-submit":
        return JSON.stringify(await onPromptSubmit(input));
      case "session-end":
        return JSON.stringify(await onSessionEnd(input));
      default:
        return "{}";
    }
  } catch (err) {
    process.stderr.write(
      `remarc-hooks: ${event} failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return "{}";
  }
}

async function onSessionStart(input: {
  source?: string;
  session_id?: string;
  cwd?: string;
  agent_type?: string;
}): Promise<Envelope> {
  if (input.agent_type || !input.session_id) return {};
  const source = input.source ?? "startup";

  if (source === "startup" || source === "resume") {
    const autoCreate = await readBoolDefault("claudeCodeAutoCreateSession");
    if (autoCreate === false) return {};

    const name = basename(input.cwd ?? process.cwd()) || "Session";
    const result = await createSession({
      name,
      claudeSessionId: input.session_id,
      source,
    });
    await writeMarker(input.session_id, {
      remarcSessionId: result.remarcSessionId,
      dataFilePath: result.dataFilePath,
    });
    const context = await handoff({
      remarcSessionId: result.remarcSessionId,
      claudeSessionId: input.session_id,
      recovery: true,
    });
    return wrap("SessionStart", context);
  }

  if (source === "compact" || source === "clear") {
    const marker = await readMarker(input.session_id);
    if (!marker) return {};
    const context = await handoff({
      remarcSessionId: marker.remarcSessionId,
      claudeSessionId: input.session_id,
      recovery: true,
    });
    return wrap("SessionStart", context);
  }

  return {};
}

async function onPromptSubmit(input: {
  session_id?: string;
  prompt?: string;
}): Promise<Envelope> {
  if (!input.session_id) return {};
  const marker = await readMarker(input.session_id);
  if (!marker) return {};

  // Narrow prompt-relevance filter: word boundaries, not bare 'comment'.
  const prompt = input.prompt ?? "";
  const hintMatches = /\bremarc\b|\bmy comments?\b|\bopen comments?\b/i.test(prompt);

  // Always inject if data file changed since last touch; also inject if the
  // user's prompt explicitly mentions remarc/comments.
  if (!dataNewerThanMarker(input.session_id, marker.dataFilePath) && !hintMatches) {
    return {};
  }

  const context = await handoff({
    remarcSessionId: marker.remarcSessionId,
    claudeSessionId: input.session_id,
    recovery: false,
  });
  await touchMarker(input.session_id);
  if (!context) return {};
  return wrap("UserPromptSubmit", context);
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

function wrap(eventName: string, additionalContext: string): Envelope {
  if (!additionalContext) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
}

// CLI entrypoint. fileURLToPath() handles paths with spaces correctly, unlike
// the naive `import.meta.url === \`file://\${process.argv[1]}\`` form.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const event = process.argv[2] ?? "";
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const out = await runHook(event, raw);
  if (out !== "{}") process.stdout.write(out);
  process.exit(0);
}
