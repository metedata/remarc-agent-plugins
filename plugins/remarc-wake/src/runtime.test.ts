import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { AppState, Comment, CommentStatus, Session } from "../../shared/data.js";
import type {
  Marker,
  MarkerLockOptions,
  MarkerOwnerPatchOutcome,
  MarkerOwnerRemoveOutcome,
  MarkerReadOutcome,
} from "../../shared/marker.js";
import {
  OMP_HEARTBEAT_INTERVAL_MS,
  OMP_POLL_INTERVAL_MS,
  OMP_SHUTDOWN_CLEANUP_MS,
  type LeaseClaimOutcome,
  type LeaseClaimRequest,
  type LeaseStore,
} from "./lease.js";
import {
  RemarcWakeRuntime,
  type DataFileWatcher,
  type WakeRuntimeDependencies,
} from "./runtime.js";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cloneMarker(marker: Marker): Marker {
  return structuredClone(marker);
}

function baseMarker(overrides: Partial<Marker> = {}): Marker {
  return {
    remarcSessionId: "R1",
    dataFilePath: "/remarc/comments.json",
    transcriptPath: "/omp/session.jsonl",
    wakeCapable: true,
    lastActivity: new Date(100_000).toISOString(),
    deliveredIds: [],
    wakedAt: {},
    protocolVersion: 1,
    harness: "omp",
    ownerPid: 101,
    ownerToken: "1".repeat(32),
    leaseHeartbeatAt: new Date(100_000).toISOString(),
    pendingWake: null,
    ...overrides,
  };
}

class FakeLeaseStore implements LeaseStore {
  readonly markers = new Map<string, Marker>();
  readonly alivePids = new Set<number>([101, 102, 103]);
  readonly claimCalls: { request: LeaseClaimRequest; options?: MarkerLockOptions }[] = [];
  readonly patchCalls: { markerId: string; token: string; options?: MarkerLockOptions }[] = [];
  readonly removeCalls: { markerId: string; token: string; options?: MarkerLockOptions }[] = [];
  now = 100_000;
  claimGate: Deferred | null = null;
  patchGate: Deferred | null = null;
  removeGate: Deferred | null = null;

  async read(markerId: string): Promise<MarkerReadOutcome> {
    const marker = this.markers.get(markerId);
    return marker
      ? { kind: "valid", source: "json", marker: cloneMarker(marker) }
      : { kind: "missing" };
  }

  #live(marker: Marker): boolean {
    const heartbeat =
      typeof marker.leaseHeartbeatAt === "string"
        ? Date.parse(marker.leaseHeartbeatAt)
        : Number.NaN;
    return (
      marker.wakeCapable === true &&
      marker.protocolVersion === 1 &&
      marker.harness === "omp" &&
      typeof marker.ownerToken === "string" &&
      marker.ownerToken.length > 0 &&
      typeof marker.ownerPid === "number" &&
      this.alivePids.has(marker.ownerPid) &&
      Number.isFinite(heartbeat) &&
      this.now - heartbeat >= -30_000 &&
      this.now - heartbeat <= 60_000
    );
  }

  async claim(
    request: LeaseClaimRequest,
    options?: MarkerLockOptions
  ): Promise<LeaseClaimOutcome> {
    this.claimCalls.push({ request: { ...request }, options });
    if (this.claimGate) await this.claimGate.promise;
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    for (const [markerId, marker] of this.markers) {
      if (marker.remarcSessionId.toUpperCase() !== request.remarcSessionId.toUpperCase()) {
        continue;
      }
      if (markerId === request.markerId && marker.ownerToken === request.ownerToken) continue;
      if (this.#live(marker)) {
        return { kind: "conflict", ownerId: markerId, marker: cloneMarker(marker) };
      }
    }
    const destination = this.markers.get(request.markerId);
    if (
      destination &&
      destination.ownerToken !== request.ownerToken &&
      this.#live(destination)
    ) {
      return {
        kind: "conflict",
        ownerId: request.markerId,
        marker: cloneMarker(destination),
      };
    }

    const marker = destination ? cloneMarker(destination) : baseMarker();
    Object.assign(marker, {
      remarcSessionId: request.remarcSessionId,
      dataFilePath: request.dataFilePath,
      transcriptPath: request.transcriptPath,
      wakeCapable: true,
      lastActivity: new Date(request.now).toISOString(),
      protocolVersion: 1,
      harness: "omp",
      ownerPid: request.ownerPid,
      ownerToken: request.ownerToken,
      leaseHeartbeatAt: new Date(request.now).toISOString(),
    });
    if (request.resetDeliveryState) {
      marker.pendingWake = null;
      marker.wakedAt = {};
      marker.deliveredIds = [];
    }
    this.markers.set(request.markerId, marker);
    return { kind: "acquired", marker: cloneMarker(marker) };
  }

  async patch(
    markerId: string,
    ownerToken: string,
    mutate: (marker: Marker) => void | Promise<void>,
    options?: MarkerLockOptions
  ): Promise<MarkerOwnerPatchOutcome> {
    this.patchCalls.push({ markerId, token: ownerToken, options });
    if (this.patchGate) await this.patchGate.promise;
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const existing = this.markers.get(markerId);
    if (!existing) return { kind: "missing" };
    if (existing.ownerToken !== ownerToken) return { kind: "ownerMismatch" };
    const marker = cloneMarker(existing);
    await mutate(marker);
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (marker.ownerToken !== ownerToken) return { kind: "ownerMismatch" };
    this.markers.set(markerId, marker);
    return { kind: "updated", marker: cloneMarker(marker) };
  }

  async remove(
    markerId: string,
    ownerToken: string,
    options?: MarkerLockOptions
  ): Promise<MarkerOwnerRemoveOutcome> {
    this.removeCalls.push({ markerId, token: ownerToken, options });
    if (this.removeGate) await this.removeGate.promise;
    const marker = this.markers.get(markerId);
    if (!marker) return { kind: "missing" };
    if (marker.ownerToken !== ownerToken) return { kind: "ownerMismatch" };
    this.markers.delete(markerId);
    return { kind: "removed" };
  }
}

