import { describe, expect, test } from "vitest";
import { AgentMcpCapabilityStore } from "./agent-mcp-capability.js";

describe("agent MCP capability store", () => {
  test("binds a bearer to one daemon, generation, agent, and workspace", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const issued = store.issue({ agentId: "parent-a", workspaceId: "wks_a" });

    expect(store.resolve(issued.token)).toEqual(issued.scope);
    expect(issued.scope).toMatchObject({
      serverId: "srv_local",
      agentId: "parent-a",
      workspaceId: "wks_a",
      scope: "agent_mcp_parent_v1",
    });
    expect(issued.scope.generation).toBeTruthy();
    expect("token" in issued.scope).toBe(false);
  });

  test("does not let one caller's token select a different caller", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const issued = store.issue({ agentId: "parent-a", workspaceId: "wks_a" });

    expect(store.resolve(issued.token, "parent-a")).toEqual(issued.scope);
    expect(store.resolve(issued.token, "parent-b")).toBeNull();
  });

  test("keeps a runtime generation stable and rotates it after revocation", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const first = store.issue({ agentId: "parent-a", workspaceId: "wks_a" });
    const second = store.issue({ agentId: "parent-a", workspaceId: "wks_a" });

    expect(second.scope.generation).toBe(first.scope.generation);
    expect(second.token).toBe(first.token);
    expect(store.resolve(first.token)).toEqual(first.scope);

    store.revokeAgent("parent-a", first.scope.generation);
    expect(store.resolve(first.token)).toBeNull();

    const next = store.issue({ agentId: "parent-a", workspaceId: "wks_a" });
    expect(next.scope.generation).not.toBe(first.scope.generation);
    expect(next.token).not.toBe(first.token);
    expect(store.resolve(next.token)).toEqual(next.scope);
  });

  test("refuses to rebind overlapping generations to a different workspace", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    store.issue({ agentId: "parent-a", workspaceId: "wks_a" });

    expect(() => store.issue({ agentId: "parent-a", workspaceId: "wks_b" })).toThrow(
      "Agent MCP capability workspace cannot change during a runtime generation",
    );
  });

  test("rejects missing, malformed, shared, and revoked credentials", () => {
    const store = new AgentMcpCapabilityStore({ serverId: "srv_local" });
    const issued = store.issue({ agentId: "parent-a", workspaceId: "wks_a" });

    expect(store.resolve(null)).toBeNull();
    expect(store.resolve("")).toBeNull();
    expect(store.resolve("daemon-shared-token")).toBeNull();
    expect(store.resolve(`${issued.token}x`)).toBeNull();
    store.revokeAgent("parent-a");
    expect(store.resolve(issued.token)).toBeNull();
  });
});
