import { readFile, writeFile, rename, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Apple Epoch Conversion
// ---------------------------------------------------------------------------

/**
 * Offset between Unix epoch (1970-01-01) and Apple/Core Data epoch (2001-01-01)
 * in seconds.
 */
const APPLE_EPOCH_OFFSET = 978307200;

/** Convert an Apple-epoch timestamp (seconds since 2001-01-01 UTC) to a JS Date. */
export function appleToDate(timestamp: number): Date {
  return new Date((timestamp + APPLE_EPOCH_OFFSET) * 1000);
}

/** Convert a JS Date to an Apple-epoch timestamp. */
export function dateToApple(date: Date): number {
  return date.getTime() / 1000 - APPLE_EPOCH_OFFSET;
}

/** Format a Date as a human-readable UTC string (e.g. "2026-02-27 14:30 UTC"). */
export function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min} UTC`;
}

// ---------------------------------------------------------------------------
// Types — mirrors the Swift Codable structs
// ---------------------------------------------------------------------------

export type CommentStatus = "open" | "handedOff" | "inProgress" | "resolved";

export type CommentType =
  | { comment: { text: string } }
  | { screenshot: { imagePath: string } }
  | { quickNote: Record<string, never> }
  | { critMode: Record<string, never> }
  | { webElement: { componentName?: string | null; filePath?: string | null } };

/**
 * Web context attached to a comment. Mirrors the Swift WebContext struct.
 *
 * Pre-flattened strings on the wire (Agentation-style). The TS server doesn't
 * model every nested field — anything we don't list is passed through verbatim
 * on round-trip so future additions on the Swift side survive status updates.
 * Legacy structured shapes (e.g., computedStyles as Record, accessibility as
 * object) are also accepted on input and flattened at format time.
 */
export interface WebContext {
  componentName?: string | null;
  filePath?: string | null;
  reactComponents?: string | null;
  elementName?: string | null;
  elementPath?: string | null;
  selectedText?: string | null;
  cssClasses?: string | null;
  selector?: string | null;
  computedStyles?: string | Record<string, string> | null;
  accessibility?: string | LegacyAccessibility | null;
  nearbyText?: string | LegacyNearbyText | null;
  nearbyElements?: string | LegacyNearbyElement[] | null;
  boundingBox?: {
    x?: number | null;
    y?: number | null;
    width?: number | null;
    height?: number | null;
  } | null;
  pageUrl?: string | null;
  /**
   * Optional HyperFrames composition context (beat, active tweens, source-line
   * ranges) for comments captured on HF compositions. Populated by the
   * composition's `window.__remarcHFContext` bridge via the Chrome extension.
   * Debug-only on the Swift side; release builds drop this field on save.
   */
  hyperframesContext?: string | null;
  // Forward-compatibility: any unknown fields written by Swift survive round-trip.
  [k: string]: unknown;
}

interface LegacyAccessibility {
  role?: string | null;
  ariaLabel?: string | null;
  ariaDescribedby?: string | null;
  ariaHidden?: string | null;
  tabIndex?: number | null;
  focusable?: boolean | null;
}

interface LegacyNearbyText {
  element?: string | null;
  before?: string | null;
  after?: string | null;
}

interface LegacyNearbyElement {
  tag?: string | null;
  classes?: string | null;
  id?: string | null;
  textSnippet?: string | null;
}

export interface RawComment {
  id: string;
  type?: CommentType;
  selectedText?: string; // legacy field
  commentText: string;
  source: string;
  appBundleID?: string | null;
  createdAt: number; // Apple epoch
  updatedAt: number; // Apple epoch
  sessionID?: string;
  stackID?: string; // legacy field
  isDeleted: boolean;
  deletedAt?: number | null;
  status?: CommentStatus;
  resolutionSummary?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
  attachments?: string[];
  webContext?: WebContext | null;
  regionElements?: WebContext[] | null;
  wakeRequestedAt?: number | null;
  [k: string]: unknown;
}

export interface Comment {
  id: string;
  shortID: string;
  type: CommentType;
  commentText: string;
  source: string;
  appBundleID: string | null;
  createdAt: Date;
  updatedAt: Date;
  sessionID: string;
  isDeleted: boolean;
  deletedAt: Date | null;
  status: CommentStatus;
  resolutionSummary: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  attachments: string[];
  webContext: WebContext | null;
  regionElements: WebContext[] | null;
  /**
   * Wake request timestamp (Apple epoch on the wire). Written only by the app
   * when the user presses "Send instantly & save". Read by the hooks plugin to
   * decide whether a comment should wake an idle Claude Code session.
   */
  wakeRequestedAt: Date | null;
  /**
   * Every key present on disk that this build does not model, preserved so a
   * write from an older plugin cannot delete fields a newer app wrote.
   */
  unknownFields: Record<string, unknown>;
}

export interface RawSession {
  id: string;
  name: string;
  createdAt: number;
  isDeleted: boolean;
  deletedAt?: number | null;
  isAutoDismissed: boolean;
  autoDismissedAt?: number | null;
  origin?: string;
  claudeCodeSessionId?: string | null;
  [k: string]: unknown;
}

export interface Session {
  id: string;
  name: string;
  createdAt: Date;
  isDeleted: boolean;
  deletedAt: Date | null;
  isAutoDismissed: boolean;
  autoDismissedAt: Date | null;
  origin: string;
  claudeCodeSessionId: string | null;
  /** Unmodeled keys present on disk, preserved on round-trip. */
  unknownFields: Record<string, unknown>;
}

export interface RawAppState {
  sessions?: RawSession[];
  stacks?: RawSession[]; // legacy
  comments: RawComment[];
  activeSessionID?: string | null;
  activeStackID?: string | null; // legacy
  totalCommentsCreated: number;
  [k: string]: unknown;
}

export interface AppState {
  sessions: Session[];
  comments: Comment[];
  activeSessionID: string | null;
  totalCommentsCreated: number;
  /**
   * Top-level keys this build does not model - notably `orphanedImages` and
   * `transcriptions`, which the Swift app persists. Preserved on round-trip;
   * before this existed, any plugin write silently deleted them.
   */
  unknownFields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Data File Path
// ---------------------------------------------------------------------------

function getDataDir(): string {
  return join(homedir(), "Library", "Application Support", "Remarc");
}

/** Returns the path to the comments file, preferring comments.json over data.json. */
export function getDataFilePath(): string {
  const dir = getDataDir();
  const newPath = join(dir, "comments.json");
  const oldPath = join(dir, "data.json");

  if (existsSync(newPath)) return newPath;
  if (existsSync(oldPath)) return oldPath;
  // Default to new path even if it doesn't exist yet
  return newPath;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseType(raw: RawComment): CommentType {
  if (raw.type) return raw.type;
  return { quickNote: {} };
}

/** Keys this build models on a comment; everything else is preserved verbatim. */
const KNOWN_COMMENT_KEYS = new Set([
  "id", "type", "selectedText", "commentText", "source", "appBundleID",
  "createdAt", "updatedAt", "sessionID", "stackID", "isDeleted", "deletedAt",
  "status", "resolutionSummary", "resolvedBy", "resolvedAt", "attachments",
  "webContext", "regionElements", "wakeRequestedAt",
]);

const KNOWN_SESSION_KEYS = new Set([
  "id", "name", "createdAt", "isDeleted", "deletedAt", "isAutoDismissed",
  "autoDismissedAt", "origin", "claudeCodeSessionId",
]);

const KNOWN_STATE_KEYS = new Set([
  "sessions", "stacks", "comments", "activeSessionID", "activeStackID",
  "totalCommentsCreated",
]);

/** Collect every key of `raw` that is not in `known`. */
function collectUnknown(
  raw: Record<string, unknown>,
  known: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) out[k] = v;
  }
  return out;
}

function parseComment(raw: RawComment): Comment {
  return {
    id: raw.id,
    shortID: raw.id.substring(0, 5).toLowerCase(),
    type: parseType(raw),
    commentText: raw.commentText,
    source: raw.source,
    appBundleID: raw.appBundleID ?? null,
    createdAt: appleToDate(raw.createdAt),
    updatedAt: appleToDate(raw.updatedAt),
    sessionID: raw.sessionID ?? raw.stackID ?? "",
    isDeleted: raw.isDeleted,
    deletedAt: raw.deletedAt != null ? appleToDate(raw.deletedAt) : null,
    status: raw.status ?? "open",
    resolutionSummary: raw.resolutionSummary ?? null,
    resolvedBy: raw.resolvedBy ?? null,
    resolvedAt: raw.resolvedAt != null ? appleToDate(raw.resolvedAt) : null,
    attachments: raw.attachments ?? [],
    webContext: raw.webContext ?? null,
    regionElements: raw.regionElements ?? null,
    wakeRequestedAt:
      raw.wakeRequestedAt != null ? appleToDate(raw.wakeRequestedAt) : null,
    unknownFields: collectUnknown(raw, KNOWN_COMMENT_KEYS),
  };
}

function parseSession(raw: RawSession): Session {
  return {
    id: raw.id,
    name: raw.name,
    createdAt: appleToDate(raw.createdAt),
    isDeleted: raw.isDeleted,
    deletedAt: raw.deletedAt != null ? appleToDate(raw.deletedAt) : null,
    isAutoDismissed: raw.isAutoDismissed,
    autoDismissedAt:
      raw.autoDismissedAt != null ? appleToDate(raw.autoDismissedAt) : null,
    origin: raw.origin ?? "manual",
    claudeCodeSessionId: raw.claudeCodeSessionId ?? null,
    unknownFields: collectUnknown(raw, KNOWN_SESSION_KEYS),
  };
}

export function parseAppState(raw: RawAppState): AppState {
  const rawSessions = raw.sessions ?? raw.stacks ?? [];
  return {
    sessions: rawSessions.map(parseSession),
    comments: raw.comments.map(parseComment),
    activeSessionID: raw.activeSessionID ?? raw.activeStackID ?? null,
    totalCommentsCreated: raw.totalCommentsCreated,
    unknownFields: collectUnknown(raw, KNOWN_STATE_KEYS),
  };
}

// ---------------------------------------------------------------------------
// Serialization helpers (back to raw JSON)
// ---------------------------------------------------------------------------

function serializeComment(c: Comment): RawComment {
  const raw: RawComment = {
    ...c.unknownFields,
    id: c.id,
    type: c.type,
    commentText: c.commentText,
    source: c.source,
    appBundleID: c.appBundleID,
    createdAt: dateToApple(c.createdAt),
    updatedAt: dateToApple(c.updatedAt),
    sessionID: c.sessionID,
    isDeleted: c.isDeleted,
    deletedAt: c.deletedAt != null ? dateToApple(c.deletedAt) : null,
    status: c.status,
    resolutionSummary: c.resolutionSummary,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt != null ? dateToApple(c.resolvedAt) : null,
  };
  raw.attachments = c.attachments;
  if (c.webContext != null) raw.webContext = c.webContext;
  if (c.regionElements != null) raw.regionElements = c.regionElements;
  if (c.wakeRequestedAt != null) {
    raw.wakeRequestedAt = dateToApple(c.wakeRequestedAt);
  }
  return raw;
}

function serializeSession(s: Session): RawSession {
  return {
    ...s.unknownFields,
    id: s.id,
    name: s.name,
    createdAt: dateToApple(s.createdAt),
    isDeleted: s.isDeleted,
    deletedAt: s.deletedAt != null ? dateToApple(s.deletedAt) : null,
    isAutoDismissed: s.isAutoDismissed,
    autoDismissedAt:
      s.autoDismissedAt != null ? dateToApple(s.autoDismissedAt) : null,
    origin: s.origin,
    claudeCodeSessionId: s.claudeCodeSessionId,
  };
}

export function serializeAppState(state: AppState): object {
  return {
    ...state.unknownFields,
    sessions: state.sessions.map(serializeSession),
    comments: state.comments.map(serializeComment),
    activeSessionID: state.activeSessionID,
    totalCommentsCreated: state.totalCommentsCreated,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read and parse the Remarc data file. Returns null if file doesn't exist. */
export async function readAppState(): Promise<AppState | null> {
  const filePath = getDataFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: RawAppState = JSON.parse(raw);
    return parseAppState(parsed);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Write the app state atomically (unique .tmp, then rename).
 *
 * Prefer `withDocument` for mutations: state read outside the lock can be
 * stale, and writing it clobbers whatever another process committed meanwhile.
 * This stays exported because `withDocument` calls it and some callers legitimately
 * replace the whole document.
 */
export async function writeAppState(state: AppState): Promise<void> {
  const filePath = getDataFilePath();
  const dir = dirname(filePath);

  // Ensure the directory exists
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Unique temp name: a fixed one lets concurrent writers interleave through
  // the same path and lose or tear a write.
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const json = JSON.stringify(serializeAppState(state), null, 2);
  await writeFile(tmpPath, json, "utf-8");
  await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Cross-process document transaction
// ---------------------------------------------------------------------------

/**
 * Lock directory beside the data file. `mkdir` is atomic on POSIX and behaves
 * the same from Swift (`createDirectory` with `withIntermediateDirectories:
 * false` throws when it exists), so the app, MCP server, and hooks share one
 * protocol without needing a native flock binding in Node.
 */
function getLockPath(): string {
  return getDataFilePath() + ".lock";
}

const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 25;
/** A lock this old with a dead owner is treated as abandoned. */
const LOCK_STALE_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a process with this pid exists (signal 0 delivers nothing). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM: the process exists but is owned by someone else.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function acquireLock(): Promise<string> {
  const lockPath = getLockPath();
  const dir = dirname(lockPath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath); // atomic; exactly one caller succeeds
      try {
        await writeFile(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, at: Date.now() }),
          "utf-8"
        );
      } catch (err) {
        // Do not leave an ownerless directory behind - it would look like a
        // held lock that nobody can attribute.
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return lockPath;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;

      // Someone holds it. Reclaim only if that someone is demonstrably gone -
      // age alone must never evict a live holder, or both processes end up
      // "holding" the lock and the loser's release deletes the winner's.
      try {
        const info = await stat(lockPath);
        let abandoned = false;
        try {
          const owner = JSON.parse(
            await readFile(join(lockPath, "owner.json"), "utf-8")
          ) as { pid?: number };
          abandoned = typeof owner.pid === "number" && !pidAlive(owner.pid);
        } catch {
          // No readable owner yet: only a generous age check may decide.
          abandoned = Date.now() - info.mtimeMs > LOCK_STALE_MS;
        }
        if (abandoned) {
          try {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          } catch {
            // Removal failed (permissions). Fall through to the backoff below
            // instead of spinning without delay.
          }
        }
      } catch {
        // Lock disappeared between EEXIST and stat; retry immediately.
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the Remarc data lock (${lockPath})`
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

