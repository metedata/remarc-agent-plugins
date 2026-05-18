import { execFile } from "node:child_process";

/**
 * Post a DistributedNotification to tell Remarc to reload its data file.
 * Uses a tiny inline Swift script via `swift -e`.
 *
 * Fire-and-forget: does NOT block the caller. The `swift -e` invocation can
 * take 2-5 s on a cold compiler start, which would stall the CLI and risk
 * Claude Code hook timeouts. Instead we spawn the process and return
 * immediately — the notification arrives asynchronously a moment later.
 */
export function notifyRemarcReload(): void {
  const child = execFile(
    "swift",
    [
      "-e",
      'import Foundation; DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("com.metepolat.Remarc.reload"), object: nil, userInfo: nil, deliverImmediately: true)',
    ],
    { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    () => {
      // Silently ignore — errors are non-fatal (Remarc may not be running)
    }
  );
  child.unref(); // Allow Node process to exit without waiting for swift
}
