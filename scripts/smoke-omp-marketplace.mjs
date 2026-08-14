#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) {
    throw new Error(`invalid argument near ${JSON.stringify(name)}`);
  }
  argumentsByName.set(name.slice(2), value);
}

const ompArgument = argumentsByName.get("omp") ?? "omp";
const ompBinary = ompArgument.includes(sep) ? resolve(ompArgument) : ompArgument;
const marketplaceSource = argumentsByName.get("marketplace") ?? repositoryRoot;
const expectedVersion = argumentsByName.get("expected-version") ?? "0.12.0";
const keep = argumentsByName.get("keep") === "true";
const corePluginId = "remarc@remarc";
const wakePluginId = "remarc-wake@remarc";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isWithin(candidate, parent) {
  const path = relative(realpathSync(parent), realpathSync(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function run(args, { cwd, env }) {
  const result = spawnSync(ompBinary, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${ompBinary} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout.trim();
}

function marketplaceEntries(list, pluginId) {
  return list.marketplace.filter((item) => item.id === pluginId);
}

function assertScope(list, pluginId, scope, expected) {
  const item = marketplaceEntries(list, pluginId).find((candidate) => candidate.scope === scope);
  if (!expected) {
    assert(item === undefined, `unexpected ${scope} ${pluginId} installation`);
    return undefined;
  }
  assert(item, `missing ${scope} ${pluginId} installation`);
  assert(item.entries.length === 1, `${scope} ${pluginId} installation has unexpected entry count`);
  assert(item.entries[0].scope === scope, `${scope} ${pluginId} installation reports the wrong scope`);
  assert(
    item.entries[0].version === expectedVersion,
    `${scope} ${pluginId} installation has the wrong version`
  );
  return item;
}

function assertInstalledPackage(item, pluginId, requiredPaths) {
  const installPath = item.entries[0].installPath;
  const target = lstatSync(installPath);
  assert(target.isDirectory(), `${pluginId} cache target is not a directory`);
  assert(!target.isSymbolicLink(), `${pluginId} cache target is a symlink`);
  assert(!isWithin(installPath, repositoryRoot), `${pluginId} cache target points into the source checkout`);
  for (const relativePath of requiredPaths) {
    assert(
      existsSync(resolve(installPath, relativePath)),
      `installed ${pluginId} package is missing ${relativePath}`
    );
  }
  return installPath;
}

function assertCommand(commands, name, source, expected = true) {
  const found = commands.some((command) => command.name === name && command.source === source);
  assert(
    found === expected,
    expected
      ? `OMP did not discover /${name} from ${source}`
      : `OMP unexpectedly discovered /${name} from ${source}`
  );
}

async function availableCommandsInOmp({ cwd, env }) {
  return new Promise((resolveDiscovery, rejectDiscovery) => {
    const child = spawn(
      ompBinary,
      ["--mode", "rpc", "--no-session", "--model", "openai/gpt-5.2"],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdoutBuffer = "";
    let stderr = "";
    let ready = false;
    let commands;
    let settled = false;
    let timeoutTimer;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (!child.stdin.destroyed) child.stdin.end();
      if (error) {
        child.kill("SIGTERM");
        rejectDiscovery(error);
      }
    };

    const inspectFrame = (frame) => {
      if (frame.type === "ready") ready = true;
      if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) {
        commands = frame.commands;
        finish();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          inspectFrame(JSON.parse(line));
        } catch (error) {
          finish(new Error(`invalid OMP RPC frame: ${line.slice(0, 200)}\n${error}`));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`OMP RPC exited before discovery (${code ?? signal})\n${stderr}`));
        return;
      }
      if (code !== 0) {
        rejectDiscovery(new Error(`OMP RPC exited ${code ?? signal}\n${stderr}`));
        return;
      }
      if (!ready || !Array.isArray(commands)) {
        rejectDiscovery(
          new Error(`OMP RPC command discovery was incomplete (ready=${ready}, commands=${Array.isArray(commands)})`)
        );
        return;
      }
      resolveDiscovery(commands);
    });

    timeoutTimer = setTimeout(() => {
      finish(
        new Error(
          `OMP did not publish available commands within 15 seconds (ready=${ready})\n${stderr}`
        )
      );
    }, 15_000);
  });
}

