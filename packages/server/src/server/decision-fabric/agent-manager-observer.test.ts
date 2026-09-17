import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent/agent-sdk-types.js";
import type { CompletedRunObservation, CompletedRunObserver } from "./observer.js";

const logger = createTestLogger();

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class ScriptedSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly events: AgentStreamEvent[],
  ) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = "turn-scripted-1";
    setTimeout(() => {
      for (const event of this.events) {
        this.pushEvent(event);
      }
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
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
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

class ScriptedClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  constructor(private readonly events: AgentStreamEvent[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new ScriptedSession(config, this.events);
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error("not used");
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

class RecordingObserver implements CompletedRunObserver {
  readonly observations: CompletedRunObservation[] = [];
  constructor(private readonly error?: Error) {}
  async observe(input: CompletedRunObservation): Promise<void> {
    this.observations.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

const COMPLETED_EVENTS: AgentStreamEvent[] = [
  { type: "turn_started", provider: "codex", turnId: "turn-scripted-1" },
  {
    type: "timeline",
    provider: "codex",
    turnId: "turn-scripted-1",
    item: { type: "assistant_message", text: "done" } satisfies AgentTimelineItem,
  },
  { type: "turn_completed", provider: "codex", turnId: "turn-scripted-1" },
];

const FAILED_EVENTS: AgentStreamEvent[] = [
  { type: "turn_started", provider: "codex", turnId: "turn-scripted-1" },
  {
    type: "turn_failed",
    provider: "codex",
    error: "provider exploded",
    turnId: "turn-scripted-1",
  },
];

async function drain(stream: AsyncGenerator<AgentStreamEvent>): Promise<string[]> {
  const types: string[] = [];
  for await (const event of stream) {
    types.push(event.type);
  }
  return types;
}

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "jev-manager-"));
}

describe("AgentManager completed-run observation hook", () => {
  test("invokes the observer once on turn_completed without touching the stream", async () => {
    const workdir = makeWorkdir();
    const observer = new RecordingObserver();
    const manager = new AgentManager({
      clients: { codex: new ScriptedClient(COMPLETED_EVENTS) },
      completedRunObserver: observer,
      logger,
    });
    try {
      const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: undefined,
      });
      const events = await drain(manager.streamAgent(agent.id, "run it"));
      await manager.flush();

      expect(observer.observations).toHaveLength(1);
      const observation = observer.observations[0];
      expect(observation.agent.id).toBe(agent.id);
      expect(observation.agent.provider).toBe("codex");
      expect(observation.event.type).toBe("turn_completed");
      expect(observation.rows.some((row) => row.item.type === "assistant_message")).toBe(true);

      expect(events).toContain("turn_started");
      expect(events).toContain("turn_completed");
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("an observer failure cannot alter lifecycle or swallow stream events", async () => {
    const workdir = makeWorkdir();
    const observer = new RecordingObserver(new Error("fabric exploded"));
    const manager = new AgentManager({
      clients: { codex: new ScriptedClient(COMPLETED_EVENTS) },
      completedRunObserver: observer,
      logger,
    });
    try {
      const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: undefined,
      });
      const events = await drain(manager.streamAgent(agent.id, "run it"));
      await manager.flush();

      expect(observer.observations).toHaveLength(1);
      expect(events).toEqual(
        expect.arrayContaining(["turn_started", "timeline", "turn_completed"]),
      );
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("turn_failed never reaches the observer", async () => {
    const workdir = makeWorkdir();
    const observer = new RecordingObserver();
    const manager = new AgentManager({
      clients: { codex: new ScriptedClient(FAILED_EVENTS) },
      completedRunObserver: observer,
      logger,
    });
    try {
      const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: undefined,
      });
      const events = await drain(manager.streamAgent(agent.id, "run it"));
      await manager.flush();

      expect(observer.observations).toHaveLength(0);
      expect(events).toContain("turn_failed");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("no observer configured produces identical stream behavior (disabled path)", async () => {
    const workdir = makeWorkdir();
    const manager = new AgentManager({
      clients: { codex: new ScriptedClient(COMPLETED_EVENTS) },
      logger,
    });
    try {
      const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: undefined,
      });
      const events = await drain(manager.streamAgent(agent.id, "run it"));
      await manager.flush();
      expect(events).toEqual(
        expect.arrayContaining(["turn_started", "timeline", "turn_completed"]),
      );
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
