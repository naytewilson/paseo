import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDaemonConnectionCommandError,
  getDaemonHost,
  resolveDefaultDaemonHosts,
} from "./client.js";

vi.mock("@getpaseo/server", () => ({
  resolvePaseoHome: (env: NodeJS.ProcessEnv) => env.PASEO_HOME,
  loadConfig: (home: string) => {
    const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as {
      daemon?: { listen?: string };
    };
    return { listen: parsed.daemon?.listen ?? "127.0.0.1:6767" };
  },
}));

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "paseo-cli-client-"));
  temporaryHomes.push(home);
  return home;
}

function writeConfig(home: string, listen?: string): void {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ daemon: { listen: listen ?? "127.0.0.1:6767" } }),
  );
}

function writePid(home: string, target: Record<string, unknown>): void {
  writeFileSync(join(home, "paseo.pid"), JSON.stringify(target));
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryHomes.length > 0) {
    const home = temporaryHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("default daemon endpoint discovery", () => {
  it("prefers a live TCP runtime PID target over persisted configuration", () => {
    const home = temporaryHome();
    writeConfig(home, "192.0.2.10:7000");
    writePid(home, {
      pid: process.pid,
      listen: "198.51.100.20:8000",
      startedAt: new Date().toISOString(),
      hostname: "test-host",
      uid: process.getuid?.() ?? 0,
      heartbeat: true,
    });

    expect(resolveDefaultDaemonHosts({ PASEO_HOME: home })).toEqual([
      "198.51.100.20:8000",
      "192.0.2.10:7000",
      "localhost:6767",
    ]);
  });

  it("accepts a live IPC runtime PID target", () => {
    const home = temporaryHome();
    writeConfig(home, "192.0.2.10:7000");
    writePid(home, {
      pid: process.pid,
      sockPath: "/tmp/paseo-test.sock",
      startedAt: new Date().toISOString(),
      hostname: "test-host",
      uid: process.getuid?.() ?? 0,
      heartbeat: true,
    });

    expect(resolveDefaultDaemonHosts({ PASEO_HOME: home })).toEqual([
      "unix:///tmp/paseo-test.sock",
      "192.0.2.10:7000",
      "localhost:6767",
    ]);
  });

  it("ignores a stale PID target and falls back to persisted configuration", () => {
    const home = temporaryHome();
    writeConfig(home, "192.0.2.10:7000");
    writePid(home, {
      pid: 999_999_999,
      listen: "198.51.100.20:8000",
      startedAt: new Date().toISOString(),
      hostname: "test-host",
      uid: 1000,
      heartbeat: true,
    });

    expect(resolveDefaultDaemonHosts({ PASEO_HOME: home })).toEqual([
      "192.0.2.10:7000",
      "localhost:6767",
    ]);
  });

  it("uses persisted configuration before the localhost fallback", () => {
    const home = temporaryHome();
    writeConfig(home, "192.0.2.10:7000");

    expect(resolveDefaultDaemonHosts({ PASEO_HOME: home })).toEqual([
      "192.0.2.10:7000",
      "localhost:6767",
    ]);
  });

  it("uses localhost when neither runtime nor persisted configuration has a target", () => {
    const home = temporaryHome();
    writeConfig(home, "127.0.0.1:6767");

    expect(resolveDefaultDaemonHosts({ PASEO_HOME: home })).toEqual(["localhost:6767"]);
  });

  it("preserves explicit host and PASEO_HOST precedence", () => {
    const home = temporaryHome();
    writeConfig(home, "192.0.2.10:7000");
    writePid(home, { pid: process.pid, listen: "198.51.100.20:8000" });
    vi.stubEnv("PASEO_HOME", home);

    expect(getDaemonHost({ host: "203.0.113.30:9000" })).toBe("203.0.113.30:9000");

    vi.stubEnv("PASEO_HOST", "203.0.113.40:9001");
    expect(getDaemonHost()).toBe("203.0.113.40:9001");
  });
});

describe("daemon connection error redaction", () => {
  it("never renders a TCP password in the display host or error details", () => {
    const secret = "CLIENT_SENTINEL_DO_NOT_RENDER";
    const host = `tcp://127.0.0.1:6767?password=${secret}`;
    const error = buildDaemonConnectionCommandError({
      host,
      error: new Error(`connection failed for ${host}`),
    });

    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).toContain("[REDACTED]");
  });
});
