import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Marker } from "./marker.js";

/**
 * `markersDir()` is anchored to `homedir()`, which on POSIX reads $HOME on
 * every call. Pointing HOME at a temp directory is what keeps these tests off
 * the real markers directory - which `pruneDeadMarkers` deletes from, so a test
 * that got this wrong would eat the live sessions of whoever ran it.
 */
let home: string;
let realHome: string | undefined;

const HOUR = 60 * 60 * 1000;

interface OmpLeaseContractFixture {
  fixtureVersion: number;
  now: string;
  requestedRemarcSessionId: string;
  cases: Array<{
    name: string;
    ownerAlive: boolean;
    expectedReachable: boolean;
    marker: Record<string, unknown>;
  }>;
}

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

async function readOmpLeaseContractFixture(): Promise<OmpLeaseContractFixture> {
  const url = new URL("../../../shared/fixtures/omp-lease-v1.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as OmpLeaseContractFixture;
}

async function writeCompleteMarker(
  id: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await writeFile(
    join(markersDir(), `${id}.json`),
    JSON.stringify({
      remarcSessionId: "S1",
      dataFilePath: join(home, "comments.json"),
      transcriptPath: null,
      wakeCapable: false,
      lastActivity: null,
      deliveredIds: [],
      wakedAt: {},
      ...extra,
    })
  );
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

describe("safe marker reads and forward compatibility", () => {
  it("distinguishes missing, invalid, valid, and unsafe outcomes", async () => {
    const { readMarkerOutcome } = await import("./marker.js");

    expect(await readMarkerOutcome("missing")).toEqual({ kind: "missing" });

    await writeFile(join(markersDir(), "invalid.json"), "{");
    expect(await readMarkerOutcome("invalid")).toMatchObject({ kind: "invalid" });

    await writeCompleteMarker("valid");
    expect(await readMarkerOutcome("valid")).toMatchObject({
      kind: "valid",
      source: "json",
      marker: { remarcSessionId: "S1" },
    });

    const target = join(home, "outside.json");
    await writeFile(target, JSON.stringify({ remarcSessionId: "OUTSIDE" }));
    await symlink(target, join(markersDir(), "unsafe.json"));
    expect(await readMarkerOutcome("unsafe")).toMatchObject({ kind: "unsafe" });
  });

  it("rejects directories and never follows a marker symlink during update", async () => {
    const { readMarkerOutcome, updateMarker } = await import("./marker.js");
    await mkdir(join(markersDir(), "directory.json"));
    expect(await readMarkerOutcome("directory")).toMatchObject({ kind: "unsafe" });
    await expect(updateMarker("directory", () => {})).rejects.toMatchObject({
      name: "UnsafeMarkerPathError",
    });

    const outside = join(home, "outside-sentinel.json");
    await writeFile(outside, "do-not-touch");
    await symlink(outside, join(markersDir(), "linked.json"));
    await expect(
      updateMarker("linked", (marker) => {
        marker.lastActivity = new Date().toISOString();
      })
    ).rejects.toMatchObject({ name: "UnsafeMarkerPathError" });
    expect(await readFile(outside, "utf8")).toBe("do-not-touch");
  });

  it("round-trips unknown fields while normalising versioned lease fields", async () => {
    const { updateMarker, readMarker } = await import("./marker.js");
    const future = {
      nested: { flag: true, values: [1, "two", { three: 3 }] },
      scalar: "preserve-me",
    };
    await writeCompleteMarker("future", {
      future,
      scalar: "preserve-me",
      protocolVersion: 1,
      harness: "omp",
      ownerPid: 42,
      ownerToken: "owner",
      leaseHeartbeatAt: "2026-01-01T00:00:00.000Z",
      pendingWake: { good: 123, bad: "drop", infinity: null },
    });

    await updateMarker("future", (marker) => {
      marker.lastActivity = "2026-01-01T00:00:01.000Z";
    });

    const raw = JSON.parse(
      await readFile(join(markersDir(), "future.json"), "utf8")
    ) as Record<string, unknown>;
    expect(raw.future).toEqual(future);
    expect(raw.scalar).toBe("preserve-me");
    expect(raw.pendingWake).toEqual({ good: 123 });
    expect(await readMarker("future")).toMatchObject({
      protocolVersion: 1,
      harness: "omp",
      ownerPid: 42,
      ownerToken: "owner",
      pendingWake: { good: 123 },
    });
  });
});

describe("marker locks", () => {
  async function installLock(
    id: string,
    owner: Record<string, unknown>,
    ageMs = 0
  ): Promise<string> {
    const path = join(markersDir(), `${id}.json.lock`);
    await mkdir(path);
    await writeFile(join(path, "owner.json"), JSON.stringify(owner));
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      await utimes(path, old, old);
    }
    return path;
  }

  it("never age-reclaims a lock whose owner pid is live", async () => {
    const { updateMarker } = await import("./marker.js");
    const lock = await installLock(
      "live-lock",
      { pid: process.pid, token: "other" },
      60_000
    );

    await expect(
      updateMarker("live-lock", () => {}, { timeoutMs: 40 })
    ).rejects.toThrow("Timed out waiting for marker lock");
    expect(await readFile(join(lock, "owner.json"), "utf8")).toContain("other");
  });

  it("reclaims a lock with a demonstrably dead owner pid", async () => {
    const { updateMarker, readMarker } = await import("./marker.js");
    await installLock("dead-lock", { pid: 2_147_483_647, token: "dead" });

    await updateMarker("dead-lock", (marker) => {
      marker.remarcSessionId = "RECOVERED";
    });
    expect(await readMarker("dead-lock")).toMatchObject({
      remarcSessionId: "RECOVERED",
    });
  });

  it("honours an absolute deadline and an AbortSignal", async () => {
    const { updateMarker } = await import("./marker.js");
    await installLock("deadline", { pid: process.pid, token: "held" });
    await expect(
      updateMarker("deadline", () => {}, {
        timeoutMs: 5_000,
        deadlineMs: Date.now() + 35,
      })
    ).rejects.toThrow("Timed out waiting for marker lock");

    await installLock("abort", { pid: process.pid, token: "held" });
    const controller = new AbortController();
    const pending = updateMarker("abort", () => {}, {
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects lock symlinks, regular files, and unsafe owner entries", async () => {
    const { updateMarker } = await import("./marker.js");

    await writeFile(join(markersDir(), "file-lock.json.lock"), "not-a-directory");
    await expect(updateMarker("file-lock", () => {})).rejects.toMatchObject({
      name: "UnsafeMarkerPathError",
    });

    const target = join(home, "lock-target");
    await mkdir(target);
    await symlink(target, join(markersDir(), "symlink-lock.json.lock"));
    await expect(updateMarker("symlink-lock", () => {})).rejects.toMatchObject({
      name: "UnsafeMarkerPathError",
    });

    const ownerLock = join(markersDir(), "owner-link.json.lock");
    await mkdir(ownerLock);
    const outside = join(home, "owner.json");
    await writeFile(outside, JSON.stringify({ pid: process.pid }));
    await symlink(outside, join(ownerLock, "owner.json"));
    await expect(updateMarker("owner-link", () => {})).rejects.toMatchObject({
      name: "UnsafeMarkerPathError",
    });
  });
});

describe("owner-token compare and set", () => {
  it("patches and removes only for the current owner token", async () => {
    const {
      patchMarkerIfOwner,
      readMarker,
      readMarkerOutcome,
      removeMarkerIfOwner,
    } = await import("./marker.js");
    await writeCompleteMarker("owned", { ownerToken: "alpha", future: { keep: true } });

    expect(
      await patchMarkerIfOwner("owned", "wrong", (marker) => {
        marker.lastActivity = "wrong";
      })
    ).toEqual({ kind: "ownerMismatch" });
    expect((await readMarker("owned"))?.lastActivity).toBeNull();

    expect(
      await patchMarkerIfOwner("owned", "alpha", (marker) => {
        marker.lastActivity = "right";
        marker.pendingWake = { comment: 100 };
      })
    ).toMatchObject({ kind: "updated" });
    expect(await readMarker("owned")).toMatchObject({
      lastActivity: "right",
      pendingWake: { comment: 100 },
      future: { keep: true },
    });

    expect(await removeMarkerIfOwner("owned", "wrong")).toEqual({
      kind: "ownerMismatch",
    });
    expect(await removeMarkerIfOwner("owned", "alpha")).toEqual({ kind: "removed" });
    expect(await readMarkerOutcome("owned")).toEqual({ kind: "missing" });
  });

  it("does not publish an async patch after its signal is aborted", async () => {
    const { patchMarkerIfOwner, readMarker } = await import("./marker.js");
    await writeCompleteMarker("abort-patch", { ownerToken: "alpha" });
    const controller = new AbortController();

    const pending = patchMarkerIfOwner(
      "abort-patch",
      "alpha",
      async (marker) => {
        marker.lastActivity = "must-not-land";
        controller.abort();
      },
      { signal: controller.signal }
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((await readMarker("abort-patch"))?.lastActivity).toBeNull();
  });
});

describe("OMP lease contract", () => {
  const now = Date.parse("2026-08-15T00:00:00.000Z");
  const liveLease = (extra: Record<string, unknown> = {}) => ({
    remarcSessionId: "S1",
    dataFilePath: "/tmp/comments.json",
    transcriptPath: null,
    wakeCapable: true,
    lastActivity: null,
    deliveredIds: [],
    wakedAt: {},
    protocolVersion: 1,
    harness: "omp",
    ownerPid: 123,
    ownerToken: "0123456789abcdef0123456789abcdef",
    leaseHeartbeatAt: new Date(now).toISOString(),
    ...extra,
  });

  it("matches the versioned cross-language reachability fixture", async () => {
    const { isLiveOmpLease } = await import("./marker.js");
    const fixture = await readOmpLeaseContractFixture();
    const fixtureNow = Date.parse(fixture.now);
    expect(fixture.fixtureVersion).toBe(1);
    expect(Number.isFinite(fixtureNow)).toBe(true);

    for (const contractCase of fixture.cases) {
      const markerSession = contractCase.marker.remarcSessionId;
      const targetsRequestedSession =
        typeof markerSession === "string" &&
        markerSession.toUpperCase() === fixture.requestedRemarcSessionId.toUpperCase();
      const reachable =
        targetsRequestedSession &&
        isLiveOmpLease(
          contractCase.marker as unknown as Marker,
          fixtureNow,
          () => contractCase.ownerAlive
        );
      expect(reachable, `cross-language OMP lease case: ${contractCase.name}`).toBe(
        contractCase.expectedReachable
      );
    }
  });

  it("requires every structural field and a live positive integral pid", async () => {
    const { isLiveOmpLease } = await import("./marker.js");
    const alive = () => true;
    expect(isLiveOmpLease(liveLease(), now, alive)).toBe(true);

    const invalid = [
      { wakeCapable: false },
      { protocolVersion: 2 },
      { harness: "claude" },
      { ownerToken: "" },
      { ownerToken: "   " },
      { ownerPid: 0 },
      { ownerPid: -1 },
      { ownerPid: 1.5 },
      { leaseHeartbeatAt: "not-a-date" },
    ];
    for (const fields of invalid) {
      expect(isLiveOmpLease(liveLease(fields), now, alive), JSON.stringify(fields)).toBe(
        false
      );
    }
    expect(isLiveOmpLease(liveLease(), now, () => false)).toBe(false);
  });

  it("accepts heartbeat age endpoints -30s and +60s inclusively", async () => {
    const { isLiveOmpLease } = await import("./marker.js");
    const alive = () => true;
    for (const offset of [-30_000, 60_000]) {
      const heartbeat = new Date(now - offset).toISOString();
      expect(
        isLiveOmpLease(liveLease({ leaseHeartbeatAt: heartbeat }), now, alive)
      ).toBe(true);
    }
    for (const offset of [-30_001, 60_001]) {
      const heartbeat = new Date(now - offset).toISOString();
      expect(
        isLiveOmpLease(liveLease({ leaseHeartbeatAt: heartbeat }), now, alive)
      ).toBe(false);
    }
  });

  it("treats EPERM from signal 0 as proof that the owner exists", async () => {
    const { isLiveOmpLease } = await import("./marker.js");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    try {
      expect(isLiveOmpLease(liveLease({ ownerPid: 999 }), now)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("generates distinct owner tokens carrying at least 128 random bits", async () => {
    const { newOwnerToken } = await import("./marker.js");
    const tokens = new Set(Array.from({ length: 32 }, () => newOwnerToken()));
    expect(tokens.size).toBe(32);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{32,}$/);
  });

  it("serialises cross-file claims and refuses a live foreign owner", async () => {
    const { claimOmpLease } = await import("./marker.js");
    const fields = {
      dataFilePath: join(home, "comments.json"),
      ownerPid: process.pid,
      leaseHeartbeatAt: new Date().toISOString(),
    };

    const [a, b] = await Promise.all([
      claimOmpLease("omp-a", "S1", "a".repeat(32), fields),
      claimOmpLease("omp-b", "S1", "b".repeat(32), fields),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["acquired", "conflict"]);
    const conflict = a.kind === "conflict" ? a : b;
    expect(conflict).toMatchObject({ kind: "conflict" });
  });

  it("reclaims a stale/dead OMP owner and preserves target unknown fields", async () => {
    const { claimOmpLease, patchMarkerIfOwner, readMarker } = await import("./marker.js");
    await writeCompleteMarker("omp-old", {
      remarcSessionId: "S1",
      wakeCapable: true,
      protocolVersion: 1,
      harness: "omp",
      ownerPid: 2_147_483_647,
      ownerToken: "old",
      leaseHeartbeatAt: new Date().toISOString(),
      pendingWake: { queued: 9 },
    });
    await writeCompleteMarker("omp-new", {
      future: { retain: true },
      pendingWake: { existing: 10 },
    });

    expect(
      await claimOmpLease("omp-new", "S1", "new-owner", {
        dataFilePath: join(home, "comments.json"),
        ownerPid: process.pid,
      })
    ).toMatchObject({ kind: "acquired" });
    expect(await readMarker("omp-new")).toMatchObject({
      ownerToken: "new-owner",
      future: { retain: true },
      pendingWake: { existing: 10 },
    });
    const fenced = await readMarker("omp-old");
    expect(fenced).toMatchObject({
      wakeCapable: false,
      pendingWake: { queued: 9 },
    });
    expect(fenced?.ownerToken).not.toBe("old");
    await expect(
      patchMarkerIfOwner("omp-old", "old", (marker) => {
        marker.wakeCapable = true;
        marker.leaseHeartbeatAt = new Date().toISOString();
      })
    ).resolves.toEqual({ kind: "ownerMismatch" });
  });

  it("fences a stale heartbeat owned by a still-running process before takeover", async () => {
    const { claimOmpLease, patchMarkerIfOwner, readMarker } = await import("./marker.js");
    await writeCompleteMarker("omp-sleeping", {
      remarcSessionId: "S1",
      wakeCapable: true,
      protocolVersion: 1,
      harness: "omp",
      ownerPid: process.pid,
      ownerToken: "sleeping-owner",
      leaseHeartbeatAt: new Date(Date.now() - 60_001).toISOString(),
      pendingWake: { C1: 100 },
    });

    await expect(
      claimOmpLease("omp-replacement", "S1", "replacement-owner", {
        dataFilePath: join(home, "comments.json"),
        ownerPid: process.pid,
      })
    ).resolves.toMatchObject({ kind: "acquired" });

    const fenced = await readMarker("omp-sleeping");
    expect(fenced).toMatchObject({ wakeCapable: false, pendingWake: { C1: 100 } });
    expect(fenced?.ownerToken).not.toBe("sleeping-owner");
    await expect(
      patchMarkerIfOwner("omp-sleeping", "sleeping-owner", (marker) => {
        marker.wakeCapable = true;
        marker.leaseHeartbeatAt = new Date().toISOString();
      })
    ).resolves.toEqual({ kind: "ownerMismatch" });
  });

  it("refuses a live foreign token already occupying the destination path", async () => {
    const { claimOmpLease } = await import("./marker.js");
    const first = await claimOmpLease("omp-same-path", "S-OLD", "old-token", {
      dataFilePath: join(home, "comments.json"),
      ownerPid: process.pid,
      transcriptPath: join(home, "old-session.jsonl"),
    });
    expect(first).toMatchObject({ kind: "acquired" });

    expect(
      await claimOmpLease("omp-same-path", "S-NEW", "foreign-token", {
        dataFilePath: join(home, "comments.json"),
        ownerPid: process.pid,
      })
    ).toMatchObject({
      kind: "conflict",
      ownerMarkerId: "omp-same-path",
      marker: { ownerToken: "old-token", remarcSessionId: "S-OLD" },
    });
  });

  it("atomically re-pairs the same token and publishes its transcript path", async () => {
    const { claimOmpLease, readMarker } = await import("./marker.js");
    await claimOmpLease("omp-repair", "S-OLD", "same-token", {
      dataFilePath: join(home, "comments.json"),
      ownerPid: process.pid,
      pendingWake: { queued: 99 },
    });
    const transcriptPath = join(home, "session.jsonl");
    expect(
      await claimOmpLease("omp-repair", "S-NEW", "same-token", {
        dataFilePath: join(home, "comments.json"),
        ownerPid: process.pid,
        transcriptPath,
      })
    ).toMatchObject({ kind: "acquired" });
    expect(await readMarker("omp-repair")).toMatchObject({
      remarcSessionId: "S-NEW",
      ownerToken: "same-token",
      transcriptPath,
      pendingWake: { queued: 99 },
    });
  });
});
