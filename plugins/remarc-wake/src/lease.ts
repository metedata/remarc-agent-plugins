import type {
  Marker,
  MarkerLockOptions,
  MarkerOwnerPatchOutcome,
  MarkerOwnerRemoveOutcome,
  MarkerReadOutcome,
} from "../../shared/marker.js";

export const OMP_MARKER_PROTOCOL_VERSION = 1;
export const OMP_HEARTBEAT_INTERVAL_MS = 10_000;
export const OMP_POLL_INTERVAL_MS = 15_000;
export const OMP_LEASE_TTL_MS = 60_000;
export const OMP_SHUTDOWN_CLEANUP_MS = 900;

export interface LeaseClaimRequest {
  markerId: string;
  remarcSessionId: string;
  dataFilePath: string;
  transcriptPath: string | null;
  ownerPid: number;
  ownerToken: string;
  now: number;
  /** Re-pairing deliberately resets delivery state from the old Remarc session. */
  resetDeliveryState?: boolean;
}

export type LeaseClaimOutcome =
  | { kind: "acquired"; marker: Marker }
  | { kind: "conflict"; ownerId: string; marker: Marker }
  | { kind: "invalid"; reason: string }
  | { kind: "unsafe"; reason: string };

export interface LeaseStore {
  read(markerId: string): Promise<MarkerReadOutcome>;
  claim(request: LeaseClaimRequest, options?: MarkerLockOptions): Promise<LeaseClaimOutcome>;
  patch(
    markerId: string,
    ownerToken: string,
    mutate: (marker: Marker) => void | Promise<void>,
    options?: MarkerLockOptions
  ): Promise<MarkerOwnerPatchOutcome>;
  remove(
    markerId: string,
    ownerToken: string,
    options?: MarkerLockOptions
  ): Promise<MarkerOwnerRemoveOutcome>;
}

export interface ActiveLease {
  markerId: string;
  remarcSessionId: string;
  ownerToken: string;
  ownerPid: number;
  epoch: number;
}

/** OMP currently mints UUID-like ids. Reject, rather than collision-prone clean. */
export function markerIdForOmpSession(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) {
    throw new Error("OMP session id is not safe for a Remarc marker");
  }
  return `omp-${sessionId}`;
}

/** At least 128 random bits represented as the shared layer's 32-char hex. */
export function assertOwnerToken(ownerToken: string): void {
  if (!/^[0-9a-f]{32,}$/i.test(ownerToken)) {
    throw new Error("Remarc Wake owner token must contain at least 128 random bits");
  }
}

export function canResumeOmpMarker(
  outcome: MarkerReadOutcome
): outcome is Extract<MarkerReadOutcome, { kind: "valid" }> {
  return (
    outcome.kind === "valid" &&
    outcome.source === "json" &&
    outcome.marker.protocolVersion === OMP_MARKER_PROTOCOL_VERSION &&
    outcome.marker.harness === "omp" &&
    outcome.marker.remarcSessionId.length > 0
  );
}

export function patchHeartbeat(
  marker: Marker,
  lease: ActiveLease,
  dataFilePath: string,
  transcriptPath: string | null,
  now: number
): void {
  const stamp = new Date(now).toISOString();
  marker.protocolVersion = OMP_MARKER_PROTOCOL_VERSION;
  marker.harness = "omp";
  marker.remarcSessionId = lease.remarcSessionId;
  marker.dataFilePath = dataFilePath;
  marker.transcriptPath = transcriptPath;
  marker.wakeCapable = true;
  marker.lastActivity = stamp;
  marker.ownerPid = lease.ownerPid;
  marker.ownerToken = lease.ownerToken;
  marker.leaseHeartbeatAt = stamp;
}

/**
 * Keep the explicit pairing/outbox for resume while making reachability fail
 * immediately. The CAS token stays unchanged because the shared owner patch
 * contract intentionally forbids a mutator from swapping its own guard key.
 */
export function patchStoppedLease(marker: Marker, now: number): void {
  marker.wakeCapable = false;
  marker.lastActivity = new Date(now).toISOString();
  marker.leaseHeartbeatAt = new Date(now - OMP_LEASE_TTL_MS - 1).toISOString();
}

export function ownsLease(marker: Marker, lease: ActiveLease): boolean {
  return (
    marker.protocolVersion === OMP_MARKER_PROTOCOL_VERSION &&
    marker.harness === "omp" &&
    marker.remarcSessionId === lease.remarcSessionId &&
    marker.ownerToken === lease.ownerToken &&
    marker.ownerPid === lease.ownerPid &&
    marker.wakeCapable === true
  );
}
