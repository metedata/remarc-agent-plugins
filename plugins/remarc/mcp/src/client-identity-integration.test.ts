import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindHarnessToMcpServer, resetHarnessForTests } from "./harness.js";
import { registerTools } from "./tools.js";

let home: string;
let previousHome: string | undefined;
let dataFile: string;
let client: Client | undefined;
let server: McpServer | undefined;

async function connect(clientName: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = new McpServer({ name: "remarc-test", version: "0.0.0" });
  bindHarnessToMcpServer(server.server);
  registerTools(server);
  client = new Client({ name: clientName, version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

beforeEach(async () => {
  resetHarnessForTests();
  previousHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "remarc-client-identity-"));
  process.env.HOME = home;

  const remarcDirectory = join(home, "Library", "Application Support", "Remarc");
  await mkdir(remarcDirectory, { recursive: true });
  dataFile = join(remarcDirectory, "comments.json");
  await writeFile(
    dataFile,
    JSON.stringify({
      sessions: [],
      comments: [],
      activeSessionID: null,
      totalCommentsCreated: 0,
    })
  );
});

afterEach(async () => {
  if (client) await client.close().catch(() => undefined);
  if (server) await server.close().catch(() => undefined);
  client = undefined;
  server = undefined;
  resetHarnessForTests();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe.sequential("MCP client identity", () => {
  it("creates a Codex session from Codex's initialize identity", async () => {
    const connected = await connect("codex-mcp-client");
    const result = await connected.callTool({
      name: "remarc_create_session",
      arguments: {
        name: "Codex Handshake",
        claude_session_id: "codex-thread-1",
      },
    });

    expect(result.isError).not.toBe(true);
    const document = JSON.parse(await readFile(dataFile, "utf8"));
    expect(document.sessions[0]).toMatchObject({
      name: "Codex Handshake",
      origin: "codex",
      claudeCodeSessionId: "codex-thread-1",
    });
  });

  it("keeps OMP authoritative over a model-controlled Codex override", async () => {
    const connected = await connect("omp-coding-agent");
    const result = await connected.callTool({
      name: "remarc_create_session",
      arguments: {
        name: "OMP Handshake",
        claude_session_id: "spoofed-session-id",
        harness: "codex",
      },
    });

    expect(result.isError).not.toBe(true);
    const document = JSON.parse(await readFile(dataFile, "utf8"));
    expect(document.sessions[0]).toMatchObject({
      name: "OMP Handshake",
      origin: "omp",
      claudeCodeSessionId: null,
    });
  });
});