async function discoverMcpInTui({ cwd, env }) {
  return new Promise((resolveDiscovery, rejectDiscovery) => {
    const scriptBinary = "/usr/bin/script";
    assert(existsSync(scriptBinary), "macOS script(1) is required for the OMP TUI smoke test");
    const shellProgram = [
      "(",
      "  sleep 5",
      "  printf '/mcp list\\r'",
      "  sleep 10",
      "  printf '\\003\\003\\004'",
      ") | /usr/bin/script -q /dev/null \"$1\" --no-session --model openai/gpt-5.2",
    ].join("\n");
    const child = spawn(
      "/bin/sh",
      ["-c", shellProgram, "remarc-omp-tui-smoke", ompBinary],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] }
    );
    let output = "";
    let timedOut = false;

    const inspect = (chunk) => {
      output += chunk;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("error", rejectDiscovery);
    child.on("exit", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (timedOut) return;
      if (code !== 0) {
        rejectDiscovery(new Error(`OMP TUI exited ${code ?? signal}\n${output.slice(-2_000)}`));
        return;
      }
      try {
        assert(output.includes("Agent Plugins"), "OMP TUI did not attribute the server to Agent Plugins");
        assert(output.includes("remarc:remarc"), "OMP TUI did not list the namespaced Remarc MCP server");
        assert(output.includes("connected"), "OMP TUI did not connect the Remarc MCP server");
      } catch (error) {
        rejectDiscovery(error);
        return;
      }
      resolveDiscovery();
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      rejectDiscovery(
        new Error("OMP TUI did not finish the MCP discovery smoke within 30 seconds")
      );
    }, 30_000);
  });
}