interface FakeTimer {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

class FakeContext {
  readonly notifications: { message: string; type?: string }[] = [];
  readonly timers: FakeTimer[] = [];
  readonly mode = "tui";
  readonly hasUI = true;
  readonly ui = {
    notify: (message: string, type?: string) => {
      this.notifications.push({ message, type });
    },
  };
  readonly sessionManager: {
    getSessionId: () => string;
    getSessionFile: () => string;
  };

  constructor(
    readonly sessionId: string,
    readonly sessionFile = `/omp/${sessionId}.jsonl`,
    readonly idle = false
  ) {
    this.sessionManager = {
      getSessionId: () => this.sessionId,
      getSessionFile: () => this.sessionFile,
    };
  }

  setInterval(callback: () => void, ms = 0): FakeTimer {
    const timer = { callback, ms, cleared: false };
    this.timers.push(timer);
    return timer;
  }

  setTimeout(callback: () => void, ms = 0): FakeTimer {
    return this.setInterval(callback, ms);
  }

  clearTimer(timer: FakeTimer): void {
    timer.cleared = true;
  }

  isIdle(): boolean {
    return this.idle;
  }

  asExtensionContext(): ExtensionContext {
    return this as unknown as ExtensionContext;
  }
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;

class FakeApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, Command>();
  readonly messages: { message: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  readonly warnings: unknown[][] = [];
  throwOnSend = false;
  beforeSend: (() => void) | null = null;
  readonly logger = {
    warn: (...args: unknown[]) => this.warnings.push(args),
    debug: () => undefined,
  };

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, options: { handler: Command }): void {
    this.commands.set(name, options.handler);
  }

  sendMessage(
    message: Record<string, unknown>,
    options: Record<string, unknown>
  ): void {
    this.beforeSend?.();
    if (this.throwOnSend) throw new Error("queue unavailable");
    this.messages.push({ message, options });
  }

  async emit(
    event: string,
    ctx: FakeContext,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({ type: event, ...payload }, ctx.asExtensionContext());
    }
  }

