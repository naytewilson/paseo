import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  CreateAgentWorktreeTarget,
  HubExecutionControlAction,
} from "@getpaseo/protocol/messages";
import {
  correlationEnvelopeFromUnknown,
  withPaseoPlaneIdentity,
  type CorrelationEnvelope,
} from "@getpaseo/protocol/correlation";
import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { McpServerConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
import { serializeAgentSnapshot, serializeAgentStreamEvent } from "../messages.js";
import { daemonExecutionKey, type DaemonAgentOwner } from "../agent/agent-owner.js";

export interface HubExecutionAgentCreateInput {
  executionId: string;
  provider: string;
  cwd: string;
  prompt: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  providerOptions?: ProviderOptions;
  toolPolicy?: ToolPolicy;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  worktree?: CreateAgentWorktreeTarget;
  /**
   * Correlation Envelope V1 from the owning plane (opaque). Carried with the
   * execution ownership and re-emitted on owned snapshots/events; never
   * derived, repaired, or mapped from the Hub-owned executionId.
   */
  correlation?: unknown;
}

export interface HubExecutionControlInput {
  requestId: string;
  executionId: string;
  action: HubExecutionControlAction;
  /** Correlation Envelope V1 from the owning plane (opaque). */
  correlation?: unknown;
}

export interface OwnedAgentSnapshot {
  executionId: string;
  agent: AgentSnapshotPayload;
  /** Carried envelope with Paseo plane ids merged; null when none received. */
  correlation: CorrelationEnvelope | null;
}

export type OwnedAgentEvent =
  | {
      type: "update";
      executionId: string;
      agent: AgentSnapshotPayload;
      correlation: CorrelationEnvelope | null;
    }
  | {
      type: "stream";
      executionId: string;
      agentId: string;
      event: AgentStreamEventPayload;
      correlation: CorrelationEnvelope | null;
    };

interface DaemonExecutionsOptions {
  daemonId: string;
  /** Stable daemon server id — emitted as plane_identity.paseo_server_id. */
  serverId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  interruptAgent: (agentId: string) => Promise<unknown>;
  archiveWorkspace: (workspaceId: string, requestId: string) => Promise<unknown>;
  cleanupFailedCreate?: (input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    createdAgentId: string | null;
  }) => Promise<void>;
}

export interface HubExecutionAgents {
  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot>;
  control(input: HubExecutionControlInput): Promise<void>;
  subscribe(listener: (event: OwnedAgentEvent) => void): () => void;
  invalidateAuthority(): Promise<void>;
}

export class DaemonExecutions implements HubExecutionAgents {
  private readonly daemonId: string;
  private readonly serverId: string;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgentCommand: BoundCreateAgentCommand;
  private readonly pendingCreates = new Map<string, Promise<OwnedAgentSnapshot>>();
  private readonly pendingControlActions = new Map<string, Promise<void>>();
  private readonly controlTails = new Map<string, Promise<void>>();
  /** Carried Correlation Envelope V1 per owned execution (opaque, as-given). */
  private readonly correlationByOwnerKey = new Map<string, CorrelationEnvelope>();
  private authorityGeneration = 0;
  private authorityActive = true;
  private readonly cleanupFailedCreate: NonNullable<DaemonExecutionsOptions["cleanupFailedCreate"]>;

  constructor(private readonly options: DaemonExecutionsOptions) {
    this.daemonId = options.daemonId;
    this.serverId = options.serverId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgentCommand = options.createAgent;
    this.cleanupFailedCreate = options.cleanupFailedCreate ?? (async () => undefined);
  }

  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot> {
    if (!this.authorityActive) {
      return Promise.reject(new Error("Hub relationship authority is no longer active"));
    }
    return this.ensureCorrelationHydrated().then(() => {
      const owner = this.owner(input.executionId);
      const remembered = this.rememberCorrelation(owner, input.correlation);
      // The creation owner carries the remembered envelope so it persists
      // with the runtime ownership record (restart-safe carry). `undefined`
      // leaves any previously stored value untouched.
      const creationOwner: DaemonAgentOwner =
        remembered === undefined ? owner : { ...owner, correlation: remembered };
      const key = daemonExecutionKey(owner);
      const pending = this.pendingCreates.get(key);
      if (pending) {
        return pending;
      }

      const authorityGeneration = this.authorityGeneration;
      const create = this.createOrResolve(creationOwner, input, authorityGeneration).finally(() => {
        if (this.pendingCreates.get(key) === create) {
          this.pendingCreates.delete(key);
        }
      });
      this.pendingCreates.set(key, create);
      return create;
    });
  }

