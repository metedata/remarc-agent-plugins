import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetHarnessForTests, setHarnessFromArgv, type Harness } from "./harness.js";
import { registerTools } from "./tools.js";

type SetStatusHandler = (input: {
  id: string;
  status: "resolved";
  summary: string;
  expected_status: "handedOff";
}) => Promise<{ isError?: true }>;

let home: string;
let previousHome: string | undefined;
let dataFile: string;
let setStatus: SetStatusHandler;

beforeEach(async () => {
  previousHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "remarc-resolution-attribution-"));
  process.env.HOME = home;

  const remarcDirectory = join(home, "Library", "Application Support", "Remarc");
  await mkdir(remarcDirectory, { recursive: true });
  dataFile = join(remarcDirectory, "comments.json");
  await writeFile(
    dataFile,
    JSON.stringify({
      futureTop: { keep: true },
      sessions: [
        {
          id: "S1",
          name: "Existing",
          createdAt: 0,
          isDeleted: false,
          isAutoDismissed: false,
          origin: "manual",
          futureSession: "keep",
        },
      ],
      comments: [
        {
          id: "COMMENT-1",
          type: { quickNote: {} },
          commentText: "Address me",
          source: "test",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "S1",
          isDeleted: false,
          status: "handedOff",
          futureComment: "keep",
        },
      ],
      activeSessionID: "S1",
      totalCommentsCreated: 1,
    })
  );

  const fakeServer = {
    registerTool(name: string, _config: unknown, handler: unknown) {
      if (name === "remarc_set_status") setStatus = handler as SetStatusHandler;
    },
  } as unknown as McpServer;
  registerTools(fakeServer);
  if (!setStatus) throw new Error("remarc_set_status was not registered");
});

afterEach(async () => {
  resetHarnessForTests();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe.sequential("resolution attribution", () => {
  it.each<[Harness, string]>([
    ["claudeCode", "claude"],
    ["codex", "codex"],
    ["omp", "omp"],
  ])("attributes %s resolutions to %s", async (harness, expectedResolver) => {
    setHarnessFromArgv(["node", "index.js", "--harness", harness]);

    const result = await setStatus({
      id: "COMMENT-1",
      status: "resolved",
      summary: "Completed in the test harness",
      expected_status: "handedOff",
    });

    expect(result.isError).toBeUndefined();
    const document = JSON.parse(await readFile(dataFile, "utf8"));
    expect(document.comments[0].resolvedBy).toBe(expectedResolver);
    expect(document.futureTop).toEqual({ keep: true });
    expect(document.sessions[0].futureSession).toBe("keep");
    expect(document.comments[0].futureComment).toBe("keep");
  });
});
