import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "./tools.js";
import { resetHarnessForTests, setHarnessFromArgv } from "./harness.js";

type CreateSessionInput = {
  name: string;
  claude_session_id: string;
  harness?: "claudeCode" | "codex";
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

type CreateSessionHandler = (input: CreateSessionInput) => Promise<ToolResult>;

const ERROR_TEXT =
  "OMP cannot create Remarc sessions yet. Create or select a session in the Remarc app, then use remarc_list_sessions to reuse it.";

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
  setHarnessFromArgv(["node", "index.js", "--harness", "omp"]);
});

afterEach(async () => {
  resetHarnessForTests();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe.sequential("OMP session-creation guard", () => {
  it.each([
    ["without a caller override", undefined],
    ["with a spoofed Claude Code override", "claudeCode" as const],
    ["with a spoofed Codex override", "codex" as const],
  ])("rejects %s before touching Remarc data", async (_label, harness) => {
    const dataBefore = await readFile(dataFile);
    const markersBefore = await markerSnapshot();

    const result = await createSession({
      name: "Wrong Origin",
      claude_session_id: "omp-session-1",
      ...(harness ? { harness } : {}),
    });

    expect(result).toEqual({
      content: [{ type: "text", text: ERROR_TEXT }],
      isError: true,
    });
    expect(await readFile(dataFile)).toEqual(dataBefore);
    expect(await markerSnapshot()).toEqual(markersBefore);
  });

  it("returns immediately even when the document transaction is held", async () => {
    const lockDir = `${dataFile}.lock`;
    await mkdir(lockDir);
    const ownerBytes = Buffer.from(JSON.stringify({ pid: process.pid, at: Date.now() }));
    await writeFile(join(lockDir, "owner.json"), ownerBytes);
    const dataBefore = await readFile(dataFile);

    const result = await Promise.race([
      createSession({
        name: "Spoof Attempt",
        claude_session_id: "omp-session-2",
        harness: "claudeCode",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OMP guard entered the document transaction")), 250)
      ),
    ]);

    expect(result).toEqual({
      content: [{ type: "text", text: ERROR_TEXT }],
      isError: true,
    });
    expect(await readFile(dataFile)).toEqual(dataBefore);
    expect(await readFile(join(lockDir, "owner.json"))).toEqual(ownerBytes);
  });
});
