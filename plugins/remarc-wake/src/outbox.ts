import type { AppState, Comment } from "../../shared/data.js";
import type { Marker } from "../../shared/marker.js";
import {
  selectWakeCandidatesForSession,
  wakeGeneration,
  type WakeCandidate,
} from "../../shared/wake.js";

export type WakeGenerationMap = Record<string, number>;

export interface OutboxReconciliation {
  /** Durable entries which must survive until their comment leaves handedOff. */
  pendingWake: WakeGenerationMap | null;
  /** Generations proven complete by durable Remarc state. */
  wakedAt: WakeGenerationMap;
  /** Current payload material for pending/new generations. */
  candidates: WakeCandidate[];
  changed: boolean;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Normalize untrusted marker content into stable, finite, per-comment entries.
 * Invalid outbox values are not durable wake promises and are dropped.
 */
export function normalizeGenerations(value: unknown): WakeGenerationMap {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        (entry): entry is [string, number] =>
          entry[0].length > 0 && finiteGeneration(entry[1])
      )
      .sort(([a], [b]) => compareText(a, b))
  );
}

function sameGenerations(a: WakeGenerationMap, b: WakeGenerationMap): boolean {
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  return (
    aEntries.length === bEntries.length &&
    aEntries.every(([id, generation], index) => {
      const other = bEntries[index];
      return other?.[0] === id && other[1] === generation;
    })
  );
}

function commentsById(state: AppState): Map<string, Comment[]> {
  const result = new Map<string, Comment[]>();
  for (const comment of state.comments) {
    const existing = result.get(comment.id);
    if (existing) existing.push(comment);
    else result.set(comment.id, [comment]);
  }
  return result;
}

function stillAwaitingClaim(comments: readonly Comment[]): boolean {
  return comments.some((comment) => !comment.isDeleted && comment.status === "handedOff");
}

function newestHandedOffGeneration(comments: readonly Comment[]): number | null {
  let newest: number | null = null;
  for (const comment of comments) {
    if (comment.isDeleted || comment.status !== "handedOff") continue;
    const generation = wakeGeneration(comment);
    if (generation != null && (newest == null || generation > newest)) newest = generation;
  }
  return newest;
}

/**
 * Reconcile durable delivery state with Remarc's authoritative document.
 *
 * A pending entry is never cleared because OMP emitted or displayed a message.
 * It advances to `wakedAt` only after the correlated comment is absent, deleted,
 * or no longer `handedOff`. A later explicit wake generation replaces the older
 * pending generation and is offered independently.
 */
export function reconcileOutbox(
  marker: Pick<Marker, "pendingWake" | "wakedAt">,
  state: AppState,
  remarcSessionId: string
): OutboxReconciliation {
  const originalPending = normalizeGenerations(marker.pendingWake);
  const originalWakedAt = normalizeGenerations(marker.wakedAt);
  const pendingWake = { ...originalPending };
  const wakedAt = { ...originalWakedAt };
  const records = commentsById(state);

  for (const [id, pendingGeneration] of Object.entries(pendingWake)) {
    const correlated = records.get(id) ?? [];
    if (!stillAwaitingClaim(correlated)) {
      wakedAt[id] = Math.max(wakedAt[id] ?? Number.NEGATIVE_INFINITY, pendingGeneration);
      delete pendingWake[id];
      continue;
    }

    const laterGeneration = newestHandedOffGeneration(correlated);
    if (laterGeneration != null && laterGeneration > pendingGeneration) {
      pendingWake[id] = laterGeneration;
    }
  }

  const candidates = selectWakeCandidatesForSession(state, remarcSessionId, wakedAt);
  for (const candidate of candidates) {
    const pendingGeneration = pendingWake[candidate.id];
    if (pendingGeneration == null || candidate.generation > pendingGeneration) {
      pendingWake[candidate.id] = candidate.generation;
    }
  }

  const stablePending = normalizeGenerations(pendingWake);
  const stableWakedAt = normalizeGenerations(wakedAt);
  const currentCandidates = candidates.filter(
    (candidate) => stablePending[candidate.id] === candidate.generation
  );

  return {
    pendingWake: Object.keys(stablePending).length > 0 ? stablePending : null,
    wakedAt: stableWakedAt,
    candidates: currentCandidates,
    changed:
      !sameGenerations(originalPending, stablePending) ||
      !sameGenerations(originalWakedAt, stableWakedAt) ||
      (marker.pendingWake === null) !== (Object.keys(stablePending).length === 0),
  };
}

/** Offer only generations not already queued by this live extension instance. */
export function candidatesNotOffered(
  candidates: readonly WakeCandidate[],
  offered: ReadonlyMap<string, number>
): WakeCandidate[] {
  return candidates.filter((candidate) => offered.get(candidate.id) !== candidate.generation);
}

/** Drop ephemeral suppression once durable state no longer has that exact entry. */
export function pruneOffered(
  offered: Map<string, number>,
  pendingWake: WakeGenerationMap | null
): void {
  const pending = pendingWake ?? {};
  for (const [id, generation] of offered) {
    if (pending[id] !== generation) offered.delete(id);
  }
}
