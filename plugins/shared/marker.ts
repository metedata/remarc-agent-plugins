import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  /** Shared lease protocol used by runtimes which can receive live messages. */
  protocolVersion?: number;
  /** Runtime which owns the live-delivery lease (currently `omp`). */
  harness?: string;
  /** Process which owns the lease. Signal 0 is used only as a liveness probe. */
  ownerPid?: number;
  /** Unforgeable compare-and-set key for lease updates and cleanup. */
  ownerToken?: string;
  /** ISO timestamp refreshed by a live runtime at least once per lease window. */
  leaseHeartbeatAt?: string;
  /** Durable outbox: comment id -> wakeRequestedAt generation (epoch millis). */
  pendingWake?: Record<string, number> | null;
  /** Forward-compatible fields must survive every read-modify-write. */
  [key: string]: unknown;
}

export type MarkerReadOutcome =
  | { kind: "missing" }
  | { kind: "valid"; marker: Marker; source: "json" | "legacy" }
  | { kind: "invalid"; reason: string }
  | { kind: "unsafe"; reason: string };

export interface MarkerLockOptions {
  /** Abort lock waiting, or prevent a write after an async mutator returns. */
  signal?: AbortSignal;
  /** Relative wait budget. Defaults to two seconds. */
  timeoutMs?: number;
  /** Absolute Unix epoch deadline. The earlier of this and timeoutMs wins. */
  deadlineMs?: number;
}

export type MarkerOwnerPatchOutcome =
  | { kind: "updated"; marker: Marker }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "unsafe"; reason: string }
  | { kind: "ownerMismatch" };

export type MarkerOwnerRemoveOutcome =
  | { kind: "removed" }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "unsafe"; reason: string }
  | { kind: "ownerMismatch" };

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

export function emptyMarker(): Marker {
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
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // Deliberately NOT requiring remarcSessionId. SessionStart can advertise
  // harness capability before a Remarc session is paired. Callers that require
  // an actual delivery address check the field themselves.
  const marker: Marker = {
    // Keep fields introduced by a newer runtime. Known fields below are
    // normalised independently so malformed legacy data cannot poison callers.
    ...r,
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
      r.wakedAt && typeof r.wakedAt === "object" && !Array.isArray(r.wakedAt)
        ? Object.fromEntries(
            Object.entries(r.wakedAt).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1])
            )
          )
        : Array.isArray(r.wakedIds)
          ? Object.fromEntries(
              (r.wakedIds as unknown[])
                .filter((x): x is string => typeof x === "string")
                .map((id) => [id, 0])
            )
          : {},
  };

  if (typeof r.protocolVersion !== "number" || !Number.isFinite(r.protocolVersion)) {
    delete marker.protocolVersion;
  }
  if (typeof r.harness !== "string") delete marker.harness;
  if (typeof r.ownerPid !== "number" || !Number.isFinite(r.ownerPid)) {
    delete marker.ownerPid;
  }
  if (typeof r.ownerToken !== "string") delete marker.ownerToken;
  if (typeof r.leaseHeartbeatAt !== "string") delete marker.leaseHeartbeatAt;
  if (r.pendingWake === null) {
    marker.pendingWake = null;
  } else if (typeof r.pendingWake === "object" && !Array.isArray(r.pendingWake)) {
    marker.pendingWake = Object.fromEntries(
      Object.entries(r.pendingWake).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1])
      )
    );
  } else {
    delete marker.pendingWake;
  }

  return marker;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function inspectRegularFile(path: string): Promise<"missing" | "regular" | "unsafe"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return "unsafe";
    return "regular";
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
    throw err;
  }
}

/**
 * Read without collapsing corruption and hostile filesystem objects into
 * "missing". Live-delivery runtimes need to fail closed instead of silently
 * taking ownership of an attacker-controlled or damaged marker path.
 */
