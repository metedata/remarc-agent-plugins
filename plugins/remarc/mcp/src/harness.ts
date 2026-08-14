/**
 * Which agent this MCP server is running inside.
 *
 * Recorded on every session the server creates, so the app can label a session
 * with the harness that actually made it. It used to hardcode `claudeCode` for
 * everyone, which put Anthropic's logo on sessions created from Codex.
 *
 * Declared by the manifest rather than sniffed: `.codex-plugin/plugin.json`
 * points at `codex-mcp.json`, which passes `--harness codex`, exactly as the
 * Codex hook manifest passes `--portable`. Guessing from paths is the fallback
 * only, since a custom `CODEX_HOME` means the plugin root need not say "codex"
 * anywhere.
 */
export type Harness = "claudeCode" | "codex" | "omp";

let declared: Harness | null = null;

/** Read once at startup from argv. */
export function setHarnessFromArgv(argv: string[]): void {
  const i = argv.indexOf("--harness");
  const value = i >= 0 ? argv[i + 1] : undefined;
  declared = value === "codex" || value === "claudeCode" || value === "omp"
    ? value
    : null;
}

export function currentHarness(env: NodeJS.ProcessEnv = process.env): Harness {
  if (declared) return declared;

  // Fallback for an install that predates the flag, or a harness reusing the
  // Claude manifest. CLAUDE_PLUGIN_ROOT is set by Claude Code and left unset by
  // Codex, so seeing it is the positive signal; ~/.codex paths are the other.
  if (env.CLAUDE_PLUGIN_ROOT) return "claudeCode";
  const haystack = [env.CODEX_HOME ?? "", process.cwd(), process.argv[1] ?? ""];
  if (haystack.some((s) => s.includes(".codex") || s.includes("/codex/"))) {
    return "codex";
  }
  return "claudeCode";
}

/** Test seam: reset the declared value between cases. */
export function resetHarnessForTests(): void {
  declared = null;
}
