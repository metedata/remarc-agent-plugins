import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Read a boolean defaults key from com.metepolat.Remarc. Returns undefined if unset. */
export async function readBoolDefault(key: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "defaults",
      ["read", "com.metepolat.Remarc", key],
      { timeout: 3000 }
    );
    const v = stdout.trim();
    if (v === "0" || v.toLowerCase() === "false") return false;
    if (v === "1" || v.toLowerCase() === "true") return true;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read a string defaults key with fallback. */
export async function readStringDefault(key: string, fallback: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "defaults",
      ["read", "com.metepolat.Remarc", key],
      { timeout: 3000 }
    );
    const v = stdout.trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
