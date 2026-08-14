import { readFile, writeFile, rename, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Per-Claude-session marker.
 *
 * Delivery state is a set of comment ids, not a timestamp cursor: sets are
 * immune to clock skew, delayed commits, and snapshot boundaries, all of which
 * produced permanently-skipped comments in earlier designs.
 *
 * Ids are pruned by liveness (see `pruneIds`) rather than capped at a fixed
 * size - a fixed cap evicts still-eligible ids, which makes them look
 * undelivered and re-wakes them forever.
 */
export interface Marker {
  remarcSessionId: string;
  dataFilePath: string;
  /** Transcript file for this Claude session, used for liveness checks. */
  transcriptPath: string | null;
  /**
   * Whether THIS session can actually be woken. False under harnesses without
   * file-watch + rewake hooks (Codex), which is how the app knows whether to
   * offer the wake button: plugin-install state cannot tell it which harness
   * the user is actually working in right now.
   */
  wakeCapable: boolean;
  /** Last time this session showed activity; ranks wake preference. */
  lastActivity: string | null;
  /** Comment ids already injected as context for this session. */
  deliveredIds: string[];
  /**
   * Comment id -> the `wakeRequestedAt` value we woke for, as epoch millis.
   * A plain id set would ignore a second press of the wake button on the same
   * comment, because the id is already present.
   */
  wakedAt: Record<string, number>;
}

function markersDir(): string {
  return join(homedir(), "Library", "Application Support", "Remarc", "claude", "markers");
}

/**
 * Session ids arrive from hook payloads and from an MCP tool argument, so they
 * are caller-controlled. Anything but the id charset would let
 * `../../../evil` escape the markers directory and let writeMarker/removeMarker
 * clobber or delete arbitrary files.
 */
function safeSessionId(claudeSessionId: string): string {
  const cleaned = claudeSessionId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleaned) throw new Error("Invalid Claude session id");
  return cleaned.slice(0, 128);
}

export function markerPath(claudeSessionId: string): string {
  return join(markersDir(), `${safeSessionId(claudeSessionId)}.json`);
}

/** Legacy /tmp text marker written by builds before the JSON format. */
export function legacyMarkerPath(claudeSessionId: string): string {
  return `/tmp/remarc-claude-${safeSessionId(claudeSessionId)}.marker`;
}

function emptyMarker(): Marker {
  return {
    remarcSessionId: "",
    dataFilePath: "",
    transcriptPath: null,
    lastActivity: null,
    wakeCapable: false,
    deliveredIds: [],
    wakedAt: {},
  };
}

function coerce(raw: unknown): Marker | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Deliberately NOT requiring remarcSessionId. SessionStart can advertise
  // harness capability before a Remarc session is paired. Callers that require
  // an actual delivery address check the field themselves.
  return {
    remarcSessionId: typeof r.remarcSessionId === "string" ? r.remarcSessionId : "",
    dataFilePath: typeof r.dataFilePath === "string" ? r.dataFilePath : "",
    transcriptPath: typeof r.transcriptPath === "string" ? r.transcriptPath : null,
    lastActivity: typeof r.lastActivity === "string" ? r.lastActivity : null,
    wakeCapable: r.wakeCapable === true,
    deliveredIds: Array.isArray(r.deliveredIds)
      ? r.deliveredIds.filter((x): x is string => typeof x === "string")
      : [],
    // Migrate the earlier id-array shape: treat prior wakes as generation 0.
    wakedAt:
      r.wakedAt && typeof r.wakedAt === "object"
        ? (r.wakedAt as Record<string, number>)
        : Array.isArray(r.wakedIds)
          ? Object.fromEntries(
              (r.wakedIds as unknown[])
                .filter((x): x is string => typeof x === "string")
                .map((id) => [id, 0])
            )
          : {},
  };
}

/**
 * Read a marker, falling back to the legacy two-line /tmp format when present.
 * The fallback is not eagerly rewritten; a later marker update writes the JSON
 * form. A corrupt or unreadable marker reads as null; callers treat that as
 * "no delivery history", which at worst re-delivers a comment once.
 */