export async function readMarkerOutcome(
  claudeSessionId: string
): Promise<MarkerReadOutcome> {
  const path = markerPath(claudeSessionId);
  let fileKind: "missing" | "regular" | "unsafe";
  try {
    fileKind = await inspectRegularFile(path);
  } catch (err) {
    return { kind: "invalid", reason: `Cannot inspect marker: ${errorReason(err)}` };
  }

  if (fileKind === "unsafe") {
    return { kind: "unsafe", reason: `Marker path is not a regular file: ${path}` };
  }
  if (fileKind === "regular") {
    try {
      const marker = coerce(JSON.parse(await readFile(path, "utf8")));
      return marker
        ? { kind: "valid", marker, source: "json" }
        : { kind: "invalid", reason: `Marker JSON is not an object: ${path}` };
    } catch (err) {
      return { kind: "invalid", reason: `Cannot parse marker: ${errorReason(err)}` };
    }
  }

  const legacy = legacyMarkerPath(claudeSessionId);
  let legacyKind: "missing" | "regular" | "unsafe";
  try {
    legacyKind = await inspectRegularFile(legacy);
  } catch (err) {
    return { kind: "invalid", reason: `Cannot inspect legacy marker: ${errorReason(err)}` };
  }
  if (legacyKind === "unsafe") {
    return {
      kind: "unsafe",
      reason: `Legacy marker path is not a regular file: ${legacy}`,
    };
  }
  if (legacyKind === "missing") return { kind: "missing" };

  try {
    const [remarcSessionId, dataFilePath] = (await readFile(legacy, "utf8")).split("\n");
    return remarcSessionId
      ? {
          kind: "valid",
          source: "legacy",
          marker: { ...emptyMarker(), remarcSessionId, dataFilePath: dataFilePath ?? "" },
        }
      : { kind: "invalid", reason: `Legacy marker has no session id: ${legacy}` };
  } catch (err) {
    return { kind: "invalid", reason: `Cannot read legacy marker: ${errorReason(err)}` };
  }
}

/**
 * Read a marker, falling back to the legacy two-line /tmp format when present.
 * The fallback is not eagerly rewritten; a later marker update writes the JSON
 * form. A corrupt or unreadable marker reads as null; callers treat that as
 * "no delivery history", which at worst re-delivers a comment once.
 */
export async function readMarker(claudeSessionId: string): Promise<Marker | null> {
  const outcome = await readMarkerOutcome(claudeSessionId);
  return outcome.kind === "valid" ? outcome.marker : null;
}

// ---------------------------------------------------------------------------
// Locked read-modify-write
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 20;
const LOCK_STALE_MS = 10_000;

class UnsafeMarkerPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeMarkerPathError";
  }
}