  async command(name: string, ctx: FakeContext): Promise<void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Missing command ${name}`);
    await command("", ctx.asExtensionContext());
  }

  asExtensionApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

function session(id: string, name = id): Session {
  return {
    id,
    name,
    createdAt: new Date(0),
    isDeleted: false,
    deletedAt: null,
    isAutoDismissed: false,
    autoDismissedAt: null,
    origin: "manual",
    claudeCodeSessionId: null,
    unknownFields: {},
  };
}

function comment(
  id: string,
  generation: number,
  status: CommentStatus = "handedOff",
  sessionID = "R1"
): Comment {
  return {
    id,
    shortID: id.slice(0, 5),
    type: { quickNote: {} },
    commentText: `Please handle ${id}`,
    source: "test",
    appBundleID: null,
    createdAt: new Date(0),
    updatedAt: new Date(generation),
    sessionID,
    isDeleted: false,
    deletedAt: null,
    status,
    resolutionSummary: null,
    resolvedBy: null,
    resolvedAt: null,
    attachments: [],
    webContext: null,
    regionElements: null,
    wakeRequestedAt: new Date(generation),
    unknownFields: {},
  };
}

function state(
  comments: Comment[] = [],
  activeSessionID: string | null = "R1",
  sessions: Session[] = [session("R1", "Primary")]
): AppState {
  return {
    sessions,
    comments,
    activeSessionID,
    totalCommentsCreated: comments.length,
    unknownFields: {},
  };
}

interface Harness {
  api: FakeApi;
  ctx: FakeContext;
  deps: WakeRuntimeDependencies;
  runtime: RemarcWakeRuntime;
  watchers: { watcher: DataFileWatcher & { closed: boolean }; change: () => void; error: (e: unknown) => void }[];
}

function harness(
  store: FakeLeaseStore,
  appState: { value: AppState | null },
  options: { sessionId?: string; ownerPid?: number; token?: string } = {}
): Harness {
  const api = new FakeApi();
  const ctx = new FakeContext(options.sessionId ?? "OMP-A");
  const watchers: Harness["watchers"] = [];
  const deps: WakeRuntimeDependencies = {
    leaseStore: store,
    readAppState: async () => appState.value,
    getDataFilePath: () => "/remarc/comments.json",
    newOwnerToken: () => options.token ?? "a".repeat(32),
    ownerPid: options.ownerPid ?? 101,
    now: () => store.now,
    watchDataFile: (_path, change, error) => {
      const watcher = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      watchers.push({ watcher, change, error });
      return watcher;
    },
  };
  const runtime = new RemarcWakeRuntime(api.asExtensionApi(), deps);
  runtime.register();
  return { api, ctx, deps, runtime, watchers };
}

async function waitFor(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 1500, interval: 1 });
}

describe("Remarc OMP wake runtime", () => {
  it("registers only the supported lifecycle hooks and explicit pair commands", () => {
    const h = harness(new FakeLeaseStore(), { value: state() });
    expect([...h.api.commands.keys()].sort()).toEqual(["remarc-pair", "remarc-unpair"]);
    expect([...h.api.handlers.keys()].sort()).toEqual([
      "agent_end",
      "session_branch",
      "session_shutdown",
      "session_start",
      "session_switch",
      "turn_end",
    ]);
    expect(h.api.handlers.has("message_end")).toBe(false);
    expect(h.api.handlers.has("agent_settled")).toBe(false);
  });

  it("pairs the current OMP id to an existing active Remarc session and persists before queueing", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const h = harness(store, appState);
    h.api.beforeSend = () => {
      expect(store.markers.get("omp-OMP-A")?.pendingWake).toEqual({ C1: 100 });
    };

    await h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(h.api.messages).toHaveLength(1));

    const marker = store.markers.get("omp-OMP-A");
    expect(marker).toMatchObject({
      remarcSessionId: "R1",
      protocolVersion: 1,
      harness: "omp",
      ownerPid: 101,
      ownerToken: "a".repeat(32),
      wakeCapable: true,
      transcriptPath: "/omp/OMP-A.jsonl",
    });
    expect(h.api.messages[0]?.options).toEqual({
      deliverAs: "nextTurn",
      triggerTurn: true,
    });
    expect(h.api.messages[0]?.message).toMatchObject({
      customType: "remarc-wake",
      display: true,
      details: {
        protocolVersion: 1,
        remarcSessionId: "R1",
        comments: [{ id: "C1", generation: 100 }],
      },
    });
    expect(h.ctx.isIdle()).toBe(false);
    expect(h.ctx.timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([
      OMP_HEARTBEAT_INTERVAL_MS,
      OMP_POLL_INTERVAL_MS,
    ]);
  });

  it("refuses missing/deleted active sessions rather than creating one", async () => {
    const store = new FakeLeaseStore();
    const missing = harness(store, { value: state([], null) });
    await missing.api.command("remarc-pair", missing.ctx);
    expect(store.claimCalls).toHaveLength(0);

    const deleted = session("R1");
    deleted.isDeleted = true;
    const removed = harness(store, { value: state([], "R1", [deleted]) }, { sessionId: "OMP-B" });
    await removed.api.command("remarc-pair", removed.ctx);
    expect(store.claimCalls).toHaveLength(0);
  });

  it("atomically allows only one live OMP owner per Remarc session", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state() };
    const first = harness(store, appState, { sessionId: "OMP-A", ownerPid: 101, token: "a".repeat(32) });
    const second = harness(store, appState, { sessionId: "OMP-B", ownerPid: 102, token: "b".repeat(32) });

    await Promise.all([
      first.api.command("remarc-pair", first.ctx),
      second.api.command("remarc-pair", second.ctx),
    ]);

    expect(store.markers.size).toBe(1);
    expect(
      [...first.ctx.notifications, ...second.ctx.notifications].some(({ message }) =>
        message.includes("already paired")
      )
    ).toBe(true);
  });

  it("re-pairs the same token without a visibility gap and resets old delivery state", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state() };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    const marker = store.markers.get("omp-OMP-A") as Marker;
    marker.pendingWake = { OLD: 10 };
    marker.wakedAt = { OLD: 9 };
    marker.deliveredIds = ["OLD"];

    appState.value = state([], "R2", [session("R1"), session("R2", "Second")]);
    await h.api.command("remarc-pair", h.ctx);

    expect(store.markers.get("omp-OMP-A")).toMatchObject({
      remarcSessionId: "R2",
      ownerToken: "a".repeat(32),
      pendingWake: null,
      wakedAt: {},
      deliveredIds: [],
    });
    expect(store.removeCalls).toHaveLength(0);
  });

  it("keeps live-process offer suppression when the same pairing is refreshed", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(h.api.messages).toHaveLength(1));

    await h.api.command("remarc-pair", h.ctx);
    expect(h.watchers).toHaveLength(2);
    expect(h.api.messages).toHaveLength(1);
    expect(store.markers.get("omp-OMP-A")?.pendingWake).toEqual({ C1: 100 });
  });

  it("preserves and restores the previous pairing when a different live owner blocks re-pair", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(h.api.messages).toHaveLength(1));
    store.markers.set(
      "omp-OTHER",
      baseMarker({
        remarcSessionId: "R2",
        ownerPid: 102,
        ownerToken: "b".repeat(32),
      })
    );
    appState.value = state([], "R2", [session("R1"), session("R2")]);

    await h.api.command("remarc-pair", h.ctx);

    expect(store.markers.get("omp-OMP-A")?.remarcSessionId).toBe("R1");
    expect(h.watchers.at(-1)?.watcher.closed).toBe(false);
    expect(h.ctx.notifications.at(-1)?.message).toContain("already paired");
    expect(h.api.messages).toHaveLength(1);
  });

  it("keeps pending durable after a thrown or successful void send", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const h = harness(store, appState);
    h.api.throwOnSend = true;
    await h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(h.api.warnings.some((args) => String(args[0]).includes("queue"))).toBe(true));
    expect(store.markers.get("omp-OMP-A")?.pendingWake).toEqual({ C1: 100 });

    h.api.throwOnSend = false;
    await h.api.emit("agent_end", new FakeContext("OMP-A"));
    await waitFor(() => expect(h.api.messages).toHaveLength(1));
    expect(store.markers.get("omp-OMP-A")?.pendingWake).toEqual({ C1: 100 });
    await h.api.emit("turn_end", new FakeContext("OMP-A"));
    expect(store.markers.get("omp-OMP-A")?.pendingWake).toEqual({ C1: 100 });
  });

  it("renews a stale heartbeat in the same locked mutation before queueing", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state() };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    const marker = store.markers.get("omp-OMP-A") as Marker;
    marker.leaseHeartbeatAt = new Date(store.now - 60_001).toISOString();
    appState.value = state([comment("C1", 100)]);
    h.api.beforeSend = () => {
      expect(store.markers.get("omp-OMP-A")?.leaseHeartbeatAt).toBe(
        new Date(store.now).toISOString()
      );
    };

    h.watchers[0]?.change();
    await waitFor(() => expect(h.api.messages).toHaveLength(1));
  });

  it("replays a crash-surviving pending generation on session start", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const first = harness(store, appState, { ownerPid: 101, token: "a".repeat(32) });
    await first.api.command("remarc-pair", first.ctx);
    await waitFor(() => expect(first.api.messages).toHaveLength(1));

    store.alivePids.delete(101); // hard crash: no shutdown cleanup ran
    const resumed = harness(store, appState, { ownerPid: 102, token: "b".repeat(32) });
    await resumed.api.emit("session_start", resumed.ctx);
    await waitFor(() => expect(resumed.api.messages).toHaveLength(1));

    expect(resumed.api.messages[0]?.message.details).toMatchObject({
      comments: [{ id: "C1", generation: 100 }],
    });
    expect(store.markers.get("omp-OMP-A")?.ownerToken).toBe("b".repeat(32));
  });

  it("does not auto-claim legacy/ownerless markers, but explicit pair upgrades them", async () => {
    const store = new FakeLeaseStore();
    store.markers.set(
      "omp-OMP-A",
      baseMarker({
        protocolVersion: undefined,
        harness: undefined,
        ownerToken: undefined,
        ownerPid: undefined,
        wakeCapable: false,
      })
    );
    const appState = { value: state() };
    const h = harness(store, appState);

    await h.api.emit("session_start", h.ctx);
    expect(store.claimCalls).toHaveLength(0);
    await h.api.command("remarc-pair", h.ctx);
    expect(store.markers.get("omp-OMP-A")).toMatchObject({
      protocolVersion: 1,
      harness: "omp",
      ownerToken: "a".repeat(32),
    });
  });

  it("clears only after correlated Remarc state leaves handedOff", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(h.api.messages).toHaveLength(1));

    appState.value = state([comment("C1", 100, "inProgress")]);
    await h.api.emit("turn_end", h.ctx);
    await waitFor(() => expect(store.markers.get("omp-OMP-A")?.pendingWake).toBeNull());
    expect(store.markers.get("omp-OMP-A")?.wakedAt).toEqual({ C1: 100 });

    appState.value = state([comment("C1", 200)]);
    await h.api.emit("agent_end", h.ctx);
    await waitFor(() => expect(h.api.messages).toHaveLength(2));
    expect(store.markers.get("omp-OMP-A")?.pendingWake).toEqual({ C1: 200 });
  });

  it("reacts through the file watcher and managed poll timer", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state() };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    appState.value = state([comment("C1", 100)]);
    h.watchers[0]?.change();
    await waitFor(() => expect(h.api.messages).toHaveLength(1));

    appState.value = state([comment("C1", 100), comment("C2", 200)]);
    h.ctx.timers.find((timer) => timer.ms === OMP_POLL_INTERVAL_MS)?.callback();
    await waitFor(() => expect(h.api.messages).toHaveLength(2));
    expect(h.api.messages[1]?.message.details).toMatchObject({
      comments: [{ id: "C2", generation: 200 }],
    });
  });

  it("stops immediately on token-CAS ownership loss", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state() };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    const watcher = h.watchers[0]?.watcher;
    const marker = store.markers.get("omp-OMP-A") as Marker;
    marker.ownerToken = "f".repeat(32);

    h.ctx.timers.find((timer) => timer.ms === OMP_HEARTBEAT_INTERVAL_MS)?.callback();
    await waitFor(() => expect(watcher?.closed).toBe(true));
    expect(h.ctx.timers.every((timer) => timer.cleared)).toBe(true);
    expect(store.markers.get("omp-OMP-A")?.ownerToken).toBe("f".repeat(32));
  });

  it("unpair uses token CAS and never removes a takeover owner", async () => {
    const store = new FakeLeaseStore();
    const h = harness(store, { value: state() });
    await h.api.command("remarc-pair", h.ctx);
    const marker = store.markers.get("omp-OMP-A") as Marker;
    marker.ownerToken = "f".repeat(32);

    await h.api.command("remarc-unpair", h.ctx);
    expect(store.markers.get("omp-OMP-A")?.ownerToken).toBe("f".repeat(32));
    expect(store.removeCalls[0]?.token).toBe("a".repeat(32));
  });

  it("session switch retires the old lease and replays the resumed session outbox", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const h = harness(store, appState, { sessionId: "OMP-A" });
    await h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(h.api.messages).toHaveLength(1));
    store.markers.set(
      "omp-OMP-B",
      baseMarker({
        wakeCapable: false,
        ownerPid: 999,
        ownerToken: "9".repeat(32),
        pendingWake: { C1: 100 },
      })
    );
    const resumed = new FakeContext("OMP-B");

    await h.api.emit("session_switch", resumed);
    await waitFor(() => expect(h.api.messages).toHaveLength(2));

    expect(store.markers.get("omp-OMP-A")?.wakeCapable).toBe(false);
    expect(store.markers.get("omp-OMP-B")?.ownerToken).toBe("a".repeat(32));
    expect(h.api.messages[1]?.message.details).toMatchObject({
      comments: [{ id: "C1", generation: 100 }],
    });
  });

  it("session branch retires the old lease and replays the new OMP session outbox", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state([comment("C1", 100)]) };
    const h = harness(store, appState, { sessionId: "OMP-A" });
    await h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(h.api.messages).toHaveLength(1));
    store.markers.set(
      "omp-OMP-B",
      baseMarker({
        wakeCapable: false,
        ownerPid: 999,
        ownerToken: "9".repeat(32),
        pendingWake: { C1: 100 },
      })
    );
    const branched = new FakeContext("OMP-B");

    await h.api.emit("session_branch", branched, {
      previousSessionFile: "/omp/OMP-A.jsonl",
    });
    await waitFor(() => expect(h.api.messages).toHaveLength(2));

    expect(store.markers.get("omp-OMP-A")?.wakeCapable).toBe(false);
    expect(store.markers.get("omp-OMP-B")?.ownerToken).toBe("a".repeat(32));
    expect(h.api.messages[1]?.message.details).toMatchObject({
      comments: [{ id: "C1", generation: 100 }],
    });
  });

  it("shutdown clears local resources before one bounded owner-CAS cleanup completes", async () => {
    const store = new FakeLeaseStore();
    const h = harness(store, { value: state() });
    await h.api.command("remarc-pair", h.ctx);
    const gate = deferred();
    store.removeGate = gate;
    const watcher = h.watchers[0]?.watcher;

    const stopping = h.api.emit("session_shutdown", h.ctx);
    expect(watcher?.closed).toBe(true);
    expect(h.ctx.timers.every((timer) => timer.cleared)).toBe(true);
    expect(store.removeCalls).toHaveLength(1);
    expect(store.removeCalls[0]?.options).toMatchObject({
      timeoutMs: OMP_SHUTDOWN_CLEANUP_MS,
      deadlineMs: store.now + OMP_SHUTDOWN_CLEANUP_MS,
    });

    gate.resolve();
    await stopping;
    expect(store.markers.has("omp-OMP-A")).toBe(false);
    await h.api.emit("session_shutdown", h.ctx);
    expect(store.removeCalls).toHaveLength(1);
  });

  it("shutdown cleanup leaves a replacement token owner intact", async () => {
    const store = new FakeLeaseStore();
    const h = harness(store, { value: state() });
    await h.api.command("remarc-pair", h.ctx);
    const marker = store.markers.get("omp-OMP-A") as Marker;
    marker.ownerToken = "f".repeat(32);
    marker.ownerPid = 102;

    await h.api.emit("session_shutdown", h.ctx);

    expect(store.markers.get("omp-OMP-A")).toMatchObject({
      ownerToken: "f".repeat(32),
      ownerPid: 102,
    });
    expect(store.removeCalls).toHaveLength(1);
    expect(store.removeCalls[0]?.token).toBe("a".repeat(32));
  });

  it("aborts a pairing race on shutdown without publishing after cleanup", async () => {
    const store = new FakeLeaseStore();
    const gate = deferred();
    store.claimGate = gate;
    const h = harness(store, { value: state() });

    const pairing = h.api.command("remarc-pair", h.ctx);
    await waitFor(() => expect(store.claimCalls).toHaveLength(1));
    await h.api.emit("session_shutdown", h.ctx);
    gate.resolve();
    await pairing;

    expect(store.markers.has("omp-OMP-A")).toBe(false);
    expect(h.api.messages).toHaveLength(0);
  });

  it("does not queue after shutdown interrupts an in-flight data read", async () => {
    const store = new FakeLeaseStore();
    const appState = { value: state() };
    const h = harness(store, appState);
    await h.api.command("remarc-pair", h.ctx);
    const readGate = deferred<AppState | null>();
    h.deps.readAppState = () => readGate.promise;
    appState.value = state([comment("C1", 100)]);
    h.watchers[0]?.change();
    const stopping = h.api.emit("session_shutdown", h.ctx);
    readGate.resolve(appState.value);
    await stopping;

    expect(h.api.messages).toHaveLength(0);
  });
});
