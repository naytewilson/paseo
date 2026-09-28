import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// This gate travels with the maintained source, and is invoked before packaging.
// Missing suites fail explicitly: Vitest otherwise accepts a partially missing list.
const root = fileURLToPath(new URL("../", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const spawnOptions = { cwd: root, stdio: "inherit", shell: process.platform === "win32" };

// Server fidelity suites import runtime values from @getpaseo/protocol, whose
// workspace exports resolve through dist/*.js. Build that prerequisite here so
// this gate is reproducible from a clean npm ci checkout instead of depending on
// stale workspace build output.
const protocolBuild = spawnSync(npmCommand, ["run", "build:protocol"], spawnOptions);
if (protocolBuild.error) throw protocolBuild.error;
if (protocolBuild.status !== 0) {
  process.exitCode = protocolBuild.status ?? 1;
} else {
  const suites = [
    "packages/server/src/server/agent/providers/acp-agent.test.ts",
    "packages/server/src/server/agent/providers/generic-acp-agent.test.ts",
    "packages/server/src/server/agent/providers/kimi-acp-agent.test.ts",
    "packages/server/src/server/agent/agent-stream-coalescer.test.ts",
    "packages/server/src/server/agent/agent-manager-stream-coalescing.test.ts",
    "packages/server/src/server/session/owned-subscriptions/index.test.ts",
    "packages/app/src/composer/agent-controls/utils.test.ts",
    "packages/app/src/provider-selection/resolve-agent-form.test.ts",
  ];
  for (const suite of suites) {
    if (!existsSync(path.join(root, suite))) {
      throw new Error(`Provider fidelity regression suite missing: ${suite}`);
    }
  }
  const result = spawnSync(
    npmCommand,
    ["exec", "--", "vitest", "run", ...suites, "--bail=1"],
    spawnOptions,
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
