import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";

import type { PersistedConfig } from "../persisted-config.js";
import { resolveDecisionFabricConfig } from "./config.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};
const EMPTY_PERSISTED = {} as PersistedConfig;

describe("resolveDecisionFabricConfig", () => {
  test("is disabled by default with the contract socket path", () => {
    const config = resolveDecisionFabricConfig({
      env: EMPTY_ENV,
      persisted: EMPTY_PERSISTED,
    });
    expect(config.enabled).toBe(false);
    expect(config.socketPath).toBe(
      path.join(os.homedir(), ".local/share/anvil-jev-decisiond/decisiond.sock"),
    );
    expect(config.timeoutMs).toBe(30_000);
  });

  test("enables via PASEO_JEV_DECISION_FABRIC=1", () => {
    const config = resolveDecisionFabricConfig({
      env: { PASEO_JEV_DECISION_FABRIC: "1" },
      persisted: EMPTY_PERSISTED,
    });
    expect(config.enabled).toBe(true);
  });

  test("treats explicit env false as disabled even when persisted config enables it", () => {
    const config = resolveDecisionFabricConfig({
      env: { PASEO_JEV_DECISION_FABRIC: "0" },
      persisted: {
        daemon: { decisionFabric: { enabled: true } },
      } as PersistedConfig,
    });
    expect(config.enabled).toBe(false);
  });

  test("enables via persisted config", () => {
    const config = resolveDecisionFabricConfig({
      env: EMPTY_ENV,
      persisted: {
        daemon: { decisionFabric: { enabled: true, timeoutMs: 5_000 } },
      } as PersistedConfig,
    });
    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBe(5_000);
  });

  test("honors ANVIL_JEV_SOCKET from the wire contract", () => {
    const config = resolveDecisionFabricConfig({
      env: { ANVIL_JEV_SOCKET: "/run/jev/custom.sock" },
      persisted: EMPTY_PERSISTED,
    });
    expect(config.socketPath).toBe("/run/jev/custom.sock");
  });

  test("PASEO_JEV_DECISION_FABRIC_SOCKET wins over ANVIL_JEV_SOCKET and persisted", () => {
    const config = resolveDecisionFabricConfig({
      env: {
        PASEO_JEV_DECISION_FABRIC_SOCKET: "~/fab.sock",
        ANVIL_JEV_SOCKET: "/run/jev/custom.sock",
      },
      persisted: {
        daemon: { decisionFabric: { socketPath: "/persisted.sock" } },
      } as PersistedConfig,
    });
    expect(config.socketPath).toBe(path.join(os.homedir(), "fab.sock"));
  });

  test("clamps timeout to the supported range", () => {
    const low = resolveDecisionFabricConfig({
      env: { PASEO_JEV_DECISION_FABRIC_TIMEOUT_MS: "1" },
      persisted: EMPTY_PERSISTED,
    });
    expect(low.timeoutMs).toBe(1_000);
    const high = resolveDecisionFabricConfig({
      env: { PASEO_JEV_DECISION_FABRIC_TIMEOUT_MS: "999999" },
      persisted: EMPTY_PERSISTED,
    });
    expect(high.timeoutMs).toBe(120_000);
  });

  test("ignores malformed env values instead of throwing", () => {
    const config = resolveDecisionFabricConfig({
      env: {
        PASEO_JEV_DECISION_FABRIC: "not-a-bool",
        PASEO_JEV_DECISION_FABRIC_TIMEOUT_MS: "abc",
      },
      persisted: EMPTY_PERSISTED,
    });
    expect(config.enabled).toBe(false);
    expect(config.timeoutMs).toBe(30_000);
  });
});
