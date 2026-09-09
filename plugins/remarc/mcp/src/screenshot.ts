import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";

/**
 * Raw-byte budget shared by the screenshot and attachments in one tool result.
 * Base64 expands 3.5 MB to about 4.7 MB. Keep this bounded even when a comment
 * has many attachments; files that do not fit remain available by path.
 */
export const MAX_SCREENSHOT_BYTES = 3_500_000;
export const MAX_INLINE_IMAGES = 5;

/**
 * Extensions Claude can accept as image input, mapped to their MIME type.
 * A screenshot with any other extension is delivered as a path only.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Resolve a stored screenshot path to an absolute filesystem path.
 *
 * Default storage uses paths relative to the data file (`images/<uuid>.png`).
 * Custom folders and some legacy records use absolute paths. Never redirect an
 * existing reference based on the app's current storage-folder preference.
 */
export function resolveScreenshotPath(
  storedPath: string,
  dataFilePath: string
): string {
  return isAbsolute(storedPath)
    ? storedPath
    : resolve(dirname(dataFilePath), storedPath);
}

/** A screenshot ready to inline, or the reason it is being sent as a path. */
export type ScreenshotImage =
  | { ok: true; data: string; mimeType: string; byteLength: number }
  | { ok: false; reason: string };

/**
 * Read a screenshot from disk into a base64 MCP image payload.
 *
 * Never throws: a missing file, unsupported type, or oversized image is
 * reported as `{ ok: false, reason }` so the caller can fall back to a
 * path-only text result instead of failing the tool call.
 */
export async function loadScreenshotImage(
  imagePath: string,
  remainingBytes = MAX_SCREENSHOT_BYTES
): Promise<ScreenshotImage> {
  const mimeType = MIME_BY_EXTENSION[extname(imagePath).toLowerCase()];
  if (!mimeType) {
    const ext = extname(imagePath) || "none";
    return { ok: false, reason: `unsupported image type (extension: ${ext})` };
  }

  const limit = Number.isFinite(remainingBytes)
    ? Math.max(0, Math.min(MAX_SCREENSHOT_BYTES, Math.floor(remainingBytes)))
    : 0;
  const overBudget = (): ScreenshotImage => ({
    ok: false,
    reason: limit < MAX_SCREENSHOT_BYTES
      ? "the image exceeds the remaining shared inline byte budget"
      : `the image is over the ${MAX_SCREENSHOT_BYTES / 1_000_000} MB inline limit`,
  });
  if (limit === 0) return overBudget();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Nonblocking open lets us reject a FIFO/device without hanging on it.
    handle = await open(imagePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "the image path is not a regular file" };
    if (info.size > limit) return overBudget();

    // Read at most the budget plus one byte, even if the file grows after stat.
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) return overBudget();
    if (size === 0) return { ok: false, reason: "the image file is empty" };
    return {
      ok: true,
      data: buffer.subarray(0, size).toString("base64"),
      mimeType,
      byteLength: size,
    };
  } catch {
    return { ok: false, reason: "the image file is missing or unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