async function probeInstalledMcp({ serverPath, env, dataPath, markerDirectory }) {
  const clientModulePath = resolve(
    repositoryRoot,
    "plugins/remarc/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"
  );
  const transportModulePath = resolve(
    repositoryRoot,
    "plugins/remarc/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js"
  );
  assert(existsSync(clientModulePath), "run npm ci for plugins/remarc/mcp before the OMP smoke test");
  const { Client } = await import(pathToFileURL(clientModulePath));
  const { StdioClientTransport } = await import(pathToFileURL(transportModulePath));

  const dataBefore = readFileSync(dataPath);
  const markersBefore = readdirSync(markerDirectory)
    .sort()
    .map((name) => [name, readFileSync(resolve(markerDirectory, name))]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--harness", "omp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "remarc-omp-smoke", version: "1.0.0" });

  const resultText = (result) =>
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

  try {
    await client.connect(transport);
    const listedTools = await client.listTools();
    const toolNames = new Set(listedTools.tools.map((tool) => tool.name));
    for (const name of [
      "remarc_list_sessions",
      "remarc_list_comments",
      "remarc_get_comment",
      "remarc_set_status",
      "remarc_bulk_set_status",
      "remarc_rename_session",
      "remarc_create_session",
    ]) {
      assert(toolNames.has(name), `installed MCP did not expose ${name}`);
    }

    const sessions = await client.callTool({ name: "remarc_list_sessions", arguments: {} });
    assert(
      sessions.isError !== true && resultText(sessions).includes("Existing"),
      "installed MCP could not list the seeded session"
    );

    for (const [name, harness] of [
      ["Native OMP", undefined],
      ["Spoof-resistant OMP", "claudeCode"],
      ["Codex-spoof-resistant OMP", "codex"],
    ]) {
      const created = await client.callTool({
        name: "remarc_create_session",
        arguments: {
          name,
          ...(harness ? { claude_session_id: "omp-smoke-session" } : {}),
          ...(harness ? { harness } : {}),
        },
      });
      assert(created.isError !== true, `OMP could not create ${name}`);
      assert(
        resultText(created).includes("/remarc-pair"),
        "OMP creation response omitted pairing guidance"
      );
      const createdDocument = JSON.parse(readFileSync(dataPath, "utf8"));
      const createdSession = createdDocument.sessions.find((session) => session.name === name);
      assert(
        createdSession?.origin === "omp" && createdSession.claudeCodeSessionId === null,
        `OMP creation persisted the wrong origin for ${harness ?? "no harness"}`
      );
      assert(createdDocument.futureTop?.keep === true, "OMP creation dropped an unknown top-level field");
      assert(createdDocument.sessions[0].futureSession === "keep", "OMP creation dropped an unknown session field");
    }

    const comments = await client.callTool({
      name: "remarc_list_comments",
      arguments: { session_id: "S1", status: "handedOff" },
    });
    assert(
      comments.isError !== true && resultText(comments).includes("First workflow comment"),
      "installed MCP could not list the seeded handed-off comment"
    );

    const comment = await client.callTool({
      name: "remarc_get_comment",
      arguments: { id: "COMMENT-00001" },
    });
    assert(
      comment.isError !== true && resultText(comment).includes("futureComment is preserved"),
      "installed MCP could not fetch the seeded comment"
    );

    const claimed = await client.callTool({
      name: "remarc_set_status",
      arguments: {
        id: "COMMENT-00001",
        status: "inProgress",
        expected_status: "handedOff",
      },
    });
    assert(claimed.isError !== true, "installed MCP could not claim a handed-off comment");

    const staleClaim = await client.callTool({
      name: "remarc_set_status",
      arguments: {
        id: "COMMENT-00001",
        status: "inProgress",
        expected_status: "handedOff",
      },
    });
    assert(staleClaim.isError === true, "installed MCP did not enforce compare-and-set status");

    const resolved = await client.callTool({
      name: "remarc_set_status",
      arguments: {
        id: "COMMENT-00001",
        status: "resolved",
        summary: "Resolved by the installed OMP runtime",
        expected_status: "inProgress",
      },
    });
    assert(resolved.isError !== true, "installed MCP could not resolve a claimed comment");
    let mutatedDocument = JSON.parse(readFileSync(dataPath, "utf8"));
    assert(
      mutatedDocument.comments.find((item) => item.id === "COMMENT-00001")?.resolvedBy === "omp",
      "installed OMP MCP persisted the wrong resolution attribution"
    );

    const reopened = await client.callTool({
      name: "remarc_set_status",
      arguments: {
        id: "COMMENT-00001",
        status: "open",
        expected_status: "resolved",
      },
    });
    assert(reopened.isError !== true, "installed MCP could not reopen a resolved comment");

    const handedOff = await client.callTool({
      name: "remarc_set_status",
      arguments: {
        id: "COMMENT-00001",
        status: "handedOff",
        expected_status: "open",
      },
    });
    assert(handedOff.isError !== true, "installed MCP could not hand off a reopened comment");

    const bulkResolved = await client.callTool({
      name: "remarc_bulk_set_status",
      arguments: {
        status: "resolved",
        comments: [
          { id: "COMMENT-00001", summary: "Bulk-resolved first comment" },
          { id: "COMMENT-00002", summary: "Bulk-resolved second comment" },
        ],
      },
    });
    assert(bulkResolved.isError !== true, "installed MCP could not bulk-resolve comments");

    const renamed = await client.callTool({
      name: "remarc_rename_session",
      arguments: { session_id: "S1", name: "OMP Verified" },
    });
    assert(renamed.isError !== true, "installed MCP could not rename a session");

    mutatedDocument = JSON.parse(readFileSync(dataPath, "utf8"));
    assert(mutatedDocument.futureTop?.keep === true, "MCP update dropped an unknown top-level field");
    assert(mutatedDocument.sessions[0].futureSession === "keep", "MCP update dropped an unknown session field");
    assert(mutatedDocument.sessions[0].name === "OMP Verified", "MCP rename did not persist");
    for (const persistedComment of mutatedDocument.comments) {
      assert(persistedComment.futureComment === "keep", "MCP update dropped an unknown comment field");
      assert(persistedComment.status === "resolved", "MCP bulk resolution did not persist");
      assert(persistedComment.resolvedBy === "omp", "MCP bulk resolution used the wrong attribution");
    }
    assert(
      mutatedDocument.comments[0].webContext?.futureWebContext === "keep",
      "MCP update dropped an unknown web-context field"
    );
  } finally {
    await client.close();
    writeFileSync(dataPath, dataBefore);
  }

  assert(readFileSync(dataPath).equals(dataBefore), "OMP MCP probe changed comments.json bytes");
  const markersAfter = readdirSync(markerDirectory)
    .sort()
    .map((name) => [name, readFileSync(resolve(markerDirectory, name))]);
  assert(markersAfter.length === markersBefore.length, "OMP MCP probe changed marker entries");
  for (let index = 0; index < markersBefore.length; index += 1) {
    assert(markersAfter[index][0] === markersBefore[index][0], "OMP MCP probe renamed a marker");
    assert(markersAfter[index][1].equals(markersBefore[index][1]), "OMP MCP probe changed marker bytes");
  }
}

