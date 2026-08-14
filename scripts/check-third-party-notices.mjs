#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function read(relativePath) {
  const path = resolve(repositoryRoot, relativePath);
  if (!existsSync(path)) fail(`missing ${relativePath}`);
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
  }
}

function packageNameFromBundledPath(path) {
  const parts = path.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

const rootLicense = read("LICENSE");
for (const packageLicense of [
  "plugins/remarc/LICENSE",
  "plugins/remarc-hooks/LICENSE",
  "plugins/remarc-wake/LICENSE",
]) {
  assertEqual(read(packageLicense), rootLicense, `${packageLicense} must exactly match the root LICENSE`);
}

const rootNotice = read("THIRD-PARTY-NOTICES.md");
const normalizedRootNotice = rootNotice.replace(/\s+/g, " ");
for (const requiredText of [
  "[`plugins/remarc/THIRD-PARTY-NOTICES.md`](plugins/remarc/THIRD-PARTY-NOTICES.md)",
  "shipped inside every installed or cached `remarc` core plugin package",
  "`plugins/remarc-hooks` and `plugins/remarc-wake`",
  "do not bundle third-party runtime code",
]) {
  if (!normalizedRootNotice.includes(requiredText)) {
    fail(`root THIRD-PARTY-NOTICES.md is missing required distribution guidance: ${requiredText}`);
  }
}

const bundledDependencies = [
  {
    name: "@modelcontextprotocol/sdk",
    source: "https://github.com/modelcontextprotocol/typescript-sdk",
    license: "MIT",
  },
  { name: "ajv", source: "https://github.com/ajv-validator/ajv", license: "MIT" },
  {
    name: "ajv-formats",
    source: "https://github.com/ajv-validator/ajv-formats",
    license: "MIT",
  },
  {
    name: "fast-deep-equal",
    source: "https://github.com/epoberezkin/fast-deep-equal",
    license: "MIT",
  },
  { name: "fast-uri", source: "https://github.com/fastify/fast-uri", license: "BSD-3-Clause" },
  {
    name: "json-schema-traverse",
    source: "https://github.com/epoberezkin/json-schema-traverse",
    license: "MIT",
  },
  { name: "zod", source: "https://github.com/colinhacks/zod", license: "MIT" },
  {
    name: "zod-to-json-schema",
    source: "https://github.com/StefanTerdell/zod-to-json-schema",
    license: "ISC",
  },
];

const coreBundle = read("plugins/remarc/mcp/dist/index.js");
const bundledSourcePaths = [...coreBundle.matchAll(/^\/\/ node_modules\/([^:\n]+)$/gm)].map(
  (match) => match[1]
);
const actualBundledPackages = [...new Set(bundledSourcePaths.map(packageNameFromBundledPath))].sort();
const expectedBundledPackages = bundledDependencies.map(({ name }) => name).sort();
assertEqual(
  actualBundledPackages.join("\n"),
  expectedBundledPackages.join("\n"),
  "the core bundle dependency set changed; update its canonical third-party notice and checker"
);

const lock = readJson("plugins/remarc/mcp/package-lock.json");
const canonicalNotice = read("plugins/remarc/THIRD-PARTY-NOTICES.md");
const expectedHeadings = [];

for (const dependency of bundledDependencies) {
  const lockEntry = lock.packages?.[`node_modules/${dependency.name}`];
  if (!lockEntry?.version) fail(`lockfile has no version for bundled dependency ${dependency.name}`);
  if (lockEntry.dev === true) fail(`bundled dependency ${dependency.name} is marked dev-only in the lockfile`);
  assertEqual(
    lockEntry.license,
    dependency.license,
    `unexpected SPDX license for ${dependency.name}; review its current license and notice`
  );

  const installedLicensePath = `plugins/remarc/mcp/node_modules/${dependency.name}/LICENSE`;
  if (!existsSync(resolve(repositoryRoot, installedLicensePath))) {
    fail(`missing ${installedLicensePath}; run npm ci in plugins/remarc/mcp before this check`);
  }
  const upstreamLicense = read(installedLicensePath).trimEnd();
  const heading = `${dependency.name} ${lockEntry.version}`;
  expectedHeadings.push(heading);
  const expectedSection = [
    `## ${heading}`,
    "",
    `- Source: ${dependency.source}`,
    "",
    "Upstream license (verbatim):",
    "",
    "```text",
    upstreamLicense,
    "```",
  ].join("\n");
  if (!canonicalNotice.includes(expectedSection)) {
    fail(
      `canonical notice for ${dependency.name} does not exactly match lockfile version ${lockEntry.version}, source URL, and installed LICENSE text`
    );
  }
}

const actualHeadings = [...canonicalNotice.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
assertEqual(
  actualHeadings.join("\n"),
  expectedHeadings.join("\n"),
  "canonical notice headings must exactly match the bundled dependency set and lockfile order"
);

for (const [packageName, packageJsonPath, bundlePath] of [
  ["remarc-hooks", "plugins/remarc-hooks/cli/package.json", "plugins/remarc-hooks/cli/dist/hook.js"],
  ["remarc-wake", "plugins/remarc-wake/package.json", "plugins/remarc-wake/dist/index.js"],
]) {
  const packageJson = readJson(packageJsonPath);
  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
  assertEqual(
    runtimeDependencies.join("\n"),
    "",
    `${packageName} now declares runtime dependencies; update its distribution notice`
  );
  if (/^\/\/ node_modules\//m.test(read(bundlePath))) {
    fail(`${bundlePath} now contains bundled third-party runtime code; update its distribution notice`);
  }
}

const wakePackage = readJson("plugins/remarc-wake/package.json");
assertEqual(wakePackage.license, "MIT", "remarc-wake package metadata must declare MIT");
assertEqual(wakePackage.homepage, "https://remarc.app", "remarc-wake homepage metadata drifted");
assertEqual(
  wakePackage.repository?.url,
  "https://github.com/metedata/remarc-agent-plugins.git",
  "remarc-wake repository metadata drifted"
);
if (typeof wakePackage.description !== "string" || wakePackage.description.trim() === "") {
  fail("remarc-wake package metadata must include a description");
}

console.log(
  `third-party distribution notices verified: ${bundledDependencies.length} bundled core dependencies; hooks and wake contain no bundled third-party runtime code`
);
