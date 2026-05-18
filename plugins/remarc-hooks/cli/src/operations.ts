/**
 * Port of mcp/src/cli.ts's CLI subcommands into pure async functions for use
 * by hook.ts. Same data layer (data.ts), same logic, but:
 *   - typed inputs instead of flag dictionaries
 *   - typed returns instead of console.log
 *   - throw Error instead of process.exit
 *
 * This module never touches process.argv, stdin, stdout, or stderr.
 */
import { readAppState, writeAppState, getDataFilePath, applyStatusUpdate } from "./data.js";
import { notifyRemarcReload } from "./notify.js";
import { randomUUID } from "node:crypto";
import { readStringDefault } from "./defaults.js";
import type { Session, CommentStatus } from "./data.js";

const MAX_ACTIVE_SESSIONS = 8;

function buildIntegrationContext(claudeSessionId: string): string {
  const lines = [
    `A Remarc session is active for this Claude Code session (session ID: ${claudeSessionId}).`,
    "Comments made in Remarc are automatically attached to your messages.",
    'Comment lifecycle: when you receive comments, acknowledge them by calling remarc_set_status with status "handedOff".',
    'When you start working on a comment, mark it "inProgress".',
    "When you've fully addressed a comment, mark it \"resolved\" with a brief summary of what you did.",
  ];
  return lines.join(" ");
}

