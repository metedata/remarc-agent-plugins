import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readAppState,
  writeAppState,
  getDataFilePath,
  typeLabel,
  typeIdentifier,
  formatDate,
  dateToApple,
  applyStatusUpdate,
  webContextPreview,
  formatWebContextSection,
  type AppState,
  type Comment,
  type Session,
} from "./data.js";
import { notifyRemarcReload } from "./notify.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

async function loadState(): Promise<AppState> {
  const state = await readAppState();
  if (!state) {
    throw new Error(
      "No Remarc data file found. The app may not have been launched yet."
    );
  }
  return state;
}

function findSession(
  sessions: Session[],
  id: string
): Session | undefined {
  return sessions.find((s) => s.id === id);
}

/** Find a comment by full UUID or short ID prefix. */
function findComment(
  comments: Comment[],
  id: string
): Comment | undefined {
  // Try full UUID match first
  const byFull = comments.find((c) => c.id === id);
  if (byFull) return byFull;
  // Try as short ID prefix
  const normalized = id.toLowerCase();
  const nonDeleted = comments
    .filter((c) => !c.isDeleted && c.id.toLowerCase().startsWith(normalized))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (nonDeleted.length > 0) return nonDeleted[0];
  return comments.find((c) => c.id.toLowerCase().startsWith(normalized));
}

