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
const expectedVersion = argumentsByName.get("expected-version") ?? "0.11.0";
const keep = argumentsByName.get("keep") === "true";

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

function marketplaceEntries(list) {
  return list.marketplace.filter((item) => item.id === "remarc@remarc");
}

function assertScope(list, scope, expected) {
  const item = marketplaceEntries(list).find((candidate) => candidate.scope === scope);
  if (!expected) {
    assert(item === undefined, `unexpected ${scope} Remarc installation`);
    return undefined;
  }
  assert(item, `missing ${scope} Remarc installation`);
  assert(item.entries.length === 1, `${scope} installation has unexpected entry count`);
  assert(item.entries[0].scope === scope, `${scope} installation reports the wrong scope`);
  assert(item.entries[0].version === expectedVersion, `${scope} installation has the wrong version`);
  return item;
}

function assertInstalledPackage(item) {
  const installPath = item.entries[0].installPath;
  assert(lstatSync(installPath).isDirectory(), "OMP cache target is not a directory");
  assert(!lstatSync(installPath).isSymbolicLink(), "OMP cache target is a symlink");
  assert(!isWithin(installPath, repositoryRoot), "OMP cache target points into the source checkout");
  for (const relativePath of ["plugin.json", "mcp.json", "skills/remarc/SKILL.md", "mcp/dist/index.js"]) {
    assert(existsSync(resolve(installPath, relativePath)), `installed plugin is missing ${relativePath}`);
  }
  return installPath;
}

async function discoverInOmp({ cwd, env }) {
  return new Promise((resolveDiscovery, rejectDiscovery) => {
    const child = spawn(
      ompBinary,
      ["--mode", "rpc", "--no-session", "--model", "openai/gpt-5.2"],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdoutBuffer = "";
    let stderr = "";
    let ready = false;
    let foundSkill = false;
    let nextId = 0;
    let settled = false;
    let pollTimer;
    let timeoutTimer;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      if (!child.stdin.destroyed) child.stdin.end();
      if (error) {
        child.kill("SIGTERM");
        rejectDiscovery(error);
      }
    };

    const checkDone = () => {
      if (foundSkill) finish();
    };

    const inspectFrame = (frame) => {
      if (frame.type === "ready") ready = true;
      const commands =
        frame.type === "available_commands_update"
          ? frame.commands
          : frame.type === "response" && frame.command === "get_available_commands"
            ? frame.data?.commands
            : undefined;
      if (Array.isArray(commands)) {
        foundSkill ||= commands.some(
          (command) => command.name === "skill:remarc" && command.source === "skill"
        );
      }
      checkDone();
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
      resolveDiscovery({ ready, foundSkill });
    });

    pollTimer = setInterval(() => {
      if (!ready || child.stdin.destroyed) return;
      nextId += 1;
      child.stdin.write(
        `${JSON.stringify({ id: `commands-${nextId}`, type: "get_available_commands" })}\n`
      );
    }, 400);
    timeoutTimer = setTimeout(() => {
      finish(
        new Error(
          `OMP did not discover the Remarc skill within 15 seconds (ready=${ready}, skill=${foundSkill})\n${stderr}`
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

    for (const harness of [undefined, "claudeCode", "codex"]) {
      const rejected = await client.callTool({
        name: "remarc_create_session",
        arguments: {
          name: "Wrong OMP origin",
          claude_session_id: "omp-smoke-session",
          ...(harness ? { harness } : {}),
        },
      });
      const rejectionText = resultText(rejected);
      assert(rejected.isError === true, "OMP create-session guard did not return an MCP error");
      assert(
        rejectionText.includes("OMP cannot create Remarc sessions yet"),
        "OMP create-session guard returned the wrong error"
      );
      assert(
        readFileSync(dataPath).equals(dataBefore),
        `OMP create-session guard changed comments.json bytes for ${harness ?? "no harness"}`
      );
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
  run(["plugin", "install", "--scope", "user", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });

  let list = JSON.parse(
    run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment })
  );
  const user = assertScope(list, "user", true);
  assertScope(list, "project", false);
  assert(user.shadowedBy === undefined, "user install is unexpectedly shadowed");
  const userInstallPath = assertInstalledPackage(user);

  let discovery = await discoverInOmp({ cwd: project, env: isolatedEnvironment });
  assert(discovery.ready && discovery.foundSkill, "OMP user-scope skill discovery was incomplete");
  await discoverMcpInTui({ cwd: project, env: isolatedEnvironment });
  await probeInstalledMcp({
    serverPath: resolve(userInstallPath, "mcp/dist/index.js"),
    env: isolatedEnvironment,
    dataPath,
    markerDirectory,
  });

  run(["plugin", "install", "--scope", "project", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  const projectEntry = assertScope(list, "project", true);
  assert(assertScope(list, "user", true).shadowedBy === "project", "project scope does not shadow user scope");
  assert(projectEntry.shadowedBy === undefined, "project scope is unexpectedly shadowed");
  const projectInstallPath = assertInstalledPackage(projectEntry);

  discovery = await discoverInOmp({ cwd: project, env: isolatedEnvironment });
  assert(discovery.ready && discovery.foundSkill, "OMP project-scope skill discovery was incomplete");
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

  run(["plugin", "disable", "--scope", "project", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(assertScope(list, "project", true).entries[0].enabled === false, "project disable failed");
  assert(assertScope(list, "user", true).shadowedBy === undefined, "disabled project still shadows user");

  run(["plugin", "enable", "--scope", "project", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assert(assertScope(list, "project", true).entries[0].enabled === true, "project enable failed");
  assert(assertScope(list, "user", true).shadowedBy === "project", "re-enabled project does not shadow user");

  run(["plugin", "uninstall", "--scope", "project", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assertScope(list, "project", false);
  assertScope(list, "user", true);

  run(["plugin", "install", "--scope", "project", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });
  run(["plugin", "uninstall", "--scope", "project", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });
  run(["plugin", "uninstall", "--scope", "user", "remarc@remarc"], {
    cwd: project,
    env: isolatedEnvironment,
  });
  list = JSON.parse(run(["plugin", "list", "--json"], { cwd: project, env: isolatedEnvironment }));
  assertScope(list, "project", false);
  assertScope(list, "user", false);
  assert(readFileSync(dataPath, "utf8") === initialDocument, "plugin lifecycle changed Remarc data");
  assert(
    readFileSync(resolve(markerDirectory, "sentinel.json"), "utf8") === '{"futureMarker":"keep"}\n',
    "plugin lifecycle changed the marker sentinel"
  );

  console.log(
    `OMP ${expectedVersion} marketplace smoke passed: user/project lifecycle, skill, namespaced MCP tools, and guarded installed runtime`
  );
} finally {
  if (keep) console.log(`kept isolated OMP profile at ${smokeRoot}`);
  else rmSync(smokeRoot, { recursive: true, force: true });
}
