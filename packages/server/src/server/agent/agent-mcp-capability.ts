import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface AgentMcpCallerScope {
  serverId: string;
  daemonGeneration: string;
  generation: string;
  agentId: string;
  workspaceId: string | null;
  scope: "agent_mcp_parent_v1";
}

export interface IssuedAgentMcpCapability {
  token: string;
  scope: AgentMcpCallerScope;
}

interface CapabilityRecord {
  token: string;
  secretDigest: Buffer;
  scope: AgentMcpCallerScope;
}

const CAPABILITY_ID = /^[0-9a-f-]{36}$/i;
const CAPABILITY_SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * Holds runtime-bound bearer credentials for the current local agent MCP scopes.
 * A caller ID in a URL is only a consistency assertion; the credential selects
 * the server-side identity.
 */
export class AgentMcpCapabilityStore {
  private readonly records = new Map<string, CapabilityRecord>();
  private readonly recordsByAgent = new Map<string, Set<string>>();
  private readonly daemonGeneration: string;

  constructor(private readonly options: { serverId: string; daemonGeneration?: string }) {
    if (!options.serverId.trim()) throw new Error("Agent MCP capabilities require serverId");
    this.daemonGeneration = options.daemonGeneration ?? randomUUID();
  }

  issue(input: { agentId: string; workspaceId: string | null }): IssuedAgentMcpCapability {
    if (!input.agentId.trim()) throw new Error("Agent MCP capabilities require agentId");
    const activeId = this.recordsByAgent.get(input.agentId)?.values().next().value as
      | string
      | undefined;
    const activeRecord = activeId ? this.records.get(activeId) : undefined;
    if (activeRecord) {
      if (activeRecord.scope.workspaceId !== input.workspaceId) {
        throw new Error("Agent MCP capability workspace cannot change during a runtime generation");
      }
      return { token: activeRecord.token, scope: { ...activeRecord.scope } };
    }

    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const generation = randomUUID();
    const scope: AgentMcpCallerScope = {
      serverId: this.options.serverId,
      daemonGeneration: this.daemonGeneration,
      generation,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      scope: "agent_mcp_parent_v1",
    };
    const token = `${id}.${secret}`;
    this.records.set(id, { token, secretDigest: this.digest(secret), scope });
    const agentRecords = this.recordsByAgent.get(input.agentId) ?? new Set<string>();
    agentRecords.add(id);
    this.recordsByAgent.set(input.agentId, agentRecords);
    return { token, scope: { ...scope } };
  }

  resolve(token: string | null, assertedAgentId?: string): AgentMcpCallerScope | null {
    if (!token || token.length > 256) return null;
    const separator = token.indexOf(".");
    if (separator === -1 || token.indexOf(".", separator + 1) !== -1) return null;
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!CAPABILITY_ID.test(id) || !CAPABILITY_SECRET.test(secret)) return null;

    const record = this.records.get(id);
    if (!record || !this.recordsByAgent.get(record.scope.agentId)?.has(id)) return null;
    if (assertedAgentId !== undefined && assertedAgentId !== record.scope.agentId) return null;
    const actualDigest = this.digest(secret);
    if (!timingSafeEqual(actualDigest, record.secretDigest)) return null;
    return { ...record.scope };
  }

  scopeForAgent(agentId: string): AgentMcpCallerScope | null {
    const ids = [...(this.recordsByAgent.get(agentId) ?? [])];
    const id = ids.at(-1);
    const record = id ? this.records.get(id) : undefined;
    return record ? { ...record.scope } : null;
  }

  revokeAgent(agentId: string, generation?: string): void {
    const ids = this.recordsByAgent.get(agentId);
    if (!ids) return;
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || (generation !== undefined && generation !== record.scope.generation)) continue;
      ids.delete(id);
      this.records.delete(id);
    }
    if (ids.size === 0) this.recordsByAgent.delete(agentId);
  }

  clear(): void {
    this.records.clear();
    this.recordsByAgent.clear();
  }

  private digest(secret: string): Buffer {
    return createHash("sha256").update(secret, "utf8").digest();
  }
}