function deduplicateSessionName(baseName: string, activeSessions: Session[]): string {
  const existingNames = new Set(
    activeSessions.filter((s) => s.origin === "claudeCode").map((s) => s.name)
  );
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const letter of letters) {
    const candidate = `${baseName} ${letter}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

// --- createSession ---

export interface CreateSessionInput {
  name: string;
  claudeSessionId: string;
  source: string; // "startup" | "resume" | (other ignored)
}

export interface CreateSessionResult {
  remarcSessionId: string;
  dataFilePath: string;
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  if (!input.name || !input.claudeSessionId) {
    throw new Error("createSession requires name and claudeSessionId");
  }

  let state = await readAppState();
  if (!state) {
    state = {
      sessions: [],
      comments: [],
      activeSessionID: null,
      totalCommentsCreated: 0,
    };
  }

  // Resume: look for existing session linked to this claude session id
  if (input.source === "resume") {
    const existing = state.sessions.find(
      (s) =>
        !s.isDeleted &&
        !s.isAutoDismissed &&
        s.claudeCodeSessionId === input.claudeSessionId
    );
    if (existing) {
      state.activeSessionID = existing.id;
      await writeAppState(state);
      notifyRemarcReload();
      return {
        remarcSessionId: existing.id,
        dataFilePath: getDataFilePath(),
      };
    }
    // Fall through to create new
  }

  const activeSessions = state.sessions.filter((s) => !s.isDeleted && !s.isAutoDismissed);
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
      throw new Error("Max sessions reached and no Claude Code sessions to auto-dismiss.");
    }
  }

  const finalName = deduplicateSessionName(input.name, activeSessions);
  const sessionId = randomUUID().toUpperCase();
  const now = new Date();
  const newSession: Session = {
    id: sessionId,
    name: finalName,
    createdAt: now,
    isDeleted: false,
    deletedAt: null,
    isAutoDismissed: false,
    autoDismissedAt: null,
    origin: "claudeCode",
    claudeCodeSessionId: input.claudeSessionId,
  };
  state.sessions.push(newSession);
  state.activeSessionID = sessionId;

  await writeAppState(state);
  notifyRemarcReload();

  return {
    remarcSessionId: sessionId,
    dataFilePath: getDataFilePath(),
  };
}

// --- handoff ---

export interface HandoffInput {
  remarcSessionId: string;
  claudeSessionId: string;
  recovery: boolean;
}

/**
 * Returns the formatted context string. Empty string when there's nothing to inject.
 */
export async function handoff(input: HandoffInput): Promise<string> {
  const state = await readAppState();
  if (!state) return "";

  const sessionIdUpper = input.remarcSessionId.toUpperCase();
  const session = state.sessions.find((s) => s.id.toUpperCase() === sessionIdUpper);
  if (!session || session.isDeleted) return "";

  const targetStatuses: string[] = input.recovery
    ? ["open", "handedOff", "inProgress"]
    : ["open"];

  const comments = state.comments.filter(
    (c) =>
      c.sessionID.toUpperCase() === sessionIdUpper &&
      !c.isDeleted &&
      targetStatuses.includes(c.status)
  );

  const lines: string[] = [];

  if (input.recovery) {
    lines.push(buildIntegrationContext(input.claudeSessionId));
    lines.push("");
  }

  if (comments.length > 0) {
    const label = input.recovery ? "outstanding" : "new";
    lines.push(`## Remarc Comments (${comments.length} ${label})`);
    lines.push("");

    for (const comment of comments) {
      lines.push(`### [${comment.shortID}] ${comment.commentText}`);
      if (comment.type && "comment" in comment.type) {
        lines.push(`> Selected text: "${comment.type.comment.text}"`);
      }
      if (comment.source) {
        lines.push(`Source: ${comment.source}`);
      }
      lines.push(`Status: ${comment.status}`);
      lines.push("");
    }
  } else if (input.recovery) {
    lines.push("No outstanding Remarc comments.");
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

// --- windDown ---

export interface WindDownInput {
  remarcSessionId: string;
}

export async function windDown(input: WindDownInput): Promise<void> {
  const state = await readAppState();
  if (!state) return;

  const sessionIdUpper = input.remarcSessionId.toUpperCase();
  const sessionIdx = state.sessions.findIndex((s) => s.id.toUpperCase() === sessionIdUpper);
  if (sessionIdx === -1) return;

  const behavior = await readStringDefault("claudeCodeSessionEndBehavior", "autoDelete");
  const now = new Date();

  switch (behavior) {
    case "keep":
      break;

    case "moveUnresolved": {
      let inbox = state.sessions.find(
        (s) => s.name === "Inbox" && !s.isDeleted && !s.isAutoDismissed
      );
      if (!inbox) {
        const inboxSession: Session = {
          id: randomUUID(),
          name: "Inbox",
          createdAt: now,
          isDeleted: false,
          deletedAt: null,
          isAutoDismissed: false,
          autoDismissedAt: null,
          origin: "manual",
          claudeCodeSessionId: null,
        };
        state.sessions.push(inboxSession);
        inbox = inboxSession;
      }

      for (let i = 0; i < state.comments.length; i++) {
        const c = state.comments[i];
        if (
          c.sessionID.toUpperCase() === sessionIdUpper &&
          !c.isDeleted &&
          ["open", "handedOff", "inProgress"].includes(c.status)
        ) {
          state.comments[i].sessionID = inbox.id;
          state.comments[i].updatedAt = now;
        }
      }

      state.sessions[sessionIdx].isDeleted = true;
      state.sessions[sessionIdx].deletedAt = now;
      for (let i = 0; i < state.comments.length; i++) {
        if (
          state.comments[i].sessionID.toUpperCase() === sessionIdUpper &&
          !state.comments[i].isDeleted
        ) {
          state.comments[i].isDeleted = true;
          state.comments[i].deletedAt = now;
        }
      }
      break;
    }

    case "autoDelete":
    default: {
      state.sessions[sessionIdx].isDeleted = true;
      state.sessions[sessionIdx].deletedAt = now;
      for (let i = 0; i < state.comments.length; i++) {
        if (state.comments[i].sessionID.toUpperCase() === sessionIdUpper) {
          state.comments[i].isDeleted = true;
          state.comments[i].deletedAt = now;
        }
      }
      break;
    }
  }

  if (state.activeSessionID?.toUpperCase() === sessionIdUpper) {
    const remaining = state.sessions.filter((s) => !s.isDeleted && !s.isAutoDismissed);
    state.activeSessionID = remaining.length > 0 ? remaining[0].id : null;
  }

  await writeAppState(state);
  notifyRemarcReload();
}

// --- bulkSetStatus (unused by hook.ts but retained for parity with cli.ts; may be removed) ---

export interface BulkSetStatusInput {
  remarcSessionId: string;
  status: CommentStatus;
  summary?: string;
}

export async function bulkSetStatus(input: BulkSetStatusInput): Promise<{ updated: number }> {
  if (input.status === "resolved" && !input.summary) {
    throw new Error("A summary is required when resolving.");
  }

  const state = await readAppState();
  if (!state) throw new Error("Remarc data file not found.");

  const sessionIdUpper = input.remarcSessionId.toUpperCase();
  const targets = state.comments.filter(
    (c) =>
      c.sessionID.toUpperCase() === sessionIdUpper &&
      !c.isDeleted &&
      c.status !== input.status
  );

  if (targets.length === 0) return { updated: 0 };

  const now = new Date();
  for (const comment of targets) {
    applyStatusUpdate(comment, input.status, input.summary, now);
  }

  await writeAppState(state);
  notifyRemarcReload();

  return { updated: targets.length };
}
