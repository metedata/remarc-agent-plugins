import { describe, it, expect, beforeEach } from "vitest";
import {
  currentHarness,
  setHarnessFromArgv,
  setHarnessFromClientInfo,
  resetHarnessForTests,
} from "./harness.js";

describe("currentHarness", () => {
  beforeEach(() => resetHarnessForTests());

  it("takes the harness a legacy harness-specific manifest declared", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "codex"]);
    expect(currentHarness({})).toBe("codex");
  });

  it("accepts the legacy explicit OMP declaration", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "omp"]);
    expect(currentHarness({
      CLAUDE_PLUGIN_ROOT: "/Users/m/.claude/plugins/x",
      CODEX_HOME: "/Users/m/.codex",
    })).toBe("omp");
  });

  it.each([
    ["codex-mcp-client", "codex"],
    ["codex_vscode", "codex"],
    ["omp-coding-agent", "omp"],
    ["oh-my-pi", "omp"],
    ["claude-code", "claudeCode"],
  ] as const)("recognises MCP client %s as %s", (name, expected) => {
    setHarnessFromClientInfo({ name });
    expect(currentHarness({})).toBe(expected);
  });

  it("prefers the connected MCP client over a stale portable-manifest flag", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "omp"]);
    setHarnessFromClientInfo({ name: "codex-mcp-client" });
    expect(currentHarness({})).toBe("codex");
  });

  it("falls back to a valid manifest declaration for an unknown MCP client", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "codex"]);
    setHarnessFromClientInfo({ name: "unrecognised-client" });
    expect(currentHarness({})).toBe("codex");
  });

  it("ignores a declaration it does not recognise", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "somethingElse"]);
    expect(currentHarness({ CLAUDE_PLUGIN_ROOT: "/x" })).toBe("claudeCode");
  });

  it("ignores a trailing --harness with no value", () => {
    setHarnessFromArgv(["node", "index.js", "--harness"]);
    expect(currentHarness({ CLAUDE_PLUGIN_ROOT: "/x" })).toBe("claudeCode");
  });

  it("reads CLAUDE_PLUGIN_ROOT when nothing was declared", () => {
    expect(currentHarness({ CLAUDE_PLUGIN_ROOT: "/Users/m/.claude/plugins/x" }))
      .toBe("claudeCode");
  });

  it("recognises a custom CODEX_HOME", () => {
    expect(currentHarness({ CODEX_HOME: "/Volumes/AgentData" })).toBe("codex");
  });

  it("recognises Codex Desktop's portable plugin cache path", () => {
    expect(currentHarness({
      PLUGIN_ROOT: "/Users/m/.codex/plugins/cache/remarc/remarc/0.13.1",
    })).toBe("codex");
  });

  it("recognises OMP's portable plugin cache path", () => {
    expect(currentHarness({
      PLUGIN_ROOT: "/Users/m/.omp/plugins/cache/remarc/remarc/0.13.1",
    })).toBe("omp");
  });

  it("defaults to Claude Code when there is no signal at all", () => {
    expect(currentHarness({})).toBe("claudeCode");
  });

  it("prefers an explicit declaration over the environment", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "codex"]);
    expect(currentHarness({ CLAUDE_PLUGIN_ROOT: "/Users/m/.claude/plugins/x" }))
      .toBe("codex");
  });
});
