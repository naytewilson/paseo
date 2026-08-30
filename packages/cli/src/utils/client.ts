import { existsSync, readFileSync } from "node:fs";
import { loadConfig, resolvePaseoHome } from "@getpaseo/server";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";
import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import path from "node:path";
import { WebSocket } from "ws";
import { getOrCreateCliClientId } from "./client-id.js";
import { resolveCliVersion } from "../version.js";
import { createSshTunnel } from "../ssh/ssh-tunnel.js";

export interface ConnectOptions {
  host?: string;
  timeout?: number;
}

export interface DaemonConnectionCommandError {
  code: "DAEMON_NOT_RUNNING";
  message: string;
  details: string;
}

const DEFAULT_HOST = "localhost:6767";
const DEFAULT_TIMEOUT = 15000;
const PID_FILENAME = "paseo.pid";

type DaemonTarget =
  | {
      type: "tcp";
      url: string;
    }
  | {
      type: "ipc";
      url: string;
      socketPath: string;
    };

/**
 * Get the daemon host from environment or options
 */
export function getDaemonHost(options?: ConnectOptions): string {
  return redactDaemonCredentials(resolveDaemonHostCandidates(options)[0] ?? DEFAULT_HOST);
}

const SENSITIVE_QUERY_PARAMETER =
  /([?&](?:password|passwd|token|access_token|api[_-]?key|authorization)=)[^&#\s]*/gi;
const SENSITIVE_KEY_VALUE =
  /(\b(?:password|passwd|token|access[_-]?token|api[_-]?key|authorization)\b\s*[:=]\s*)(["']?)[^\s,;"']+\2/gi;
const BEARER_VALUE = /(\bBearer\s+)[^\s,;"']+/gi;

/**
 * Make a daemon target safe to use in user-facing output and diagnostics.
 *
 * Connection code intentionally retains the original target so that a URI
 * password can still be used for authentication.  Anything that crosses a
 * display/logging boundary must use this function instead.
 */
export function redactDaemonCredentials(value: string): string {
  return value
    .replace(SENSITIVE_QUERY_PARAMETER, "$1[REDACTED]")
    .replace(SENSITIVE_KEY_VALUE, "$1[REDACTED]")
    .replace(BEARER_VALUE, "$1[REDACTED]");
}

export function buildDaemonConnectionCommandError(options: {
  host?: string;
  error: unknown;
}): DaemonConnectionCommandError {
  const host = getDaemonHost({ host: options.host });
  const message = redactDaemonCredentials(
    options.error instanceof Error ? options.error.message : String(options.error),
  );
  return {
    code: "DAEMON_NOT_RUNNING",
    message: `Cannot connect to daemon at ${host}: ${message}`,
    details: host.trim().startsWith("ssh://")
      ? "Start the Paseo daemon on the SSH host; SSH transport does not install or start it."
      : "Start the daemon with: paseo daemon start",
  };
}

export function normalizeDaemonHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("tcp://")) {
    try {
      const parsed = parseConnectionUri(trimmed);
      const endpoint = normalizeHostPort(
        parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
      );
      const query = new URLSearchParams();
      if (parsed.useTls) {
        query.set("ssl", "true");
      }
      if (parsed.password) {
        query.set("password", parsed.password);
      }
      const queryString = query.toString();
      const suffix = queryString ? `?${queryString}` : "";
      return `tcp://${endpoint}${suffix}`;
    } catch {
      return null;
    }
  }

  if (
    trimmed.startsWith("unix://") ||
    trimmed.startsWith("pipe://") ||
    trimmed.startsWith("\\\\.\\pipe\\")
  ) {
    return trimmed.startsWith("\\\\.\\pipe\\") ? `pipe://${trimmed}` : trimmed;
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return `unix://${trimmed}`;
  }

  // Windows absolute paths (e.g. C:\Users\foo) are filesystem paths, not TCP or IPC targets.
  if (/^[A-Za-z]:[/\\]/.test(trimmed)) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return `127.0.0.1:${trimmed}`;
  }

  return trimmed.includes(":") ? trimmed : null;
}

export function resolveDefaultDaemonHost(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDefaultDaemonHosts(env)[0] ?? DEFAULT_HOST;
}

function isIpcDaemonHost(host: string | null): host is string {
  return host !== null && (host.startsWith("unix://") || host.startsWith("pipe://"));
}

function isTcpDaemonHost(host: string | null): host is string {
  return host !== null && !isIpcDaemonHost(host);
}

function readPidSocketTarget(paseoHome: string): string | null {
  const pidPath = path.join(paseoHome, PID_FILENAME);
  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(pidPath, "utf-8")) as {
      pid?: unknown;
      listen?: unknown;
      sockPath?: unknown;
    };
    if (
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !isPidRunning(parsed.pid)
    ) {
      return null;
    }
    if (typeof parsed.listen === "string") return parsed.listen;
    if (typeof parsed.sockPath === "string") return parsed.sockPath;
    return null;
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveConfiguredIpcDaemonHost(env: NodeJS.ProcessEnv, paseoHome: string): string | null {
  const directEnvHost = normalizeDaemonHost(env.PASEO_LISTEN ?? "");
  if (isIpcDaemonHost(directEnvHost)) {
    return directEnvHost;
  }

  const config = loadConfig(paseoHome, { env });
  const configuredHost = normalizeDaemonHost(config.listen);
  return isIpcDaemonHost(configuredHost) ? configuredHost : null;
}

function resolveConfiguredTcpDaemonHost(env: NodeJS.ProcessEnv, paseoHome: string): string | null {
  const configuredHost = normalizeDaemonHost(loadConfig(paseoHome, { env }).listen);
  if (!isTcpDaemonHost(configuredHost)) {
    return null;
  }
  return configuredHost === "127.0.0.1:6767" ? null : configuredHost;
}

export function resolveDefaultDaemonHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const paseoHome = resolvePaseoHome(env);
  const candidates: string[] = [];
  const liveRuntimeHost = normalizeDaemonHost(readPidSocketTarget(paseoHome) ?? "");
  if (liveRuntimeHost) {
    candidates.push(liveRuntimeHost);
  }
  const configuredIpcHost = resolveConfiguredIpcDaemonHost(env, paseoHome);
  if (configuredIpcHost) {
    candidates.push(configuredIpcHost);
  }
  const configuredTcpHost = resolveConfiguredTcpDaemonHost(env, paseoHome);
  if (configuredTcpHost) {
    candidates.push(configuredTcpHost);
  }
  candidates.push(DEFAULT_HOST);
  return Array.from(new Set(candidates));
}