function markerAbortError(): Error {
  const error = new Error("Marker lock wait aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw markerAbortError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(markerAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** True when signal 0 proves the pid exists. EPERM also proves existence. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** 128 bits of OS randomness, represented as a stable filesystem-safe token. */
export function newOwnerToken(): string {
  return randomBytes(16).toString("hex");
}

interface HeldLock {
  path: string;
  token: string;
}

function lockDeadline(options: MarkerLockOptions): number {
  const now = Date.now();
  const timeout = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new RangeError("Marker lock timeoutMs must be a non-negative finite number");
  }
  const relative = now + timeout;
  if (options.deadlineMs == null) return relative;
  if (!Number.isFinite(options.deadlineMs)) {
    throw new RangeError("Marker lock deadlineMs must be a finite epoch timestamp");
  }
  return Math.min(relative, options.deadlineMs);
}

async function acquire(
  lockPath: string,
  options: MarkerLockOptions = {}
): Promise<HeldLock> {
  const deadline = lockDeadline(options);
  for (;;) {
    throwIfAborted(options.signal);
    const token = newOwnerToken();
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, token, at: Date.now() }),
          { encoding: "utf8", flag: "wx" }
        );
      } catch (err) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return { path: lockPath, token };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      try {
        const info = await lstat(lockPath);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new UnsafeMarkerPathError(
            `Marker lock path is not a real directory: ${lockPath}`
          );
        }

        // Reclaim a lock with a demonstrably dead owner immediately. A live
        // pid is authoritative regardless of lock age.
        let abandoned = false;
        const ownerPath = join(lockPath, "owner.json");
        try {
          const ownerInfo = await lstat(ownerPath);
          if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) {
            throw new UnsafeMarkerPathError(
              `Marker lock owner is not a regular file: ${ownerPath}`
            );
          }
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
            pid?: number;
          };
          abandoned =
            Number.isSafeInteger(owner.pid) &&
            (owner.pid as number) > 0 &&
            !isProcessAlive(owner.pid as number);
        } catch (err) {
          if (err instanceof UnsafeMarkerPathError) throw err;
          // An unattributable lock may be reclaimed only after a generous
          // grace period. This branch is never used for a known live owner.
          abandoned = Date.now() - info.mtimeMs > LOCK_STALE_MS;
        }
        if (abandoned) {
          try {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          } catch {
            // Fall through to bounded backoff on permission/race failures.
          }
        }
      } catch (err) {
        if (err instanceof UnsafeMarkerPathError) throw err;
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        // Unreadable lock metadata is contention, never proof of abandonment.
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for marker lock ${lockPath}`);
      }
      await sleep(Math.min(LOCK_POLL_MS, remaining), options.signal);
    }
  }
}

async function release(lock: HeldLock): Promise<void> {
  try {
    const info = await lstat(lock.path);
    if (info.isSymbolicLink() || !info.isDirectory()) return;
    const ownerPath = join(lock.path, "owner.json");
    const ownerInfo = await lstat(ownerPath);
    if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) return;
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
      token?: unknown;
    };
    // A delayed releaser must not delete a lock which has been reclaimed and
    // acquired by somebody else.
    if (owner.token === lock.token) {
      await rm(lock.path, { recursive: true, force: true });
    }
  } catch {
    // Best effort; a missing lock is already released.
  }
}

async function ensureMarkersDirectory(): Promise<void> {
  const dir = markersDir();
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafeMarkerPathError(`Markers path is not a real directory: ${dir}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    await mkdir(dir, { recursive: true });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafeMarkerPathError(`Markers path is not a real directory: ${dir}`);
    }
  }
}

function pairingLockPath(): string {
  return join(markersDir(), ".omp-pairing.lock");
}

function outcomeError(
  outcome: Extract<MarkerReadOutcome, { kind: "invalid" | "unsafe" }>
): Error {
  const error = new Error(outcome.reason);
  error.name = outcome.kind === "unsafe" ? "UnsafeMarkerPathError" : "InvalidMarkerError";
  return error;
}