if (ompBinary.includes(sep)) {
  assert(existsSync(ompBinary), `OMP binary does not exist: ${ompBinary}`);
}
assert(run(["--version"], { cwd: repositoryRoot, env: process.env }) === "omp/17.3.4", "wrong OMP version");
if (isAbsolute(marketplaceSource)) {
  assert(existsSync(marketplaceSource), `marketplace does not exist: ${marketplaceSource}`);
}

const smokeRoot = mkdtempSync(resolve(tmpdir(), "remarc-omp-marketplace-"));
const home = resolve(smokeRoot, "home");
const project = resolve(smokeRoot, "project");
const remarcDirectory = resolve(home, "Library/Application Support/Remarc");
const markerDirectory = resolve(remarcDirectory, "claude/markers");
const dataPath = resolve(remarcDirectory, "comments.json");
for (const path of [
  home,
  project,
  resolve(project, ".omp"),
  resolve(smokeRoot, "xdg-data"),
  resolve(smokeRoot, "xdg-state"),
  resolve(smokeRoot, "xdg-cache"),
  resolve(smokeRoot, "tmp"),
  markerDirectory,
  resolve(home, ".omp/agent"),
]) {
  mkdirSync(path, { recursive: true });
}

const initialDocument =
  '{"futureTop":{"keep":true},"sessions":[{"id":"S1","name":"Existing","createdAt":0,"isDeleted":false,"isAutoDismissed":false,"origin":"manual","futureSession":"keep"}],"comments":[{"id":"COMMENT-00001","type":{"quickNote":{}},"commentText":"First workflow comment; futureComment is preserved","source":"omp-smoke","createdAt":0,"updatedAt":0,"sessionID":"S1","isDeleted":false,"status":"handedOff","futureComment":"keep","webContext":{"url":"https://example.test","futureWebContext":"keep"}},{"id":"COMMENT-00002","type":{"quickNote":{}},"commentText":"Second workflow comment","source":"omp-smoke","createdAt":1,"updatedAt":1,"sessionID":"S1","isDeleted":false,"status":"open","futureComment":"keep"}],"activeSessionID":"S1","totalCommentsCreated":2}\n';
writeFileSync(dataPath, initialDocument);
writeFileSync(resolve(markerDirectory, "sentinel.json"), '{"futureMarker":"keep"}\n');
writeFileSync(resolve(home, ".omp/agent/config.yml"), "setupVersion: 1\n");
writeFileSync(resolve(home, ".omp/agent/last-changelog-version"), "17.3.4");

const isolatedEnvironment = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: resolve(smokeRoot, "xdg-data"),
  XDG_STATE_HOME: resolve(smokeRoot, "xdg-state"),
  XDG_CACHE_HOME: resolve(smokeRoot, "xdg-cache"),
  TMPDIR: resolve(smokeRoot, "tmp"),
  OPENAI_API_KEY: "remarc-smoke-not-used",
};

