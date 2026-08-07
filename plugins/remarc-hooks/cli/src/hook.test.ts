import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./operations.js", async () => {
  const actual = await vi.importActual<typeof import("./operations.js")>("./operations.js");
  return {
    ...actual,
    createSession: vi.fn(async () => ({
      remarcSessionId: "ABC-123",
      sessionName: "proj",
      dataFilePath: "/tmp/test-data.json",
    })),
    handoff: vi.fn(async () => "## Remarc Comments (2 outstanding)\nSample"),
    windDown: vi.fn(async () => {}),
  };
});
vi.mock("./defaults.js", () => ({
  readBoolDefault: vi.fn(async () => true),
  readStringDefault: vi.fn(async () => "autoDelete"),
}));
vi.mock("./marker.js", () => ({
  writeMarker: vi.fn(async () => {}),
  readMarker: vi.fn(async () => ({
    remarcSessionId: "ABC-123",
    dataFilePath: "/tmp/d.json",
    transcriptPath: null,
    lastActivity: null,
    deliveredIds: [],
    wakedAt: {},
  })),
  touchMarker: vi.fn(async () => {}),
  updateMarker: vi.fn(async () => {}),
  removeMarker: vi.fn(async () => {}),
  pruneIds: (ids: string[]) => ids,
  readAllMarkers: vi.fn(async () => []),
  pruneDeadMarkers: vi.fn(async () => []),
}));
vi.mock("./data.js", async () => {
  const actual = await vi.importActual<typeof import("./data.js")>("./data.js");
  return {
    ...actual,
    getDataFilePath: () => "/Users/test/Library/Application Support/Remarc/comments.json",
    readAppState: vi.fn(async () => null),
  };
});
vi.mock("./wake.js", () => ({
  runWake: vi.fn(async () => null),
  selectQueueComments: vi.fn(() => []),
}));

const DATA_PATH = "/Users/test/Library/Application Support/Remarc/comments.json";