  control(input: HubExecutionControlInput): Promise<void> {
    if (!this.authorityActive) {
      return Promise.reject(new Error("Hub relationship authority is no longer active"));
    }
    return this.ensureCorrelationHydrated().then(() => {
      const owner = this.owner(input.executionId);
      this.rememberCorrelation(owner, input.correlation);
      const executionKey = daemonExecutionKey(owner);
      const actionKey = `${executionKey}\0${input.action}`;
      const pending = this.pendingControlActions.get(actionKey);
      if (pending) return pending;

      const previous =
        this.controlTails.get(executionKey) ??
        this.pendingCreates.get(executionKey)?.then(() => undefined) ??
        Promise.resolve();
      const authorityGeneration = this.authorityGeneration;
      const control = previous
        .catch(() => undefined)
        .then(() => this.controlOwnedExecution(owner, input, authorityGeneration));
      this.pendingControlActions.set(actionKey, control);
      this.controlTails.set(executionKey, control);
      const release = () => {
        if (this.pendingControlActions.get(actionKey) === control) {
          this.pendingControlActions.delete(actionKey);
        }
        if (this.controlTails.get(executionKey) === control) {
          this.controlTails.delete(executionKey);
        }
      };
      void control.then(release, release);
      return control;
    });
  }

  async invalidateAuthority(): Promise<void> {
    this.authorityActive = false;
    this.authorityGeneration++;
    // Drop carried envelopes with the authority: a new grant starts clean,
    // never inheriting the previous relationship's correlation.
    this.correlationByOwnerKey.clear();
    await Promise.allSettled([
      ...this.pendingCreates.values(),
      ...this.pendingControlActions.values(),
    ]);
  }

  subscribe(listener: (event: OwnedAgentEvent) => void): () => void {
    return this.agentManager.subscribe(
      (event) => {
        const owned = this.projectEvent(event);
        if (owned) {
          listener(owned);
        }
      },
      { replayState: true },
    );
  }

  private async createOrResolve(
    owner: DaemonAgentOwner,
    input: HubExecutionAgentCreateInput,
    authorityGeneration: number,
  ): Promise<OwnedAgentSnapshot> {
    const existing = await this.agentStorage.findByDaemonExecution(owner);
    if (existing) {
      requireExecutionWorkspaceId(existing);
      this.requireAuthority(authorityGeneration);
      return this.resolveRecord(existing);
    }
    this.requireAuthority(authorityGeneration);
    requireHubMcpNamespace(input.mcpServers);
    requireToolPolicyServers(input.toolPolicy, input.mcpServers);

    let createdWorktree: CreatePaseoWorktreeWorkflowResult | null = null;
    let createdAgentId: string | null = null;
    let result: Awaited<ReturnType<BoundCreateAgentCommand>>;
    try {
      result = await this.createAgentCommand({
        kind: "mcp",
        provider: input.model ? `${input.provider}/${input.model}` : input.provider,
        title: input.prompt,
        initialPrompt: input.prompt,
        promptFailure: "throw",
        cwd: input.cwd,
        mode: input.modeId,
        thinking: input.thinkingOptionId,
        features: input.featureValues,
        env: input.env,
        ...(input.mcpServers || input.providerOptions || input.toolPolicy
          ? {
              config: {
                ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
                ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
                ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
              },
            }
          : {}),
        worktree: toCreateAgentWorktree(input.worktree),
        background: true,
        notifyOnFinish: false,
        owner,
        onWorktreeCreated: (worktree) => {
          createdWorktree = worktree;
        },
        onCreated: (created) => {
          createdAgentId = created.agentId;
        },
      });
      this.requireAuthority(authorityGeneration);
      requireExecutionWorkspaceId(result.liveSnapshot);
    } catch (error) {
      try {
        if (createdAgentId && this.agentManager.getAgent(createdAgentId)) {
          try {
            await this.agentManager.closeAgent(createdAgentId);
          } finally {
            await this.agentManager.deleteAgentState(createdAgentId);
          }
        }
      } finally {
        try {
          await this.cleanupFailedCreate({
            createdWorktree: ownedCreatedWorktree(createdWorktree),
            createdAgentId: null,
          });
        } finally {
          if (createdAgentId) {
            await this.agentStorage.remove(createdAgentId);
          }
        }
      }
      throw error;
    }

    return {
      executionId: owner.executionId,
      agent: serializeAgentSnapshot(result.liveSnapshot),
      correlation: this.correlationFor(owner, result.liveSnapshot.id),
    };
  }