try {
  run(["plugin", "marketplace", "add", marketplaceSource], {
    cwd: project,
    env: isolatedEnvironment,
  });
  for (const pluginId of [corePluginId, wakePluginId]) {
    run(["plugin", "install", "--scope", "user", pluginId], {
      cwd: project,
      env: isolatedEnvironment,
    });
  }

  let list = JSON.parse(
    run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment })
  );
  const userCore = assertScope(list, corePluginId, "user", true);
  const userWake = assertScope(list, wakePluginId, "user", true);
  assertScope(list, corePluginId, "project", false);
  assertScope(list, wakePluginId, "project", false);
  assert(userCore.shadowedBy === undefined, "user core install is unexpectedly shadowed");
  assert(userWake.shadowedBy === undefined, "user wake install is unexpectedly shadowed");
  const userInstallPath = assertInstalledPackage(userCore, corePluginId, [
    "plugin.json",
    "mcp.json",
    "skills/remarc/SKILL.md",
    "mcp/dist/index.js",
  ]);
  assertInstalledPackage(userWake, wakePluginId, ["package.json", "dist/index.js"]);

  let commands = await availableCommandsInOmp({ cwd: project, env: isolatedEnvironment });
  assertCommand(commands, "skill:remarc", "skill");
  assertCommand(commands, "remarc-pair", "extension");
  assertCommand(commands, "remarc-unpair", "extension");
  await discoverMcpInTui({ cwd: project, env: isolatedEnvironment });
  await probeInstalledMcp({
    serverPath: resolve(userInstallPath, "mcp/dist/index.js"),
    env: isolatedEnvironment,
    dataPath,
    markerDirectory,
  });

  for (const pluginId of [corePluginId, wakePluginId]) {
    run(["plugin", "install", "--scope", "project", pluginId], {
      cwd: project,
      env: isolatedEnvironment,
    });
  }
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  const projectCore = assertScope(list, corePluginId, "project", true);
  const projectWake = assertScope(list, wakePluginId, "project", true);
  assert(
    assertScope(list, corePluginId, "user", true).shadowedBy === "project",
    "project core install does not shadow user scope"
  );
  assert(
    assertScope(list, wakePluginId, "user", true).shadowedBy === "project",
    "project wake install does not shadow user scope"
  );
  assert(projectCore.shadowedBy === undefined, "project core scope is unexpectedly shadowed");
  assert(projectWake.shadowedBy === undefined, "project wake scope is unexpectedly shadowed");
  const projectInstallPath = assertInstalledPackage(projectCore, corePluginId, [
    "plugin.json",
    "mcp.json",
    "skills/remarc/SKILL.md",
    "mcp/dist/index.js",
  ]);
  assertInstalledPackage(projectWake, wakePluginId, ["package.json", "dist/index.js"]);

  commands = await availableCommandsInOmp({ cwd: project, env: isolatedEnvironment });
  assertCommand(commands, "skill:remarc", "skill");
  assertCommand(commands, "remarc-pair", "extension");
  assertCommand(commands, "remarc-unpair", "extension");
  await discoverMcpInTui({ cwd: project, env: isolatedEnvironment });
  await probeInstalledMcp({
    serverPath: resolve(projectInstallPath, "mcp/dist/index.js"),
    env: isolatedEnvironment,
    dataPath,
    markerDirectory,
  });

  const doctor = JSON.parse(
    run(["plugin", "doctor", "--json"], { cwd: project, env: isolatedEnvironment })
  );
  assert(!doctor.some((check) => check.status === "error"), "OMP plugin doctor reported an error");

  run(["plugin", "disable", "--scope", "project", wakePluginId], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(
    assertScope(list, wakePluginId, "project", true).entries[0].enabled === false,
    "project wake disable failed"
  );
  assert(
    assertScope(list, wakePluginId, "user", true).shadowedBy === undefined,
    "disabled project wake still shadows user wake"
  );
  commands = await availableCommandsInOmp({ cwd: project, env: isolatedEnvironment });
  assertCommand(commands, "remarc-pair", "extension");
  assertCommand(commands, "remarc-unpair", "extension");

  run(["plugin", "disable", "--scope", "user", wakePluginId], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(
    assertScope(list, wakePluginId, "user", true).entries[0].enabled === false,
    "user wake disable failed"
  );
  commands = await availableCommandsInOmp({ cwd: project, env: isolatedEnvironment });
  assertCommand(commands, "skill:remarc", "skill");
  assertCommand(commands, "remarc-pair", "extension", false);
  assertCommand(commands, "remarc-unpair", "extension", false);

  run(["plugin", "enable", "--scope", "user", wakePluginId], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(
    assertScope(list, wakePluginId, "user", true).entries[0].enabled === true,
    "user wake enable failed"
  );
  commands = await availableCommandsInOmp({ cwd: project, env: isolatedEnvironment });
  assertCommand(commands, "remarc-pair", "extension");
  assertCommand(commands, "remarc-unpair", "extension");

  run(["plugin", "enable", "--scope", "project", wakePluginId], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(
    assertScope(list, wakePluginId, "project", true).entries[0].enabled === true,
    "project wake enable failed"
  );
  assert(
    assertScope(list, wakePluginId, "user", true).shadowedBy === "project",
    "re-enabled project wake does not shadow user wake"
  );

  run(["plugin", "disable", "--scope", "project", corePluginId], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(
    assertScope(list, corePluginId, "project", true).entries[0].enabled === false,
    "project core disable failed"
  );
  assert(
    assertScope(list, corePluginId, "user", true).shadowedBy === undefined,
    "disabled project core still shadows user core"
  );
  run(["plugin", "enable", "--scope", "project", corePluginId], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(
    assertScope(list, corePluginId, "project", true).entries[0].enabled === true,
    "project core enable failed"
  );
  assert(
    assertScope(list, corePluginId, "user", true).shadowedBy === "project",
    "re-enabled project core does not shadow user core"
  );

  for (const pluginId of [wakePluginId, corePluginId]) {
    run(["plugin", "uninstall", "--scope", "project", pluginId], {
      cwd: project,
      env: isolatedEnvironment,
    });
  }
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assertScope(list, corePluginId, "project", false);
  assertScope(list, wakePluginId, "project", false);
  assertScope(list, corePluginId, "user", true);
  assertScope(list, wakePluginId, "user", true);

  for (const pluginId of [corePluginId, wakePluginId]) {
    run(["plugin", "install", "--scope", "project", pluginId], {
      cwd: project,
      env: isolatedEnvironment,
    });
  }
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assertInstalledPackage(assertScope(list, wakePluginId, "project", true), wakePluginId, [
    "package.json",
    "dist/index.js",
  ]);
  assert(
    assertScope(list, wakePluginId, "user", true).shadowedBy === "project",
    "reinstalled project wake does not shadow user wake"
  );

  for (const scope of ["project", "user"]) {
    for (const pluginId of [wakePluginId, corePluginId]) {
      run(["plugin", "uninstall", "--scope", scope, pluginId], {
        cwd: project,
        env: isolatedEnvironment,
      });
    }
  }
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  for (const pluginId of [corePluginId, wakePluginId]) {
    assertScope(list, pluginId, "project", false);
    assertScope(list, pluginId, "user", false);
  }
  assert(readFileSync(dataPath, "utf8") === initialDocument, "plugin lifecycle changed Remarc data");
  assert(
    readFileSync(resolve(markerDirectory, "sentinel.json"), "utf8") === '{"futureMarker":"keep"}\n',
    "plugin lifecycle changed the marker sentinel"
  );
  assert(
    JSON.stringify(readdirSync(markerDirectory).sort()) === JSON.stringify(["sentinel.json"]),
    "plugin lifecycle created an unexpected Remarc marker"
  );

  console.log(
    `OMP ${expectedVersion} marketplace smoke passed: core and wake user/project lifecycle, cached packages, commands, MCP tools, and marker isolation`
  );
} finally {
  if (keep) console.log(`kept isolated OMP profile at ${smokeRoot}`);
  else rmSync(smokeRoot, { recursive: true, force: true });
}