function resolveDaemonHostCandidates(options?: ConnectOptions): string[] {
  const explicitHost = options?.host ?? process.env.PASEO_HOST;
  if (explicitHost) {
    return [explicitHost];
  }

  return resolveDefaultDaemonHosts();
}

function stripIpcPrefix(trimmed: string): string {
  if (trimmed.startsWith("unix://")) return trimmed.slice("unix://".length).trim();
  if (trimmed.startsWith("pipe://")) return trimmed.slice("pipe://".length).trim();
  return trimmed;
}

export function resolveDaemonTarget(host: string): DaemonTarget {
  const trimmed = normalizeDaemonHost(host);
  if (!trimmed) {
    throw new Error(`Invalid daemon target: ${redactDaemonCredentials(host)}`);
  }
  if (
    trimmed.startsWith("unix://") ||
    trimmed.startsWith("pipe://") ||
    trimmed.startsWith("\\\\.\\pipe\\")
  ) {
    const socketPath = stripIpcPrefix(trimmed);
    if (!socketPath) {
      throw new Error("Invalid IPC daemon target: missing socket path");
    }
    const isUnixSocket = trimmed.startsWith("unix://");
    return {
      type: "ipc",
      url: isUnixSocket ? `ws+unix://${socketPath}:/ws` : "ws://localhost/ws",
      socketPath,
    };
  }

  if (trimmed.startsWith("tcp://")) {
    const parsed = parseConnectionUri(trimmed);
    const endpoint = normalizeHostPort(
      parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
    );
    return {
      type: "tcp",
      url: buildDaemonWebSocketUrl(endpoint, { useTls: parsed.useTls }),
    };
  }

  return {
    type: "tcp",
    url: `ws://${trimmed}/ws`,
  };
}

export function resolveDaemonPassword(host: string): string | undefined {
  const trimmed = host.trim();
  if (trimmed.startsWith("tcp://")) {
    const fromUri = parseConnectionUri(trimmed).password;
    if (fromUri) return fromUri;
  }
  const fromEnv = process.env.PASEO_PASSWORD;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Create a WebSocket factory that works in Node.js
 */
function createNodeWebSocketFactory() {
  return (
    url: string,
    options?: { headers?: Record<string, string>; protocols?: string[]; socketPath?: string },
  ): WebSocketLike => {
    return new WebSocket(url, options?.protocols, {
      headers: options?.headers,
      ...(options?.socketPath ? { socketPath: options.socketPath } : {}),
    }) as unknown as WebSocketLike;
  };
}

/**
 * Create and connect a daemon client
 * Returns the connected client or throws if connection fails
 */
async function tryConnectHost(
  host: string,
  password: string | undefined,
  clientId: string,
  timeout: number,
  nodeWebSocketFactory: ReturnType<typeof createNodeWebSocketFactory>,
): Promise<{ client: DaemonClient } | { error: unknown }> {
  const target = resolveDaemonTarget(host);
  const client = new DaemonClient({
    url: target.url,
    clientId,
    clientType: "cli",
    appVersion: resolveCliVersion(),
    password,
    connectTimeoutMs: timeout,
    webSocketFactory: (
      url: string,
      config?: { headers?: Record<string, string>; protocols?: string[] },
    ) =>
      nodeWebSocketFactory(url, {
        headers: config?.headers,
        protocols: config?.protocols,
        ...(target.type === "ipc" ? { socketPath: target.socketPath } : {}),
      }),
    reconnect: { enabled: false },
  });

  try {
    await client.connect();
    return { client };
  } catch (error) {
    await client.close().catch(() => {});
    return { error };
  }
}

async function connectViaRelayOffer(
  offer: ConnectionOffer,
  clientId: string,
  timeout: number,
  nodeWebSocketFactory: ReturnType<typeof createNodeWebSocketFactory>,
): Promise<DaemonClient> {
  const url = buildRelayWebSocketUrl({
    endpoint: offer.relay.endpoint,
    serverId: offer.serverId,
    role: "client",
    useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
  });

  const client = new DaemonClient({
    url,
    clientId,
    clientType: "cli",
    appVersion: resolveCliVersion(),
    connectTimeoutMs: timeout,
    webSocketFactory: (
      target: string,
      config?: { headers?: Record<string, string>; protocols?: string[] },
    ) => nodeWebSocketFactory(target, { headers: config?.headers, protocols: config?.protocols }),
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });

  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    const lastError = client.lastError ? ` (${client.lastError})` : "";
    throw new Error(`Failed to connect via relay offer: ${message}${lastError}`, { cause: error });
  }
}

