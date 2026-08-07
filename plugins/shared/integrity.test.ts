import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withDocument, SKIP_WRITE } from "./data.js";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The data layer resolves its file path from `homedir()`, which reads $HOME on
 * every call, so each test just points HOME at a throwaway directory.
 */
let home: string;
let dataFile: string;

function baseDoc(extra: Record<string, unknown> = {}) {
  return {
    sessions: [
      {
        id: "S1",
        name: "Inbox",
        createdAt: 0,
        isDeleted: false,
        isAutoDismissed: false,
        origin: "manual",
        futureSessionField: "keep me",
      },
    ],
    comments: [
      {
        id: "C1",
        commentText: "hello",
        source: "test",
        createdAt: 0,
        updatedAt: 0,
        sessionID: "S1",
        isDeleted: false,
        status: "handedOff",
        futureCommentField: { nested: true },
      },
    ],
    activeSessionID: "S1",
    totalCommentsCreated: 1,
    // Real fields the Swift app persists that the TS layer does not model.
    orphanedImages: ["/tmp/a.png"],
    transcriptions: [{ id: "T1", text: "spoken" }],
    ...extra,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "remarc-integrity-"));
  process.env.HOME = home;
  const dir = join(home, "Library", "Application Support", "Remarc");
  await mkdir(dir, { recursive: true });
  dataFile = join(dir, "comments.json");
  await writeFile(dataFile, JSON.stringify(baseDoc(), null, 2));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("unknown-field passthrough", () => {
  it("preserves unmodeled top-level, session, and comment fields on write", async () => {

    await withDocument((state) => {
      state.comments[0].status = "inProgress";
    });

    const doc = JSON.parse(await readFile(dataFile, "utf8"));
    // The bug this guards: these disappeared on every plugin write.
    expect(doc.orphanedImages).toEqual(["/tmp/a.png"]);
    expect(doc.transcriptions).toEqual([{ id: "T1", text: "spoken" }]);
    expect(doc.sessions[0].futureSessionField).toBe("keep me");
    expect(doc.comments[0].futureCommentField).toEqual({ nested: true });
    // And the intended mutation landed.
    expect(doc.comments[0].status).toBe("inProgress");
  });

  it("round-trips wakeRequestedAt", async () => {
    const stamp = 800000000;
    await writeFile(
      dataFile,
      JSON.stringify(
        baseDoc({ comments: [{ ...baseDoc().comments[0], wakeRequestedAt: stamp }] })
      )
    );

    await withDocument((state) => {
      expect(state.comments[0].wakeRequestedAt).toBeInstanceOf(Date);
      state.comments[0].commentText = "touched";
    });

    const doc = JSON.parse(await readFile(dataFile, "utf8"));
    expect(doc.comments[0].wakeRequestedAt).toBeCloseTo(stamp, 3);
  });
});

describe("withDocument transaction", () => {
  it("serializes concurrent mutations without losing updates", async () => {

    // Each writer reads, waits, then mutates a distinct field. Without a lock
    // spanning read-through-write, the later writer's snapshot would predate
    // the earlier commit and erase it.
    const writers = [
      withDocument(async (state) => {
        await new Promise((r) => setTimeout(r, 20));
        state.comments[0].commentText = "from-writer-A";
      }),
      withDocument(async (state) => {
        await new Promise((r) => setTimeout(r, 20));
        state.totalCommentsCreated = 42;
      }),
      withDocument(async (state) => {
        await new Promise((r) => setTimeout(r, 20));
        state.sessions[0].name = "Renamed";
      }),
    ];
    await Promise.all(writers);

    const doc = JSON.parse(await readFile(dataFile, "utf8"));
    expect(doc.comments[0].commentText).toBe("from-writer-A");
    expect(doc.totalCommentsCreated).toBe(42);
    expect(doc.sessions[0].name).toBe("Renamed");
  });

  it("releases the lock when the mutator throws", async () => {

    await expect(
      withDocument(() => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // A subsequent transaction must not block on an orphaned lock.
    await withDocument((state) => {
      state.totalCommentsCreated = 7;
    });
    const doc = JSON.parse(await readFile(dataFile, "utf8"));
    expect(doc.totalCommentsCreated).toBe(7);
  });

  it("does not write when the mutator returns SKIP_WRITE", async () => {
    const before = await readFile(dataFile, "utf8");

    await withDocument((state) => {
      state.comments[0].commentText = "should not persist";
      return SKIP_WRITE;
    });

    expect(await readFile(dataFile, "utf8")).toBe(before);
  });

  it("reclaims a lock abandoned by a dead process", async () => {
    const lockPath = dataFile + ".lock";
    await mkdir(lockPath, { recursive: true });
    // pid 999999 is not running; the holder is gone.
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 999999, at: Date.now() })
    );

    await withDocument((state) => {
      state.totalCommentsCreated = 99;
    });

    const doc = JSON.parse(await readFile(dataFile, "utf8"));
    expect(doc.totalCommentsCreated).toBe(99);
  });

  it("uses unique temp files so concurrent writers cannot collide", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withDocument((state) => {
          state.totalCommentsCreated = i;
        })
      )
    );
    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(join(home, "Library", "Application Support", "Remarc")))
      .filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("compare-and-set status claim", () => {
  it("lets exactly one of two concurrent claimers win", async () => {
    // Mirrors two agents woken for the same comment: both read `handedOff`,
    // both try to claim. Without expectedStatus inside the transaction, both
    // would succeed and two agents would work the same comment.
    const claim = () =>
      withDocument((state) => {
        const c = state.comments.find((x) => x.id === "C1")!;
        if (c.status !== "handedOff") return { won: false };
        c.status = "inProgress";
        return { won: true };
      });

    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.filter((r) => r.won)).toHaveLength(1);

    const doc = JSON.parse(await readFile(dataFile, "utf8"));
    expect(doc.comments[0].status).toBe("inProgress");
  });

  it("preserves unmodeled fields through a claim", async () => {
    await withDocument((state) => {
      const c = state.comments.find((x) => x.id === "C1")!;
      c.status = "inProgress";
    });
    const doc = JSON.parse(await readFile(dataFile, "utf8"));
    expect(doc.transcriptions).toEqual([{ id: "T1", text: "spoken" }]);
    expect(doc.comments[0].futureCommentField).toEqual({ nested: true });
  });
});
