import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(root, "..", "paseo-maintained-artifacts"));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Invalid source commit");
if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) {
  throw new Error("Source worktree must be clean before packaging");
}

const names = ["cli", "server", "client", "protocol", "highlight", "plugin", "relay"];
const packages = new Map(
  names.map((name) => [
    name,
    JSON.parse(readFileSync(path.join(root, "packages", name, "package.json"), "utf8")),
  ]),
);
const externalDependencies = new Map();
for (const sourcePackage of packages.values()) {
  for (const [dependency, range] of Object.entries(sourcePackage.dependencies ?? {})) {
    if (!dependency.startsWith("@getpaseo/")) externalDependencies.set(dependency, range);
  }
}
const version = packages.get("cli").version;
if (names.some((name) => packages.get(name).version !== version)) {
  throw new Error("Internal package versions differ");
}
const stage = mkdtempSync(path.join(os.tmpdir(), "paseo-maintained-pack-"));
const files = {};
const hash = (filename) => createHash("sha256").update(readFileSync(filename)).digest("hex");
function resolveExternalRoot(dependency) {
  for (const workspace of names) {
    const direct = path.join(root, "packages", workspace, "node_modules", dependency);
    if (existsSync(path.join(direct, "package.json"))) return direct;
    try {
      const require = createRequire(path.join(root, "packages", workspace, "package.json"));
      const resolved = require.resolve(dependency);
      const candidate = findPackageRoot(path.dirname(resolved), dependency);
      if (candidate) return candidate;
    } catch {
      // Try the next workspace's dependency tree.
    }
  }
  return null;
}
function findPackageRoot(start, dependency) {
  let current = start;
  for (;;) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      const packageJson = JSON.parse(readFileSync(manifest, "utf8"));
      if (packageJson.name === dependency) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function copy(relative, destination) {
  const source = path.join(root, relative);
  if (!existsSync(source)) throw new Error(`Missing build output: ${relative}`);
  cpSync(source, destination, { recursive: true });
}
function addCritical(packageName, relative, packageRoot) {
  const target = path.join(packageRoot, relative);
  if (!existsSync(target)) throw new Error(`Missing critical file: ${packageName}/${relative}`);
  files[`${packageName}/${relative}`] = hash(target);
}
function addExternalDependencies(destination, source, internal) {
  for (const [dependency, range] of Object.entries(source.dependencies ?? {})) {
    if (dependency.startsWith("@getpaseo/")) continue;
    if (dependency === "@agentclientprotocol/sdk" && internal === "plugin") continue;
    const existing = destination[dependency];
    if (existing && existing !== range) {
      throw new Error(`Conflicting external dependency ${dependency}: ${existing} vs ${range}`);
    }
    destination[dependency] = range;
  }
}

for (const name of names) {
  const sourcePackage = packages.get(name);
  const target = name === "cli" ? stage : path.join(stage, "node_modules", "@getpaseo", name);
  mkdirSync(target, { recursive: true });
  copy(`packages/${name}/dist`, path.join(target, "dist"));
  if (name === "cli") copy("packages/cli/bin", path.join(target, "bin"));
  if (name === "highlight") {
    mkdirSync(path.join(target, "src", "astro"), { recursive: true });
    copy("packages/highlight/src/astro/LICENSE", path.join(target, "src", "astro", "LICENSE"));
  }
  for (const extra of ["README.md", ".env.example"]) {
    const from = path.join(root, "packages", name, extra);
    if (existsSync(from)) cpSync(from, path.join(target, extra));
  }
  const stagedPackage = { ...sourcePackage };
  delete stagedPackage.scripts;
  if (name === "cli") {
    stagedPackage.dependencies = { ...sourcePackage.dependencies };
    for (const internal of names.slice(1)) {
      stagedPackage.dependencies[`@getpaseo/${internal}`] = version;
      addExternalDependencies(stagedPackage.dependencies, packages.get(internal), internal);
    }
    stagedPackage.bundleDependencies = names.slice(1).map((internal) => `@getpaseo/${internal}`);
    stagedPackage.bundleDependencies.push(...externalDependencies.keys());
    stagedPackage.files = ["bin", "dist", "node_modules", "source-identity.json"];
  }
  if (name === "plugin") {
    // The plugin ACP SDK is newer than the server ACP SDK. Preserve the exact
    // nested package instead of letting Node resolve the server's old copy.
    stagedPackage.bundleDependencies = ["@agentclientprotocol/sdk"];
    const sdk = path.join(
      root,
      "packages",
      "plugin",
      "node_modules",
      "@agentclientprotocol",
      "sdk",
    );
    if (!existsSync(sdk)) throw new Error("Missing plugin ACP SDK build dependency");
    mkdirSync(path.join(target, "node_modules", "@agentclientprotocol"), { recursive: true });
    cpSync(sdk, path.join(target, "node_modules", "@agentclientprotocol", "sdk"), {
      recursive: true,
    });
  }
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`);
  addCritical(name, "package.json", target);
}
for (const dependency of externalDependencies.keys()) {
  const source = resolveExternalRoot(dependency);
  if (!source) throw new Error(`Missing external dependency: ${dependency}`);
  const target = path.join(stage, "node_modules", dependency);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
const identity = { sourceCommit, packageVersion: version, internalPackages: names };
for (const target of [
  stage,
  path.join(stage, "node_modules", "@getpaseo", "server", "dist", "server", "server"),
]) {
  writeFileSync(
    path.join(target, "source-identity.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
}
addCritical("cli", "source-identity.json", stage);
addCritical(
  "server",
  "dist/server/server/source-identity.json",
  path.join(stage, "node_modules", "@getpaseo", "server"),
);
for (const [name, relatives] of Object.entries({
  cli: ["dist/index.js", "dist/commands/daemon/status.js"],
  server: [
    "dist/server/server/source-identity.js",
    "dist/server/server/websocket-server.js",
    "dist/server/server/agent/providers/acp-agent.js",
    "dist/server/server/agent/providers/generic-acp-agent.js",
    "dist/server/server/agent/agent-stream-coalescer.js",
    "dist/server/server/session/daemon/npm-global-cli.js",
    "dist/server/server/session/owned-subscriptions/index.js",
  ],
  client: ["dist/daemon-client.js"],
  protocol: ["dist/messages.js"],
})) {
  const target = name === "cli" ? stage : path.join(stage, "node_modules", "@getpaseo", name);
  for (const relative of relatives) addCritical(name, relative, target);
}
mkdirSync(output, { recursive: true });
const packOutput = mkdtempSync(path.join(output, ".pack-"));
const packed = execFileSync(
  "npm",
  ["pack", stage, "--ignore-scripts", "--pack-destination", packOutput, "--json"],
  {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  },
);
const [description] = JSON.parse(packed);
const bundled = new Set(description.bundled);
for (const name of names.slice(1)) {
  if (!bundled.has(`@getpaseo/${name}`)) throw new Error(`Not bundled: ${name}`);
}
const artifact = path.join(output, description.filename.replace(/\.tgz$/, `-${sourceCommit}.tgz`));
if (existsSync(artifact)) throw new Error(`Immutable artifact already exists: ${artifact}`);
renameSync(path.join(packOutput, description.filename), artifact);
rmSync(packOutput, { recursive: true });
const manifest = {
  sourceCommit,
  artifact,
  sha256: hash(artifact),
  signing: "HASHED/UNSIGNED",
  packageVersion: version,
  bundled: description.bundled,
  criticalFiles: files,
};
writeFileSync(`${artifact}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({ artifact, sha256: manifest.sha256, sourceCommit, bundled: description.bundled }),
);
