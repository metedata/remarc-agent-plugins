import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";
import { MAX_INLINE_IMAGES, MAX_SCREENSHOT_BYTES } from "./screenshot.js";

// The actual data layer reads/writes a fixture home without changing the host
// environment. Notifications must not reload the user's running Remarc app.
const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => fixture.home,
}));
vi.mock("./notify.js", () => ({ notifyRemarcReload: vi.fn(async () => undefined) }));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
  "base64"
);
let root: string;
let images: string;
let custom: string;
let dataFile: string;
let client: Client;
let server: McpServer;
const sessionID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "remarc-comment-images-"));
  fixture.home = join(root, "home");
  const dataDirectory = join(fixture.home, "Library", "Application Support", "Remarc");
  images = join(dataDirectory, "images");
  custom = join(root, "Design review (screenshots)");
  dataFile = join(dataDirectory, "comments.json");
  await mkdir(images, { recursive: true });
  await mkdir(custom, { recursive: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = new McpServer({ name: "remarc-images-test", version: "0.0.0" });
  registerTools(server);
  client = new Client({ name: "remarc-images-test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
  fixture.home = "";
});

async function image(directory: string, name: string, bytes = PNG): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

async function saveComment(type: object, attachments: string[] = []): Promise<string> {
  const id = randomUUID();
  await writeFile(dataFile, JSON.stringify({
    sessions: [{ id: sessionID, name: "Image review", createdAt: 0, isDeleted: false, isAutoDismissed: false }],
    comments: [{
      id, type, commentText: "Review these images", source: "Remarc", appBundleID: null,
      createdAt: 0, updatedAt: 0, sessionID, isDeleted: false, status: "open", attachments,
    }],
    activeSessionID: sessionID, totalCommentsCreated: 1,
  }));
  return id;
}

async function getComment(id: string): Promise<CallToolResult> {
  const result = await client.callTool({ name: "remarc_get_comment", arguments: { id } }) as CallToolResult;
  expect(result.isError).not.toBe(true);
  return result;
}

function imageBlocks(result: CallToolResult) {
  return result.content.filter((block) => block.type === "image");
}

function text(result: CallToolResult): string {
  return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

describe.sequential("comment image delivery through MCP", () => {
  it.each(["relative", "absolute"])("returns real screenshot bytes for a %s path", async (kind) => {
    const absolute = await image(kind === "relative" ? images : custom, "capture.png");
    const stored = kind === "relative" ? "images/capture.png" : absolute;
    const id = await saveComment({ screenshot: { imagePath: stored } });
    const before = await readFile(dataFile);
    const result = await getComment(id);
    expect(imageBlocks(result)).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
    expect(text(result)).toContain(`Image Path: ${absolute}`);
    expect(await readFile(dataFile)).toEqual(before);
  });

  it.each(["quickNote", "comment"])("delivers pasted attachments on %s comments", async (kind) => {
    const path = await image(custom, "pasted.png");
    const type = kind === "comment" ? { comment: { text: "Selected text" } } : { quickNote: {} };
    const id = await saveComment(type, [path]);
    const result = await getComment(id);
    expect(imageBlocks(result)[0]?.data).toBe(PNG.toString("base64"));
    expect(text(result)).toContain(`Attachment 1 Path: ${path}`);
    expect(text(result)).toContain(`Attachment 1 (${path}) is attached below.`);

    const listed = await client.callTool({ name: "remarc_list_comments", arguments: {} }) as CallToolResult;
    expect(imageBlocks(listed)).toHaveLength(0);
    expect(text(listed)).toContain("Attachments: 1 (call remarc_get_comment to inspect)");
  });

  it("keeps mixed roots, primary-first labels, deduplication and sidecar exclusion", async () => {
    const primary = await image(images, "capture.png");
    const attachment = await image(custom, "pasted.png");
    await image(custom, "pasted.base.png", Buffer.from("must not be read"));
    await writeFile(join(custom, "pasted.marks.json"), "must not be read");
    const id = await saveComment({ screenshot: { imagePath: "images/capture.png" } }, [attachment, primary, attachment]);
    const result = await getComment(id);
    expect(imageBlocks(result)).toHaveLength(2);
    expect(result.content.map((block) => block.type)).toEqual(["text", "text", "image", "text", "image", "text", "text"]);
    expect(text(result)).toContain("Screenshot (");
    expect(text(result)).toContain("Attachment 2: same file as Screenshot");
    expect(text(result)).toContain("Attachment 3: same file as Attachment 1");
    expect(text(result)).not.toContain("must not be read");

    await client.callTool({ name: "remarc_set_status", arguments: { id, status: "inProgress" } });
    const saved = JSON.parse(await readFile(dataFile, "utf8"));
    expect(saved.comments[0].type.screenshot.imagePath).toBe("images/capture.png");
    expect(saved.comments[0].attachments).toEqual([attachment, primary, attachment]);
  });

  it("reports bad paths independently and still delivers a later valid attachment", async () => {
    const missing = join(custom, "missing.png");
    const unsupported = await image(custom, "notes.json", Buffer.from("private notes"));
    const large = await image(custom, "large.png", Buffer.alloc(MAX_SCREENSHOT_BYTES + 1));
    const valid = await image(custom, "valid.png");
    const id = await saveComment({ quickNote: {} }, [missing, unsupported, large, valid]);
    const result = await getComment(id);
    expect(imageBlocks(result)).toHaveLength(1);
    expect(imageBlocks(result)[0].data).toBe(PNG.toString("base64"));
    expect(text(result)).toContain(`${missing}) could not be attached: the image file is missing or unreadable`);
    expect(text(result)).toContain(`${unsupported}) could not be attached: unsupported image type`);
    expect(text(result)).toContain(`${large}) could not be attached: the image is over the 3.5 MB inline limit`);
    expect(text(result)).not.toContain("private notes");
  });

  it("shares the byte budget and leaves space for later small images", async () => {
    const largeBytes = Buffer.alloc(MAX_SCREENSHOT_BYTES - PNG.length);
    PNG.copy(largeBytes);
    const primary = await image(custom, "primary.png", largeBytes);
    const skipped = await image(custom, "too-big-for-remainder.png", Buffer.concat([PNG, PNG]));
    const small = await image(custom, "small.png");
    const extra = await image(custom, "extra.png");
    const id = await saveComment({ screenshot: { imagePath: primary } }, [skipped, small, extra]);
    const result = await getComment(id);
    const blocks = imageBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks.reduce((sum, block) => sum + Buffer.from(block.data, "base64").length, 0)).toBe(MAX_SCREENSHOT_BYTES);
    expect(blocks[1].data).toBe(PNG.toString("base64"));
    expect(text(result)).toContain(`${skipped}) could not be attached: the image exceeds the remaining shared inline byte budget`);
    expect(text(result)).toContain(`${extra}) could not be attached: the image exceeds the remaining shared inline byte budget`);
  });

  it("limits image count while retaining every remaining path", async () => {
    const paths = await Promise.all(Array.from({ length: MAX_INLINE_IMAGES + 2 }, (_, index) => image(custom, `${index}.png`)));
    const id = await saveComment({ quickNote: {} }, paths);
    const result = await getComment(id);
    expect(imageBlocks(result)).toHaveLength(MAX_INLINE_IMAGES);
    for (const path of paths.slice(MAX_INLINE_IMAGES)) {
      expect(text(result)).toContain(`${path}) could not be attached: the ${MAX_INLINE_IMAGES}-image inline limit has been reached`);
    }
  });
});
