/**
 * Which agent this MCP server is running inside.
 *
 * Recorded on every session the server creates, so the app can label a session
 * with the harness that actually made it. It used to hardcode `claudeCode` for
 * everyone, which put Anthropic's logo on sessions created from Codex.
 *
 * The MCP initialization handshake is the primary source of truth. That lets
 * the portable Agent Plugins manifest be shared by Codex and OMP without one
 * host's launch flag being applied to the other. Harness-specific manifests
 * may still pass `--harness` for older clients, and environment/path detection
 * remains a final compatibility fallback.
 */
export type Harness = "claudeCode" | "codex" | "omp";

let declared: Harness | null = null;
let connected: Harness | null = null;

type ClientInfo = {
  readonly name?: string;
};

type McpClientIdentitySource = {
  oninitialized?: () => void;
  getClientVersion(): ClientInfo | undefined;
};

function harnessFromClientName(name: string): Harness | null {
  const normalized = name.trim().toLowerCase();

  // Names sent by the supported clients today are `codex-mcp-client` and
  // `omp-coding-agent`. Keep delimiter-based aliases for official variants
  // without treating an arbitrary word containing "omp" or "codex" as proof.
  if (
    normalized === "codex" ||
    normalized.startsWith("codex-") ||
    normalized.startsWith("codex_")
  ) {
    return "codex";
  }
  if (
    normalized === "omp" ||
    normalized.startsWith("omp-") ||
    normalized.startsWith("omp_") ||
    normalized === "oh-my-pi" ||
    normalized.startsWith("oh-my-pi-")
  ) {
    return "omp";
  }
  if (
    normalized === "claude" ||
    normalized.startsWith("claude-") ||
    normalized.startsWith("claude_")
  ) {
    return "claudeCode";
  }
  return null;
}

/** Read once at startup from argv. */
export function setHarnessFromArgv(argv: string[]): void {
  const i = argv.indexOf("--harness");
  const value = i >= 0 ? argv[i + 1] : undefined;
  declared = value === "codex" || value === "claudeCode" || value === "omp"
    ? value
    : null;
}

/** Record the client identity negotiated by the MCP initialize handshake. */
export function setHarnessFromClientInfo(clientInfo: ClientInfo | undefined): void {
  connected = clientInfo?.name ? harnessFromClientName(clientInfo.name) : null;
}

/** Bind harness detection to an MCP server's completed initialization. */
export function bindHarnessToMcpServer(source: McpClientIdentitySource): void {
  const previousHandler = source.oninitialized;
  source.oninitialized = () => {
    setHarnessFromClientInfo(source.getClientVersion());
    previousHandler?.();
  };
}

export function currentHarness(env: NodeJS.ProcessEnv = process.env): Harness {
  // The connected client is newer and more specific than a package manifest.
  // In particular, Codex Desktop can consume the portable root manifest that
  // was originally added for OMP.
  if (connected) return connected;
  if (declared) return declared;

  // Fallback for clients that omit recognizable clientInfo. Prefer variables
  // owned by a plugin runtime, then inspect the portable plugin paths.
  if (env.CLAUDE_PLUGIN_ROOT) return "claudeCode";
  const launchPaths = [
    env.PLUGIN_ROOT ?? "",
    env.PLUGIN_DATA ?? "",
    process.cwd(),
    process.argv[1] ?? "",
  ].map((value) => value.toLowerCase());
  if (launchPaths.some((path) => path.includes(".codex/") || path.includes("/codex/"))) {
    return "codex";
  }
  if (launchPaths.some((path) => path.includes(".omp/") || path.includes("/omp/"))) {
    return "omp";
  }
  if (env.CODEX_HOME) return "codex";
  if (env.OMP_PROFILE || env.OMP_PROCESSING_AGENT_DIR || env.PI_CODING_AGENT_DIR) {
    return "omp";
  }
  return "claudeCode";
}

/** Test seam: reset negotiated and declared values between cases. */
export function resetHarnessForTests(): void {
  declared = null;
  connected = null;
}
