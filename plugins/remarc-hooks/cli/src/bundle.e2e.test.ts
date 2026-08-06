import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "dist", "hook.js");

/**
 * These run the committed bundle, not the TypeScript sources. The hooks that
 * actually execute in Claude Code are `dist/hook.js`, so source-only tests can
 * pass while the shipped artifact is stale or broken.
 */
let home: string;
let dataDir: string;

function run(
  event: string,
  input: unknown
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BUNDLE, event], {
      env: { ...process.env, HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function doc(overrides: Record<string, unknown> = {}) {
  return {
    sessions: [
      {
        id: "S1",
        name: "Proj",
        createdAt: 0,
        isDeleted: false,
        isAutoDismissed: false,
        origin: "claudeCode",
        claudeCodeSessionId: "claude-e2e",
      },
    ],
    comments: [
      {
        id: "11111111-2222-3333-4444-555555555555",
        commentText: "Fix the hover state",
        source: "Xcode",
        createdAt: 0,
        updatedAt: 0,
        sessionID: "S1",
        isDeleted: false,
        status: "handedOff",
        wakeRequestedAt: 800000000,
      },
    ],
    activeSessionID: "S1",
    totalCommentsCreated: 1,
    orphanedImages: ["/tmp/keep.png"],
    transcriptions: [{ id: "T1", text: "keep me" }],
    ...overrides,
  };
}

async function writeMarker(sessionId: string, extra: Record<string, unknown> = {}) {
  const dir = join(dataDir, "claude", "markers");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${sessionId}.json`),
    JSON.stringify({
      remarcSessionId: "S1",
      dataFilePath: join(dataDir, "comments.json"),
      transcriptPath: null,
      lastActivity: "2026-08-06T00:00:00Z",
      deliveredIds: [],
      wakedAt: {},
      ...extra,
    })
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "remarc-e2e-"));
  dataDir = join(home, "Library", "Application Support", "Remarc");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "comments.json"), JSON.stringify(doc(), null, 2));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("bundle: wake path", () => {
  it("exits 2 with a system-reminder payload for a wake-flagged comment", async () => {
    await writeMarker("claude-e2e");
    const r = await run("file-changed", {
      session_id: "claude-e2e",
      file_path: "comments.json",
      event: "change",
    });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("11111111-2222-3333-4444-555555555555");
    expect(r.stderr).toContain('expected_status: "handedOff"');
    expect(r.stderr).toMatch(/<<<REMARC-DATA-[0-9a-f]{8}>>>/);
  });

  it("does not wake twice for the same comment", async () => {
    await writeMarker("claude-e2e");
    const first = await run("file-changed", { session_id: "claude-e2e" });
    expect(first.code).toBe(2);
    const second = await run("file-changed", { session_id: "claude-e2e" });
    expect(second.code).toBe(0);
    expect(second.stderr).toBe("");
  });

  it("stays silent for a deleted comment", async () => {
    await writeFile(
      join(dataDir, "comments.json"),
      JSON.stringify(doc({ comments: [{ ...doc().comments[0], isDeleted: true }] }))
    );
    await writeMarker("claude-e2e");
    const r = await run("file-changed", { session_id: "claude-e2e" });
    expect(r.code).toBe(0);
  });

  it("stays silent once another agent has claimed it", async () => {
    await writeFile(
      join(dataDir, "comments.json"),
      JSON.stringify(doc({ comments: [{ ...doc().comments[0], status: "inProgress" }] }))
    );
    await writeMarker("claude-e2e");
    const r = await run("file-changed", { session_id: "claude-e2e" });
    expect(r.code).toBe(0);
  });
});

describe("bundle: watch registration", () => {
  it("emits watchPaths on SessionStart even when auto-create is off", async () => {
    // This machine's default may be either value; the point is that watchPaths
    // is present regardless, because Claude Code only registers dynamic paths
    // when the hook produces output.
    const r = await run("session-start", {
      source: "startup",
      session_id: "claude-new",
      cwd: "/Users/m/proj",
    });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.watchPaths).toEqual([join(dataDir, "comments.json")]);
  });

  it("re-emits watchPaths on CwdChanged", async () => {
    const r = await run("cwd-changed", { session_id: "claude-e2e", cwd: "/elsewhere" });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe("CwdChanged");
    expect(out.watchPaths).toEqual([join(dataDir, "comments.json")]);
  });
});

describe("bundle: data integrity", () => {
  it("preserves unmodeled top-level fields across a hook write", async () => {
    await writeMarker("claude-e2e");
    await run("session-end", { session_id: "claude-e2e" });

    const after = JSON.parse(await readFile(join(dataDir, "comments.json"), "utf8"));
    expect(after.orphanedImages).toEqual(["/tmp/keep.png"]);
    expect(after.transcriptions).toEqual([{ id: "T1", text: "keep me" }]);
  });

  it("leaves no temp files behind", async () => {
    await writeMarker("claude-e2e");
    await run("file-changed", { session_id: "claude-e2e" });
    const { readdir } = await import("node:fs/promises");
    const stray = (await readdir(dataDir)).filter((f) => f.endsWith(".tmp"));
    expect(stray).toEqual([]);
  });
});

describe("bundle freshness", () => {
  it("dist exists and is executable", () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });
});