  private async controlOwnedExecution(
    owner: DaemonAgentOwner,
    input: HubExecutionControlInput,
    authorityGeneration: number,
  ): Promise<void> {
    this.requireAuthority(authorityGeneration, "execution control");
    const record = await this.agentStorage.findByDaemonExecution(owner);
    this.requireAuthority(authorityGeneration, "execution control");
    if (!record) {
      return;
    }
    this.requireOwner(record);

    if (input.action === "interrupt") {
      if (!record.archivedAt && this.agentManager.getAgent(record.id)) {
        await this.options.interruptAgent(record.id);
      }
      return;
    }

    const workspaceId = requireExecutionWorkspaceId(record);
    this.requireAuthority(authorityGeneration, "execution control");
    await this.options.archiveWorkspace(workspaceId, input.requestId);
  }

  private resolveRecord(record: StoredAgentRecord): OwnedAgentSnapshot {
    requireExecutionWorkspaceId(record);
    return this.projectRecord(record);
  }

  private requireAuthority(authorityGeneration: number, operation = "agent creation"): void {
    if (!this.authorityActive || authorityGeneration !== this.authorityGeneration) {
      throw new Error(`Hub relationship authority ended during ${operation}`);
    }
  }

  private projectRecord(record: StoredAgentRecord): OwnedAgentSnapshot {
    const owner = this.requireOwner(record);
    const live = this.agentManager.getAgent(record.id);
    return {
      executionId: owner.executionId,
      agent: live
        ? serializeAgentSnapshot(live)
        : {
            ...buildStoredAgentPayload(record, this.agentManager.getRegisteredProviderIds()),
            status: "closed",
          },
      correlation: this.correlationFor(owner, record.id),
    };
  }

  private projectEvent(event: AgentManagerEvent): OwnedAgentEvent | null {
    if (event.type === "agent_state") {
      return this.projectAgentState(event.agent);
    }
    if (event.type !== "agent_stream") {
      return null;
    }
    const agent = this.agentManager.getAgent(event.agentId);
    if (!this.isOwned(agent)) {
      return null;
    }
    const serialized = serializeAgentStreamEvent(event.event);
    if (!serialized) {
      return null;
    }
    return {
      type: "stream",
      executionId: agent.owner.executionId,
      agentId: agent.id,
      event: serialized,
      correlation: this.correlationFor(agent.owner, agent.id),
    };
  }

  private projectAgentState(agent: ManagedAgent): OwnedAgentEvent | null {
    if (!this.isOwned(agent)) {
      return null;
    }
    return {
      type: "update",
      executionId: agent.owner.executionId,
      agent: serializeAgentSnapshot(agent),
      correlation: this.correlationFor(agent.owner, agent.id),
    };
  }

  private correlationHydrated = false;

  /**
   * Rehydrate carried envelopes from persisted ownership records once per
   * instance, so a daemon restart keeps carrying them. Best-effort: a
   * storage failure degrades to in-memory-only carry, never fails the call.
   */
  private async ensureCorrelationHydrated(): Promise<void> {
    if (this.correlationHydrated) return;
    this.correlationHydrated = true;
    try {
      const records = await this.agentStorage.list();
      for (const record of records) {
        const owner = record.owner;
        if (owner?.kind !== "daemon" || owner.daemonId !== this.daemonId) continue;
        const envelope = owner.correlation
          ? correlationEnvelopeFromUnknown(owner.correlation)
          : null;
        if (envelope) {
          this.correlationByOwnerKey.set(daemonExecutionKey(owner), envelope);
        }
      }
    } catch {
      // Best-effort: in-memory carry still works for this session.
    }
  }

