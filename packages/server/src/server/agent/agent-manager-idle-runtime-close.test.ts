import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";

afterEach(() => {
  vi.useRealTimers();
});

test("idle runtime closure is disabled by default", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = await mkdtemp(path.join(tmpdir(), "paseo-idle-runtime-default-"));
  const logger = createTestLogger();
  let closeCount = 0;
  const manager = new AgentManager({
    clients: {
      devin: createTestAgentClient("devin", {
        closeSession: async () => {
          closeCount += 1;
        },
      }),
    },
    logger,
  });

  try {
    const agent = await manager.createAgent({ provider: "devin", cwd: root }, undefined, {
      workspaceId: undefined,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await manager.flush();

    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    expect(closeCount).toBe(0);
  } finally {
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id))).catch(
      () => undefined,
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("configured Devin idle runtime closes after the TTL and persists a resumable record", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = await mkdtemp(path.join(tmpdir(), "paseo-idle-runtime-devin-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  let closeCount = 0;
  const client = createTestAgentClient("devin", {
    closeSession: async () => {
      closeCount += 1;
    },
  });
  const manager = new AgentManager({
    clients: { devin: client },
    registry: storage,
    idleRuntimeCloseMsByProvider: { devin: 10_000 },
    logger,
  });

  try {
    const agent = await manager.createAgent({ provider: "devin", cwd: root }, undefined, {
      workspaceId: undefined,
    });
    await manager.flush();
    await storage.flush();
    const before = await storage.get(agent.id);

    await vi.advanceTimersByTimeAsync(9_999);
    await manager.flush();
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");

    await vi.advanceTimersByTimeAsync(1);
    await manager.flush();
    await storage.flush();

    expect(manager.getAgent(agent.id)).toBeNull();
    expect(closeCount).toBe(1);
    const stored = await storage.get(agent.id);
    expect(stored?.lastStatus).toBe("closed");
    expect(stored?.updatedAt).toBe(before?.updatedAt);

    const resumed = await ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    expect(resumed.id).toBe(agent.id);
    expect(resumed.lifecycle).toBe("idle");
  } finally {
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id))).catch(
      () => undefined,
    );
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("foreground activity rearms the Devin idle TTL and preserves finished attention", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = await mkdtemp(path.join(tmpdir(), "paseo-idle-runtime-rearm-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: { devin: createTestAgentClient("devin") },
    registry: storage,
    idleRuntimeCloseMsByProvider: { devin: 10_000 },
    logger,
  });

  try {
    const agent = await manager.createAgent({ provider: "devin", cwd: root }, undefined, {
      workspaceId: undefined,
    });

    await vi.advanceTimersByTimeAsync(9_000);
    await manager.runAgent(agent.id, "finish a tiny turn");
    await manager.flush();
    await storage.flush();

    const finished = await storage.get(agent.id);
    expect(manager.getAgent(agent.id)?.attention.requiresAttention).toBe(true);

    // The pre-turn timer would have fired here. Activity must have rearmed it.
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.flush();
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");

    await vi.advanceTimersByTimeAsync(9_000);
    await manager.flush();
    await storage.flush();

    expect(manager.getAgent(agent.id)).toBeNull();
    const closed = await storage.get(agent.id);
    expect(closed?.lastStatus).toBe("closed");
    expect(closed?.requiresAttention).toBe(true);
    expect(closed?.attentionReason).toBe("finished");
    expect(closed?.updatedAt).toBe(finished?.updatedAt);
  } finally {
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id))).catch(
      () => undefined,
    );
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("provider-scoped idle closure leaves other providers resident", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = await mkdtemp(path.join(tmpdir(), "paseo-idle-runtime-scope-"));
  const logger = createTestLogger();
  let codexCloseCount = 0;
  const manager = new AgentManager({
    clients: {
      devin: createTestAgentClient("devin"),
      codex: createTestAgentClient("codex", {
        closeSession: async () => {
          codexCloseCount += 1;
        },
      }),
    },
    idleRuntimeCloseMsByProvider: { devin: 5_000 },
    logger,
  });

  try {
    const codex = await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
      workspaceId: undefined,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await manager.flush();

    expect(manager.getAgent(codex.id)?.lifecycle).toBe("idle");
    expect(codexCloseCount).toBe(0);
  } finally {
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id))).catch(
      () => undefined,
    );
    await rm(root, { recursive: true, force: true });
  }
});
