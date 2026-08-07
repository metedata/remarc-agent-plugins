import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `markersDir()` is anchored to `homedir()`, which on POSIX reads $HOME on
 * every call. Pointing HOME at a temp directory is what keeps these tests off
 * the real markers directory - which `pruneDeadMarkers` deletes from, so a test
 * that got this wrong would eat the live sessions of whoever ran it.
 */
let home: string;
let realHome: string | undefined;

const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  realHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "remarc-markers-"));
  process.env.HOME = home;
  await mkdir(markersDir(), { recursive: true });
});

afterEach(async () => {
  process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

function markersDir(): string {
  return join(home, "Library", "Application Support", "Remarc", "claude", "markers");
}

async function writeRawMarker(
  id: string,
  fields: { transcriptPath?: string | null; lastActivity?: string | null }
): Promise<void> {
  await writeFile(
    join(markersDir(), `${id}.json`),
    JSON.stringify({
      remarcSessionId: "",
      dataFilePath: "",
      transcriptPath: fields.transcriptPath ?? null,
      wakeCapable: true,
      lastActivity: fields.lastActivity ?? null,
      deliveredIds: [],
      wakedAt: {},
    })
  );
}

async function existingTranscript(name: string): Promise<string> {
  const path = join(home, name);
  await writeFile(path, "{}");
  return path;
}

async function remaining(): Promise<string[]> {
  return (await readdir(markersDir())).filter((n) => n.endsWith(".json")).sort();
}

async function prune(keep?: string) {
  const { pruneDeadMarkers } = await import("./marker.js");
  return pruneDeadMarkers(keep);
}

describe("pruneDeadMarkers", () => {
  it("removes a marker whose named transcript was never created", async () => {
    // The `claude plugin list --json` signature: a marker naming a transcript
    // the invocation exited too fast to write.
    await writeRawMarker("phantom", {
      transcriptPath: join(home, "never-written.jsonl"),
      lastActivity: new Date(Date.now() - HOUR).toISOString(),
    });

    expect(await prune()).toEqual(["phantom"]);
    expect(await remaining()).toEqual([]);
  });

  it("keeps a young marker naming a transcript that has not appeared yet", async () => {
    // SessionStart reports the path before Claude Code necessarily writes the
    // file. Pruning inside the grace window would delete live sessions.
    await writeRawMarker("starting", {
      transcriptPath: join(home, "not-yet.jsonl"),
      lastActivity: new Date().toISOString(),
    });

    expect(await prune()).toEqual([]);
    expect(await remaining()).toEqual(["starting.json"]);
  });

  it("keeps a marker whose transcript exists and is recent", async () => {
    await writeRawMarker("live", {
      transcriptPath: await existingTranscript("live.jsonl"),
      lastActivity: new Date().toISOString(),
    });

    expect(await prune()).toEqual([]);
    expect(await remaining()).toEqual(["live.json"]);
  });

  it("removes a day-old marker even when its transcript still exists", async () => {
    // A session killed hard enough to skip SessionEnd leaves its transcript
    // behind, so the transcript check alone would never collect it.
    await writeRawMarker("abandoned", {
      transcriptPath: await existingTranscript("abandoned.jsonl"),
      lastActivity: new Date(Date.now() - 25 * HOUR).toISOString(),
    });

    expect(await prune()).toEqual(["abandoned"]);
    expect(await remaining()).toEqual([]);
  });

  it("removes a marker with no usable timestamp", async () => {
    await writeRawMarker("undated", { transcriptPath: null, lastActivity: null });

    expect(await prune()).toEqual(["undated"]);
    expect(await remaining()).toEqual([]);
  });

  it("never removes the session it was told to keep", async () => {
    // The caller is mid-write on its own marker at SessionStart, and its
    // transcript is exactly the one least likely to exist yet.
    await writeRawMarker("mine", {
      transcriptPath: join(home, "mine.jsonl"),
      lastActivity: new Date(Date.now() - 25 * HOUR).toISOString(),
    });

    expect(await prune("mine")).toEqual([]);
    expect(await remaining()).toEqual(["mine.json"]);
  });

  it("leaves markers stamped in the future alone", async () => {
    // Clock skew between writers is not evidence that a session is dead.
    await writeRawMarker("skewed", {
      transcriptPath: join(home, "skewed.jsonl"),
      lastActivity: new Date(Date.now() + HOUR).toISOString(),
    });

    expect(await prune()).toEqual([]);
    expect(await remaining()).toEqual(["skewed.json"]);
  });

  it("collects only the dead ones when both kinds are present", async () => {
    await writeRawMarker("dead", {
      transcriptPath: join(home, "gone.jsonl"),
      lastActivity: new Date(Date.now() - HOUR).toISOString(),
    });
    await writeRawMarker("alive", {
      transcriptPath: await existingTranscript("alive.jsonl"),
      lastActivity: new Date().toISOString(),
    });

    expect(await prune()).toEqual(["dead"]);
    expect(await remaining()).toEqual(["alive.json"]);
  });
});
