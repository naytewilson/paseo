import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { withTimeout } from "../../utils/promise-timeout.js";
import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import {
  createTestAgentClients,
  type TestAgentClientOptions,
} from "../test-utils/fake-agent-client.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

interface StructuredContent {
  [key: string]: unknown;
}

interface McpToolResult {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
  isError?: boolean;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

async function waitForPathExists(options: {
  targetPath: string;
  timeoutMs: number;
}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (existsSync(options.targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for path: ${options.targetPath}`);
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    if (content.structuredContent) return content.structuredContent;
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

async function createMcpClient(url: string, authToken?: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : undefined,
  );
  const rawClient = await experimental_createMCPClient({ transport });
  const boundCallTool: McpClient["callTool"] = Reflect.get(rawClient, "callTool").bind(rawClient);
  return { callTool: boundCallTool, close: () => rawClient.close() };
}

function getPaseoBearer(config: AgentSessionConfig | undefined): string | null {
  const authorization = config?.mcpServers?.paseo?.headers?.Authorization;
  return typeof authorization === "string" ? authorization.replace(/^Bearer\s+/, "") : null;
}

async function expectRevokedAgentBearer(options: {
  mcpUrl: string;
  agentId: string;
  token: string;
  launchCount: () => number;
  agentCount: () => number;
}): Promise<void> {
  const beforeLaunches = options.launchCount();
  const beforeAgents = options.agentCount();
  const url = new URL(options.mcpUrl);
  url.searchParams.set("callerAgentId", options.agentId);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(options.launchCount()).toBe(beforeLaunches);
  expect(options.agentCount()).toBe(beforeAgents);
}

async function archiveParentAndAssertNoScopedCreate(options: {
  rootClient: McpClient;
  scopedClient: McpClient;
  parentId: string;
  workspaceId: string | undefined;
  launchCount: () => number;
}): Promise<void> {
  await options.rootClient.callTool({
    name: "archive_agent",
    args: { agentId: options.parentId },
  });
  const before = options.launchCount();
  const denied = await options.scopedClient
    .callTool({
      name: "create_agent",
      args: {
        operationKey: "archived-parent-must-not-create",
        workspaceId: options.workspaceId,
        title: "Must not start",
        provider: "claude/claude-test-model",
        settings: { thinkingOptionId: "high" },
        initialPrompt: "Must not reach provider Create",
      },
    })
    .catch(() => null);
  expect(denied?.isError ?? true).toBe(true);
  expect(options.launchCount()).toBe(before);
}

interface OfflineMcpDaemon {
  client: McpClient;
  stop: () => Promise<void>;
}

async function startOfflineMcpDaemon(): Promise<OfflineMcpDaemon> {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  const removeDirectories = async () => {
    await rm(paseoHome, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  };
  const port = await getAvailablePort();
  const daemon = await createPaseoDaemon(
    {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    },
    pino({ level: "silent" }),
  ).catch(async (error: unknown) => {
    await removeDirectories();
    throw error;
  });
  try {
    await daemon.start();
    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);
    return {
      client,
      stop: async () => {
        await client.close();
        await daemon.stop();
        await removeDirectories();
      },
    };
  } catch (error) {
    await daemon.stop();
    await removeDirectories();
    throw error;
  }
}

type WorkspaceCreation = { workspaceId: unknown } | { error: unknown };

async function createLocalWorkspace(client: McpClient, cwd: string): Promise<WorkspaceCreation> {
  const result = await client.callTool({
    name: "create_workspace",
    args: { isolation: "local", path: cwd },
  });
  if (result.isError) {
    const content = result.content?.[0];
    return { error: content && "text" in content ? content.text : undefined };
  }
  return { workspaceId: getStructuredContent(result)?.workspaceId };
}

async function listWorkspaces(client: McpClient): Promise<WorkspaceCreation[]> {
  const result = await client.callTool({ name: "list_workspaces", args: {} });
  const workspaces = getStructuredContent(result)?.workspaces;
  if (!Array.isArray(workspaces)) return [];
  return workspaces.map((workspace: StructuredContent) => ({ workspaceId: workspace.workspaceId }));
}

interface LaunchRecorder {
  recordedLaunches: AgentSessionConfig[];
  failStartTurnFor?: { title: string; message: string };
}

class RecordingAgentClient implements AgentClient {
  readonly provider: AgentClient["provider"];
  readonly capabilities: AgentClient["capabilities"];

  constructor(
    private readonly inner: AgentClient,
    private readonly recorder: LaunchRecorder,
  ) {
    this.provider = inner.provider;
    this.capabilities = {
      ...inner.capabilities,
      supportsMcpServers: true,
      supportsNativePaseoTools: false,
    };
  }

  async createSession(
    ...args: Parameters<AgentClient["createSession"]>
  ): ReturnType<AgentClient["createSession"]> {
    // Background title/branch helpers are not the user agents exercised here.
    if (!args[0].internal) this.recorder.recordedLaunches.push(args[0]);
    const session = await this.inner.createSession(...args);
    const failure = this.recorder.failStartTurnFor;
    if (!failure || args[0].title !== failure.title) return session;
    return new Proxy(session, {
      get(target, property) {
        if (property === "startTurn") {
          return async () => {
            throw new Error(failure.message);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async resumeSession(
    ...args: Parameters<AgentClient["resumeSession"]>
  ): ReturnType<AgentClient["resumeSession"]> {
    if (args[1] && !args[1].internal) {
      this.recorder.recordedLaunches.push(args[1] as AgentSessionConfig);
    }
    return this.inner.resumeSession(...args);
  }

  async fetchCatalog(
    ...args: Parameters<AgentClient["fetchCatalog"]>
  ): ReturnType<AgentClient["fetchCatalog"]> {
    return this.inner.fetchCatalog(...args);
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

function createMcpRecordingAgentClients(
  recorder: LaunchRecorder,
  options: TestAgentClientOptions = {},
) {
  const clients = createTestAgentClients(options);
  const claude = clients.claude;
  if (!claude) {
    throw new Error("Fake Claude client is not configured");
  }

  return {
    ...clients,
    claude: new RecordingAgentClient(claude, recorder),
  };
}

async function waitForAgentFinish(options: { client: McpClient; agentId: string }): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await options.client.callTool({
          name: "get_agent_status",
          args: { agentId: options.agentId },
        });
        return getStructuredContent(result)?.status;
      },
      { timeout: 10000 },
    )
    .toBe("idle");
}

describe("agent MCP end-to-end (offline)", () => {
  test("create_agent runs initial prompt and affects filesystem", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const filePath = path.join(agentCwd, "mcp-smoke.txt");
      await writeFile(filePath, "ok", "utf8");

      const initialPrompt = [
        "You must call the Bash command tool with the exact command `rm -f mcp-smoke.txt`.",
        "Run it and reply with done and stop.",
        "Do not respond before the command finishes.",
      ].join("\n");

      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP e2e smoke",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      await waitForAgentFinish({ client, agentId: agentId! });

      if (existsSync(filePath)) {
        const contents = await readFile(filePath, "utf8");
        throw new Error(
          `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`,
        );
      }
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("keyed Foundry children retain parent scope across workspace placement and replay", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-agent-operation-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-agent-operation-"));
    const parentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-operation-parent-"));
    const cellCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-foundry-operation-cell-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };
    const parentNotifications: string[] = [];
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        relayEnabled: false,
        agentClients: createMcpRecordingAgentClients(recorder, {
          onStartTurn: (prompt, config) => {
            if (config.title === "Operation parent") {
              parentNotifications.push(
                typeof prompt === "string" ? prompt : JSON.stringify(prompt),
              );
            }
          },
        }),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const rootClient = await createMcpClient(mcpUrl);
    let scopedClient: McpClient | null = null;
    const createdAgentIds: string[] = [];
    try {
      const parentResult = await rootClient.callTool({
        name: "create_agent",
        args: {
          cwd: parentCwd,
          title: "Operation parent",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "Parent session setup",
        },
      });
      const parentId = getStructuredContent(parentResult)?.agentId;
      expect(typeof parentId).toBe("string");
      createdAgentIds.push(parentId as string);

      const parentScope = daemon.agentManager.getAgent(parentId as string);
      expect(parentScope?.workspaceId).toBeTruthy();
      const mcpConfig = recorder.recordedLaunches.at(-1)?.mcpServers?.paseo;
      expect(mcpConfig?.type).toBe("http");
      const authorization = mcpConfig?.headers?.Authorization;
      expect(authorization).toBeTruthy();
      scopedClient = await createMcpClient(
        mcpConfig!.url,
        authorization!.replace(/^Bearer\s+/, ""),
      );

      const scopeResult = await scopedClient.callTool({ name: "get_agent_mcp_scope", args: {} });
      const scope = getStructuredContent(scopeResult);
      expect(scopeResult.isError).not.toBe(true);
      expect(scope).toMatchObject({
        serverId: daemon.getServerId(),
        agentId: parentId,
        workspaceId: parentScope?.workspaceId,
        scope: "agent_mcp_parent_v1",
      });

      const cell = await createLocalWorkspace(scopedClient, cellCwd);
      expect("workspaceId" in cell).toBe(true);
      if (!("workspaceId" in cell)) throw new Error("Expected Foundry cell workspace");
      expect(typeof cell.workspaceId).toBe("string");
      expect(cell.workspaceId).not.toBe(parentScope?.workspaceId);

      const createArgs = {
        operationKey: "run-luna-high-01",
        workspaceId: cell.workspaceId,
        title: "Keyed child",
        provider: "claude/claude-test-model",
        settings: { thinkingOptionId: "high" },
        initialPrompt: "reply with done and stop",
        notifyOnFinish: true,
      };
      const initialLaunchCount = recorder.recordedLaunches.length;
      const childResult = await scopedClient.callTool({ name: "create_agent", args: createArgs });
      const childId = getStructuredContent(childResult)?.agentId;
      expect(childResult.isError, JSON.stringify(childResult)).not.toBe(true);
      expect(typeof childId).toBe("string");
      createdAgentIds.push(childId as string);

      const childRecord = await daemon.agentStorage.get(childId as string);
      expect(childRecord?.labels).toMatchObject({
        "paseo.parent-agent-id": parentId,
        "paseo.parent-server-id": daemon.getServerId(),
      });
      expect(childRecord?.workspaceId).toBe(cell.workspaceId);
      expect(childRecord?.cwd).toBe(cellCwd);
      expect(recorder.recordedLaunches).toHaveLength(initialLaunchCount + 1);

      const replay = await scopedClient.callTool({ name: "create_agent", args: createArgs });
      expect(replay.isError).not.toBe(true);
      expect(getStructuredContent(replay)?.agentId).toBe(childId);
      expect(recorder.recordedLaunches).toHaveLength(initialLaunchCount + 1);

      const movedReplay = await scopedClient.callTool({
        name: "create_agent",
        args: { ...createArgs, workspaceId: parentScope?.workspaceId },
      });
      expect(movedReplay.isError).toBe(true);
      expect(recorder.recordedLaunches).toHaveLength(initialLaunchCount + 1);

      const lookup = await scopedClient.callTool({
        name: "get_agent_by_operation",
        args: { operationKey: createArgs.operationKey },
      });
      expect(getStructuredContent(lookup)).toMatchObject({ status: "created", agentId: childId });

      const changedIntent = await scopedClient.callTool({
        name: "create_agent",
        args: { ...createArgs, initialPrompt: "different immutable intent" },
      });
      expect(changedIntent.isError).toBe(true);
      expect(recorder.recordedLaunches).toHaveLength(initialLaunchCount + 1);

      await vi.waitFor(
        () => {
          expect(parentNotifications.join("\n").toLowerCase().includes("finished")).toBe(true);
        },
        { timeout: 10_000 },
      );
      const stopFinishedOperation = await scopedClient.callTool({
        name: "cancel_agent_by_operation",
        args: { operationKey: createArgs.operationKey },
      });
      expect(getStructuredContent(stopFinishedOperation)).toMatchObject({
        status: "turn_mismatch",
        cancelAcknowledged: false,
      });
      expect(daemon.agentManager.getAgent(childId as string)?.lifecycle).toBe("idle");

      await archiveParentAndAssertNoScopedCreate({
        rootClient,
        scopedClient,
        parentId: parentId as string,
        workspaceId: cell.workspaceId as string,
        launchCount: () => recorder.recordedLaunches.length,
      });
    } finally {
      for (const agentId of createdAgentIds) {
        await rootClient.callTool({ name: "kill_agent", args: { agentId } }).catch(() => undefined);
      }
      await scopedClient?.close();
      await rootClient.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(parentCwd, { recursive: true, force: true });
      await rm(cellCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_workspace with local isolation adopts only an existing directory", async () => {
    const daemon = await startOfflineMcpDaemon();
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-local-workspace-"));
    const missingPath = path.join(root, "does-not-exist");
    const filePath = path.join(root, "regular-file");
    await writeFile(filePath, "not a directory\n", "utf8");
    try {
      expect(await createLocalWorkspace(daemon.client, missingPath)).toEqual({
        error: expect.stringContaining(`Directory not found: ${missingPath}`),
      });
      expect(await createLocalWorkspace(daemon.client, filePath)).toEqual({
        error: expect.stringContaining(`Directory not found: ${filePath}`),
      });
      const created = await createLocalWorkspace(daemon.client, root);
      expect(await listWorkspaces(daemon.client)).toEqual([created]);
    } finally {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("password-protected daemon authorizes the agent MCP via the capability token", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      auth: { password: hashDaemonPassword("daemon-secret") },
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const capabilityToken = daemon.agentManager.getMcpAuthToken();
    expect(typeof capabilityToken).toBe("string");

    let agentId: string | null = null;
    let client: McpClient | null = null;
    try {
      // Remote auth is not weakened: a request without credentials is rejected
      // before any MCP processing.
      const unauthorized = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      // The injected capability token authenticates the full MCP handshake:
      // creating (and connecting) the client and driving a tool call both go
      // through the password-gated /mcp/agents route. (The exact bearer header
      // injected into a child agent's config is covered by the
      // runtime-mcp-config unit test.)
      client = await createMcpClient(mcpUrl, capabilityToken!);
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Password MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
    } finally {
      if (agentId) {
        await client?.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client?.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("refresh rotates agent MCP bearers and denies closed runtime credentials", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-agent-refresh-capability-"));
    const staticDir = await mkdtemp(
      path.join(os.tmpdir(), "paseo-static-agent-refresh-capability-"),
    );
    const parentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-refresh-parent-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        relayEnabled: false,
        agentClients: createMcpRecordingAgentClients(recorder, { supportsMcpServers: true }),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const rootClient = await createMcpClient(mcpUrl);
    let currentClient: McpClient | null = null;
    const createdAgentIds: string[] = [];
    const scopedClients: McpClient[] = [];
    try {
      const parentResult = await rootClient.callTool({
        name: "create_agent",
        args: {
          cwd: parentCwd,
          title: "Refresh parent",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "Initialize refresh parent",
        },
      });
      const parentId = getStructuredContent(parentResult)?.agentId as string;
      expect(parentId).toBeTruthy();
      createdAgentIds.push(parentId);

      const firstToken = getPaseoBearer(recorder.recordedLaunches.at(-1));
      expect(firstToken).toBeTruthy();
      await daemon.agentManager.reloadAgentSession(parentId);
      const sameWorkspaceToken = getPaseoBearer(recorder.recordedLaunches.at(-1));
      expect(sameWorkspaceToken).toBeTruthy();
      expect(sameWorkspaceToken).not.toBe(firstToken);
      await expectRevokedAgentBearer({
        mcpUrl,
        agentId: parentId,
        token: firstToken!,
        launchCount: () => recorder.recordedLaunches.length,
        agentCount: () => daemon.agentManager.listAgents().length,
      });

      currentClient = await createMcpClient(mcpUrl, sameWorkspaceToken!);
      scopedClients.push(currentClient);
      const scopeResult = await currentClient.callTool({ name: "get_agent_mcp_scope", args: {} });
      expect(getStructuredContent(scopeResult)).toMatchObject({
        agentId: parentId,
        workspaceId: daemon.agentManager.getAgent(parentId)?.workspaceId,
      });

      daemon.agentManager.setPaseoToolsEnabled(false);
      await daemon.agentManager.reloadAgentSession(parentId);
      expect(recorder.recordedLaunches.at(-1)?.mcpServers?.paseo).toBeUndefined();
      await expectRevokedAgentBearer({
        mcpUrl,
        agentId: parentId,
        token: sameWorkspaceToken!,
        launchCount: () => recorder.recordedLaunches.length,
        agentCount: () => daemon.agentManager.listAgents().length,
      });

      daemon.agentManager.setPaseoToolsEnabled(true);
      await daemon.agentManager.reloadAgentSession(parentId);
      const relaunchedToken = getPaseoBearer(recorder.recordedLaunches.at(-1));
      expect(relaunchedToken).toBeTruthy();
      expect(relaunchedToken).not.toBe(firstToken);
      expect(relaunchedToken).not.toBe(sameWorkspaceToken);
      await expectRevokedAgentBearer({
        mcpUrl,
        agentId: parentId,
        token: sameWorkspaceToken!,
        launchCount: () => recorder.recordedLaunches.length,
        agentCount: () => daemon.agentManager.listAgents().length,
      });
      currentClient = await createMcpClient(mcpUrl, relaunchedToken!);
      scopedClients.push(currentClient);
      expect(
        getStructuredContent(
          await currentClient.callTool({ name: "get_agent_mcp_scope", args: {} }),
        )?.agentId,
      ).toBe(parentId);
    } finally {
      for (const agentId of createdAgentIds) {
        await rootClient.callTool({ name: "kill_agent", args: { agentId } }).catch(() => undefined);
      }
      for (const client of scopedClients) await client.close();
      await rootClient.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(parentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("agent-scoped MCP capability is distinct and cannot select a different caller", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-agent-scope-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-agent-scope-"));
    const firstCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-scope-first-"));
    const secondCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-scope-second-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        relayEnabled: false,
        agentClients: createMcpRecordingAgentClients(recorder),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const client = await createMcpClient(mcpUrl);
    const createdAgentIds: string[] = [];
    try {
      for (const [title, cwd] of [
        ["Scope parent one", firstCwd],
        ["Scope parent two", secondCwd],
      ]) {
        const result = await client.callTool({
          name: "create_agent",
          args: {
            cwd,
            title,
            provider: "claude/claude-test-model",
            mode: "bypassPermissions",
            initialPrompt: "reply with done and stop",
          },
        });
        const agentId = getStructuredContent(result)?.agentId;
        expect(typeof agentId).toBe("string");
        createdAgentIds.push(agentId as string);
      }

      const firstConfig = recorder.recordedLaunches.at(-2)?.mcpServers?.paseo;
      const secondConfig = recorder.recordedLaunches.at(-1)?.mcpServers?.paseo;
      expect(firstConfig?.type).toBe("http");
      expect(secondConfig?.type).toBe("http");
      const firstToken = firstConfig?.headers?.Authorization?.replace(/^Bearer\s+/, "");
      const secondToken = secondConfig?.headers?.Authorization?.replace(/^Bearer\s+/, "");
      expect(firstToken).toBeTruthy();
      expect(secondToken).toBeTruthy();
      expect(firstToken).not.toBe(daemon.agentManager.getMcpAuthToken());
      expect(secondToken).not.toBe(daemon.agentManager.getMcpAuthToken());
      expect(firstToken).not.toBe(secondToken);

      const forgedCaller = new URL(mcpUrl);
      forgedCaller.searchParams.set("callerAgentId", createdAgentIds[1]!);
      const forged = await fetch(forgedCaller, {
        method: "POST",
        headers: {
          authorization: `Bearer ${firstToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(forged.status).toBe(403);

      const sharedToken = daemon.agentManager.getMcpAuthToken();
      const sharedCaller = await fetch(new URL(`${mcpUrl}?callerAgentId=${createdAgentIds[0]}`), {
        method: "POST",
        headers: {
          authorization: `Bearer ${sharedToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(sharedCaller.status).toBe(403);

      const missingCaller = await fetch(new URL(`${mcpUrl}?callerAgentId=${createdAgentIds[0]}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(missingCaller.status).toBe(403);
      expect(daemon.agentManager.listAgents()).toHaveLength(2);
    } finally {
      for (const agentId of createdAgentIds) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(firstCwd, { recursive: true, force: true });
      await rm(secondCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("MCP keyed prompt failures redact provider details from responses and the journal", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-prompt-redaction-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-prompt-redaction-"));
    const parentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-prompt-redaction-parent-"));
    const port = await getAvailablePort();
    const providerSecret = "synthetic-prompt-credential-9137";
    const recorder: LaunchRecorder = {
      recordedLaunches: [],
      failStartTurnFor: {
        title: "Prompt failure child",
        message: `provider prompt failure bearer=${providerSecret}`,
      },
    };
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        relayEnabled: false,
        agentClients: createMcpRecordingAgentClients(recorder, { supportsMcpServers: true }),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();

    const rootClient = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);
    let scopedClient: McpClient | null = null;
    const createdAgentIds: string[] = [];
    try {
      const parentResult = await rootClient.callTool({
        name: "create_agent",
        args: {
          cwd: parentCwd,
          title: "Prompt redaction parent",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "Initialize parent",
        },
      });
      const parentId = getStructuredContent(parentResult)?.agentId as string;
      expect(parentId).toBeTruthy();
      createdAgentIds.push(parentId);
      const mcpConfig = recorder.recordedLaunches.at(-1)?.mcpServers?.paseo;
      expect(mcpConfig?.type).toBe("http");
      const authorization = mcpConfig?.headers?.Authorization;
      expect(authorization).toBeTruthy();
      scopedClient = await createMcpClient(
        mcpConfig!.url,
        authorization!.replace(/^Bearer\s+/, ""),
      );
      const parent = daemon.agentManager.getAgent(parentId);
      expect(parent?.workspaceId).toBeTruthy();

      const createResponse = await scopedClient.callTool({
        name: "create_agent",
        args: {
          operationKey: "prompt-secret-redaction",
          workspaceId: parent?.workspaceId,
          title: "Prompt failure child",
          provider: "claude/claude-test-model",
          settings: { thinkingOptionId: "high" },
          initialPrompt: "Start the child task",
          notifyOnFinish: false,
        },
      });
      const responsePayload = getStructuredContent(createResponse);
      if (typeof responsePayload?.agentId === "string") {
        createdAgentIds.push(responsePayload.agentId);
      }
      expect(JSON.stringify(createResponse)).not.toContain(providerSecret);
      expect(responsePayload).toMatchObject({ outcomeUnknown: true, operationStatus: "failed" });

      const childStatus = await scopedClient.callTool({
        name: "get_agent_status",
        args: { agentId: responsePayload?.agentId as string },
      });
      expect(JSON.stringify(childStatus)).not.toContain(providerSecret);

      const operation = await scopedClient.callTool({
        name: "get_agent_by_operation",
        args: { operationKey: "prompt-secret-redaction" },
      });
      expect(JSON.stringify(operation)).not.toContain(providerSecret);
      expect(getStructuredContent(operation)).toMatchObject({
        status: "unknown",
        outcomeUnknown: true,
      });

      const journalDir = path.join(paseoHome, "creations");
      const journalFiles = await readdir(journalDir);
      const journalContents = await Promise.all(
        journalFiles
          .filter((name) => name.endsWith(".json"))
          .map((name) => readFile(path.join(journalDir, name), "utf8")),
      );
      expect(journalContents.join("\n")).not.toContain(providerSecret);
      expect(journalContents.join("\n")).toContain("agent_prompt_outcome_unknown");
    } finally {
      for (const agentId of createdAgentIds) {
        await rootClient.callTool({ name: "kill_agent", args: { agentId } }).catch(() => undefined);
      }
      await scopedClient?.close();
      await rootClient.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(parentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("agent-scoped operation keys replay, lookup, and notify the authenticated parent", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-agent-operation-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-agent-operation-"));
    const parentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-operation-parent-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };
    const parentNotifications: string[] = [];
    const daemon = await createPaseoDaemon(
      {
        listen: `127.0.0.1:${port}`,
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        relayEnabled: false,
        agentClients: createMcpRecordingAgentClients(recorder, {
          onStartTurn: (prompt, config) => {
            if (config.title === "Operation parent") {
              parentNotifications.push(
                typeof prompt === "string" ? prompt : JSON.stringify(prompt),
              );
            }
          },
        }),
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const rootClient = await createMcpClient(mcpUrl);
    let scopedClient: McpClient | null = null;
    const createdAgentIds: string[] = [];
    try {
      const parentResult = await rootClient.callTool({
        name: "create_agent",
        args: {
          cwd: parentCwd,
          title: "Operation parent",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "Parent session setup",
        },
      });
      const parentId = getStructuredContent(parentResult)?.agentId;
      expect(typeof parentId).toBe("string");
      createdAgentIds.push(parentId as string);

      const parent = daemon.agentManager.getAgent(parentId as string);
      expect(parent?.workspaceId).toBeTruthy();
      const paseoMcp = recorder.recordedLaunches.at(-1)?.mcpServers?.paseo;
      expect(paseoMcp?.type).toBe("http");
      const authorization = paseoMcp?.headers?.Authorization;
      expect(authorization).toBeTruthy();
      scopedClient = await createMcpClient(paseoMcp!.url, authorization!.replace(/^Bearer\s+/, ""));

      const scopeResult = await scopedClient.callTool({ name: "get_agent_mcp_scope", args: {} });
      expect(scopeResult.isError).not.toBe(true);
      expect(getStructuredContent(scopeResult)).toMatchObject({
        serverId: daemon.getServerId(),
        agentId: parentId,
        workspaceId: parent?.workspaceId,
        scope: "agent_mcp_parent_v1",
      });

      const beforeInvalidCalls = recorder.recordedLaunches.length;
      const wrongWorkspace = await scopedClient.callTool({
        name: "create_agent",
        args: {
          operationKey: "wrong-workspace",
          workspaceId: "wks_foreign",
          title: "Must not start",
          provider: "claude/claude-test-model",
          settings: { thinkingOptionId: "high" },
          initialPrompt: "Must not reach Create",
        },
      });
      expect(wrongWorkspace.isError).toBe(true);
      expect(recorder.recordedLaunches).toHaveLength(beforeInvalidCalls);

      const wrongHost = await scopedClient.callTool({
        name: "create_agent",
        args: {
          serverId: "srv_foreign",
          operationKey: "wrong-host",
          workspaceId: parent?.workspaceId,
          title: "Must not route",
          provider: "claude/claude-test-model",
          settings: { thinkingOptionId: "high" },
          initialPrompt: "Must not reach remote Create",
        },
      });
      expect(wrongHost.isError).toBe(true);
      expect(recorder.recordedLaunches).toHaveLength(beforeInvalidCalls);

      const createArgs = {
        operationKey: "run-luna-high-01",
        workspaceId: parent?.workspaceId,
        title: "Keyed child",
        provider: "claude/claude-test-model",
        settings: { modeId: "bypassPermissions", thinkingOptionId: "high" },
        initialPrompt: "reply with done and stop",
        notifyOnFinish: true,
      };
      const childResult = await scopedClient.callTool({ name: "create_agent", args: createArgs });
      const childId = getStructuredContent(childResult)?.agentId;
      expect(childResult.isError).not.toBe(true);
      expect(typeof childId).toBe("string");
      createdAgentIds.push(childId as string);

      const child = daemon.agentManager.getAgent(childId as string);
      expect(child?.labels).toMatchObject({
        "paseo.parent-agent-id": parentId,
        "paseo.parent-server-id": daemon.getServerId(),
      });
      expect(child?.workspaceId).toBe(parent?.workspaceId);
      const operationLaunchCount = recorder.recordedLaunches.length;

      const replay = await scopedClient.callTool({ name: "create_agent", args: createArgs });
      expect(replay.isError).not.toBe(true);
      expect(getStructuredContent(replay)?.agentId).toBe(childId);
      expect(recorder.recordedLaunches).toHaveLength(operationLaunchCount);

      const lookup = await scopedClient.callTool({
        name: "get_agent_by_operation",
        args: { operationKey: createArgs.operationKey },
      });
      expect(getStructuredContent(lookup)).toMatchObject({ status: "created", agentId: childId });

      const changedIntent = await scopedClient.callTool({
        name: "create_agent",
        args: { ...createArgs, initialPrompt: "different immutable intent" },
      });
      expect(changedIntent.isError).toBe(true);
      expect(recorder.recordedLaunches).toHaveLength(operationLaunchCount);

      await vi.waitFor(
        () => {
          expect(parentNotifications.join("\n").toLowerCase().includes("finished")).toBe(true);
        },
        { timeout: 10_000 },
      );
      const stopFinishedOperation = await scopedClient.callTool({
        name: "cancel_agent_by_operation",
        args: { operationKey: createArgs.operationKey },
      });
      expect(getStructuredContent(stopFinishedOperation)).toMatchObject({
        status: "turn_mismatch",
        cancelAcknowledged: false,
      });
      expect(daemon.agentManager.getAgent(childId as string)?.lifecycle).toBe("idle");
    } finally {
      for (const agentId of createdAgentIds) {
        await rootClient.callTool({ name: "kill_agent", args: { agentId } }).catch(() => undefined);
      }
      await scopedClient?.close();
      await rootClient.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(parentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent auto-injects paseo MCP by default and can be disabled", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    const disabledPaseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-disabled-"));
    const disabledStaticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-disabled-"));
    const disabledAgentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-disabled-"));
    const disabledPort = await getAvailablePort();
    const disabledRecorder: LaunchRecorder = { recordedLaunches: [] };
    const disabledDaemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${disabledPort}`,
      paseoHome: disabledPaseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      mcpInjectIntoAgents: false,
      staticDir: disabledStaticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createMcpRecordingAgentClients(disabledRecorder),
      agentStoragePath: path.join(disabledPaseoHome, "agents"),
    };
    const disabledDaemon = await createPaseoDaemon(disabledDaemonConfig, pino({ level: "silent" }));
    await disabledDaemon.start();

    const disabledClient = await createMcpClient(`http://127.0.0.1:${disabledPort}/mcp/agents`);

    let agentId: string | null = null;
    let disabledAgentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      expect(recorder.recordedLaunches.at(-1)?.mcpServers).toMatchObject({
        paseo: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId!}`,
        },
      });
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();

      const disabledResult = await disabledClient.callTool({
        name: "create_agent",
        args: {
          cwd: disabledAgentCwd,
          title: "No injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
        },
      });
      const disabledPayload = getStructuredContent(disabledResult);
      disabledAgentId =
        typeof disabledPayload?.agentId === "string" ? disabledPayload.agentId : null;
      expect(disabledAgentId).toBeTruthy();

      expect(disabledRecorder.recordedLaunches.at(-1)?.mcpServers?.paseo).toBeUndefined();
      const disabledAgent = disabledDaemon.agentManager.getAgent(disabledAgentId!);
      expect(disabledAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      if (disabledAgentId) {
        await disabledClient.callTool({ name: "kill_agent", args: { agentId: disabledAgentId } });
      }
      await disabledClient.close();
      await disabledDaemon.stop();
      await rm(disabledPaseoHome, { recursive: true, force: true });
      await rm(disabledStaticDir, { recursive: true, force: true });
      await rm(disabledAgentCwd, { recursive: true, force: true });
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent injects a loopback MCP URL when the daemon listens on all interfaces", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: [] };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `0.0.0.0:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Wildcard MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      expect(recorder.recordedLaunches.at(-1)?.mcpServers).toMatchObject({
        paseo: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId!}`,
        },
      });
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent with background initialPrompt reflects running state once the first turn starts", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP background create",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      expect(payload?.status).toBe("running");

      const statusResult = await client.callTool({
        name: "get_agent_status",
        args: { agentId },
      });
      const statusPayload = getStructuredContent(statusResult);
      expect(statusPayload?.status).toBe("running");
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent propagates initial-turn start failure instead of returning success", async () => {
    class StartTurnFailureSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly id = "mcp-start-turn-failure-session";
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("Initial turn failed to start");
      }

      subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
        return () => undefined;
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield* [];
      }

      async getRuntimeInfo() {
        return {
          provider: "codex" as const,
          sessionId: this.id,
          model: "gpt-5.4-mini",
          modeId: "full-access",
        };
      }

      async getAvailableModes(): Promise<
        Array<{ id: string; label: string; description: string }>
      > {
        return [{ id: "full-access", label: "Full access", description: "No prompts" }];
      }

      async getCurrentMode(): Promise<string | null> {
        return "full-access";
      }

      async setMode(): Promise<void> {}

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle | null {
        return { provider: "codex", sessionId: this.id };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    class StartTurnFailureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async fetchCatalog(): Promise<{
        models: Array<{ provider: "codex"; id: string; label: string; isDefault: boolean }>;
        modes: Array<{ id: string; label: string; description: string }>;
      }> {
        return {
          models: [
            {
              provider: "codex",
              id: "gpt-5.4-mini",
              label: "gpt-5.4-mini",
              isDefault: true,
            },
          ],
          modes: [{ id: "full-access", label: "Full access", description: "No prompts" }],
        };
      }

      async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }

      async resumeSession(
        _handle: AgentPersistenceHandle,
        _config?: Partial<AgentSessionConfig>,
      ): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }
    }

    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: {
        ...createTestAgentClients(),
        codex: new StartTurnFailureClient(),
      },
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP start failure",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Initial turn failed to start");
      expect(getStructuredContent(result)?.agentId).toBeUndefined();
    } finally {
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("workspace creation owns async setup and terminal bootstrap before agent attachment", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-worktree-repo-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      relayEnabled: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const { execSync } = await import("node:child_process");
      execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.email 'test@test.com'", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.name 'Test'", { cwd: repoRoot, stdio: "pipe" });
      await writeFile(path.join(repoRoot, "file.txt"), "hello\n", "utf8");
      execSync("git add .", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoRoot, stdio: "pipe" });

      const setupCommand =
        'while [ ! -f "$PASEO_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$PASEO_WORKTREE_PATH/setup-done.txt"';
      await writeFile(
        path.join(repoRoot, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: [setupCommand],
            terminals: [
              {
                name: "Dev Server",
                command: 'echo "dev-server" > dev-terminal.txt; tail -f /dev/null',
              },
            ],
          },
        }),
        "utf8",
      );
      execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'add worktree config'", {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const workspaceResult = await withTimeout({
        promise: client.callTool({
          name: "create_workspace",
          args: {
            isolation: "worktree",
            path: repoRoot,
            worktreeSlug: "mcp-worktree-setup-test",
            baseBranch: "main",
          },
        }),
        timeoutMs: 2500,
        label: "create_workspace should not block on setup",
      });
      const workspace = getStructuredContent(workspaceResult);
      if (typeof workspace?.workspaceId !== "string") throw new Error("Expected created workspace");
      const result = await client.callTool({
        name: "create_agent",
        args: {
          workspaceId: workspace.workspaceId,
          title: "MCP worktree setup terminals",
          provider: "claude/claude-test-model",
          settings: { modeId: "bypassPermissions" },
          initialPrompt: "say done and stop",
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      const worktreePath = typeof payload?.cwd === "string" ? payload.cwd : "";
      expect(worktreePath).toContain(`${path.sep}worktrees${path.sep}`);
      expect(existsSync(path.join(worktreePath, "setup-done.txt"))).toBe(false);
      expect(existsSync(path.join(worktreePath, "dev-terminal.txt"))).toBe(false);

      await writeFile(path.join(worktreePath, "allow-setup"), "ok\n", "utf8");

      await waitForPathExists({
        targetPath: path.join(worktreePath, "setup-done.txt"),
        timeoutMs: 15000,
      });
      await waitForPathExists({
        targetPath: path.join(worktreePath, "dev-terminal.txt"),
        timeoutMs: 30000,
      });
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