function parseHostOfferOrNull(host: string | undefined): ConnectionOffer | null {
  if (!host) return null;
  try {
    return parseConnectionOfferFromUrl(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pairing offer URL: ${message}`, { cause: error });
  }
}

export async function connectToDaemon(options?: ConnectOptions): Promise<DaemonClient> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const clientId = await getOrCreateCliClientId();
  const nodeWebSocketFactory = createNodeWebSocketFactory();

  const explicitHost = options?.host ?? process.env.PASEO_HOST;
  if (explicitHost?.trim().startsWith("ssh://")) {
    const target = parseSshTransportUri(explicitHost.trim());
    const tunnel = await createSshTunnel(target);
    const password = resolveDaemonPassword(explicitHost);
    const result = await tryConnectHost(
      tunnel.endpoint,
      password,
      clientId,
      timeout,
      nodeWebSocketFactory,
    );
    if ("client" in result) return result.client;

    const failure = tunnel.failureDetail();
    tunnel.close();
    if (failure) throw new Error(`SSH connection failed: ${failure}`, { cause: result.error });
    throw redactConnectionError(result.error);
  }
  const offer = parseHostOfferOrNull(explicitHost);
  if (offer) {
    return connectViaRelayOffer(offer, clientId, timeout, nodeWebSocketFactory);
  }

  const hosts = resolveDaemonHostCandidates(options);

  async function tryNext(index: number, lastError: unknown): Promise<DaemonClient> {
    if (index >= hosts.length) {
      if (lastError instanceof Error) throw redactConnectionError(lastError);
      throw new Error(
        redactDaemonCredentials(`Unable to connect to Paseo daemon via ${hosts.join(", ")}`),
      );
    }
    const host = hosts[index];
    const password = resolveDaemonPassword(host);
    try {
      const result = await tryConnectHost(host, password, clientId, timeout, nodeWebSocketFactory);
      if ("client" in result) {
        return result.client;
      }
      return tryNext(index + 1, result.error);
    } catch (error) {
      return tryNext(index + 1, redactConnectionError(error));
    }
  }

  return tryNext(0, null);
}

function redactConnectionError(error: unknown): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = redactDaemonCredentials(rawMessage);
  if (error instanceof Error && safeMessage === rawMessage) {
    return error;
  }
  return new Error(safeMessage, { cause: error });
}

/**
 * Try to connect to the daemon, returns null if connection fails
 */
export async function tryConnectToDaemon(options?: ConnectOptions): Promise<DaemonClient | null> {
  try {
    return await connectToDaemon(options);
  } catch {
    return null;
  }
}

/** Minimal agent type for ID resolution */
interface AgentLike {
  id: string;
  title?: string | null;
}

/**
 * Resolve an agent ID from a partial ID or name.
 * Supports:
 * - Full ID match
 * - Prefix match (first N characters)
 * - Title/name match (case-insensitive)
 *
 * Returns the full agent ID if found, null otherwise.
 */
export function resolveAgentId(idOrName: string, agents: AgentLike[]): string | null {
  if (!idOrName || agents.length === 0) {
    return null;
  }

  const query = idOrName.toLowerCase();

  // Try exact ID match first
  const exactMatch = agents.find((a) => a.id === idOrName);
  if (exactMatch) {
    return exactMatch.id;
  }

  // Try ID prefix match
  const prefixMatches = agents.filter((a) => a.id.toLowerCase().startsWith(query));
  if (prefixMatches.length === 1 && prefixMatches[0]) {
    return prefixMatches[0].id;
  }

  // Try title/name match (case-insensitive)
  const titleMatches = agents.filter((a) => a.title?.toLowerCase() === query);
  if (titleMatches.length === 1 && titleMatches[0]) {
    return titleMatches[0].id;
  }

  // Try partial title match
  const partialTitleMatches = agents.filter((a) => a.title?.toLowerCase().includes(query));
  if (partialTitleMatches.length === 1 && partialTitleMatches[0]) {
    return partialTitleMatches[0].id;
  }

  // If we have multiple prefix matches and no unique title match, return first prefix match
  const firstPrefixMatch = prefixMatches[0];
  if (firstPrefixMatch) {
    return firstPrefixMatch.id;
  }

  return null;
}
