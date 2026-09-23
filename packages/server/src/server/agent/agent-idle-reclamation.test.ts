import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, resolveIdleReclamationConfig } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "./agent-loading.js";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
  ProviderCatalog,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const RECLAIM_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

/**
 * Fake ACP-like session: holds a (simulated) resident child process and opts
 * into idle reclamation exactly like ACPAgentSession does.
 */
class ReclaimableSession implements AgentSession {
  readonly provider: AgentProvider = "codex";
  readonly capabilities = RECLAIM_CAPABILITIES;
  readonly id = randomUUID();
  readonly idleReclaimEligible = true;
  closeCount = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: `turn-${randomUUID()}` };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  emit(event: AgentStreamEvent): void {
    for (const cb of Array.from(this.subscribers)) {
      cb(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: null as string | null,
      modeId: null as string | null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** Session whose startTurn never emits: lets a test hold an agent "running". */
class HangingTurnSession extends ReclaimableSession {
  private turnCounter = 0;
  pendingTurnId: string | null = null;

  override async startTurn(): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.turnCounter}`;
    this.pendingTurnId = turnId;
    // Emit turn_started on the next macrotask so the manager's foreground
    // waiter is attached before the event lands.
    setTimeout(() => {
      if (this.pendingTurnId === turnId) {
        this.emit({ type: "turn_started", provider: this.provider, turnId });
      }
    }, 0);
    return { turnId };
  }

  completeTurn(): void {
    const turnId = this.pendingTurnId;
    if (!turnId) {
      return;
    }
    this.pendingTurnId = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }
}

/** Session that does NOT opt into reclamation (e.g. a non-ACP provider). */
class NonReclaimableSession extends ReclaimableSession {
  override readonly idleReclaimEligible = false;
}

class ReclaimableClient implements AgentClient {
  readonly provider: AgentProvider = "codex";
  readonly capabilities = RECLAIM_CAPABILITIES;
  readonly sessions: ReclaimableSession[] = [];
  resumeCount = 0;
  makeSession: (config: AgentSessionConfig) => ReclaimableSession = (config) =>
    new ReclaimableSession(config);

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchCatalog(_options: FetchCatalogOptions): Promise<ProviderCatalog> {
    return { models: [], modes: [] };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = this.makeSession(config);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumeCount += 1;
    const session = this.makeSession({
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
    });
    this.sessions.push(session);
    return session;
  }
}

interface ManagerHarness {
  manager: AgentManager;
  client: ReclaimableClient;
  storage: AgentStorage;
  workdir: string;
}

function createHarness(
  client: ReclaimableClient,
  idleReclamation?: { enabled?: boolean; sweepIntervalMs?: number; idleTtlMs?: number },
): ManagerHarness {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-idle-reclaim-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idleReclamation: { sweepIntervalMs: 1_000, idleTtlMs: 5_000, ...idleReclamation },
  });
  return { manager, client, storage, workdir };
}

async function destroyHarness(harness: ManagerHarness): Promise<void> {
  const { manager, storage, workdir } = harness;
  manager.stopIdleReclamation();
  await Promise.allSettled(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
  await storage.flush().catch(() => undefined);
  rmSync(workdir, { recursive: true, force: true });
}

async function createIdleAgent(
  harness: ManagerHarness,
  options?: { labels?: Record<string, string> },
) {
  const { manager, workdir } = harness;
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
    labels: options?.labels,
  });
  await manager.flush();
  expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  return agent;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("idle-reclamation config defaults and env parsing", () => {
  const defaults = resolveIdleReclamationConfig();
  expect(defaults.enabled).toBe(true);
  expect(defaults.sweepIntervalMs).toBe(60_000);
  expect(defaults.idleTtlMs).toBe(30 * 60_000);

  const overridden = resolveIdleReclamationConfig({
    enabled: false,
    sweepIntervalMs: 1_000,
    idleTtlMs: 2_000,
  });
  expect(overridden).toEqual({ enabled: false, sweepIntervalMs: 1_000, idleTtlMs: 2_000 });
});

test("reclaims an idle ACP-eligible agent past the TTL", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);
    const session = client.sessions[0];
    expect(session).toBeDefined();

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);

    expect(reclaimed).toEqual([agent.id]);
    expect(session.closeCount).toBe(1);
    expect(harness.manager.getAgent(agent.id)).toBeNull();

    // The record persists (not archived) so a later steer can resume it.
    const stored = await harness.storage.get(agent.id);
    expect(stored).not.toBeNull();
    expect(stored?.archivedAt).toBeUndefined();
  } finally {
    await destroyHarness(harness);
  }
});

test("leaves a recently-active agent alone", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 1_000);

    expect(reclaimed).toEqual([]);
    expect(client.sessions[0].closeCount).toBe(0);
    expect(harness.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    await destroyHarness(harness);
  }
});

test("leaves a running agent alone", async () => {
  const client = new ReclaimableClient();
  client.makeSession = (config) => new HangingTurnSession(config);
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);
    const runPromise = harness.manager.runAgent(agent.id, "do work");
    await tick();
    await tick();
    expect(harness.manager.getAgent(agent.id)?.lifecycle).toBe("running");

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);

    expect(reclaimed).toEqual([]);
    expect(client.sessions[0].closeCount).toBe(0);

    (client.sessions[0] as HangingTurnSession).completeTurn();
    await runPromise;
    expect(harness.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    await destroyHarness(harness);
  }
});

test("leaves an agent awaiting a permission decision alone", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);
    const session = client.sessions[0];
    expect(agent.id).toBeDefined();
    session.emit({
      type: "permission_requested",
      provider: "codex",
      request: {
        id: "perm-1",
        provider: "codex",
        name: "exec",
        kind: "tool",
        description: "run a command",
      },
    });
    await tick();

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);

    expect(reclaimed).toEqual([]);
    expect(session.closeCount).toBe(0);
  } finally {
    await destroyHarness(harness);
  }
});

test("leaves a desktop-attached idle agent alone", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness, {
      labels: { [getOpenAgentTabLabel("desktop-client")]: "true" },
    });

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);

    expect(reclaimed).toEqual([]);
    expect(client.sessions[0].closeCount).toBe(0);
    expect(harness.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    await destroyHarness(harness);
  }
});

test("leaves non-ACP sessions alone even past the TTL", async () => {
  const client = new ReclaimableClient();
  client.makeSession = (config) => new NonReclaimableSession(config);
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);
    expect(agent.id).toBeDefined();

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);

    expect(reclaimed).toEqual([]);
    expect(client.sessions[0].closeCount).toBe(0);
  } finally {
    await destroyHarness(harness);
  }
});

test("does not sweep when disabled", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { enabled: false, idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);

    expect(reclaimed).toEqual([]);
    expect(client.sessions[0].closeCount).toBe(0);
    expect(harness.manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  } finally {
    await destroyHarness(harness);
  }
});

test("archived agents are never reclaimed by the sweep", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);
    await harness.manager.archiveAgent(agent.id);
    await harness.manager.flush();

    expect(client.sessions[0].closeCount).toBe(1);
    const stored = await harness.storage.get(agent.id);
    expect(stored?.archivedAt).toBeDefined();

    // The archived agent is out of the live map; a sweep far past the TTL
    // must not touch it again.
    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 3_600_000);

    expect(reclaimed).toEqual([]);
    expect(client.sessions[0].closeCount).toBe(1);
  } finally {
    await destroyHarness(harness);
  }
});

test("a reclaimed agent resumes lazily on next use", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);
    const closedSession = client.sessions[0];

    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);
    expect(reclaimed).toEqual([agent.id]);
    expect(closedSession.closeCount).toBe(1);

    const resumed = await ensureUnarchivedAgentLoaded(agent.id, {
      agentManager: harness.manager,
      agentStorage: harness.storage,
      logger,
    });

    expect(client.resumeCount).toBe(1);
    expect(client.sessions).toHaveLength(2);
    expect(client.sessions[1]).not.toBe(closedSession);
    expect(resumed.id).toBe(agent.id);
    expect(harness.manager.getAgent(agent.id)?.lifecycle).toBe("idle");

    // The resumed agent is fresh activity: an immediate sweep must not close it.
    const reclaimedAgain = await harness.manager.runIdleReclamationSweep(Date.now() + 1_000);
    expect(reclaimedAgain).toEqual([]);
  } finally {
    await destroyHarness(harness);
  }
});

test("closed children do not respawn on later sweeps", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    const agent = await createIdleAgent(harness);

    const first = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);
    expect(first).toEqual([agent.id]);
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0].closeCount).toBe(1);

    // No createSession/resumeSession calls happen between sweeps, so a later
    // pass must find nothing to close and must not create new sessions.
    const second = await harness.manager.runIdleReclamationSweep(Date.now() + 3_600_000);
    const third = await harness.manager.runIdleReclamationSweep(Date.now() + 7_200_000);

    expect(second).toEqual([]);
    expect(third).toEqual([]);
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0].closeCount).toBe(1);
    expect(client.resumeCount).toBe(0);
  } finally {
    await destroyHarness(harness);
  }
});

test("startIdleReclamation is idempotent and stopIdleReclamation halts the timer", async () => {
  const client = new ReclaimableClient();
  const harness = createHarness(client, { idleTtlMs: 5_000 });
  try {
    harness.manager.startIdleReclamation();
    harness.manager.startIdleReclamation();
    harness.manager.stopIdleReclamation();
    harness.manager.stopIdleReclamation();
    // No throw, no hang; sweep still works when driven directly.
    const agent = await createIdleAgent(harness);
    const reclaimed = await harness.manager.runIdleReclamationSweep(Date.now() + 60_000);
    expect(reclaimed).toEqual([agent.id]);
  } finally {
    await destroyHarness(harness);
  }
});
