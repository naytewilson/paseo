import { describe, expect, test } from "vitest";
import { AgentMcpCapabilityStore } from "./agent-mcp-capability.js";

describe("agent MCP capability store", () => {
  test("binds a bearer to one daemon, runtime generation, agent, and workspace", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const issued = store.issue({
      agentId: "parent-a",
      workspaceId: "wks_a",
      runtimeGeneration: "runtime-a",
    });

    expect(store.resolve(issued.token)).toEqual(issued.scope);
    expect(issued.scope).toMatchObject({
      serverId: "srv_local",
      generation: "runtime-a",
      agentId: "parent-a",
      workspaceId: "wks_a",
      scope: "agent_mcp_parent_v1",
    });
    expect("token" in issued.scope).toBe(false);
  });

  test("does not let one caller's token select a different caller", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const issued = store.issue({
      agentId: "parent-a",
      workspaceId: "wks_a",
      runtimeGeneration: "runtime-a",
    });

    expect(store.resolve(issued.token, "parent-a")).toEqual(issued.scope);
    expect(store.resolve(issued.token, "parent-b")).toBeNull();
  });

  test("issues distinct capabilities for distinct runtime generations", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const first = store.issue({
      agentId: "parent-a",
      workspaceId: "wks_a",
      runtimeGeneration: "runtime-a",
    });
    const second = store.issue({
      agentId: "parent-a",
      workspaceId: "wks_a",
      runtimeGeneration: "runtime-b",
    });

    expect(second.scope.generation).not.toBe(first.scope.generation);
    expect(second.token).not.toBe(first.token);
    expect(store.resolve(first.token)).toEqual(first.scope);
    expect(store.resolve(second.token)).toEqual(second.scope);

    store.revokeAgent("parent-a", first.scope.generation);
    expect(store.resolve(first.token)).toBeNull();
    expect(store.resolve(second.token)).toEqual(second.scope);
  });

  test("does not issue the same runtime generation twice", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    store.issue({
      agentId: "parent-a",
      workspaceId: "wks_a",
      runtimeGeneration: "runtime-a",
    });

    expect(() =>
      store.issue({
        agentId: "parent-a",
        workspaceId: "wks_a",
        runtimeGeneration: "runtime-a",
      }),
    ).toThrow("Agent MCP capability generation has already been issued");
  });

  test("rejects missing, malformed, shared, and revoked credentials", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const issued = store.issue({
      agentId: "parent-a",
      workspaceId: "wks_a",
      runtimeGeneration: "runtime-a",
    });

    expect(store.resolve(null)).toBeNull();
    expect(store.resolve("")).toBeNull();
    expect(store.resolve("daemon-shared-token")).toBeNull();
    expect(store.resolve(`${issued.token}x`)).toBeNull();
    store.revokeAgent("parent-a");
    expect(store.resolve(issued.token)).toBeNull();
  });

  test("retains only the bearer verification digest in the capability store", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const issued = store.issue({
      agentId: "parent-a",
      workspaceId: "wks_a",
      runtimeGeneration: "runtime-a",
    });
    const id = issued.token.split(".")[0]!;
    const records = Reflect.get(store, "records") as Map<string, Record<string, unknown>>;

    expect(records.get(id)).not.toHaveProperty("token");
    expect(records.get(id)?.secretDigest).toBeInstanceOf(Buffer);
  });
});
