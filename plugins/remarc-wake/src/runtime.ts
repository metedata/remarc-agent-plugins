import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { AppState } from "../../shared/data.js";
import type { Marker, MarkerLockOptions } from "../../shared/marker.js";
import { buildWakePayload } from "../../shared/wake.js";
import {
  OMP_HEARTBEAT_INTERVAL_MS,
  OMP_POLL_INTERVAL_MS,
  OMP_SHUTDOWN_CLEANUP_MS,
  assertOwnerToken,
  canResumeOmpMarker,
  markerIdForOmpSession,
  ownsLease,
  patchHeartbeat,
  patchStoppedLease,
  type ActiveLease,
  type LeaseClaimOutcome,
  type LeaseStore,
} from "./lease.js";
import {
  candidatesNotOffered,
  pruneOffered,
  reconcileOutbox,
} from "./outbox.js";

type ManagedTimer = ReturnType<ExtensionContext["setInterval"]>;

export interface DataFileWatcher {
  close(): void;
}

export interface WakeRuntimeDependencies {
  leaseStore: LeaseStore;
  readAppState(): Promise<AppState | null>;
  getDataFilePath(): string;
  newOwnerToken(): string;
  ownerPid: number;
  now(): number;
  watchDataFile(
    path: string,
    onChange: () => void,
    onError: (error: unknown) => void
  ): DataFileWatcher;
}

export interface WakeMessageDetails {
  protocolVersion: 1;
  remarcSessionId: string;
  comments: { id: string; generation: number }[];
}

function outcomeMessage(outcome: LeaseClaimOutcome): string {
  switch (outcome.kind) {
    case "conflict":
      return `Remarc session is already paired to live OMP session ${outcome.ownerId}.`;
    case "invalid":
      return `Cannot pair because a Remarc marker is invalid: ${outcome.reason}`;
    case "unsafe":
      return `Cannot pair because a Remarc marker path is unsafe: ${outcome.reason}`;
    case "acquired":
      return "";
  }
}

function sameLease(a: ActiveLease | null, b: ActiveLease): boolean {
  return (
    a != null &&
    a.markerId === b.markerId &&
    a.ownerToken === b.ownerToken &&
    a.epoch === b.epoch
  );
}

/**
 * OMP-side live-delivery runtime.
 *
 * The marker is the durable source of truth. `offered` only suppresses repeat
 * queueing by this one live extension instance; it is deliberately discarded
 * on restart so a pending outbox generation is replayed.
 */
export class RemarcWakeRuntime {
  readonly #api: ExtensionAPI;
  readonly #deps: WakeRuntimeDependencies;
  readonly #ownerToken: string;

  #context: ExtensionContext | null = null;
  #lease: ActiveLease | null = null;
  #provisional: ActiveLease | null = null;
  #watcher: DataFileWatcher | null = null;
  #heartbeatTimer: ManagedTimer | null = null;
  #pollTimer: ManagedTimer | null = null;
  #activityAbort: AbortController | null = null;
  #claimAbort: AbortController | null = null;
  #epoch = 0;
  #closing = false;
  #shutdownStarted = false;
  #draining = false;
  #dirty = false;
  readonly #offered = new Map<string, number>();