describe("session-start: watch registration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits watchPaths and a session title on startup", async () => {
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({ source: "startup", session_id: "claude-abc", cwd: "/Users/m/proj" })
    );

    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.watchPaths).toEqual([DATA_PATH]);
    expect(out.sessionTitle).toBe("proj");
    expect(out.additionalContext).toContain("Remarc Comments");
  });

  it("still emits watchPaths when session auto-create is disabled", async () => {
    // Claude Code only registers dynamic watch paths when SessionStart output
    // is non-empty. Returning {} here would leave wake permanently disarmed for
    // users who turned auto-create off.
    const { readBoolDefault } = await import("./defaults.js");
    vi.mocked(readBoolDefault).mockResolvedValueOnce(false);
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({ source: "startup", session_id: "claude-abc", cwd: "/Users/m/proj" })
    );

    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.watchPaths).toEqual([DATA_PATH]);
    const { createSession } = await import("./operations.js");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("still records wake capability when session auto-create is disabled", async () => {
    // The app decides whether to offer the wake button by reading `wakeCapable`
    // off the markers. Auto-create only governs whether a Remarc session gets
    // made, so skipping the marker here hid the button forever from anyone who
    // creates their sessions by hand - watchPaths alone is not enough.
    const { readBoolDefault } = await import("./defaults.js");
    vi.mocked(readBoolDefault).mockResolvedValueOnce(false);
    const { updateMarker } = await import("./marker.js");
    vi.mocked(updateMarker).mockClear();
    const { runHook } = await import("./hook.js");
    await runHook(
      "session-start",
      JSON.stringify({
        source: "startup",
        session_id: "claude-abc",
        cwd: "/Users/m/proj",
        transcript_path: "/Users/m/.claude/t.jsonl",
      })
    );

    expect(updateMarker).toHaveBeenCalledWith("claude-abc", expect.any(Function));
    const mutate = vi.mocked(updateMarker).mock.calls[0][1];
    const marker: Record<string, unknown> = { wakeCapable: false, lastActivity: null };
    mutate(marker as never);
    expect(marker.wakeCapable).toBe(true);
    expect(marker.transcriptPath).toBe("/Users/m/.claude/t.jsonl");
    expect(typeof marker.lastActivity).toBe("string");
  });

  it("does not claim wake capability under a strict harness with auto-create off", async () => {
    // Codex has no rewake hook. Recording it as wake-capable would put a button
    // in front of the user that cannot reach anything.
    const { readBoolDefault } = await import("./defaults.js");
    vi.mocked(readBoolDefault).mockResolvedValueOnce(false);
    const { updateMarker } = await import("./marker.js");
    vi.mocked(updateMarker).mockClear();
    const { runHook } = await import("./hook.js");
    await runHook(
      "session-start",
      JSON.stringify({
        source: "startup",
        session_id: "codex-abc",
        transcript_path: "/Users/mete/.codex/sessions/r.jsonl",
      })
    );

    const mutate = vi.mocked(updateMarker).mock.calls[0][1];
    const marker: Record<string, unknown> = { wakeCapable: true };
    mutate(marker as never);
    expect(marker.wakeCapable).toBe(false);
  });

  it("still emits watchPaths for compact/clear with no marker", async () => {
    const { readMarker } = await import("./marker.js");
    vi.mocked(readMarker).mockResolvedValueOnce(null);
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({ source: "clear", session_id: "claude-abc" })
    );
    expect(JSON.parse(res.stdout).hookSpecificOutput.watchPaths).toEqual([DATA_PATH]);
  });

  it("handles fork as a real source, not a fall-through", async () => {
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({ source: "fork", session_id: "claude-fork", cwd: "/Users/m/proj" })
    );

    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.watchPaths).toEqual([DATA_PATH]);
    expect(out.sessionTitle).toBe("proj");
    const { createSession } = await import("./operations.js");
    expect(createSession).toHaveBeenCalled();
  });

  it("omits Claude-Code-only fields for Codex, keeping the context", async () => {
    // Codex's SessionStart output schema is additionalProperties:false and
    // allows only hookEventName + additionalContext. Emitting watchPaths or
    // sessionTitle makes it reject the WHOLE payload, so the comments never
    // arrive - verified live against codex-cli 0.146.1.
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({
        source: "startup",
        session_id: "codex-abc",
        cwd: "/Users/m/proj",
        transcript_path: "/Users/mete/.codex/sessions/2026/08/06/rollout-x.jsonl",
      })
    );

    const out = JSON.parse(res.stdout).hookSpecificOutput;
    expect(out.additionalContext).toContain("Remarc Comments");
    expect(out.watchPaths).toBeUndefined();
    expect(out.sessionTitle).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(["additionalContext", "hookEventName"]);
  });

  it("emits nothing at all for Codex when there is no context to deliver", async () => {
    const { readBoolDefault } = await import("./defaults.js");
    vi.mocked(readBoolDefault).mockResolvedValueOnce(false);
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({
        source: "startup",
        session_id: "codex-abc",
        transcript_path: "/Users/mete/.codex/sessions/r.jsonl",
      })
    );
    expect(res.stdout).toBe("{}");
  });

  it("ignores subagent sessions", async () => {
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({ source: "startup", session_id: "s", agent_type: "explore" })
    );
    expect(res.stdout).toBe("{}");
  });
});

describe("cwd-changed: watch re-registration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-emits the same watchPaths", async () => {
    // Claude Code replaces (not merges) the dynamic watch list on every cwd
    // change, taking it from CwdChanged hook output. Without this the list
    // empties on the first `cd` and wake dies silently.
    const { runHook } = await import("./hook.js");
    const res = await runHook("cwd-changed", JSON.stringify({ session_id: "claude-abc" }));
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "CwdChanged", watchPaths: [DATA_PATH] },
    });
  });

  it("no-ops without a session id", async () => {
    const { runHook } = await import("./hook.js");
    expect((await runHook("cwd-changed", "{}")).stdout).toBe("{}");
  });

  it("stays silent on Codex, which has no CwdChanged event", async () => {
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "cwd-changed",
      JSON.stringify({
        session_id: "codex-abc",
        transcript_path: "/Users/mete/.codex/sessions/r.jsonl",
      })
    );
    expect(res.stdout).toBe("{}");
  });
});

