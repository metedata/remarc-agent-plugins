import { writeFile, readFile, unlink, utimes } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

export interface Marker {
  remarcSessionId: string;
  dataFilePath: string;
}

function markerPath(claudeSessionId: string): string {
  return `/tmp/remarc-claude-${claudeSessionId}.marker`;
}

/**
 * Write the marker file with mtime explicitly in the past. This ensures the
 * first prompt-submit hook fires (data.mtime > marker.mtime). Year-2000 is
 * arbitrarily far back; the contract is "older than any data file we'd see".
 * See hook.test.ts for the pinning test.
 */
export async function writeMarker(claudeSessionId: string, m: Marker): Promise<void> {
  const path = markerPath(claudeSessionId);
  await writeFile(path, `${m.remarcSessionId}\n${m.dataFilePath}\n`);
  const stamp = new Date("2000-01-01T00:00:00Z");
  await utimes(path, stamp, stamp);
}

export async function readMarker(claudeSessionId: string): Promise<Marker | null> {
  const path = markerPath(claudeSessionId);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf8");
  const [remarcSessionId, dataFilePath] = content.split("\n");
  return remarcSessionId ? { remarcSessionId, dataFilePath: dataFilePath ?? "" } : null;
}

export async function touchMarker(claudeSessionId: string): Promise<void> {
  const path = markerPath(claudeSessionId);
  if (existsSync(path)) {
    const now = new Date();
    await utimes(path, now, now);
  }
}

export function dataNewerThanMarker(claudeSessionId: string, dataFilePath: string): boolean {
  const mp = markerPath(claudeSessionId);
  if (!existsSync(mp) || !existsSync(dataFilePath)) return false;
  return statSync(dataFilePath).mtimeMs > statSync(mp).mtimeMs;
}

export async function removeMarker(claudeSessionId: string): Promise<void> {
  try {
    await unlink(markerPath(claudeSessionId));
  } catch {
    /* gone already is fine */
  }
}

/** Test-only: expose the path computation. */
export function _markerPath(claudeSessionId: string): string {
  return markerPath(claudeSessionId);
}