  /**
   * Remember the envelope carried in from the owning plane, as-given.
   * A present-but-malformed value clears the stored envelope rather than
   * being repaired; absent (undefined) leaves the stored value untouched.
   * Returns the remembered envelope, or undefined when untouched.
   */
  private rememberCorrelation(
    owner: DaemonAgentOwner,
    correlation: unknown,
  ): CorrelationEnvelope | null | undefined {
    if (correlation === undefined) return undefined;
    const envelope = correlationEnvelopeFromUnknown(correlation);
    const key = daemonExecutionKey(owner);
    if (envelope) {
      this.correlationByOwnerKey.set(key, envelope);
    } else {
      this.correlationByOwnerKey.delete(key);
    }
    // Durable: persist with the runtime ownership record when one exists
    // (the create path persists via the creation owner instead, since the
    // record does not exist yet at that point). Best-effort, never fails.
    void this.persistCorrelation(owner, envelope);
    return envelope;
  }

  private async persistCorrelation(
    owner: DaemonAgentOwner,
    envelope: CorrelationEnvelope | null,
  ): Promise<void> {
    try {
      const record = await this.agentStorage.findByDaemonExecution(owner);
      if (!record || record.owner?.kind !== "daemon") return;
      const current = record.owner.correlation ?? null;
      if (JSON.stringify(current) === JSON.stringify(envelope)) return;
      await this.agentStorage.upsert({
        ...record,
        owner: { ...record.owner, correlation: envelope },
      });
    } catch {
      // Best-effort: the in-memory map still carries for this session.
    }
  }

  /**
   * The carried envelope for a new observation, with Paseo's plane-native
   * ids merged into plane_identity. ANVIL fields are preserved verbatim.
   * Absent stays absent — Paseo never mints.
   */
  private correlationFor(owner: DaemonAgentOwner, agentId: string): CorrelationEnvelope | null {
    const carried = this.correlationByOwnerKey.get(daemonExecutionKey(owner)) ?? null;
    return withPaseoPlaneIdentity(carried, {
      paseo_agent_id: agentId,
      paseo_server_id: this.serverId,
    });
  }

  private isOwned(agent: ManagedAgent | null): agent is ManagedAgent & { owner: DaemonAgentOwner } {
    return agent?.owner?.kind === "daemon" && agent.owner.daemonId === this.daemonId;
  }

  private owner(executionId: string): DaemonAgentOwner {
    return { kind: "daemon", daemonId: this.daemonId, executionId };
  }

  private requireOwner(record: StoredAgentRecord): DaemonAgentOwner {
    const owner = record.owner;
    if (owner?.kind !== "daemon" || owner.daemonId !== this.daemonId) {
      throw new Error(`Agent ${record.id} is not owned by daemon ${this.daemonId}`);
    }
    return owner;
  }
}

function requireHubMcpNamespace(mcpServers: Record<string, McpServerConfig> | undefined): void {
  if (mcpServers && Object.hasOwn(mcpServers, "paseo")) {
    throw new Error('Hub execution MCP server name "paseo" is reserved by the daemon');
  }
}

function requireToolPolicyServers(
  toolPolicy: ToolPolicy | undefined,
  mcpServers: Record<string, McpServerConfig> | undefined,
): void {
  if (!toolPolicy) return;
  const serverNames = new Set(Object.keys(mcpServers ?? {}));
  for (const grant of toolPolicy.preapproved) {
    if (!serverNames.has(grant.server)) {
      throw new Error(
        `Hub tool preapproval '${grant.server}.${grant.tool}' requires MCP server '${grant.server}' in the same create request`,
      );
    }
  }
}

function ownedCreatedWorktree(
  worktree: CreatePaseoWorktreeWorkflowResult | null,
): CreatePaseoWorktreeWorkflowResult | null {
  return worktree?.created === true ? worktree : null;
}

function requireExecutionWorkspaceId(
  record: Pick<StoredAgentRecord, "id" | "workspaceId">,
): string {
  if (!record.workspaceId) {
    throw new Error(`Hub execution agent ${record.id} has no workspaceId`);
  }
  return record.workspaceId;
}

function toCreateAgentWorktree(target: CreateAgentWorktreeTarget | undefined) {
  if (!target) return undefined;
  if (target.mode === "branch-off") {
    return {
      worktreeName: target.newBranch,
      baseBranch: target.base,
      action: "branch-off" as const,
    };
  }
  if (target.mode === "checkout-branch") {
    return { refName: target.branch, action: "checkout" as const };
  }
  return { githubPrNumber: target.prNumber, action: "checkout" as const };
}
