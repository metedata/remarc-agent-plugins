import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "./tools.js";
import {
  resetHarnessForTests,
  setHarnessFromArgv,
  setHarnessFromClientInfo,
} from "./harness.js";

type CreateSessionInput = {
  name: string;
  claude_session_id?: string;
  harness?: "claudeCode" | "codex";
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

type CreateSessionHandler = (input: CreateSessionInput) => Promise<ToolResult>;

let home: string;
let previousHome: string | undefined;
let dataFile: string;
let markerDir: string;
let createSession: CreateSessionHandler;

async function markerSnapshot(): Promise<Array<[string, Buffer]>> {
  const names = (await readdir(markerDir)).sort();
  return Promise.all(
    names.map(async (name) => [name, await readFile(join(markerDir, name))] as [string, Buffer])
  );
}

beforeEach(async () => {
  previousHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "remarc-omp-create-"));
  process.env.HOME = home;

  const remarcDir = join(home, "Library", "Application Support", "Remarc");
  markerDir = join(remarcDir, "claude", "markers");
  dataFile = join(remarcDir, "comments.json");
  await mkdir(markerDir, { recursive: true });

  // Deliberately preserve unusual formatting and unknown fields so a rejected
  // request has to leave the exact bytes untouched, not merely equivalent JSON.
  await writeFile(
    dataFile,
    '{"futureTop":{"keep":true},"sessions":[{"id":"S1","name":"Existing","createdAt":0,"isDeleted":false,"isAutoDismissed":false,"origin":"manual","futureSession":"keep"}],"comments":[{"id":"C1","commentText":"hello","source":"test","createdAt":0,"updatedAt":0,"sessionID":"S1","isDeleted":false,"status":"open","futureComment":"keep"}],"activeSessionID":"S1","totalCommentsCreated":1}\n'
  );
  await writeFile(join(markerDir, "sentinel.json"), '{"futureMarker":"keep"}\n');

  const fakeServer = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === "remarc_create_session") {
        createSession = handler as CreateSessionHandler;
      }
    },
  } as unknown as McpServer;

  registerTools(fakeServer);
  if (!createSession) throw new Error("remarc_create_session was not registered");
  setHarnessFromClientInfo({ name: "omp-coding-agent" });
});

afterEach(async () => {
  resetHarnessForTests();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe.sequential("OMP native session creation", () => {
  it.each([
    ["without a caller override", undefined],
    ["with a spoofed Claude Code override", "claudeCode" as const],
    ["with a spoofed Codex override", "codex" as const],
  ])("creates an OMP-labelled session %s", async (_label, harness) => {
    const markersBefore = await markerSnapshot();

    const result = await createSession({
      name: "Native OMP",
      ...(harness ? { harness } : {}),
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("/remarc-pair");

    const raw = JSON.parse(await readFile(dataFile, "utf8"));
    const created = raw.sessions.find((session: { name: string }) => session.name === "Native OMP");
    expect(created).toMatchObject({
      name: "Native OMP",
      origin: "omp",
      claudeCodeSessionId: null,
      isDeleted: false,
      isAutoDismissed: false,
    });
    expect(raw.activeSessionID).toBe(created.id);
    expect(raw.futureTop).toEqual({ keep: true });
    expect(raw.sessions[0].futureSession).toBe("keep");
    expect(raw.comments[0].futureComment).toBe("keep");
    expect(await markerSnapshot()).toEqual(markersBefore);
  });

  it("still requires the legacy agent session id outside OMP before writing", async () => {
    resetHarnessForTests();
    setHarnessFromArgv(["node", "index.js", "--harness", "claudeCode"]);
    const dataBefore = await readFile(dataFile);
    const markersBefore = await markerSnapshot();

    const result = await createSession({ name: "Missing ID" });

    expect(result).toEqual({
      content: [{
        type: "text",
        text: "claude_session_id is required when creating a Claude Code or Codex session.",
      }],
      isError: true,
    });
    expect(await readFile(dataFile)).toEqual(dataBefore);
    expect(await markerSnapshot()).toEqual(markersBefore);
  });

  it("preserves the Claude/Codex override path and legacy marker behavior", async () => {
    resetHarnessForTests();
    setHarnessFromArgv(["node", "index.js", "--harness", "claudeCode"]);

    const result = await createSession({
      name: "Nested Codex",
      claude_session_id: "codex-session-1",
      harness: "codex",
    });

    expect(result.isError).toBeUndefined();
    const raw = JSON.parse(await readFile(dataFile, "utf8"));
    const created = raw.sessions.find((session: { name: string }) => session.name === "Nested Codex");
    expect(created).toMatchObject({
      origin: "codex",
      claudeCodeSessionId: "codex-session-1",
    });
    const marker = JSON.parse(
      await readFile(join(markerDir, "codex-session-1.json"), "utf8")
    );
    expect(marker.remarcSessionId).toBe(created.id);
  });

  it("deduplicates and auto-dismisses sessions within the native OMP origin", async () => {
    for (let index = 0; index < 8; index += 1) {
      const result = await createSession({ name: "OMP Review" });
      expect(result.isError).toBeUndefined();
    }

    const raw = JSON.parse(await readFile(dataFile, "utf8"));
    const manual = raw.sessions.find((session: { id: string }) => session.id === "S1");
    const ompSessions = raw.sessions.filter((session: { origin: string }) => session.origin === "omp");
    expect(manual.isAutoDismissed).toBe(false);
    expect(ompSessions).toHaveLength(8);
    expect(ompSessions[0].isAutoDismissed).toBe(true);
    expect(ompSessions.slice(1).every((session: { isAutoDismissed: boolean }) => !session.isAutoDismissed))
      .toBe(true);
    expect(ompSessions.map((session: { name: string }) => session.name)).toEqual([
      "OMP Review",
      "OMP Review A",
      "OMP Review B",
      "OMP Review C",
      "OMP Review D",
      "OMP Review E",
      "OMP Review F",
      "OMP Review G",
    ]);
  });
});
