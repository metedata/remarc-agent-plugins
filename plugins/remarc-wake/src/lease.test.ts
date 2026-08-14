import { describe, expect, it } from "vitest";
import type { Marker } from "../../shared/marker.js";
import {
  OMP_HEARTBEAT_INTERVAL_MS,
  OMP_POLL_INTERVAL_MS,
  OMP_SHUTDOWN_CLEANUP_MS,
  assertOwnerToken,
  canResumeOmpMarker,
  markerIdForOmpSession,
  patchHeartbeat,
  patchStoppedLease,
} from "./lease.js";

function marker(overrides: Partial<Marker> = {}): Marker {
  return {
    remarcSessionId: "R1",
    dataFilePath: "/tmp/comments.json",
    transcriptPath: "/tmp/omp.jsonl",
    wakeCapable: true,
    lastActivity: new Date(1000).toISOString(),
    deliveredIds: [],
    wakedAt: {},
    protocolVersion: 1,
    harness: "omp",
    ownerPid: 42,
    ownerToken: "a".repeat(32),
    leaseHeartbeatAt: new Date(1000).toISOString(),
    ...overrides,
  };
}

describe("OMP lease helpers", () => {
  it("uses safe, non-normalized marker ids", () => {
    expect(markerIdForOmpSession("session_A-12")).toBe("omp-session_A-12");
    expect(() => markerIdForOmpSession("../escape")).toThrow(/not safe/);
    expect(() => markerIdForOmpSession("x".repeat(121))).toThrow(/not safe/);
  });

  it("requires at least 128 bits of hex owner-token material", () => {
    expect(() => assertOwnerToken("0".repeat(32))).not.toThrow();
    expect(() => assertOwnerToken("0".repeat(31))).toThrow(/128/);
    expect(() => assertOwnerToken("z".repeat(32))).toThrow(/128/);
  });

  it("resumes only paired v1 JSON OMP markers", () => {
    expect(canResumeOmpMarker({ kind: "valid", source: "json", marker: marker() })).toBe(true);
    expect(
      canResumeOmpMarker({ kind: "valid", source: "legacy", marker: marker() })
    ).toBe(false);
    expect(
      canResumeOmpMarker({
        kind: "valid",
        source: "json",
        marker: marker({ protocolVersion: 2 }),
      })
    ).toBe(false);
    expect(
      canResumeOmpMarker({
        kind: "valid",
        source: "json",
        marker: marker({ remarcSessionId: "" }),
      })
    ).toBe(false);
  });

  it("refreshes all lease identity fields and retires reachability without PID fallback", () => {
    const value = marker({ remarcSessionId: "OLD", ownerPid: 7 });
    patchHeartbeat(
      value,
      {
        markerId: "omp-S1",
        remarcSessionId: "R2",
        ownerToken: "b".repeat(32),
        ownerPid: 99,
        epoch: 3,
      },
      "/new/comments.json",
      "/new/session.jsonl",
      50_000
    );
    expect(value).toMatchObject({
      protocolVersion: 1,
      harness: "omp",
      remarcSessionId: "R2",
      ownerToken: "b".repeat(32),
      ownerPid: 99,
      dataFilePath: "/new/comments.json",
      transcriptPath: "/new/session.jsonl",
      wakeCapable: true,
      leaseHeartbeatAt: new Date(50_000).toISOString(),
    });

    patchStoppedLease(value, 60_000);
    expect(value.wakeCapable).toBe(false);
    expect(Date.parse(value.leaseHeartbeatAt as string)).toBeLessThan(60_000 - 60_000);
    expect(value.ownerToken).toBe("b".repeat(32));
  });

  it("keeps managed cadence and shutdown cleanup inside protocol limits", () => {
    expect(OMP_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(15_000);
    expect(OMP_POLL_INTERVAL_MS).toBeLessThanOrEqual(15_000);
    expect(OMP_SHUTDOWN_CLEANUP_MS).toBeLessThanOrEqual(900);
  });
});