async function atomicWrite(path: string, marker: Marker): Promise<void> {
  const kind = await inspectRegularFile(path);
  if (kind === "unsafe") {
    throw new UnsafeMarkerPathError(`Marker path is not a regular file: ${path}`);
  }
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(marker, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    const beforeRename = await inspectRegularFile(path);
    if (beforeRename === "unsafe") {
      throw new UnsafeMarkerPathError(`Marker path became unsafe: ${path}`);
    }
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
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
  mutate: (m: Marker) => void | Promise<void>,
  options: MarkerLockOptions = {}
): Promise<Marker> {
  const path = markerPath(claudeSessionId);
  await ensureMarkersDirectory();
  const lockPath = path + ".lock";
  const lock = await acquire(lockPath, options);
  try {
    const outcome = await readMarkerOutcome(claudeSessionId);
    if (outcome.kind === "invalid" || outcome.kind === "unsafe") {
      throw outcomeError(outcome);
    }
    const current = outcome.kind === "valid" ? outcome.marker : emptyMarker();
    await mutate(current);
    throwIfAborted(options.signal);
    await atomicWrite(path, current);
    return current;
  } finally {
    await release(lock);
  }
}

export async function writeMarker(
  claudeSessionId: string,
  m: Partial<Marker> & { remarcSessionId: string; dataFilePath: string },
  options: MarkerLockOptions = {}
): Promise<void> {
  await updateMarker(claudeSessionId, (cur) => {
    Object.assign(cur, m);
  }, options);
}

export async function touchMarker(claudeSessionId: string): Promise<void> {
  const outcome = await readMarkerOutcome(claudeSessionId);
  if (outcome.kind === "missing") return;
  if (outcome.kind === "invalid" || outcome.kind === "unsafe") {
    throw outcomeError(outcome);
  }
  await updateMarker(claudeSessionId, (m) => {
    m.lastActivity = new Date().toISOString();
  });
}

async function unlinkRegular(path: string): Promise<void> {
  const kind = await inspectRegularFile(path);
  if (kind === "missing") return;
  if (kind === "unsafe") {
    throw new UnsafeMarkerPathError(`Refusing to remove unsafe marker path: ${path}`);
  }
  await unlink(path);
}

export async function removeMarker(
  claudeSessionId: string,
  options: MarkerLockOptions = {}
): Promise<void> {
  await ensureMarkersDirectory();
  const path = markerPath(claudeSessionId);
  const lock = await acquire(path + ".lock", options);
  try {
    await unlinkRegular(path);
    await unlinkRegular(legacyMarkerPath(claudeSessionId));
  } finally {
    await release(lock);
  }
}

/** Patch only while the caller still owns the marker lease. */
export async function patchMarkerIfOwner(
  claudeSessionId: string,
  expectedOwnerToken: string,
  mutate: (m: Marker) => void | Promise<void>,
  options: MarkerLockOptions = {}
): Promise<MarkerOwnerPatchOutcome> {
  const path = markerPath(claudeSessionId);
  await ensureMarkersDirectory();
  const boundedOptions = { ...options, deadlineMs: lockDeadline(options) };
  const pairingLock = await acquire(pairingLockPath(), boundedOptions);
  try {
    const lock = await acquire(path + ".lock", boundedOptions);
    try {
      const outcome = await readMarkerOutcome(claudeSessionId);
      if (outcome.kind !== "valid") return outcome;
      if (!expectedOwnerToken || outcome.marker.ownerToken !== expectedOwnerToken) {
        return { kind: "ownerMismatch" };
      }
      await mutate(outcome.marker);
      throwIfAborted(options.signal);
      // Re-check happens while the marker lock is still held; no cooperative
      // writer can change the token between comparison and atomic publication.
      if (outcome.marker.ownerToken !== expectedOwnerToken) {
        return { kind: "ownerMismatch" };
      }
      await atomicWrite(path, outcome.marker);
      return { kind: "updated", marker: outcome.marker };
    } finally {
      await release(lock);
    }
  } finally {
    await release(pairingLock);
  }
}

/** Remove only while the caller still owns the marker lease. */
export async function removeMarkerIfOwner(
  claudeSessionId: string,
  expectedOwnerToken: string,
  options: MarkerLockOptions = {}
): Promise<MarkerOwnerRemoveOutcome> {
  const path = markerPath(claudeSessionId);
  await ensureMarkersDirectory();
  const boundedOptions = { ...options, deadlineMs: lockDeadline(options) };
  const pairingLock = await acquire(pairingLockPath(), boundedOptions);
  try {
    const lock = await acquire(path + ".lock", boundedOptions);
    try {
      const outcome = await readMarkerOutcome(claudeSessionId);
      if (outcome.kind !== "valid") return outcome;
      if (!expectedOwnerToken || outcome.marker.ownerToken !== expectedOwnerToken) {
        return { kind: "ownerMismatch" };
      }
      await unlinkRegular(path);
      return { kind: "removed" };
    } finally {
      await release(lock);
    }
  } finally {
    await release(pairingLock);
  }
}

/**
 * Exact app/runtime contract for advertising a wake-capable OMP session.
 * Heartbeats tolerate 30 seconds of forward clock skew and remain live for 60
 * seconds. Both endpoints are inclusive.
 */
export function isLiveOmpLease(
  marker: Marker,
  now: number = Date.now(),
  processAlive: (pid: number) => boolean = isProcessAlive
): boolean {
  if (marker.wakeCapable !== true) return false;
  if (marker.protocolVersion !== 1 || marker.harness !== "omp") return false;
  if (typeof marker.ownerToken !== "string" || marker.ownerToken.trim() === "") {
    return false;
  }
  if (!Number.isSafeInteger(marker.ownerPid) || (marker.ownerPid as number) <= 0) {
    return false;
  }
  if (typeof marker.leaseHeartbeatAt !== "string") return false;
  const heartbeat = Date.parse(marker.leaseHeartbeatAt);
  if (!Number.isFinite(heartbeat)) return false;
  const age = now - heartbeat;
  if (age < -30_000 || age > 60_000) return false;
  return processAlive(marker.ownerPid as number);
}

export interface ListedMarkerOutcome {
  markerId: string;
  outcome: MarkerReadOutcome;
}

/** List every JSON marker without following symlinks or hiding bad entries. */
export async function readAllMarkerOutcomes(): Promise<ListedMarkerOutcome[]> {
  const dir = markersDir();
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafeMarkerPathError(`Markers path is not a real directory: ${dir}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const out: ListedMarkerOutcome[] = [];
  for (const name of names) {
    const markerId = name.slice(0, -5);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(markerId)) {
      out.push({
        markerId,
        outcome: {
          kind: "unsafe",
          reason: `Unsafe marker filename in markers directory: ${name}`,
        },
      });
      continue;
    }
    out.push({ markerId, outcome: await readMarkerOutcome(markerId) });
  }
  return out;
}

export interface OmpLeaseClaimFields {
  dataFilePath: string;
  ownerPid: number;
  /** OMP session file, when the runtime exposes one. */
  transcriptPath?: string | null;
  /** Defaults to the claim time. */
  leaseHeartbeatAt?: string;
  /** Existing pending generations are retained when omitted. */
  pendingWake?: Record<string, number> | null;
  /** Forward-compatible fields to publish without replacing known invariants. */
  extra?: Record<string, unknown>;
}

export type OmpLeaseClaimOutcome =
  | { kind: "acquired"; marker: Marker }
  | { kind: "conflict"; ownerMarkerId: string; marker: Marker }
  | { kind: "invalid"; markerId: string; reason: string }
  | { kind: "unsafe"; markerId: string; reason: string };

function normaliseGenerationMap(
  value: Record<string, number> | null | undefined
): Record<string, number> | null | undefined {
  if (value == null) return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

/**
 * Atomically claim the one OMP lease for a Remarc session.
 *
 * The directory-scoped pairing lock serialises scan + publication across
 * different marker files. Heartbeats and token-CAS cleanup take the same lock,
 * so a lease cannot become live between the conflict scan and publication.
 */
export async function claimOmpLease(
  markerId: string,
  remarcSessionId: string,
  ownerToken: string,
  fields: OmpLeaseClaimFields,
  options: MarkerLockOptions = {}
): Promise<OmpLeaseClaimOutcome> {
  safeSessionId(markerId);
  if (!remarcSessionId) throw new TypeError("OMP lease requires a Remarc session id");
  if (!ownerToken.trim()) throw new TypeError("OMP lease requires a non-empty owner token");
  if (!Number.isSafeInteger(fields.ownerPid) || fields.ownerPid <= 0) {
    throw new TypeError("OMP lease requires a positive integral owner pid");
  }
  if (typeof fields.dataFilePath !== "string") {
    throw new TypeError("OMP lease requires a data file path");
  }
  const heartbeat = fields.leaseHeartbeatAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(heartbeat))) {
    throw new TypeError("OMP lease heartbeat must be a valid timestamp");
  }

  await ensureMarkersDirectory();
  const deadlineMs = lockDeadline(options);
  const boundedOptions = { ...options, deadlineMs };
  const pairingLock = await acquire(pairingLockPath(), boundedOptions);
  try {
    const targetSession = remarcSessionId.toUpperCase();
    const staleSameSessionMarkerIds: string[] = [];
    for (const entry of await readAllMarkerOutcomes()) {
      if (!entry.markerId.startsWith("omp-")) continue;
      if (entry.outcome.kind === "invalid" || entry.outcome.kind === "unsafe") {
        // An unreadable OMP marker may conceal a competing owner. Fail closed.
        return { ...entry.outcome, markerId: entry.markerId };
      }
      if (entry.outcome.kind !== "valid") continue;
      const marker = entry.outcome.marker;
      if (
        entry.markerId === markerId &&
        marker.ownerToken !== ownerToken &&
        isLiveOmpLease(marker)
      ) {
        return {
          kind: "conflict",
          ownerMarkerId: markerId,
          marker,
        };
      }
      if (marker.remarcSessionId.toUpperCase() !== targetSession) continue;
      if (
        entry.markerId === markerId &&
        marker.ownerToken === ownerToken
      ) {
        continue; // same owner refreshing/recovering its own marker
      }
      if (isLiveOmpLease(marker)) {
        return {
          kind: "conflict",
          ownerMarkerId: entry.markerId,
          marker,
        };
      }
      if (entry.markerId !== markerId) {
        staleSameSessionMarkerIds.push(entry.markerId);
      }
    }

    // A stale heartbeat is a takeover boundary, not permission for the old
    // process to revive later. Fence every stale same-session marker before
    // publishing the replacement lease. Otherwise its still-running timer can
    // resume after this claim, pass token CAS on its own marker, and create two
    // simultaneously live owners for one Remarc session.
    for (const staleMarkerId of staleSameSessionMarkerIds) {
      const stalePath = markerPath(staleMarkerId);
      const staleLock = await acquire(stalePath + ".lock", boundedOptions);
      try {
        const staleOutcome = await readMarkerOutcome(staleMarkerId);
        if (staleOutcome.kind === "invalid" || staleOutcome.kind === "unsafe") {
          return { ...staleOutcome, markerId: staleMarkerId };
        }
        if (staleOutcome.kind !== "valid") continue;
        const staleMarker = staleOutcome.marker;
        if (staleMarker.remarcSessionId.toUpperCase() !== targetSession) continue;
        if (isLiveOmpLease(staleMarker)) {
          return {
            kind: "conflict",
            ownerMarkerId: staleMarkerId,
            marker: staleMarker,
          };
        }

        staleMarker.wakeCapable = false;
        staleMarker.ownerToken = newOwnerToken();
        throwIfAborted(options.signal);
        await atomicWrite(stalePath, staleMarker);
      } finally {
        await release(staleLock);
      }
    }

    const path = markerPath(markerId);
    const markerLock = await acquire(path + ".lock", boundedOptions);
    try {
      const currentOutcome = await readMarkerOutcome(markerId);
      if (currentOutcome.kind === "invalid" || currentOutcome.kind === "unsafe") {
        return { ...currentOutcome, markerId };
      }
      if (
        currentOutcome.kind === "valid" &&
        currentOutcome.marker.ownerToken !== ownerToken &&
        isLiveOmpLease(currentOutcome.marker)
      ) {
        // The destination marker itself may have been paired to a different
        // Remarc session and therefore omitted by the session-scoped scan.
        // Its live foreign token is still authoritative for this path.
        return {
          kind: "conflict",
          ownerMarkerId: markerId,
          marker: currentOutcome.marker,
        };
      }
      const marker =
        currentOutcome.kind === "valid" ? currentOutcome.marker : emptyMarker();
      const extra = fields.extra ?? {};
      const existingPendingWake = marker.pendingWake;
      Object.assign(marker, extra, {
        remarcSessionId,
        dataFilePath: fields.dataFilePath,
        transcriptPath: fields.transcriptPath ?? null,
        wakeCapable: true,
        lastActivity: heartbeat,
        protocolVersion: 1,
        harness: "omp",
        ownerPid: fields.ownerPid,
        ownerToken,
        leaseHeartbeatAt: heartbeat,
      });
      // Known lease invariants above cannot be overridden by `extra`.
      if (fields.pendingWake !== undefined) {
        marker.pendingWake = normaliseGenerationMap(fields.pendingWake);
      } else {
        marker.pendingWake = existingPendingWake;
      }
      throwIfAborted(options.signal);
      await atomicWrite(path, marker);
      return { kind: "acquired", marker };
    } finally {
      await release(markerLock);
    }
  } finally {
    await release(pairingLock);
  }
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
  const out: Array<{ claudeSessionId: string; marker: Marker }> = [];
  for (const { markerId, outcome } of await readAllMarkerOutcomes()) {
    if (outcome.kind === "valid") {
      out.push({ claudeSessionId: markerId, marker: outcome.marker });
    }
  }
  return out;
}