  constructor(api: ExtensionAPI, dependencies: WakeRuntimeDependencies) {
    this.#api = api;
    this.#deps = dependencies;
    this.#ownerToken = dependencies.newOwnerToken();
    assertOwnerToken(this.#ownerToken);
    if (!Number.isSafeInteger(dependencies.ownerPid) || dependencies.ownerPid <= 0) {
      throw new Error("Remarc Wake requires a positive OMP owner PID");
    }
  }

  register(): void {
    this.#api.registerCommand("remarc-pair", {
      description: "Pair this OMP session with the active Remarc session",
      handler: async (_args, ctx) => this.pair(ctx),
    });
    this.#api.registerCommand("remarc-unpair", {
      description: "Stop waking this OMP session from Remarc",
      handler: async (_args, ctx) => this.unpair(ctx),
    });

    this.#api.on("session_start", async (_event, ctx) => this.start(ctx));
    this.#api.on("session_switch", async (_event, ctx) => this.switchSession(ctx));
    this.#api.on("session_branch", async (_event, ctx) => this.switchSession(ctx));
    this.#api.on("turn_end", (_event, ctx) => this.settled(ctx));
    this.#api.on("agent_end", (_event, ctx) => this.settled(ctx));
    this.#api.on("session_shutdown", async (_event, ctx) => this.shutdown(ctx));
  }

  /** Resume a prior v1 OMP pairing, including every durable pending generation. */
  async start(ctx: ExtensionContext): Promise<void> {
    if (this.#closing || ctx.mode !== "tui") return;
    this.#context = ctx;

    let markerId: string;
    try {
      markerId = markerIdForOmpSession(ctx.sessionManager.getSessionId());
    } catch (error) {
      this.#api.logger.warn("Remarc Wake rejected the OMP session id", {
        error: String(error),
      });
      return;
    }

    const operationEpoch = ++this.#epoch;
    let outcome;
    try {
      outcome = await this.#deps.leaseStore.read(markerId);
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not read its marker", {
        error: String(error),
      });
      return;
    }
    if (this.#closing || operationEpoch !== this.#epoch) return;
    if (!canResumeOmpMarker(outcome)) return;

    await this.#claim(
      ctx,
      markerId,
      outcome.marker.remarcSessionId,
      false,
      null,
      new Map(),
      operationEpoch
    );
  }

  /**
   * Session resume/new/fork/branch changes the OMP id without restarting extensions.
   * Make the old lease unreachable, retain its pairing/outbox, then rehydrate
   * the new session's own marker.
   */
  async switchSession(ctx: ExtensionContext): Promise<void> {
    if (this.#closing) return;
    const previous = this.#stopLocal(false);
    if (previous) await this.#markStopped(previous);
    if (!this.#closing) await this.start(ctx);
  }

  /** Explicit pairing only targets an already-existing active Remarc session. */
  async pair(ctx: ExtensionContext): Promise<void> {
    if (this.#closing) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Remarc pairing is available in interactive OMP sessions.", "warning");
      return;
    }

    let state: AppState | null;
    try {
      state = await this.#deps.readAppState();
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not read Remarc data", {
        error: String(error),
      });
      ctx.ui.notify("Could not read Remarc data.", "error");
      return;
    }
    if (!state?.activeSessionID) {
      ctx.ui.notify("Open Remarc and select an active session first.", "warning");
      return;
    }
    const target = state.sessions.find(
      (session) =>
        !session.isDeleted &&
        session.id.toUpperCase() === state?.activeSessionID?.toUpperCase()
    );
    if (!target) {
      ctx.ui.notify("The active Remarc session no longer exists.", "warning");
      return;
    }

    let markerId: string;
    try {
      markerId = markerIdForOmpSession(ctx.sessionManager.getSessionId());
    } catch (error) {
      this.#api.logger.warn("Remarc Wake rejected the OMP session id", {
        error: String(error),
      });
      ctx.ui.notify("This OMP session id cannot be paired safely.", "error");
      return;
    }

    const previous = this.#lease;
    const previousOffered = new Map(this.#offered);
    let resetDeliveryState = false;
    try {
      const current = await this.#deps.leaseStore.read(markerId);
      resetDeliveryState =
        current.kind === "valid" &&
        current.marker.remarcSessionId.length > 0 &&
        current.marker.remarcSessionId.toUpperCase() !== target.id.toUpperCase();
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not inspect the existing pairing", {
        error: String(error),
      });
      ctx.ui.notify("Could not inspect the existing Remarc pairing.", "error");
      return;
    }

    this.#stopLocal(false);
    const operationEpoch = ++this.#epoch;
    const acquired = await this.#claim(
      ctx,
      markerId,
      target.id,
      resetDeliveryState,
      previous,
      previousOffered,
      operationEpoch
    );
    if (acquired) {
      ctx.ui.notify(`Paired with Remarc session “${target.name}”.`, "info");
    }
  }

  async unpair(ctx: ExtensionContext): Promise<void> {
    if (this.#closing) return;
    const target = this.#stopLocal(false);
    if (!target) {
      ctx.ui.notify("This OMP session is not paired with Remarc.", "info");
      return;
    }
    try {
      const outcome = await this.#deps.leaseStore.remove(
        target.markerId,
        target.ownerToken
      );
      if (outcome.kind === "removed" || outcome.kind === "missing") {
        ctx.ui.notify("Unpaired this OMP session from Remarc.", "info");
      } else if (outcome.kind === "ownerMismatch") {
        ctx.ui.notify("Pairing ownership changed; the new owner was left intact.", "warning");
      } else {
        ctx.ui.notify(`Could not remove the Remarc pairing: ${outcome.reason}`, "error");
      }
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not remove its pairing", {
        error: String(error),
      });
      ctx.ui.notify("Could not remove the Remarc pairing.", "error");
    }
  }

  settled(ctx: ExtensionContext): void {
    if (this.#closing || !this.#lease) return;
    let markerId: string;
    try {
      markerId = markerIdForOmpSession(ctx.sessionManager.getSessionId());
    } catch {
      return;
    }
    // OMP creates a fresh ExtensionContext wrapper for each event. Session
    // identity, not object identity, determines whether this event belongs to
    // the lease currently armed by the extension.
    if (markerId !== this.#lease.markerId) return;
    this.#requestDrain();
  }

  /** Stop synchronously, then perform one bounded token-CAS marker removal. */
  async shutdown(_ctx: ExtensionContext): Promise<void> {
    if (this.#shutdownStarted) return;
    this.#shutdownStarted = true;
    this.#closing = true;
    const target = this.#stopLocal(true);
    if (!target) return;

    const now = this.#deps.now();
    const options: MarkerLockOptions = {
      timeoutMs: OMP_SHUTDOWN_CLEANUP_MS,
      deadlineMs: now + OMP_SHUTDOWN_CLEANUP_MS,
    };
    try {
      const outcome = await this.#deps.leaseStore.remove(
        target.markerId,
        target.ownerToken,
        options
      );
      if (
        outcome.kind !== "removed" &&
        outcome.kind !== "missing" &&
        outcome.kind !== "ownerMismatch"
      ) {
        this.#api.logger.warn("Remarc Wake shutdown cleanup was refused", {
          kind: outcome.kind,
          reason: outcome.reason,
        });
      }
    } catch (error) {
      this.#api.logger.warn("Remarc Wake shutdown cleanup did not complete", {
        error: String(error),
      });
    }
  }

  async #claim(
    ctx: ExtensionContext,
    markerId: string,
    remarcSessionId: string,
    resetDeliveryState: boolean,
    previous: ActiveLease | null,
    previousOffered: ReadonlyMap<string, number>,
    operationEpoch: number
  ): Promise<boolean> {
    if (this.#closing || operationEpoch !== this.#epoch) return false;
    const abort = new AbortController();
    this.#claimAbort = abort;
    const provisional: ActiveLease = {
      markerId,
      remarcSessionId,
      ownerToken: this.#ownerToken,
      ownerPid: this.#deps.ownerPid,
      epoch: operationEpoch,
    };
    this.#provisional = provisional;

    let outcome: LeaseClaimOutcome;
    try {
      outcome = await this.#deps.leaseStore.claim(
        {
          markerId,
          remarcSessionId,
          dataFilePath: this.#deps.getDataFilePath(),
          transcriptPath: ctx.sessionManager.getSessionFile() ?? null,
          ownerPid: this.#deps.ownerPid,
          ownerToken: this.#ownerToken,
          now: this.#deps.now(),
          resetDeliveryState,
        },
        { signal: abort.signal }
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        this.#api.logger.warn("Remarc Wake lease claim failed", {
          error: String(error),
        });
        ctx.ui.notify("Could not claim the Remarc pairing.", "error");
      }
      if (this.#provisional === provisional) this.#provisional = null;
      await this.#restorePreviousIfOwned(
        ctx,
        previous,
        previousOffered,
        operationEpoch
      );
      return false;
    } finally {
      if (this.#claimAbort === abort) this.#claimAbort = null;
    }

    if (
      this.#closing ||
      abort.signal.aborted ||
      operationEpoch !== this.#epoch ||
      this.#provisional !== provisional
    ) {
      return false;
    }
    this.#provisional = null;

    if (outcome.kind !== "acquired") {
      ctx.ui.notify(outcomeMessage(outcome), outcome.kind === "conflict" ? "warning" : "error");
      await this.#restorePreviousIfOwned(
        ctx,
        previous,
        previousOffered,
        operationEpoch
      );
      return false;
    }

    this.#arm(
      ctx,
      provisional,
      resetDeliveryState ? undefined : previousOffered
    );
    return true;
  }

  async #restorePreviousIfOwned(
    ctx: ExtensionContext,
    previous: ActiveLease | null,
    previousOffered: ReadonlyMap<string, number>,
    operationEpoch: number
  ): Promise<void> {
    if (!previous || this.#closing || operationEpoch !== this.#epoch) return;
    try {
      const outcome = await this.#deps.leaseStore.read(previous.markerId);
      if (
        outcome.kind === "valid" &&
        outcome.marker.ownerToken === previous.ownerToken &&
        outcome.marker.remarcSessionId === previous.remarcSessionId &&
        !this.#closing &&
        operationEpoch === this.#epoch
      ) {
        this.#arm(ctx, { ...previous, epoch: operationEpoch }, previousOffered);
      }
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not restore its prior pairing", {
        error: String(error),
      });
    }
  }

  #arm(
    ctx: ExtensionContext,
    lease: ActiveLease,
    preservedOffered: ReadonlyMap<string, number> = new Map()
  ): void {
    if (this.#closing || lease.epoch !== this.#epoch) return;
    this.#context = ctx;
    this.#lease = lease;
    this.#provisional = null;
    this.#activityAbort = new AbortController();
    this.#offered.clear();
    for (const [id, generation] of preservedOffered) {
      this.#offered.set(id, generation);
    }

    this.#heartbeatTimer = ctx.setInterval(
      () => void this.#heartbeat(lease),
      OMP_HEARTBEAT_INTERVAL_MS
    );
    this.#pollTimer = ctx.setInterval(
      () => this.#requestDrain(),
      OMP_POLL_INTERVAL_MS
    );

    const dataFilePath = this.#deps.getDataFilePath();
    try {
      this.#watcher = this.#deps.watchDataFile(
        dataFilePath,
        () => this.#requestDrain(),
        (error) => {
          this.#api.logger.warn("Remarc Wake file watcher failed; polling remains active", {
            error: String(error),
          });
        }
      );
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not watch comments.json; polling remains active", {
        error: String(error),
      });
    }
    this.#requestDrain();
  }

  #requestDrain(): void {
    if (this.#closing || !this.#lease) return;
    this.#dirty = true;
    if (this.#draining) return;
    this.#draining = true;
    void this.#drainLoop().catch((error) => {
      this.#api.logger.warn("Remarc Wake reconciliation failed", {
        error: String(error),
      });
    });
  }

  async #drainLoop(): Promise<void> {
    try {
      while (this.#dirty && !this.#closing) {
        this.#dirty = false;
        const lease = this.#lease;
        if (!lease) break;
        await this.#reconcile(lease);
      }
    } finally {
      this.#draining = false;
      if (this.#dirty && !this.#closing && this.#lease) this.#requestDrain();
    }
  }

  async #reconcile(lease: ActiveLease): Promise<void> {
    if (!sameLease(this.#lease, lease)) return;
    const abort = this.#activityAbort;
    const ctx = this.#context;
    if (!abort || abort.signal.aborted || !ctx) return;

    let state: AppState | null;
    try {
      state = await this.#deps.readAppState();
    } catch (error) {
      if (!abort.signal.aborted) {
        this.#api.logger.warn("Remarc Wake could not read Remarc data", {
          error: String(error),
        });
      }
      return;
    }
    if (!state || !sameLease(this.#lease, lease) || abort.signal.aborted) return;

    const reconciliation = {
      value: null as ReturnType<typeof reconcileOutbox> | null,
    };
    let leaseMismatch = false;
    let outcome;
    try {
      outcome = await this.#deps.leaseStore.patch(
        lease.markerId,
        lease.ownerToken,
        (marker) => {
          if (!ownsLease(marker, lease)) {
            leaseMismatch = true;
            return;
          }
          // Reconciliation is live runtime activity. Renew inside the same
          // directory-scoped lock as the outbox write so a stale-timer takeover
          // cannot fence this owner between persistence and sendMessage.
          patchHeartbeat(
            marker,
            lease,
            this.#deps.getDataFilePath(),
            ctx.sessionManager.getSessionFile() ?? null,
            this.#deps.now()
          );
          reconciliation.value = reconcileOutbox(
            marker,
            state as AppState,
            lease.remarcSessionId
          );
          marker.pendingWake = reconciliation.value.pendingWake;
          marker.wakedAt = reconciliation.value.wakedAt;
          if (reconciliation.value.changed) {
            marker.lastActivity = new Date(this.#deps.now()).toISOString();
          }
        },
        { signal: abort.signal }
      );
    } catch (error) {
      if (!abort.signal.aborted) {
        this.#api.logger.warn("Remarc Wake could not persist its outbox", {
          error: String(error),
        });
      }
      return;
    }
    if (abort.signal.aborted || !sameLease(this.#lease, lease)) return;
    const reconciled = reconciliation.value;
    if (outcome.kind !== "updated" || leaseMismatch || !reconciled) {
      this.#loseLease(lease, outcome.kind);
      return;
    }

    pruneOffered(this.#offered, reconciled.pendingWake);
    const payload = buildWakePayload(
      candidatesNotOffered(reconciled.candidates, this.#offered)
    );
    if (payload.included.length === 0 || !sameLease(this.#lease, lease)) return;

    try {
      this.#api.sendMessage<WakeMessageDetails>(
        {
          customType: "remarc-wake",
          content: payload.text,
          display: true,
          details: {
            protocolVersion: 1,
            remarcSessionId: lease.remarcSessionId,
            comments: payload.included,
          },
        },
        { deliverAs: "nextTurn", triggerTurn: true }
      );
      // A void return means only "queued". Durable pendingWake remains until
      // a later comments.json snapshot proves each comment left handedOff.
      for (const entry of payload.included) this.#offered.set(entry.id, entry.generation);
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not queue its pending wake", {
        error: String(error),
      });
    }
  }

  async #heartbeat(lease: ActiveLease): Promise<void> {
    if (!sameLease(this.#lease, lease)) return;
    const abort = this.#activityAbort;
    const ctx = this.#context;
    if (!abort || abort.signal.aborted || !ctx) return;
    try {
      const outcome = await this.#deps.leaseStore.patch(
        lease.markerId,
        lease.ownerToken,
        (marker) =>
          patchHeartbeat(
            marker,
            lease,
            this.#deps.getDataFilePath(),
            ctx.sessionManager.getSessionFile() ?? null,
            this.#deps.now()
          ),
        { signal: abort.signal }
      );
      if (!abort.signal.aborted && outcome.kind !== "updated") {
        this.#loseLease(lease, outcome.kind);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.#api.logger.warn("Remarc Wake heartbeat failed", {
          error: String(error),
        });
      }
    }
  }

  #loseLease(lease: ActiveLease, reason: string): void {
    if (!sameLease(this.#lease, lease)) return;
    this.#api.logger.warn("Remarc Wake stopped after losing marker ownership", {
      reason,
    });
    this.#stopLocal(false);
  }

  /** Local resources stop synchronously before any marker I/O begins. */
  #stopLocal(keepClosing: boolean): ActiveLease | null {
    const target = this.#lease ?? this.#provisional;
    this.#epoch += 1;
    this.#claimAbort?.abort();
    this.#claimAbort = null;
    this.#activityAbort?.abort();
    this.#activityAbort = null;
    this.#dirty = false;
    this.#lease = null;
    this.#provisional = null;
    this.#offered.clear();

    if (this.#watcher) {
      try {
        this.#watcher.close();
      } catch (error) {
        this.#api.logger.warn("Remarc Wake watcher cleanup failed", {
          error: String(error),
        });
      }
      this.#watcher = null;
    }
    if (this.#context && this.#heartbeatTimer) {
      this.#context.clearTimer(this.#heartbeatTimer);
    }
    if (this.#context && this.#pollTimer) {
      this.#context.clearTimer(this.#pollTimer);
    }
    this.#heartbeatTimer = null;
    this.#pollTimer = null;
    if (!keepClosing) this.#context = null;
    return target;
  }

  async #markStopped(lease: ActiveLease): Promise<void> {
    const now = this.#deps.now();
    try {
      await this.#deps.leaseStore.patch(
        lease.markerId,
        lease.ownerToken,
        (marker: Marker) => patchStoppedLease(marker, now),
        {
          timeoutMs: OMP_SHUTDOWN_CLEANUP_MS,
          deadlineMs: now + OMP_SHUTDOWN_CLEANUP_MS,
        }
      );
    } catch (error) {
      this.#api.logger.warn("Remarc Wake could not retire the previous OMP session lease", {
        error: String(error),
      });
    }
  }
}
