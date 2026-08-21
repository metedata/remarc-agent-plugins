import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

const manifestPaths = [
  "plugins/remarc/.claude-plugin/plugin.json",
  "plugins/remarc/.codex-plugin/plugin.json",
  "plugins/remarc/plugin.json",
  "plugins/remarc-hooks/.claude-plugin/plugin.json",
  "plugins/remarc-hooks/.codex-plugin/plugin.json",
];

const versions = manifestPaths.map((path) => ({
  path,
  version: readJson(path).version,
}));

const ompCatalog = readJson(".omp-plugin/marketplace.json");
const ompRemarc = ompCatalog.plugins?.find((plugin) => plugin.name === "remarc");
if (!ompRemarc) {
  throw new Error(".omp-plugin/marketplace.json has no remarc entry");
}
const ompWake = ompCatalog.plugins?.find((plugin) => plugin.name === "remarc-wake");
if (!ompWake) {
  throw new Error(".omp-plugin/marketplace.json has no remarc-wake entry");
}
versions.push({
  path: ".omp-plugin/marketplace.json#remarc",
  version: ompRemarc.version,
});
versions.push({
  path: ".omp-plugin/marketplace.json#remarc-wake",
  version: ompWake.version,
});
versions.push({
  path: "plugins/remarc-wake/package.json",
  version: readJson("plugins/remarc-wake/package.json").version,
});

for (const { path, version } of versions) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${path} has invalid public version ${JSON.stringify(version)}`);
  }
}

const publicVersions = new Set(versions.map(({ version }) => version));
if (publicVersions.size !== 1) {
  throw new Error(
    `public plugin versions differ:\n${versions
      .map(({ path, version }) => `  ${path}: ${version}`)
      .join("\n")}`
  );
}

const mcpPackageVersion = readJson("plugins/remarc/mcp/package.json").version;
const mcpSourcePath = "plugins/remarc/mcp/src/index.ts";
const mcpSource = readFileSync(resolve(root, mcpSourcePath), "utf8");
const mcpSourceMatch = mcpSource.match(/name: "remarc",\s*version: "([^"]+)"/s);
if (!mcpSourceMatch) {
  throw new Error(`could not find the MCP initialize version in ${mcpSourcePath}`);
}
if (mcpPackageVersion !== mcpSourceMatch[1]) {
  throw new Error(
    `MCP implementation versions differ: package.json=${mcpPackageVersion}, ${mcpSourcePath}=${mcpSourceMatch[1]}`
  );
}

console.log(
  `public plugin version ${versions[0].version}; MCP implementation version ${mcpPackageVersion}`
);