export async function readMarker(claudeSessionId: string): Promise<Marker | null> {
  const path = markerPath(claudeSessionId);
  if (existsSync(path)) {
    try {
      return coerce(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return null;
    }
  }
  const legacy = legacyMarkerPath(claudeSessionId);
  if (existsSync(legacy)) {
    try {
      const [remarcSessionId, dataFilePath] = (await readFile(legacy, "utf8")).split("\n");
      if (!remarcSessionId) return null;
      return { ...emptyMarker(), remarcSessionId, dataFilePath: dataFilePath ?? "" };
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locked read-modify-write
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 20;
const LOCK_STALE_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function acquire(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, at: Date.now() }),
        "utf8"
      ).catch(() => {});
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockPath);
        // Same rule as the document lock: a live owner keeps its lock no
        // matter how long it has held it.
        let abandoned = false;
        try {
          const owner = JSON.parse(
            await readFile(join(lockPath, "owner.json"), "utf8")
          ) as { pid?: number };
          abandoned = typeof owner.pid === "number" && !pidAlive(owner.pid);
        } catch {
          abandoned = Date.now() - info.mtimeMs > LOCK_STALE_MS;
        }
        if (abandoned) {
          try {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          } catch {
            /* fall through to backoff */
          }
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for marker lock ${lockPath}`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

/**
 * Update a marker under a lock.
 *
 * "One writer per session" is not true by construction: two FileChanged hooks,
 * or a FileChanged overlapping UserPromptSubmit, run as separate processes in
 * the same Claude session. Without this, one firing's id-set update silently
 * overwrites the other's and the same comment wakes twice.
 */
export async function updateMarker(
  claudeSessionId: string,
  mutate: (m: Marker) => void
): Promise<Marker> {
  const path = markerPath(claudeSessionId);
  const dir = markersDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  const lockPath = path + ".lock";
  await acquire(lockPath);
  try {
    const current = (await readMarker(claudeSessionId)) ?? emptyMarker();
    mutate(current);
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(current, null, 2), "utf8");
    await rename(tmp, path);
    return current;
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeMarker(claudeSessionId: string, m: Partial<Marker> & { remarcSessionId: string; dataFilePath: string }): Promise<void> {
  await updateMarker(claudeSessionId, (cur) => {
    Object.assign(cur, m);
  });
}

export async function touchMarker(claudeSessionId: string): Promise<void> {
  if (!existsSync(markerPath(claudeSessionId))) return;
  await updateMarker(claudeSessionId, (m) => {
    m.lastActivity = new Date().toISOString();
  });
}

export async function removeMarker(claudeSessionId: string): Promise<void> {
  await rm(markerPath(claudeSessionId), { force: true }).catch(() => {});
  await rm(legacyMarkerPath(claudeSessionId), { force: true }).catch(() => {});
}

/**
 * Drop ids whose comments are gone or finished, so the sets stay bounded by
 * the number of live comments instead of by an arbitrary cap.
 */
export function pruneIds(ids: string[], liveIds: Set<string>): string[] {
  return ids.filter((id) => liveIds.has(id));
}

/** Same pruning for the wake generation map. */
export function pruneWakes(
  wakes: Record<string, number>,
  liveIds: Set<string>
): Record<string, number> {
  return Object.fromEntries(Object.entries(wakes).filter(([id]) => liveIds.has(id)));
}

/** A session gone this long is not coming back, transcript or not. */
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long a marker may name a transcript that is not on disk yet. Claude Code
 * reports the path at SessionStart, before the file necessarily exists, so a
 * young marker naming a missing transcript is a session still waking up.
 */
const TRANSCRIPT_GRACE_MS = 5 * 60 * 1000;

/**
 * Delete markers for sessions that ended without a SessionEnd hook.
 *
 * The directory is otherwise append-only in practice, and one writer never
 * cleans up after itself: `claude plugin list --json` - which the Remarc app
 * runs at launch and from Preferences to detect the plugin - starts a session,
 * gets a marker naming a transcript it exits too fast to create, and never
 * fires SessionEnd. One user accumulated 13 of these in a few minutes.
 *
 * Two ways to be dead, both needed: a named transcript that does not exist
 * (past the grace window) catches those instantly, and sheer age catches real
 * sessions killed hard enough to skip SessionEnd, whose transcripts do exist.
 *
 * `keepSessionId` is never pruned - the caller is usually mid-write on it.
 */
export async function pruneDeadMarkers(
  keepSessionId?: string,
  now: number = Date.now()
): Promise<string[]> {
  const removed: string[] = [];
  for (const { claudeSessionId, marker } of await readAllMarkers()) {
    if (keepSessionId && claudeSessionId === keepSessionId) continue;

    const stamped = marker.lastActivity ? Date.parse(marker.lastActivity) : NaN;
    // No usable timestamp means nothing can vouch for it; treat as ancient
    // rather than immortal.
    const age = Number.isNaN(stamped) ? Infinity : now - stamped;
    if (age < 0) continue; // clock skew: a future stamp is not evidence of death

    const transcriptGone =
      typeof marker.transcriptPath === "string" &&
      marker.transcriptPath !== "" &&
      !existsSync(marker.transcriptPath);

    if (age > MARKER_MAX_AGE_MS || (transcriptGone && age > TRANSCRIPT_GRACE_MS)) {
      await removeMarker(claudeSessionId);
      removed.push(claudeSessionId);
    }
  }
  return removed;
}

/** All markers on disk, for wake ranking. */
export async function readAllMarkers(): Promise<Array<{ claudeSessionId: string; marker: Marker }>> {
  const dir = markersDir();
  if (!existsSync(dir)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const out: Array<{ claudeSessionId: string; marker: Marker }> = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const m = await readMarker(id);
    if (m) out.push({ claudeSessionId: id, marker: m });
  }
  return out;
}