/** Return this from a `withDocument` mutator to finish without writing. */
export const SKIP_WRITE = Symbol("remarc.skipWrite");

/**
 * Run a mutation as a transaction: acquire the lock, read the document fresh
 * from disk, apply `mutate` in place, write, rename, release.
 *
 * The lock spans read-through-rename. Locking only the write still loses
 * updates, because the snapshot being written may predate another process's
 * commit. Every mutating caller must go through this instead of pairing
 * `readAppState` with `writeAppState`.
 */
export async function withDocument<T>(
  mutate: (state: AppState) => T | Promise<T>
): Promise<T> {
  const lockPath = await acquireLock();
  try {
    const state = (await readAppState()) ?? {
      sessions: [],
      comments: [],
      activeSessionID: null,
      totalCommentsCreated: 0,
      unknownFields: {},
    };
    const result = await mutate(state);
    if ((result as unknown) !== SKIP_WRITE) {
      await writeAppState(state);
    }
    return result;
  } finally {
    await releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Status update helper
// ---------------------------------------------------------------------------

/** Apply a status change to a comment, including resolution metadata. */
export function applyStatusUpdate(
  comment: Comment,
  status: CommentStatus,
  summary: string | undefined | null,
  now: Date
): void {
  comment.status = status;
  comment.updatedAt = now;

  if (status === "resolved") {
    comment.resolutionSummary = summary!;
    comment.resolvedBy = "claude";
    comment.resolvedAt = now;
  } else {
    comment.resolutionSummary = null;
    comment.resolvedBy = null;
    comment.resolvedAt = null;
  }
}

// ---------------------------------------------------------------------------
// Type display helpers
// ---------------------------------------------------------------------------

export type CommentTypeId =
  | "comment"
  | "screenshot"
  | "critMode"
  | "webElement"
  | "quickNote";

/** Get a string identifier for the comment type discriminant. */
export function typeIdentifier(t: CommentType): CommentTypeId {
  if ("comment" in t) return "comment";
  if ("screenshot" in t) return "screenshot";
  if ("critMode" in t) return "critMode";
  if ("webElement" in t) return "webElement";
  return "quickNote";
}

/**
 * Get a human-readable label for a comment type.
 *
 * For webElement, optionally pass the comment's webContext so we can fall back
 * to elementName (text-content based) when componentName is missing or
 * minified - the "smart identification" pattern from Agentation.
 */
export function typeLabel(
  t: CommentType,
  webContext?: WebContext | null
): string {
  if ("comment" in t) {
    const text = t.comment.text;
    const cleaned = text.replace(/\n/g, " ").trim();
    if (cleaned.length > 80) return `"${cleaned.slice(0, 80)}..."`;
    return `"${cleaned}"`;
  }
  if ("screenshot" in t) {
    return `Screenshot: ${t.screenshot.imagePath}`;
  }
  if ("critMode" in t) {
    return "Crit Mode";
  }
  if ("webElement" in t) {
    const label = smartLabel(t.webElement.componentName, webContext?.elementName);
    const parts = [label, t.webElement.filePath].filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    return parts.length > 0 ? parts.join(" · ") : "Web Element";
  }
  return "Quick Note";
}

/** True if the name looks like a real React component (PascalCase, 3+ chars). */
export function isMeaningfulComponentName(name: string | null | undefined): boolean {
  if (!name || name.length < 3) return false;
  const first = name[0];
  return first >= "A" && first <= "Z";
}

/**
 * Smart identifier picker: matches Agentation's behavior of preferring the
 * DOM-derived elementName (text-content based) as the primary label. Falls
 * back to componentName only when there's no elementName.
 */
export function smartLabel(
  componentName: string | null | undefined,
  elementName: string | null | undefined
): string | null {
  if (elementName && elementName.length > 0) return elementName;
  if (componentName && isMeaningfulComponentName(componentName)) return componentName;
  return null;
}

// ---------------------------------------------------------------------------
// Web context formatting
// ---------------------------------------------------------------------------

/** One-line summary suitable for list-view previews. */
export function webContextPreview(wc: WebContext | null | undefined): string | null {
  if (!wc) return null;
  const primary = smartLabel(
    typeof wc.componentName === "string" ? wc.componentName : null,
    typeof wc.elementName === "string" ? wc.elementName : null,
  );
  const secondary = pickFirstString(wc.filePath, wc.pageUrl);
  const parts = [primary, secondary].filter((s): s is string => !!s);
  if (parts.length === 0) {
    const selector = pickFirstString(wc.selector, wc.elementPath);
    return selector ?? null;
  }
  return parts.join(" · ");
}

function pickFirstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/** Render a WebContext as a list of indented lines for the get-comment output. */
export function formatWebContextSection(
  wc: WebContext | null | undefined,
  title = "Web Context"
): string[] {
  if (!wc) return [];
  const lines: string[] = [`${title}:`];
  const add = (label: string, value: unknown) => {
    if (value == null) return;
    if (typeof value === "string" && value.trim().length === 0) return;
    lines.push(`  ${label}: ${value}`);
  };

  add("Page URL", wc.pageUrl);
  if (wc.componentName || wc.filePath) {
    const cn = wc.componentName ? String(wc.componentName) : null;
    const fp = wc.filePath ? ` (${wc.filePath})` : "";
    if (cn) lines.push(`  Component: ${cn}${fp}`);
    else if (wc.filePath) lines.push(`  File: ${wc.filePath}`);
  }
  add("Via", wc.reactComponents);
  add("Element", wc.elementName);
  add("Element Path", wc.elementPath);
  add("Selector", wc.selector);
  add("Selected Text", wc.selectedText);
  add("CSS Classes", wc.cssClasses);

  if (wc.boundingBox) {
    const bb = wc.boundingBox;
    if (bb.width != null && bb.height != null && bb.x != null && bb.y != null) {
      lines.push(`  Bounding Box: ${bb.width}x${bb.height} at (${bb.x}, ${bb.y})`);
    }
  }

  add("Nearby Text", flattenNearbyText(wc.nearbyText));
  add("Accessibility", flattenAccessibility(wc.accessibility));
  add("Computed Styles", flattenComputedStyles(wc.computedStyles));
  add("Nearby Elements", flattenNearbyElements(wc.nearbyElements));

  // HyperFrames context (debug-only feature). The bridge emits one
  // `Label: value` per line — same shape as the rest of this section so
  // we render it identically (indented, label:value).
  const hfCtx = typeof wc.hyperframesContext === "string" ? wc.hyperframesContext.trim() : null;
  if (hfCtx && hfCtx.length > 0) {
    lines.push("");
    lines.push("HyperFrames Context:");
    for (const raw of hfCtx.split(/\r?\n/)) {
      const ln = raw.trim();
      if (ln.length === 0) continue;
      // Already shaped as `Label: value` — pass through with two-space indent
      // to match `add()`'s output.
      lines.push(`  ${ln}`);
    }
  }

  return lines.length > 1 ? lines : [];
}

/**
 * Accepts either an already-flat string or a legacy structured value; in the
 * latter case `flatten` converts it. Returns null for missing/empty input so
 * callers can omit the field entirely.
 */
function flattenField<T>(
  v: string | T | null | undefined,
  flatten: (t: T) => string
): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim().length > 0 ? v : null;
  const s = flatten(v as T);
  return s.length > 0 ? s : null;
}

function flattenComputedStyles(v: WebContext["computedStyles"]): string | null {
  return flattenField(v, (dict: Record<string, string>) =>
    Object.entries(dict)
      .filter(([, val]) => val != null && val !== "")
      .map(([k, val]) => `${k}: ${val}`)
      .join("; ")
  );
}

function flattenAccessibility(v: WebContext["accessibility"]): string | null {
  return flattenField(v, (a: LegacyAccessibility) => {
    const parts: string[] = [];
    if (a.role) parts.push(`role=${a.role}`);
    if (a.ariaLabel) parts.push(`aria-label="${a.ariaLabel}"`);
    if (a.ariaDescribedby) parts.push(`aria-describedby="${a.ariaDescribedby}"`);
    if (a.ariaHidden) parts.push(`aria-hidden=${a.ariaHidden}`);
    if (a.tabIndex != null) parts.push(`tabIndex=${a.tabIndex}`);
    if (a.focusable != null) parts.push(`focusable=${a.focusable}`);
    return parts.join(", ");
  });
}

function flattenNearbyText(v: WebContext["nearbyText"]): string | null {
  return flattenField(v, (n: LegacyNearbyText) => {
    const parts: string[] = [];
    if (n.before) parts.push(`before: "${n.before}"`);
    if (n.after) parts.push(`after: "${n.after}"`);
    return parts.join("; ");
  });
}

function flattenNearbyElements(v: WebContext["nearbyElements"]): string | null {
  return flattenField(v, (arr: LegacyNearbyElement[]) =>
    arr
      .map((ne) => {
        const tag = ne.tag ?? "?";
        const id = ne.id ? `#${ne.id}` : "";
        const cls = ne.classes
          ? "." + String(ne.classes).split(/\s+/).slice(0, 3).join(".")
          : "";
        const snippet = ne.textSnippet ? ` "${ne.textSnippet}"` : "";
        return `<${tag}${id}${cls}>${snippet}`;
      })
      .join(" | ")
  );
}
