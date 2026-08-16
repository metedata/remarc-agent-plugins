import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadScreenshotImage,
  resolveScreenshotPath,
  MAX_SCREENSHOT_BYTES,
} from "./screenshot.js";

// A 1x1 transparent PNG - the smallest real image, enough to prove round-trip.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

describe("resolveScreenshotPath", () => {
  it("resolves a relative path against the data file's directory", () => {
    expect(
      resolveScreenshotPath(
        "images/capture.png",
        "/Users/x/Library/Application Support/Remarc/comments.json"
      )
    ).toBe("/Users/x/Library/Application Support/Remarc/images/capture.png");
  });

  it("passes an absolute path through unchanged", () => {
    expect(
      resolveScreenshotPath("/tmp/legacy.png", "/anywhere/comments.json")
    ).toBe("/tmp/legacy.png");
  });
});

describe("loadScreenshotImage", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "remarc-shot-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a real PNG into a base64 image payload with the right mime type", async () => {
    const path = join(dir, "shot.png");
    await writeFile(path, Buffer.from(PNG_1X1_BASE64, "base64"));

    const result = await loadScreenshotImage(path);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe("image/png");
      expect(result.data).toBe(PNG_1X1_BASE64);
    }
  });

  it("maps jpg/jpeg/gif/webp extensions to their mime types", async () => {
    for (const [ext, mime] of [
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
    ] as const) {
      const path = join(dir, `shot.${ext}`);
      await writeFile(path, Buffer.from([1, 2, 3]));
      const result = await loadScreenshotImage(path);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.mimeType).toBe(mime);
    }
  });

  it("reports a missing file without throwing", async () => {
    const result = await loadScreenshotImage(join(dir, "does-not-exist.png"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing or unreadable/);
  });

  it("rejects an unsupported extension", async () => {
    const path = join(dir, "shot.bmp");
    await writeFile(path, Buffer.from([1, 2, 3]));
    const result = await loadScreenshotImage(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unsupported image type/);
  });

  it("falls back to path-only when the image exceeds the inline cap", async () => {
    const path = join(dir, "huge.png");
    await writeFile(path, Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 0));
    const result = await loadScreenshotImage(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/over the .* inline limit/);
  });
});
