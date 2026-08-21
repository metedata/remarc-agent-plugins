import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readAppState,
  writeAppState,
  withDocument,
  getDataFilePath,
  displayCommentBody,
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
import { writeMarker } from "./marker.js";
import { currentHarness } from "./harness.js";
import { loadScreenshotImage, resolveScreenshotPath } from "./screenshot.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Durable resolution attribution from the negotiated MCP client identity. */
function currentResolver(): string {
  const harness = currentHarness();
  return harness === "claudeCode" ? "claude" : harness;
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

export function formatCommentLine(comment: Comment, sessions: Session[]): string {
  const statusTag = `[${comment.status}]`;
  const ref = typeLabel(comment.type, comment.webContext);
  const session = findSession(sessions, comment.sessionID);
  const sessionName = session ? session.name : "Unknown Session";
  const source = comment.source;
  const date = formatDate(comment.createdAt);

  const lines: string[] = [];
  lines.push(`[${typeIdentifier(comment.type)}] ${statusTag} ${ref}`);
  lines.push(`  Comment: ${displayCommentBody(comment.commentText)}`);
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

/** Full-detail rendering used by remarc_get_comment. */
export function formatCommentDetail(
  comment: Comment,
  sessions: Session[],
  dataFilePath = getDataFilePath()
): string {
  const session = findSession(sessions, comment.sessionID);
  const sessionName = session ? session.name : "Unknown Session";
  const ref = typeLabel(comment.type, comment.webContext);
  const date = formatDate(comment.createdAt);
  const updated = formatDate(comment.updatedAt);

  const lines: string[] = [];
  lines.push(`Comment: ${comment.id} (${comment.shortID})`);
  lines.push(`Status: ${comment.status}`);
  lines.push(`Type: ${typeIdentifier(comment.type)}`);
  lines.push(`Reference: ${ref}`);
  if ("comment" in comment.type) {
    // typeLabel is intentionally a compact preview for list/reference fields.
    // Full detail must also expose the exact selection as its own value.
    lines.push(`Selected Text: ${comment.type.comment.text}`);
  }
  lines.push(`Text: ${displayCommentBody(comment.commentText)}`);
  lines.push(`Source: ${comment.source}`);
  if (comment.appBundleID) {
    lines.push(`App Bundle ID: ${comment.appBundleID}`);
  }
  if ("screenshot" in comment.type) {
    const imagePath = resolveScreenshotPath(
      comment.type.screenshot.imagePath,
      dataFilePath
    );
    lines.push(`Image Path: ${imagePath}`);
    // The image itself is attached to remarc_get_comment's result; the handler
    // appends the note that says whether it was inlined or must be read by path.
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

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  // 1. remarc_list_sessions
  server.registerTool("remarc_list_sessions", {
    title: "List Remarc sessions",
    description:
      "List active Remarc sessions with comment counts.",
    annotations: {
      title: "List Remarc sessions",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
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
    title: "List Remarc comments",
    description:
      "List Remarc comments, filtered by session, status, or type. Note: comments injected via hooks have \"handedOff\" status, so use status \"handedOff\" or omit the status filter to find them. After addressing a comment, call remarc_set_status to resolve it.",
    annotations: {
      title: "List Remarc comments",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
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
    title: "Get a Remarc comment",
    description:
      "Get full details of a comment by ID or short ID (5-char UUID prefix).",
    annotations: {
      title: "Get a Remarc comment",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
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

      const detail = formatCommentDetail(comment, state.sessions);

      // Screenshot comments carry the picture that is the whole point of the
      // comment. Attach it as an MCP image block so the agent can see it
      // directly - clients without a filesystem Read tool (e.g. Claude Desktop)
      // cannot open the path, and even those that can save a round-trip. Fall
      // back to a path-only text result if the image can't be inlined.
      if ("screenshot" in comment.type) {
        const imagePath = resolveScreenshotPath(
          comment.type.screenshot.imagePath,
          getDataFilePath()
        );
        const image = await loadScreenshotImage(imagePath);
        if (image.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${detail}\n(The screenshot is attached to this result as an image.)`,
              },
              {
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              },
            ],
          };
        }
        return textResult(
          `${detail}\n(The screenshot could not be attached: ${image.reason}. ` +
            `Read the file at the Image Path above if your client has a file-reading tool.)`
        );
      }

      return textResult(detail);
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 4. remarc_set_status — consolidates resolve, reopen, and set-in-progress
  server.registerTool("remarc_set_status", {
    title: "Update Remarc comment status",
    description:
      "Update a comment's status. Use \"resolved\" (with summary) after addressing it, \"inProgress\" while working on it, or \"open\" to reopen.",
    annotations: {
      title: "Update Remarc comment status",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      id: z.string().describe("Full UUID or short ID (e.g. 'a3f2b')."),
      status: z
        .enum(["handedOff", "inProgress", "resolved", "open"])
        .describe("New status for the comment."),
      summary: z
        .string()
        .optional()
        .describe("How/why the comment was resolved. Required when status is \"resolved\"."),
      expected_status: z
        .enum(["open", "handedOff", "inProgress", "resolved"])
        .optional()
        .describe(
          "Only apply the change if the comment currently has this status. Use it to claim work another agent may also have been woken for: expected_status \"handedOff\" with status \"inProgress\" succeeds for exactly one caller."
        ),
    },
  }, async ({ id, status, summary, expected_status }) => {
    try {
      if (status === "resolved" && !summary) {
        return errorResult("A summary is required when resolving. Briefly describe what you did.");
      }

      // Compare-and-set inside the document transaction: the status is read and
      // written under one lock, so two agents woken for the same comment cannot
      // both claim it.
      const outcome = await withDocument((state) => {
        const comment = findComment(state.comments, id);
        if (!comment) {
          return { kind: "missing" as const };
        }
        if (expected_status != null && comment.status !== expected_status) {
          return { kind: "conflict" as const, actual: comment.status, shortID: comment.shortID };
        }
        if (comment.status === status) {
          return { kind: "noop" as const, shortID: comment.shortID };
        }
        applyStatusUpdate(comment, status, summary, new Date(), currentResolver());
        return { kind: "ok" as const, shortID: comment.shortID };
      });

      if (outcome.kind === "missing") {
        return errorResult(`Comment not found: ${id}. Use remarc_list_comments to see available comments.`);
      }
      if (outcome.kind === "conflict") {
        return errorResult(
          `Comment ${outcome.shortID} is ${outcome.actual}, not ${expected_status} - another agent likely claimed it. Skip this comment.`
        );
      }
      if (outcome.kind === "noop") {
        return errorResult(`Comment is already ${status}.`);
      }

      notifyRemarcReload();

      switch (status) {
        case "resolved":
          return textResult(`Resolved comment ${outcome.shortID}.\nSummary: ${summary}`);
        case "inProgress":
          return textResult(`Marked comment ${outcome.shortID} as in progress.`);
        case "open":
          return textResult(`Reopened comment ${outcome.shortID}.`);
        case "handedOff":
          return textResult(`Marked comment ${outcome.shortID} as handed off.`);
      }
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 5. remarc_bulk_set_status — batch status updates to save context
  server.registerTool("remarc_bulk_set_status", {
    title: "Update multiple Remarc comment statuses",
    description:
      "Update multiple comments' statuses in one call. Use this instead of calling remarc_set_status repeatedly — it saves significant context. Provide either specific comment IDs, or a session_id to target all unresolved comments in that session.",
    annotations: {
      title: "Update multiple Remarc comment statuses",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
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
      const outcome = await withDocument<{ kind: "text" | "error"; message: string; skip: boolean }>((state) => {
      // Determine which comments to update
      let targets: Array<{ comment: Comment; summary?: string }> = [];

      if (commentEntries && commentEntries.length > 0) {
        // Explicit list of comment IDs
        for (const entry of commentEntries) {
          const comment = findComment(state.comments, entry.id);
          if (!comment) {
            return {
              kind: "error" as const,
              message: `Comment not found: ${entry.id}. Use remarc_list_comments to see available comments.`,
              skip: true,
            };
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
          return { kind: "text" as const, message: `No comments to update in session ${session_id}.`, skip: true };
        }
        targets = sessionComments.map((c) => ({ comment: c, summary }));
      } else {
        return {
          kind: "error" as const,
          message: "Provide either a comments array or session_id to specify which comments to update.",
          skip: true,
        };
      }

      // Validate summaries for resolved status
      if (status === "resolved") {
        const missingSummary = targets.find((t) => !t.summary);
        if (missingSummary) {
          return {
            kind: "error" as const,
            message:
              "A summary is required when resolving. Provide a shared summary or individual summaries for each comment.",
            skip: true,
          };
        }
      }

      // Apply updates
      const now = new Date();
      const results: string[] = [];

      for (const { comment, summary: commentSummary } of targets) {
        if (comment.status === status) continue; // skip no-ops
        applyStatusUpdate(comment, status, commentSummary, now, currentResolver());
        results.push(comment.shortID);
      }

      if (results.length === 0) {
        return { kind: "text" as const, message: "All targeted comments already have that status.", skip: true };
      }

      const verb =
        status === "resolved"
          ? "Resolved"
          : status === "inProgress"
            ? "Marked in progress"
            : status === "open"
              ? "Reopened"
              : "Updated";

      return {
        kind: "text" as const,
        message: `${verb} ${results.length} comment${results.length === 1 ? "" : "s"}: ${results.join(", ")}.`,
        skip: false,
      };
      });

      if (outcome.skip && outcome.kind === "error") return errorResult(outcome.message);
      if (outcome.skip) return textResult(outcome.message);
      notifyRemarcReload();
      return textResult(outcome.message);
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 6. remarc_rename_session
  server.registerTool("remarc_rename_session", {
    title: "Rename a Remarc session",
    description:
      "Rename a Remarc session. Use this to give a session a more descriptive name after you understand the task context (e.g. rename from 'Remarc A' to 'Auth Refactor').",
    annotations: {
      title: "Rename a Remarc session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      session_id: z.string().describe("Session UUID to rename."),
      name: z.string().describe("New name for the session (1-3 words, descriptive)."),
    },
  }, async ({ session_id, name }) => {
    try {
      const outcome = await withDocument((state) => {
        const sessionIdUpper = session_id.toUpperCase();
        const session = state.sessions.find(
          (s) => s.id.toUpperCase() === sessionIdUpper && !s.isDeleted
        );
        if (!session) return { ok: false as const };
        const oldName = session.name;
        session.name = name;
        return { ok: true as const, oldName };
      });

      if (!outcome.ok) return errorResult(`Session not found: ${session_id}`);
      notifyRemarcReload();
      return textResult(`Renamed session from "${outcome.oldName}" to "${name}".`);
    } catch (err) {
      return errorResult(String(err));
    }
  });

  // 7. remarc_create_session — create a new session mid-chat
  server.registerTool("remarc_create_session", {
    title: "Create a Remarc session",
    description:
      "Create a new Remarc session for Claude Code, Codex, or OMP. The server derives the host from the MCP initialization identity; OMP sessions pair separately for instant delivery.",
    annotations: {
      title: "Create a Remarc session",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      name: z.string().describe("Session name (e.g. directory name or task description)."),
      claude_session_id: z
        .string()
        .optional()
        .describe("Your agent session ID. Required for Claude Code and Codex; OMP pairing is owned by remarc-wake."),
      harness: z
        .enum(["claudeCode", "codex"])
        .optional()
        .describe(
          "Override the detected host only for a nested Claude Code or Codex agent. Usually omit this. For example, a Codex agent running inside Claude Code reaches Claude Code's MCP client and must identify the nested agent explicitly."
        ),
    },
  }, async ({ name, claude_session_id, harness }) => {
    const serverHarness = currentHarness();
    // The MCP client handshake is outside the model-controlled tool input. A
    // Claude/Codex override must never relabel a server identified as OMP.
    // Nested Claude/Codex sessions keep their existing override path.
    const sessionOrigin = serverHarness === "omp"
      ? "omp"
      : (harness ?? serverHarness);

    if (serverHarness !== "omp" && !claude_session_id) {
      return errorResult(
        "claude_session_id is required when creating a Claude Code or Codex session."
      );
    }

    try {
      const created = await withDocument((state) => {
        const MAX_ACTIVE_SESSIONS = 8;

        // Deduplicate name
        const activeSessions = state.sessions.filter(
          (s) => !s.isDeleted && !s.isAutoDismissed
        );

        const existingNames = new Set(
          activeSessions.filter((s) => s.origin === sessionOrigin).map((s) => s.name)
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
          const integrationSessions = activeSessions
            .filter((s) => s.origin === sessionOrigin)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          if (integrationSessions.length > 0) {
            const oldest = integrationSessions[0];
            const idx = state.sessions.findIndex((s) => s.id === oldest.id);
            if (idx !== -1) {
              state.sessions[idx].isAutoDismissed = true;
              state.sessions[idx].autoDismissedAt = new Date();
            }
          } else {
            return { ok: false as const };
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
          // `claudeCodeSessionId` keeps its legacy name for schema compatibility.
          // OMP's optional wake extension owns its session-scoped lease instead,
          // so core OMP creation deliberately leaves this field empty.
          origin: sessionOrigin,
          claudeCodeSessionId: serverHarness === "omp" ? null : claude_session_id!,
          unknownFields: {},
        });
        state.activeSessionID = sessionId;
        return { ok: true as const, sessionId, finalName };
      });

      if (!created.ok) {
        return errorResult("Max sessions reached. Delete a session first.");
      }
      notifyRemarcReload();

      if (serverHarness !== "omp") {
        // Claude/Codex lifecycle integrations use the historical marker. OMP's
        // optional wake extension owns an explicit token-leased pairing and
        // must never be replaced by this ownerless legacy marker.
        await writeMarker(claude_session_id!, {
          remarcSessionId: created.sessionId,
          dataFilePath: getDataFilePath(),
        });
      }

      if (serverHarness === "omp") {
        return textResult(
          `Created Remarc session "${created.finalName}" (id: ${created.sessionId}). ` +
          "It is now active. If the optional remarc-wake plugin is installed, " +
          "run /remarc-pair in this OMP session to enable instant delivery; otherwise use MCP on demand."
        );
      }

      return textResult(
        `Created Remarc session "${created.finalName}" (id: ${created.sessionId}). ` +
        "It is now active. Future comments can be fetched through the Remarc MCP tools; " +
        "an installed lifecycle integration may attach them automatically."
      );
    } catch (err) {
      return errorResult(String(err));
    }
  });
}
