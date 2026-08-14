import { describe, expect, it } from "vitest";
import type { AppState, Comment, CommentStatus } from "../../shared/data.js";
import {
  candidatesNotOffered,
  normalizeGenerations,
  pruneOffered,
  reconcileOutbox,
} from "./outbox.js";

function comment(
  id: string,
  generation: number | null,
  status: CommentStatus = "handedOff",
  overrides: Partial<Comment> = {}
): Comment {
  return {
    id,
    shortID: id.slice(0, 5).toLowerCase(),
    type: { quickNote: {} },
    commentText: `Comment ${id}`,
    source: "test",
    appBundleID: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    sessionID: "S1",
    isDeleted: false,
    deletedAt: null,
    status,
    resolutionSummary: null,
    resolvedBy: null,
    resolvedAt: null,
    attachments: [],
    webContext: null,
    regionElements: null,
    wakeRequestedAt: generation == null ? null : new Date(generation),
    unknownFields: {},
    ...overrides,
  };
}

function state(comments: Comment[]): AppState {
  return {
    sessions: [
      {
        id: "S1",
        name: "Design pass",
        createdAt: new Date(0),
        isDeleted: false,
        deletedAt: null,
        isAutoDismissed: false,
        autoDismissedAt: null,
        origin: "manual",
        claudeCodeSessionId: null,
        unknownFields: {},
      },
    ],
    comments,
    activeSessionID: "S1",
    totalCommentsCreated: comments.length,
    unknownFields: {},
  };
}

describe("durable OMP wake outbox", () => {
  it("filters malformed generations and orders valid keys deterministically", () => {
    expect(
      normalizeGenerations({ z: 3, nope: Number.NaN, a: 1, bad: "2", inf: Infinity })
    ).toEqual({ a: 1, z: 3 });
    expect(normalizeGenerations(null)).toEqual({});
    expect(normalizeGenerations([])).toEqual({});
  });

  it("records a new generation in pendingWake before exposing it for delivery", () => {
    const result = reconcileOutbox({ pendingWake: null, wakedAt: {} }, state([comment("C1", 100)]), "S1");

    expect(result.pendingWake).toEqual({ C1: 100 });
    expect(result.wakedAt).toEqual({});
    expect(result.candidates.map(({ id, generation }) => ({ id, generation }))).toEqual([
      { id: "C1", generation: 100 },
    ]);
    expect(result.changed).toBe(true);
  });

  it("does not treat message enqueue or turn completion as a durable receipt", () => {
    const result = reconcileOutbox(
      { pendingWake: { C1: 100 }, wakedAt: {} },
      state([comment("C1", 100)]),
      "S1"
    );

    expect(result.pendingWake).toEqual({ C1: 100 });
    expect(result.wakedAt).toEqual({});
    expect(result.candidates).toHaveLength(1);
    expect(result.changed).toBe(false);
  });

  it.each(["open", "inProgress", "resolved"] as const)(
    "clears pending and advances history only after status becomes %s",
    (status) => {
      const result = reconcileOutbox(
        { pendingWake: { C1: 100 }, wakedAt: {} },
        state([comment("C1", 100, status)]),
        "S1"
      );

      expect(result.pendingWake).toBeNull();
      expect(result.wakedAt).toEqual({ C1: 100 });
      expect(result.candidates).toEqual([]);
    }
  );

  it("settles a pending generation after deletion or hard removal", () => {
    const deleted = reconcileOutbox(
      { pendingWake: { C1: 100 }, wakedAt: {} },
      state([comment("C1", 100, "handedOff", { isDeleted: true })]),
      "S1"
    );
    const missing = reconcileOutbox(
      { pendingWake: { C1: 100 }, wakedAt: {} },
      state([]),
      "S1"
    );

    expect(deleted.pendingWake).toBeNull();
    expect(deleted.wakedAt).toEqual({ C1: 100 });
    expect(missing.pendingWake).toBeNull();
    expect(missing.wakedAt).toEqual({ C1: 100 });
  });

  it("upgrades a still-pending comment to a later explicit wake generation", () => {
    const result = reconcileOutbox(
      { pendingWake: { C1: 100 }, wakedAt: { C1: 50 } },
      state([comment("C1", 200)]),
      "S1"
    );

    expect(result.pendingWake).toEqual({ C1: 200 });
    expect(result.wakedAt).toEqual({ C1: 50 });
    expect(result.candidates[0]?.generation).toBe(200);
  });

  it("deduplicates a completed generation but accepts a later one", () => {
    const same = reconcileOutbox(
      { pendingWake: null, wakedAt: { C1: 100 } },
      state([comment("C1", 100)]),
      "S1"
    );
    const later = reconcileOutbox(
      { pendingWake: null, wakedAt: { C1: 100 } },
      state([comment("C1", 101)]),
      "S1"
    );

    expect(same.candidates).toEqual([]);
    expect(same.pendingWake).toBeNull();
    expect(later.pendingWake).toEqual({ C1: 101 });
    expect(later.candidates).toHaveLength(1);
  });

  it("never offers a pending comment from another Remarc session", () => {
    const result = reconcileOutbox(
      { pendingWake: { OTHER: 100 }, wakedAt: {} },
      state([comment("OTHER", 100, "handedOff", { sessionID: "S2" })]),
      "S1"
    );

    expect(result.pendingWake).toEqual({ OTHER: 100 });
    expect(result.candidates).toEqual([]);
  });

  it("suppresses only exact generations offered by this live process", () => {
    const first = reconcileOutbox(
      { pendingWake: null, wakedAt: {} },
      state([comment("C1", 100), comment("C2", 200)]),
      "S1"
    );
    const offered = new Map<string, number>([["C1", 100]]);

    expect(candidatesNotOffered(first.candidates, offered).map((candidate) => candidate.id)).toEqual([
      "C2",
    ]);

    pruneOffered(offered, { C1: 101 });
    expect(offered.size).toBe(0);
  });
});
