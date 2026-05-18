import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer(
  {
    name: "remarc",
    version: "0.1.0",
  },
  {
    instructions:
      "Remarc is a macOS contextual commenting app. Comments have short IDs (first 5 UUID chars, e.g. 'a3f2b'). After addressing a comment, call remarc_set_status with status \"resolved\" and a brief summary of what you did. When resolving multiple comments, use remarc_bulk_set_status to save context.",
  }
);

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Remarc MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
