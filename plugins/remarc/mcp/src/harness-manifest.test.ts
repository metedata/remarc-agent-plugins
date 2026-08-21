import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type McpManifest = {
  mcpServers: {
    remarc: {
      args: string[];
    };
  };
};

async function readManifest(relativePath: string): Promise<McpManifest> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8")
  ) as McpManifest;
}

describe("harness manifests", () => {
  it("keeps the portable Agent Plugins launcher harness-neutral", async () => {
    const manifest = await readManifest("../../mcp.json");
    expect(manifest.mcpServers.remarc.args).toEqual([
      "${PLUGIN_ROOT}/mcp/dist/index.js",
    ]);
  });

  it("keeps the legacy Codex-specific launcher explicit", async () => {
    const manifest = await readManifest("../../codex-mcp.json");
    expect(manifest.mcpServers.remarc.args).toEqual([
      "mcp/dist/index.js",
      "--harness",
      "codex",
    ]);
  });
});
