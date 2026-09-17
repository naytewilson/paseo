import path from "node:path";

import { expandTilde } from "../../utils/path.js";
import type { PersistedConfig } from "../persisted-config.js";

const DEFAULT_SOCKET_PATH = "~/.local/share/anvil-jev-decisiond/decisiond.sock";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export interface DecisionFabricConfig {
  enabled: boolean;
  socketPath: string;
  timeoutMs: number;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function clampTimeoutMs(value: number): number {
  return Math.min(Math.max(value, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * Opt-in machine-local Decision Fabric wiring. Disabled unless explicitly
 * enabled by env or persisted config; the socket path honors the campaign wire
 * contract's own ANVIL_JEV_SOCKET before the documented default.
 */
export function resolveDecisionFabricConfig(params: {
  env: NodeJS.ProcessEnv;
  persisted: PersistedConfig;
}): DecisionFabricConfig {
  const { env, persisted } = params;
  const persistedFabric = persisted.daemon?.decisionFabric;

  const enabled =
    parseBooleanEnv(env.PASEO_JEV_DECISION_FABRIC) ?? persistedFabric?.enabled ?? false;

  const socketPathRaw =
    nonEmptyEnv(env.PASEO_JEV_DECISION_FABRIC_SOCKET) ??
    nonEmptyEnv(env.ANVIL_JEV_SOCKET) ??
    persistedFabric?.socketPath ??
    DEFAULT_SOCKET_PATH;
  const socketPath = path.resolve(expandTilde(socketPathRaw));

  const timeoutMs = clampTimeoutMs(
    parsePositiveIntegerEnv(env.PASEO_JEV_DECISION_FABRIC_TIMEOUT_MS) ??
      persistedFabric?.timeoutMs ??
      DEFAULT_TIMEOUT_MS,
  );

  return { enabled, socketPath, timeoutMs };
}
