import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./operations.js", () => ({
  createSession: vi.fn(async () => ({
    remarcSessionId: "ABC-123",
    dataFilePath: "/tmp/test-data.json",
  })),
  handoff: vi.fn(async () => "## Remarc Comments (2 outstanding)\nSample"),
  windDown: vi.fn(async () => {}),
}));
vi.mock("./defaults.js", () => ({
  readBoolDefault: vi.fn(async () => true),
  readStringDefault: vi.fn(async () => "autoDelete"),
}));
vi.mock("./marker.js", () => ({
  writeMarker: vi.fn(async () => {}),
  readMarker: vi.fn(async () => ({
    remarcSessionId: "ABC-123",
    dataFilePath: "/tmp/d.json",
  })),
  touchMarker: vi.fn(async () => {}),
  dataNewerThanMarker: vi.fn(() => true),
  removeMarker: vi.fn(async () => {}),
}));

describe("hook session-start", () => {
  beforeEach(() => vi.clearAllMocks());

  it("startup: creates session, writes marker, emits additionalContext", async () => {
    const input = JSON.stringify({
      source: "startup",
      session_id: "claude-abc",
      cwd: "/Users/m/proj",
    });
    const { runHook } = await import("./hook.js");
    const output = await runHook("session-start", input);

    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("Remarc Comments"),
      },
    });
  });

  it("startup with auto-create disabled: emits {}, no session created", async () => {
    const { readBoolDefault } = await import("./defaults.js");
    vi.mocked(readBoolDefault).mockResolvedValueOnce(false);
    const input = JSON.stringify({
      source: "startup",
      session_id: "claude-abc",
      cwd: "/Users/m/proj",
    });
    const { runHook } = await import("./hook.js");
    const output = await runHook("session-start", input);

    expect(JSON.parse(output)).toEqual({});
    const { createSession } = await import("./operations.js");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("subagent invocations are skipped", async () => {
    const input = JSON.stringify({
      source: "startup",
      session_id: "claude-abc",
      agent_type: "Explore",
    });
    const { runHook } = await import("./hook.js");
    const output = await runHook("session-start", input);
    expect(JSON.parse(output)).toEqual({});
  });

  it("errors thrown by operations degrade to {} (silent fail contract)", async () => {
    const { createSession } = await import("./operations.js");
    vi.mocked(createSession).mockRejectedValueOnce(new Error("simulated failure"));
    const input = JSON.stringify({
      source: "startup",
      session_id: "claude-abc",
      cwd: "/Users/m/proj",
    });
    const { runHook } = await import("./hook.js");
    const output = await runHook("session-start", input);
    expect(JSON.parse(output)).toEqual({});
  });

  it("compact source re-injects context using existing marker", async () => {
    const input = JSON.stringify({
      source: "compact",
      session_id: "claude-abc",
    });
    const { runHook } = await import("./hook.js");
    const output = await runHook("session-start", input);
    expect(JSON.parse(output).hookSpecificOutput.hookEventName).toBe("SessionStart");
    const { createSession } = await import("./operations.js");
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("hook prompt-submit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no marker: emits {}", async () => {
    const { readMarker } = await import("./marker.js");
    vi.mocked(readMarker).mockResolvedValueOnce(null);
    const input = JSON.stringify({ session_id: "claude-abc", prompt: "hi" });
    const { runHook } = await import("./hook.js");
    expect(JSON.parse(await runHook("prompt-submit", input))).toEqual({});
  });

  it("data unchanged + no hint: emits {}", async () => {
    const { dataNewerThanMarker } = await import("./marker.js");
    vi.mocked(dataNewerThanMarker).mockReturnValueOnce(false);
    const input = JSON.stringify({
      session_id: "claude-abc",
      prompt: "what's the weather",
    });
    const { runHook } = await import("./hook.js");
    expect(JSON.parse(await runHook("prompt-submit", input))).toEqual({});
  });

  it("data unchanged but prompt mentions remarc: injects", async () => {
    const { dataNewerThanMarker } = await import("./marker.js");
    vi.mocked(dataNewerThanMarker).mockReturnValueOnce(false);
    const input = JSON.stringify({
      session_id: "claude-abc",
      prompt: "summarize my remarc comments",
    });
    const { runHook } = await import("./hook.js");
    const out = JSON.parse(await runHook("prompt-submit", input));
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("narrowed regex does NOT match 'commentary' or 'commented out'", async () => {
    const { dataNewerThanMarker } = await import("./marker.js");
    vi.mocked(dataNewerThanMarker).mockReturnValueOnce(false);
    const input = JSON.stringify({
      session_id: "claude-abc",
      prompt: "the function has commentary about edge cases",
    });
    const { runHook } = await import("./hook.js");
    expect(JSON.parse(await runHook("prompt-submit", input))).toEqual({});
  });
});

describe("hook session-end", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls windDown and removes marker", async () => {
    const input = JSON.stringify({ session_id: "claude-abc" });
    const { runHook } = await import("./hook.js");
    const out = await runHook("session-end", input);
    expect(JSON.parse(out)).toEqual({});

    const { windDown } = await import("./operations.js");
    const { removeMarker } = await import("./marker.js");
    expect(windDown).toHaveBeenCalledWith({ remarcSessionId: "ABC-123" });
    expect(removeMarker).toHaveBeenCalledWith("claude-abc");
  });

  it("windDown errors are swallowed", async () => {
    const { windDown } = await import("./operations.js");
    vi.mocked(windDown).mockRejectedValueOnce(new Error("simulated"));
    const input = JSON.stringify({ session_id: "claude-abc" });
    const { runHook } = await import("./hook.js");
    expect(JSON.parse(await runHook("session-end", input))).toEqual({});
  });
});

describe("marker invariant", () => {
  it("writeMarker sets mtime in the past (year-2000 contract)", async () => {
    // Pins the non-obvious year-2000 mtime invariant. If someone changes
    // writeMarker to use `now`, first prompt-submit would silently no-op for
    // any session created after data.json was last touched.
    // Note: unmock marker for this test by importing the real module.
    vi.doUnmock("./marker.js");
    const { writeMarker, _markerPath } = await import("./marker.js?real");
    const { statSync } = await import("node:fs");
    const sessionId = `test-${Date.now()}-${Math.random()}`;
    await writeMarker(sessionId, {
      remarcSessionId: "abc",
      dataFilePath: "/tmp/x.json",
    });
    const stat = statSync(_markerPath(sessionId));
    expect(stat.mtimeMs).toBeLessThan(Date.now() - 365 * 24 * 60 * 60 * 1000);
  });
});
