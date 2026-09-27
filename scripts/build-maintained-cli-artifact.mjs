import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const version = packages.get("cli").version;
if (names.some((name) => packages.get(name).version !== version)) {
  throw new Error("Internal package versions differ");
}
const stage = mkdtempSync(path.join(os.tmpdir(), "paseo-maintained-pack-"));
const files = {};
const hash = (filename) => createHash("sha256").update(readFileSync(filename)).digest("hex");
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
    }
    stagedPackage.bundleDependencies = names.slice(1).map((internal) => `@getpaseo/${internal}`);
    stagedPackage.files = ["bin", "dist", "node_modules", "source-identity.json"];
  }
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`);
  addCritical(name, "package.json", target);
}
const identity = { sourceCommit, packageVersion: version, internalPackages: names };
for (const target of [stage, path.join(stage, "node_modules", "@getpaseo", "server")]) {
  writeFileSync(
    path.join(target, "source-identity.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
}
addCritical("cli", "source-identity.json", stage);
addCritical(
  "server",
  "source-identity.json",
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
const packed = execFileSync(
  "npm",
  ["pack", stage, "--ignore-scripts", "--pack-destination", output, "--json"],
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
const artifact = path.join(output, description.filename);
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
