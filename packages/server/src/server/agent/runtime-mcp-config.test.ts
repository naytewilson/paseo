import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      agentMcpCapability: {
        token: "agent-token",
        scope: {
          serverId: "srv_local",
          daemonGeneration: "daemon-generation",
          generation: "session-generation",
          agentId: "agent-1",
          workspaceId: "wks-1",
          scope: "agent_mcp_parent_v1",
        },
      },
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer agent-token" },
    });
  });

  test("does not inject an agent-scoped URL when no per-agent capability is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      agentMcpCapability: null,
    });

    expect(result.mcpServers?.paseo).toBeUndefined();
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      agentMcpCapability: null,
    });

    expect(result.mcpServers).toBeUndefined();
  });
});
