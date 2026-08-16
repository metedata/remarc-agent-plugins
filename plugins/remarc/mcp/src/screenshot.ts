import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

/**
 * Raw-byte cap for inlining a screenshot into a tool result.
 *
 * Base64 inflates by ~4/3, so 3.5 MB of image is ~4.7 MB on the wire - under
 * every provider's per-image ceiling (Claude API 10 MB, Amazon Bedrock and
 * Google Cloud 5 MB). Anything larger falls back to a path-only text result
 * rather than risk a rejected request. The Remarc screenshot corpus sits well
 * inside this; the cap exists for the pathological case, not the common one.
 */
export const MAX_SCREENSHOT_BYTES = 3_500_000;

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
 * The app records screenshots relative to the data file (`images/<uuid>.png`);
 * older records stored an absolute path. Relative paths resolve against the
 * data file's directory so a moved Application Support directory still works.
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
  imagePath: string
): Promise<ScreenshotImage> {
  const mimeType = MIME_BY_EXTENSION[extname(imagePath).toLowerCase()];
  if (!mimeType) {
    const ext = extname(imagePath) || "none";
    return { ok: false, reason: `unsupported image type (extension: ${ext})` };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(imagePath);
  } catch {
    return { ok: false, reason: "the image file is missing or unreadable" };
  }

  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    const mb = (bytes.byteLength / 1_000_000).toFixed(1);
    const capMb = (MAX_SCREENSHOT_BYTES / 1_000_000).toFixed(1);
    return {
      ok: false,
      reason: `the image is ${mb} MB, over the ${capMb} MB inline limit`,
    };
  }

  return {
    ok: true,
    data: bytes.toString("base64"),
    mimeType,
    byteLength: bytes.byteLength,
  };
}
