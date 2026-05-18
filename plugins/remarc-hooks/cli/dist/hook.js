#!/usr/bin/env node

// src/hook.ts
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// ../../shared/data.ts
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
var APPLE_EPOCH_OFFSET = 978307200;
function appleToDate(timestamp) {
  return new Date((timestamp + APPLE_EPOCH_OFFSET) * 1e3);
}
function dateToApple(date) {
  return date.getTime() / 1e3 - APPLE_EPOCH_OFFSET;
}
function getDataDir() {
  return join(homedir(), "Library", "Application Support", "Remarc");
}
function getDataFilePath() {
  const dir = getDataDir();
  const newPath = join(dir, "comments.json");
  const oldPath = join(dir, "data.json");
  if (existsSync(newPath)) return newPath;
  if (existsSync(oldPath)) return oldPath;
  return newPath;
}
function parseType(raw) {
  if (raw.type) return raw.type;
  return { quickNote: {} };
}
function parseComment(raw) {
  return {
    id: raw.id,
    shortID: raw.id.substring(0, 5).toLowerCase(),
    type: parseType(raw),
    commentText: raw.commentText,
    source: raw.source,
    appBundleID: raw.appBundleID ?? null,
    createdAt: appleToDate(raw.createdAt),
    updatedAt: appleToDate(raw.updatedAt),
    sessionID: raw.sessionID ?? raw.stackID ?? "",
    isDeleted: raw.isDeleted,
    deletedAt: raw.deletedAt != null ? appleToDate(raw.deletedAt) : null,
    status: raw.status ?? "open",
    resolutionSummary: raw.resolutionSummary ?? null,
    resolvedBy: raw.resolvedBy ?? null,
    resolvedAt: raw.resolvedAt != null ? appleToDate(raw.resolvedAt) : null,
    attachments: raw.attachments ?? [],
    webContext: raw.webContext ?? null,
    regionElements: raw.regionElements ?? null
  };
}
function parseSession(raw) {
  return {
    id: raw.id,
    name: raw.name,
    createdAt: appleToDate(raw.createdAt),
    isDeleted: raw.isDeleted,
    deletedAt: raw.deletedAt != null ? appleToDate(raw.deletedAt) : null,
    isAutoDismissed: raw.isAutoDismissed,
    autoDismissedAt: raw.autoDismissedAt != null ? appleToDate(raw.autoDismissedAt) : null,
    origin: raw.origin ?? "manual",
    claudeCodeSessionId: raw.claudeCodeSessionId ?? null
  };
}
function parseAppState(raw) {
  const rawSessions = raw.sessions ?? raw.stacks ?? [];
  return {
    sessions: rawSessions.map(parseSession),
    comments: raw.comments.map(parseComment),
    activeSessionID: raw.activeSessionID ?? raw.activeStackID ?? null,
    totalCommentsCreated: raw.totalCommentsCreated
  };
}
function serializeComment(c) {
  const raw = {
    id: c.id,
    type: c.type,
    commentText: c.commentText,
    source: c.source,
    appBundleID: c.appBundleID,
    createdAt: dateToApple(c.createdAt),
    updatedAt: dateToApple(c.updatedAt),
    sessionID: c.sessionID,
    isDeleted: c.isDeleted,
    deletedAt: c.deletedAt != null ? dateToApple(c.deletedAt) : null,
    status: c.status,
    resolutionSummary: c.resolutionSummary,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt != null ? dateToApple(c.resolvedAt) : null
  };
  raw.attachments = c.attachments;
  if (c.webContext != null) raw.webContext = c.webContext;
  if (c.regionElements != null) raw.regionElements = c.regionElements;
  return raw;
}
function serializeSession(s) {
  return {
    id: s.id,
    name: s.name,
    createdAt: dateToApple(s.createdAt),
    isDeleted: s.isDeleted,
    deletedAt: s.deletedAt != null ? dateToApple(s.deletedAt) : null,
    isAutoDismissed: s.isAutoDismissed,
    autoDismissedAt: s.autoDismissedAt != null ? dateToApple(s.autoDismissedAt) : null,
    origin: s.origin,
    claudeCodeSessionId: s.claudeCodeSessionId
  };
}
function serializeAppState(state) {
  return {
    sessions: state.sessions.map(serializeSession),
    comments: state.comments.map(serializeComment),
    activeSessionID: state.activeSessionID,
    totalCommentsCreated: state.totalCommentsCreated
  };
}
async function readAppState() {
  const filePath = getDataFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parseAppState(parsed);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
async function writeAppState(state) {
  const filePath = getDataFilePath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp";
  const json = JSON.stringify(serializeAppState(state), null, 2);
  await writeFile(tmpPath, json, "utf-8");
  await rename(tmpPath, filePath);
}

// ../../shared/notify.ts
import { execFile } from "node:child_process";
function notifyRemarcReload() {
  const child = execFile(
    "swift",
    [
      "-e",
      'import Foundation; DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("com.metepolat.Remarc.reload"), object: nil, userInfo: nil, deliverImmediately: true)'
    ],
    { timeout: 5e3, stdio: ["pipe", "pipe", "pipe"] },
    () => {
    }
  );
  child.unref();
}

// src/operations.ts
import { randomUUID } from "node:crypto";

// src/defaults.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile2);
async function readBoolDefault(key) {
  try {
    const { stdout } = await execFileAsync(
      "defaults",
      ["read", "com.metepolat.Remarc", key],
      { timeout: 3e3 }
    );
    const v = stdout.trim();
    if (v === "0" || v.toLowerCase() === "false") return false;
    if (v === "1" || v.toLowerCase() === "true") return true;
    return void 0;
  } catch {
    return void 0;
  }
}
async function readStringDefault(key, fallback) {
  try {
    const { stdout } = await execFileAsync(
      "defaults",
      ["read", "com.metepolat.Remarc", key],
      { timeout: 3e3 }
    );
    const v = stdout.trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

// src/operations.ts
var MAX_ACTIVE_SESSIONS = 8;
function buildIntegrationContext(claudeSessionId) {
  const lines = [
    `A Remarc session is active for this Claude Code session (session ID: ${claudeSessionId}).`,
    "Comments made in Remarc are automatically attached to your messages.",
    'Comment lifecycle: when you receive comments, acknowledge them by calling remarc_set_status with status "handedOff".',
    'When you start working on a comment, mark it "inProgress".',
    `When you've fully addressed a comment, mark it "resolved" with a brief summary of what you did.`
  ];
  return lines.join(" ");
}
function deduplicateSessionName(baseName, activeSessions) {
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
async function createSession(input) {
  if (!input.name || !input.claudeSessionId) {
    throw new Error("createSession requires name and claudeSessionId");
  }
  let state = await readAppState();
  if (!state) {
    state = {
      sessions: [],
      comments: [],
      activeSessionID: null,
      totalCommentsCreated: 0
    };
  }
  if (input.source === "resume") {
    const existing = state.sessions.find(
      (s) => !s.isDeleted && !s.isAutoDismissed && s.claudeCodeSessionId === input.claudeSessionId
    );
    if (existing) {
      state.activeSessionID = existing.id;
      await writeAppState(state);
      notifyRemarcReload();
      return {
        remarcSessionId: existing.id,
        dataFilePath: getDataFilePath()
      };
    }
  }
  const activeSessions = state.sessions.filter((s) => !s.isDeleted && !s.isAutoDismissed);
  if (activeSessions.length >= MAX_ACTIVE_SESSIONS) {
    const claudeSessions = activeSessions.filter((s) => s.origin === "claudeCode").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (claudeSessions.length > 0) {
      const oldest = claudeSessions[0];
      const idx = state.sessions.findIndex((s) => s.id === oldest.id);
      if (idx !== -1) {
        state.sessions[idx].isAutoDismissed = true;
        state.sessions[idx].autoDismissedAt = /* @__PURE__ */ new Date();
      }
    } else {
      throw new Error("Max sessions reached and no Claude Code sessions to auto-dismiss.");
    }
  }
  const finalName = deduplicateSessionName(input.name, activeSessions);
  const sessionId = randomUUID().toUpperCase();
  const now = /* @__PURE__ */ new Date();
  const newSession = {
    id: sessionId,
    name: finalName,
    createdAt: now,
    isDeleted: false,
    deletedAt: null,
    isAutoDismissed: false,
    autoDismissedAt: null,
    origin: "claudeCode",
    claudeCodeSessionId: input.claudeSessionId
  };
  state.sessions.push(newSession);
  state.activeSessionID = sessionId;
  await writeAppState(state);
  notifyRemarcReload();
  return {
    remarcSessionId: sessionId,
    dataFilePath: getDataFilePath()
  };
}
async function handoff(input) {
  const state = await readAppState();
  if (!state) return "";
  const sessionIdUpper = input.remarcSessionId.toUpperCase();
  const session = state.sessions.find((s) => s.id.toUpperCase() === sessionIdUpper);
  if (!session || session.isDeleted) return "";
  const targetStatuses = input.recovery ? ["open", "handedOff", "inProgress"] : ["open"];
  const comments = state.comments.filter(
    (c) => c.sessionID.toUpperCase() === sessionIdUpper && !c.isDeleted && targetStatuses.includes(c.status)
  );
  const lines = [];
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
async function windDown(input) {
  const state = await readAppState();
  if (!state) return;
  const sessionIdUpper = input.remarcSessionId.toUpperCase();
  const sessionIdx = state.sessions.findIndex((s) => s.id.toUpperCase() === sessionIdUpper);
  if (sessionIdx === -1) return;
  const behavior = await readStringDefault("claudeCodeSessionEndBehavior", "autoDelete");
  const now = /* @__PURE__ */ new Date();
  switch (behavior) {
    case "keep":
      break;
    case "moveUnresolved": {
      let inbox = state.sessions.find(
        (s) => s.name === "Inbox" && !s.isDeleted && !s.isAutoDismissed
      );
      if (!inbox) {
        const inboxSession = {
          id: randomUUID(),
          name: "Inbox",
          createdAt: now,
          isDeleted: false,
          deletedAt: null,
          isAutoDismissed: false,
          autoDismissedAt: null,
          origin: "manual",
          claudeCodeSessionId: null
        };
        state.sessions.push(inboxSession);
        inbox = inboxSession;
      }
      for (let i = 0; i < state.comments.length; i++) {
        const c = state.comments[i];
        if (c.sessionID.toUpperCase() === sessionIdUpper && !c.isDeleted && ["open", "handedOff", "inProgress"].includes(c.status)) {
          state.comments[i].sessionID = inbox.id;
          state.comments[i].updatedAt = now;
        }
      }
      state.sessions[sessionIdx].isDeleted = true;
      state.sessions[sessionIdx].deletedAt = now;
      for (let i = 0; i < state.comments.length; i++) {
        if (state.comments[i].sessionID.toUpperCase() === sessionIdUpper && !state.comments[i].isDeleted) {
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

// src/marker.ts
import { writeFile as writeFile2, readFile as readFile2, unlink, utimes } from "node:fs/promises";
import { existsSync as existsSync2, statSync } from "node:fs";
function markerPath(claudeSessionId) {
  return `/tmp/remarc-claude-${claudeSessionId}.marker`;
}
async function writeMarker(claudeSessionId, m) {
  const path = markerPath(claudeSessionId);
  await writeFile2(path, `${m.remarcSessionId}
${m.dataFilePath}
`);
  const stamp = /* @__PURE__ */ new Date("2000-01-01T00:00:00Z");
  await utimes(path, stamp, stamp);
}
async function readMarker(claudeSessionId) {
  const path = markerPath(claudeSessionId);
  if (!existsSync2(path)) return null;
  const content = await readFile2(path, "utf8");
  const [remarcSessionId, dataFilePath] = content.split("\n");
  return remarcSessionId ? { remarcSessionId, dataFilePath: dataFilePath ?? "" } : null;
}
async function touchMarker(claudeSessionId) {
  const path = markerPath(claudeSessionId);
  if (existsSync2(path)) {
    const now = /* @__PURE__ */ new Date();
    await utimes(path, now, now);
  }
}
function dataNewerThanMarker(claudeSessionId, dataFilePath) {
  const mp = markerPath(claudeSessionId);
  if (!existsSync2(mp) || !existsSync2(dataFilePath)) return false;
  return statSync(dataFilePath).mtimeMs > statSync(mp).mtimeMs;
}
async function removeMarker(claudeSessionId) {
  try {
    await unlink(markerPath(claudeSessionId));
  } catch {
  }
}

// src/hook.ts
async function runHook(event, rawInput) {
  try {
    let input;
    try {
      input = JSON.parse(rawInput || "{}");
    } catch {
      return "{}";
    }
    switch (event) {
      case "session-start":
        return JSON.stringify(await onSessionStart(input));
      case "prompt-submit":
        return JSON.stringify(await onPromptSubmit(input));
      case "session-end":
        return JSON.stringify(await onSessionEnd(input));
      default:
        return "{}";
    }
  } catch (err) {
    process.stderr.write(
      `remarc-hooks: ${event} failed: ${err instanceof Error ? err.message : String(err)}
`
    );
    return "{}";
  }
}
async function onSessionStart(input) {
  if (input.agent_type || !input.session_id) return {};
  const source = input.source ?? "startup";
  if (source === "startup" || source === "resume") {
    const autoCreate = await readBoolDefault("claudeCodeAutoCreateSession");
    if (autoCreate === false) return {};
    const name = basename(input.cwd ?? process.cwd()) || "Session";
    const result = await createSession({
      name,
      claudeSessionId: input.session_id,
      source
    });
    await writeMarker(input.session_id, {
      remarcSessionId: result.remarcSessionId,
      dataFilePath: result.dataFilePath
    });
    const context = await handoff({
      remarcSessionId: result.remarcSessionId,
      claudeSessionId: input.session_id,
      recovery: true
    });
    return wrap("SessionStart", context);
  }
  if (source === "compact" || source === "clear") {
    const marker = await readMarker(input.session_id);
    if (!marker) return {};
    const context = await handoff({
      remarcSessionId: marker.remarcSessionId,
      claudeSessionId: input.session_id,
      recovery: true
    });
    return wrap("SessionStart", context);
  }
  return {};
}
async function onPromptSubmit(input) {
  if (!input.session_id) return {};
  const marker = await readMarker(input.session_id);
  if (!marker) return {};
  const prompt = input.prompt ?? "";
  const hintMatches = /\bremarc\b|\bmy comments?\b|\bopen comments?\b/i.test(prompt);
  if (!dataNewerThanMarker(input.session_id, marker.dataFilePath) && !hintMatches) {
    return {};
  }
  const context = await handoff({
    remarcSessionId: marker.remarcSessionId,
    claudeSessionId: input.session_id,
    recovery: false
  });
  await touchMarker(input.session_id);
  if (!context) return {};
  return wrap("UserPromptSubmit", context);
}
async function onSessionEnd(input) {
  if (!input.session_id) return {};
  const marker = await readMarker(input.session_id);
  if (!marker) return {};
  try {
    await windDown({ remarcSessionId: marker.remarcSessionId });
  } catch {
  }
  await removeMarker(input.session_id);
  return {};
}
function wrap(eventName, additionalContext) {
  if (!additionalContext) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext
    }
  };
}
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const event = process.argv[2] ?? "";
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const out = await runHook(event, raw);
  if (out !== "{}") process.stdout.write(out);
  process.exit(0);
}
export {
  runHook
};
