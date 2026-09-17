import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "../agent/agent-storage.js";
import type { ManagedAgent } from "../agent/agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { createCompletedRunObserver, type CompletedRunObserver } from "./observer.js";
import {
  DecisionFabricTimeoutError,
  DecisionFabricUnavailableError,
  type DecisionFabricClient,
} from "./client.js";
import type { DecideRequest, DecideResponse } from "./contract.js";

const RECEIPT_DIGEST = "b".repeat(64);

const AGENT = {
  id: "agent-obs-1",
  provider: "codex",
  cwd: "/tmp/project",
  workspaceId: "wks-1",
  title: "observed agent",
};

const COMPLETED: AgentStreamEvent = {
  type: "turn_completed",
  provider: "codex",
  turnId: "turn-9",
};

const ROWS: AgentTimelineRow[] = [
  {
    seq: 1,
    timestamp: "2026-09-17T00:00:00.000Z",
    turnId: "turn-9",
    item: { type: "user_message", text: "finish the plumbing task" },
  },
  {
    seq: 2,
    timestamp: "2026-09-17T00:00:01.000Z",
    turnId: "turn-9",
    item: { type: "assistant_message", text: "done" },
  },
];

function decideResponse(request: DecideRequest): DecideResponse {
  return {
    request_id: request.request_id,
    contract_id: request.contract_id,
    contract_version: request.contract_version,
    requested_model: "jev-local",
    effective_model: "jev-local",
    answers: { verdict: { type: "noul", noul: 0.75 } },
    policy_mode: "SHADOW_ONLY",
    policy_outcome: "WOULD_CLOSE",
    receipt_id: "drc-observer-1",
    receipt_digest: RECEIPT_DIGEST,
  };
}

class StubClient implements DecisionFabricClient {
  readonly requests: DecideRequest[] = [];
  constructor(private readonly behavior: (request: DecideRequest) => Promise<DecideResponse>) {}
  async decide(request: DecideRequest): Promise<DecideResponse> {
    this.requests.push(request);
    return this.behavior(request);
  }
}

function createIdleManagedAgent(agentId: string): ManagedAgent {
  const now = new Date("2026-09-17T00:00:00.000Z");
  const config: AgentSessionConfig = { provider: "codex", cwd: "/tmp/project" };
  return {
    id: agentId,
    provider: "codex",
    cwd: "/tmp/project",
    session: {} as AgentSession,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    config,
    lifecycle: "idle",
    createdAt: now,
    updatedAt: now,
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: null,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: [],
    attention: { requiresAttention: false },
    runtimeInfo: { provider: "codex", sessionId: "session-1", model: null, modeId: null },
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: now,
  };
}

async function seedAgent(storage: AgentStorage, agentId: string): Promise<void> {
  await storage.applySnapshot(createIdleManagedAgent(agentId));
}

describe("createCompletedRunObserver", () => {
  let tmpDir: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  function observer(client: DecisionFabricClient): CompletedRunObserver {
    return createCompletedRunObserver({
      client,
      sink: storage,
      logger,
      now: () => new Date("2026-09-17T01:00:00.000Z"),
      requestIdFactory: () => "fixed-request-id",
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "jev-observer-"));
    storage = new AgentStorage(path.join(tmpDir, "agents"), logger);
    await seedAgent(storage, AGENT.id);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("attaches the shadow observation under advisory.jev with receipt proof", async () => {
    const client = new StubClient(async (request) => decideResponse(request));
    await observer(client).observe({ agent: AGENT, event: COMPLETED, rows: ROWS });

    expect(client.requests).toHaveLength(1);
    const request = client.requests[0];
    expect(request.contract_id).toBe("anvil.agent-trace-observability.v1");
    expect(request.contract_version).toBe("1.0.0");
    expect(request.request_id).toBe("paseo-agent-obs-1-fixed-request-id");
    expect(request.source_run_id).toBe("paseo:agent-obs-1:turn-9");
    expect(request.state.mission).toBe("finish the plumbing task");
    expect(request.source_evidence_ids.length).toBeGreaterThanOrEqual(1);

    const record = await storage.get(AGENT.id);
    expect(record?.advisory?.jev).toMatchObject({
      status: "observed",
      contractId: "anvil.agent-trace-observability.v1",
      contractVersion: "1.0.0",
      requestId: "paseo-agent-obs-1-fixed-request-id",
      sourceRunId: "paseo:agent-obs-1:turn-9",
      turnId: "turn-9",
      observedAt: "2026-09-17T01:00:00.000Z",
      policyMode: "SHADOW_ONLY",
      policyOutcome: "WOULD_CLOSE",
      receiptId: "drc-observer-1",
      receiptDigest: RECEIPT_DIGEST,
      answers: { verdict: { type: "noul", noul: 0.75 } },
    });

    const reloaded = new AgentStorage(path.join(tmpDir, "agents"), logger);
    const persisted = await reloaded.get(AGENT.id);
    expect(persisted?.advisory?.jev?.status).toBe("observed");
  });

  test("records a failed marker instead of throwing when the daemon is unavailable", async () => {
    const client = new StubClient(async () => {
      throw new DecisionFabricUnavailableError("/tmp/missing.sock", "connect ENOENT");
    });
    await expect(
      observer(client).observe({ agent: AGENT, event: COMPLETED, rows: ROWS }),
    ).resolves.toBeUndefined();

    const record = await storage.get(AGENT.id);
    expect(record?.advisory?.jev).toMatchObject({
      status: "failed",
      requestId: "paseo-agent-obs-1-fixed-request-id",
      turnId: "turn-9",
      attemptedAt: "2026-09-17T01:00:00.000Z",
      error: { code: "unavailable", retryable: true },
    });
  });

  test("records a failed marker on timeout", async () => {
    const client = new StubClient(async () => {
      throw new DecisionFabricTimeoutError("/tmp/slow.sock", 30_000);
    });
    await observer(client).observe({ agent: AGENT, event: COMPLETED, rows: ROWS });
    const record = await storage.get(AGENT.id);
    expect(record?.advisory?.jev).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
  });

  test("does not submit non-completed events to the fabric", async () => {
    const client = new StubClient(async (request) => decideResponse(request));
    const events: AgentStreamEvent[] = [
      { type: "turn_failed", provider: "codex", error: "boom", turnId: "turn-9" },
      { type: "turn_canceled", provider: "codex", reason: "user", turnId: "turn-9" },
      { type: "turn_started", provider: "codex", turnId: "turn-9" },
    ];
    for (const event of events) {
      await observer(client).observe({ agent: AGENT, event, rows: ROWS });
    }
    expect(client.requests).toHaveLength(0);
    const record = await storage.get(AGENT.id);
    expect(record?.advisory).toBeUndefined();
  });

  test("still resolves when the advisory sink itself fails", async () => {
    const failingSink = {
      recordAdvisoryJev: () => Promise.reject(new Error("disk full")),
    };
    const client = new StubClient(async (request) => decideResponse(request));
    const obs = createCompletedRunObserver({
      client,
      sink: failingSink,
      logger,
      now: () => new Date("2026-09-17T01:00:00.000Z"),
      requestIdFactory: () => "fixed-request-id",
    });
    await expect(
      obs.observe({ agent: AGENT, event: COMPLETED, rows: ROWS }),
    ).resolves.toBeUndefined();
    expect(client.requests).toHaveLength(1);
  });
});
