import { describe, it, expect, beforeEach } from "vitest";
import { currentHarness, setHarnessFromArgv, resetHarnessForTests } from "./harness.js";

describe("currentHarness", () => {
  beforeEach(() => resetHarnessForTests());

  it("takes the harness the manifest declared", () => {
    // codex-mcp.json passes this, so Codex never has to be guessed at.
    setHarnessFromArgv(["node", "index.js", "--harness", "codex"]);
    expect(currentHarness({})).toBe("codex");
  });

  it("recognises OMP only from the explicit manifest declaration", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "omp"]);
    expect(currentHarness({
      CLAUDE_PLUGIN_ROOT: "/Users/m/.claude/plugins/x",
      CODEX_HOME: "/Users/m/.codex",
    })).toBe("omp");
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
    // Installs predating the flag, and any harness reusing the Claude manifest.
    expect(currentHarness({ CLAUDE_PLUGIN_ROOT: "/Users/m/.claude/plugins/x" }))
      .toBe("claudeCode");
  });

  it("recognises a custom CODEX_HOME", () => {
    // The reason paths alone are only a fallback: CODEX_HOME can point anywhere,
    // so the plugin root need not mention codex at all.
    expect(currentHarness({ CODEX_HOME: "/Users/m/.codex" })).toBe("codex");
  });

  it("defaults to Claude Code when there is no signal at all", () => {
    // Claude Code is the harness that has always worked, so an unknown one
    // keeps today's labelling rather than inventing a new claim.
    expect(currentHarness({})).toBe("claudeCode");
  });

  it("prefers an explicit declaration over the environment", () => {
    setHarnessFromArgv(["node", "index.js", "--harness", "codex"]);
    expect(currentHarness({ CLAUDE_PLUGIN_ROOT: "/Users/m/.claude/plugins/x" }))
      .toBe("codex");
  });
});