describe("file-changed: wake", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exits 2 with the payload on stderr when there is something to wake for", async () => {
    const { runWake } = await import("./wake.js");
    vi.mocked(runWake).mockResolvedValueOnce({
      stderrText: "WAKE-PAYLOAD",
      exitCode: 2,
      commit: async () => {},
    });
    const { runHook } = await import("./hook.js");
    const res = await runHook("file-changed", JSON.stringify({ session_id: "claude-abc" }));

    expect(res.exitCode).toBe(2);
    expect(res.stderrText).toBe("WAKE-PAYLOAD");
  });

  it("exits 0 silently when nothing is eligible", async () => {
    const { runHook } = await import("./hook.js");
    const res = await runHook("file-changed", JSON.stringify({ session_id: "claude-abc" }));
    expect(res.exitCode).toBe(0);
    expect(res.stderrText).toBeUndefined();
  });
});

describe("session-end", () => {
  beforeEach(() => vi.clearAllMocks());

  it("winds down only when the user cleared the conversation", async () => {
    // `clear` is the one ending that means "done with this work".
    const { runHook } = await import("./hook.js");
    await runHook(
      "session-end",
      JSON.stringify({ session_id: "claude-abc", reason: "clear" })
    );
    const { windDown } = await import("./operations.js");
    const { removeMarker } = await import("./marker.js");
    expect(windDown).toHaveBeenCalledWith({ remarcSessionId: "ABC-123" });
    expect(removeMarker).toHaveBeenCalledWith("claude-abc");
  });

  it("unlinks without winding down when the user just quits", async () => {
    // Quitting means the agent stopped, not that the comments were handled.
    // Winding down here destroyed the session and moved live comments to the
    // Inbox, where nothing delivers them.
    const { runHook } = await import("./hook.js");
    for (const reason of ["prompt_input_exit", "logout", "other", undefined]) {
      vi.clearAllMocks();
      await runHook(
        "session-end",
        JSON.stringify({ session_id: "claude-abc", reason })
      );
      const { windDown } = await import("./operations.js");
      const { removeMarker } = await import("./marker.js");
      expect(windDown, `reason=${reason}`).not.toHaveBeenCalled();
      expect(removeMarker, `reason=${reason}`).toHaveBeenCalledWith("claude-abc");
    }
  });

  it("leaves the marker alone when the session is coming back", async () => {
    // `resume` fires on compaction and explicit resume - the session keeps its
    // id and returns. Removing the marker there dropped the pairing mid-
    // conversation, and winding down destroyed the session it pointed at.
    const { runHook } = await import("./hook.js");
    await runHook(
      "session-end",
      JSON.stringify({ session_id: "claude-abc", reason: "resume" })
    );
    const { windDown } = await import("./operations.js");
    const { removeMarker } = await import("./marker.js");
    expect(windDown).not.toHaveBeenCalled();
    expect(removeMarker).not.toHaveBeenCalled();
  });

  it("survives a wind-down failure and still removes the marker", async () => {
    const { windDown } = await import("./operations.js");
    vi.mocked(windDown).mockRejectedValueOnce(new Error("nope"));
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-end",
      JSON.stringify({ session_id: "claude-abc", reason: "clear" })
    );
    expect(res.exitCode).toBe(0);
    const { removeMarker } = await import("./marker.js");
    expect(removeMarker).toHaveBeenCalled();
  });
});

describe("degradation contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns {} on malformed input", async () => {
    const { runHook } = await import("./hook.js");
    expect((await runHook("session-start", "not json")).stdout).toBe("{}");
  });

  it("returns {} when orchestration throws", async () => {
    const { createSession } = await import("./operations.js");
    vi.mocked(createSession).mockRejectedValueOnce(new Error("app not running"));
    const { runHook } = await import("./hook.js");
    const res = await runHook(
      "session-start",
      JSON.stringify({ source: "startup", session_id: "s", cwd: "/x" })
    );
    expect(res.stdout).toBe("{}");
    expect(res.exitCode).toBe(0);
  });

  it("returns {} for unknown events", async () => {
    const { runHook } = await import("./hook.js");
    expect((await runHook("nonsense", "{}")).stdout).toBe("{}");
  });
});