function formatCommentLine(comment: Comment, sessions: Session[]): string {
  const statusTag = `[${comment.status}]`;
  const ref = typeLabel(comment.type, comment.webContext);
  const session = findSession(sessions, comment.sessionID);
  const sessionName = session ? session.name : "Unknown Session";
  const source = comment.source;
  const date = formatDate(comment.createdAt);

  const lines: string[] = [];
  lines.push(`[${typeIdentifier(comment.type)}] ${statusTag} ${ref}`);
  lines.push(`  Comment: ${comment.commentText}`);
  lines.push(`  Source: ${source} | Session: ${sessionName} | ${date}`);
  lines.push(`  ID: ${comment.id} (${comment.shortID})`);

  const preview = webContextPreview(comment.webContext);
  if (preview) lines.push(`  Context: ${preview}`);

  if (comment.status === "resolved") {
    if (comment.resolutionSummary) {
      lines.push(`  Resolution: ${comment.resolutionSummary}`);
    }
    if (comment.resolvedBy) {
      lines.push(`  Resolved by: ${comment.resolvedBy}`);
    }
    if (comment.resolvedAt) {
      lines.push(`  Resolved at: ${formatDate(comment.resolvedAt)}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  // 1. remarc_list_sessions
  server.registerTool("remarc_list_sessions", {
    description:
      "List active Remarc sessions with comment counts.",
  }, async () => {
    try {
      const state = await loadState();
      const activeSessions = state.sessions.filter(
        (s) => !s.isDeleted && !s.isAutoDismissed
      );

      if (activeSessions.length === 0) {
        return textResult("No active sessions found.");
      }

      const lines = activeSessions.map((session) => {
        const comments = state.comments.filter(
          (c) => c.sessionID === session.id && !c.isDeleted
        );
        const openCount = comments.filter((c) => c.status === "open").length;
        const inProgressCount = comments.filter(
          (c) => c.status === "inProgress"
        ).length;
        const resolvedCount = comments.filter(
          (c) => c.status === "resolved"
        ).length;
        const date = formatDate(session.createdAt);
        const isActive = session.id === state.activeSessionID;
        const activeTag = isActive ? " [ACTIVE]" : "";

        return `Session: ${session.name}${activeTag} (id: ${session.id})\n  ${openCount} open, ${inProgressCount} in progress, ${resolvedCount} resolved · Created ${date}`;
      });

      return textResult(lines.join("\n\n"));
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 2. remarc_list_comments
  server.registerTool("remarc_list_comments", {
    description:
      "List Remarc comments, filtered by session, status, or type. Note: comments injected via hooks have \"handedOff\" status, so use status \"handedOff\" or omit the status filter to find them. After addressing a comment, call remarc_set_status to resolve it.",
    inputSchema: {
      session_id: z
        .string()
        .optional()
        .describe("Filter by session UUID."),
      status: z
        .enum(["open", "handedOff", "inProgress", "resolved"])
        .optional()
        .describe("Filter by status."),
      type: z
        .enum(["comment", "screenshot", "quickNote", "critMode", "webElement"])
        .optional()
        .describe("Filter by type."),
    },
  }, async ({ session_id, status, type }) => {
    try {
      const state = await loadState();
      let comments = state.comments.filter((c) => !c.isDeleted);

      if (session_id) {
        comments = comments.filter((c) => c.sessionID === session_id);
      }
      if (status) {
        comments = comments.filter((c) => c.status === status);
      }
      if (type) {
        comments = comments.filter((c) => typeIdentifier(c.type) === type);
      }

      // Sort by createdAt ascending
      comments.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      );

      if (comments.length === 0) {
        const filters: string[] = [];
        if (session_id) filters.push(`session ${session_id}`);
        if (status) filters.push(`status "${status}"`);
        if (type) filters.push(`type "${type}"`);
        const filterDesc =
          filters.length > 0 ? ` matching ${filters.join(" and ")}` : "";
        return textResult(`No comments found${filterDesc}.`);
      }

      const header = `${comments.length} comment${comments.length === 1 ? "" : "s"}:`;
      const formatted = comments.map((c) =>
        formatCommentLine(c, state.sessions)
      );

      // Nudge: remind agent to resolve comments after addressing them
      const hasActionable = comments.some((c) => c.status !== "resolved");
      const nudge = hasActionable
        ? "\n\nAfter addressing comments, use remarc_bulk_set_status to resolve multiple at once (saves context), or remarc_set_status for a single comment."
        : "";

      return textResult(`${header}\n\n${formatted.join("\n\n")}${nudge}`);
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 3. remarc_get_comment
  server.registerTool("remarc_get_comment", {
    description:
      "Get full details of a comment by ID or short ID (5-char UUID prefix).",
    inputSchema: {
      id: z.string().describe("Full UUID or short ID (e.g. 'a3f2b')."),
    },
  }, async ({ id }) => {
    try {
      const state = await loadState();
      const comment = findComment(state.comments, id);

      if (!comment) {
        return errorResult(`Comment not found: ${id}. Use remarc_list_comments to see available comments.`);
      }

      const session = findSession(state.sessions, comment.sessionID);
      const sessionName = session ? session.name : "Unknown Session";
      const ref = typeLabel(comment.type, comment.webContext);
      const date = formatDate(comment.createdAt);
      const updated = formatDate(comment.updatedAt);

      const lines: string[] = [];
      lines.push(`Comment: ${comment.id} (${comment.shortID})`);
      lines.push(`Status: ${comment.status}`);
      lines.push(`Type: ${typeIdentifier(comment.type)}`);
      lines.push(`Reference: ${ref}`);
      lines.push(`Text: ${comment.commentText}`);
      lines.push(`Source: ${comment.source}`);
      if (comment.appBundleID) {
        lines.push(`App Bundle ID: ${comment.appBundleID}`);
      }
      if (comment.type && "screenshot" in comment.type) {
        lines.push(`Image Path: ${comment.type.screenshot.imagePath}`);
        lines.push(`(Use the Read tool to view this image file.)`);
      }
      lines.push(`Session: ${sessionName} (${comment.sessionID})`);
      lines.push(`Created: ${date}`);
      lines.push(`Updated: ${updated}`);

      const wcLines = formatWebContextSection(comment.webContext);
      if (wcLines.length > 0) {
        lines.push("");
        lines.push(...wcLines);
      }

      if (comment.regionElements && comment.regionElements.length > 0) {
        lines.push("");
        lines.push(`Region Elements (${comment.regionElements.length}):`);
        comment.regionElements.forEach((el, idx) => {
          const preview = webContextPreview(el) ?? "(unidentified)";
          lines.push(`  [${idx + 1}] ${preview}`);
          const selector =
            (typeof el.selector === "string" && el.selector) ||
            (typeof el.elementPath === "string" && el.elementPath) ||
            null;
          if (selector) lines.push(`      Selector: ${selector}`);
          if (el.boundingBox) {
            const bb = el.boundingBox;
            if (
              bb.width != null &&
              bb.height != null &&
              bb.x != null &&
              bb.y != null
            ) {
              lines.push(
                `      Bounding Box: ${bb.width}x${bb.height} at (${bb.x}, ${bb.y})`
              );
            }
          }
        });
      }

      if (comment.status === "resolved") {
        if (comment.resolutionSummary) {
          lines.push(`Resolution Summary: ${comment.resolutionSummary}`);
        }
        if (comment.resolvedBy) {
          lines.push(`Resolved By: ${comment.resolvedBy}`);
        }
        if (comment.resolvedAt) {
          lines.push(`Resolved At: ${formatDate(comment.resolvedAt)}`);
        }
      }

      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 4. remarc_set_status — consolidates resolve, reopen, and set-in-progress
  server.registerTool("remarc_set_status", {
    description:
      "Update a comment's status. Use \"resolved\" (with summary) after addressing it, \"inProgress\" while working on it, or \"open\" to reopen.",
    inputSchema: {
      id: z.string().describe("Full UUID or short ID (e.g. 'a3f2b')."),
      status: z
        .enum(["handedOff", "inProgress", "resolved", "open"])
        .describe("New status for the comment."),
      summary: z
        .string()
        .optional()
        .describe("How/why the comment was resolved. Required when status is \"resolved\"."),
    },
  }, async ({ id, status, summary }) => {
    try {
      const state = await loadState();
      const comment = findComment(state.comments, id);

      if (!comment) {
        return errorResult(`Comment not found: ${id}. Use remarc_list_comments to see available comments.`);
      }

      if (comment.status === status) {
        return errorResult(`Comment is already ${status}.`);
      }

      if (status === "resolved" && !summary) {
        return errorResult("A summary is required when resolving. Briefly describe what you did.");
      }

      applyStatusUpdate(comment, status, summary, new Date());

      await writeAppState(state);
      notifyRemarcReload();

      const shortId = comment.shortID;
      switch (status) {
        case "resolved":
          return textResult(`Resolved comment ${shortId}.\nSummary: ${summary}`);
        case "inProgress":
          return textResult(`Marked comment ${shortId} as in progress.`);
        case "open":
          return textResult(`Reopened comment ${shortId}.`);
      }
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 5. remarc_bulk_set_status — batch status updates to save context
  server.registerTool("remarc_bulk_set_status", {
    description:
      "Update multiple comments' statuses in one call. Use this instead of calling remarc_set_status repeatedly — it saves significant context. Provide either specific comment IDs, or a session_id to target all unresolved comments in that session.",
    inputSchema: {
      status: z
        .enum(["handedOff", "inProgress", "resolved", "open"])
        .describe("New status for all targeted comments."),
      comments: z
        .array(
          z.object({
            id: z.string().describe("Full UUID or short ID."),
            summary: z
              .string()
              .optional()
              .describe("Resolution summary for this specific comment."),
          })
        )
        .optional()
        .describe(
          "Specific comments to update. Each can have its own summary. If omitted, use session_id to target comments."
        ),
      session_id: z
        .string()
        .optional()
        .describe(
          "Target all unresolved comments in this session. Ignored if comments array is provided."
        ),
      summary: z
        .string()
        .optional()
        .describe(
          "Shared summary for all comments that don't have an individual summary. Required when status is \"resolved\" and any comment lacks its own summary."
        ),
    },
  }, async ({ status, comments: commentEntries, session_id, summary }) => {
    try {
      const state = await loadState();

      // Determine which comments to update
      let targets: Array<{ comment: Comment; summary?: string }> = [];

      if (commentEntries && commentEntries.length > 0) {
        // Explicit list of comment IDs
        for (const entry of commentEntries) {
          const comment = findComment(state.comments, entry.id);
          if (!comment) {
            return errorResult(
              `Comment not found: ${entry.id}. Use remarc_list_comments to see available comments.`
            );
          }
          targets.push({
            comment,
            summary: entry.summary ?? summary,
          });
        }
      } else if (session_id) {
        // All unresolved comments in session
        const sessionComments = state.comments.filter(
          (c) =>
            c.sessionID.toUpperCase() === session_id.toUpperCase() &&
            !c.isDeleted &&
            c.status !== status
        );
        if (sessionComments.length === 0) {
          return textResult(
            `No comments to update in session ${session_id}.`
          );
        }
        targets = sessionComments.map((c) => ({ comment: c, summary }));
      } else {
        return errorResult(
          "Provide either a comments array or session_id to specify which comments to update."
        );
      }

      // Validate summaries for resolved status
      if (status === "resolved") {
        const missingSummary = targets.find((t) => !t.summary);
        if (missingSummary) {
          return errorResult(
            "A summary is required when resolving. Provide a shared summary or individual summaries for each comment."
          );
        }
      }

      // Apply updates
      const now = new Date();
      const results: string[] = [];

      for (const { comment, summary: commentSummary } of targets) {
        if (comment.status === status) continue; // skip no-ops
        applyStatusUpdate(comment, status, commentSummary, now);
        results.push(comment.shortID);
      }

      if (results.length === 0) {
        return textResult("All targeted comments already have that status.");
      }

      await writeAppState(state);
      notifyRemarcReload();

      const verb =
        status === "resolved"
          ? "Resolved"
          : status === "inProgress"
            ? "Marked in progress"
            : status === "open"
              ? "Reopened"
              : "Updated";

      return textResult(
        `${verb} ${results.length} comment${results.length === 1 ? "" : "s"}: ${results.join(", ")}.`
      );
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 6. remarc_rename_session
  server.registerTool("remarc_rename_session", {
    description:
      "Rename a Remarc session. Use this to give a session a more descriptive name after you understand the task context (e.g. rename from 'Remarc A' to 'Auth Refactor').",
    inputSchema: {
      session_id: z.string().describe("Session UUID to rename."),
      name: z.string().describe("New name for the session (1-3 words, descriptive)."),
    },
  }, async ({ session_id, name }) => {
    try {
      const state = await loadState();
      const sessionIdUpper = session_id.toUpperCase();
      const session = state.sessions.find(
        (s) => s.id.toUpperCase() === sessionIdUpper && !s.isDeleted
      );

      if (!session) {
        return errorResult(`Session not found: ${session_id}`);
      }

      const oldName = session.name;
      session.name = name;

      await writeAppState(state);
      notifyRemarcReload();

      return textResult(`Renamed session from "${oldName}" to "${name}".`);
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 7. remarc_create_session — create a new session mid-chat
  server.registerTool("remarc_create_session", {
    description:
      "Create a new Remarc session and link it to this Claude Code session. Use when the user asks to start a Remarc session mid-conversation. Comments made in Remarc will be attached to subsequent messages.",
    inputSchema: {
      name: z.string().describe("Session name (e.g. directory name or task description)."),
      claude_session_id: z.string().describe("Your Claude Code session ID (provided in your session context)."),
    },
  }, async ({ name, claude_session_id }) => {
    try {
      const state = await loadState();
      const MAX_ACTIVE_SESSIONS = 8;

      // Deduplicate name
      const activeSessions = state.sessions.filter(
        (s) => !s.isDeleted && !s.isAutoDismissed
      );

      const existingNames = new Set(
        activeSessions.filter((s) => s.origin === "claudeCode").map((s) => s.name)
      );
      let finalName = name;
      if (existingNames.has(name)) {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        for (const letter of letters) {
          const candidate = `${name} ${letter}`;
          if (!existingNames.has(candidate)) {
            finalName = candidate;
            break;
          }
        }
      }

      // Check session limit
      if (activeSessions.length >= MAX_ACTIVE_SESSIONS) {
        const claudeSessions = activeSessions
          .filter((s) => s.origin === "claudeCode")
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (claudeSessions.length > 0) {
          const oldest = claudeSessions[0];
          const idx = state.sessions.findIndex((s) => s.id === oldest.id);
          if (idx !== -1) {
            state.sessions[idx].isAutoDismissed = true;
            state.sessions[idx].autoDismissedAt = new Date();
          }
        } else {
          return errorResult("Max sessions reached. Delete a session first.");
        }
      }

      // Create session
      const sessionId = randomUUID().toUpperCase();
      const now = new Date();
      state.sessions.push({
        id: sessionId,
        name: finalName,
        createdAt: now,
        isDeleted: false,
        deletedAt: null,
        isAutoDismissed: false,
        autoDismissedAt: null,
        origin: "claudeCode",
        claudeCodeSessionId: claude_session_id,
      });
      state.activeSessionID = sessionId;

      await writeAppState(state);
      notifyRemarcReload();

      // Write marker file so UserPromptSubmit hook picks up comments
      const markerPath = `/tmp/remarc-claude-${claude_session_id}.marker`;
      const dataFilePath = getDataFilePath();
      writeFileSync(markerPath, `${sessionId}\n${dataFilePath}\n`);
      // Set mtime to past so first prompt check always triggers
      const { execSync } = await import("node:child_process");
      execSync(`touch -t 200001010000 "${markerPath}"`, { stdio: "pipe" });

      return textResult(
        `Created Remarc session "${finalName}" (id: ${sessionId}). ` +
        `It's now the active session — comments you make in Remarc will be attached to your messages.`
      );
    } catch (err) {
      return errorResult(String(err));
    }
  });
}
