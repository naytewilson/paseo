import { describe, expect, test } from "vitest";

import type { AgentStreamEvent, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { AgentTraceStateSchema } from "./contract.js";
import { buildAgentTrace, type ObservedAgent } from "./trace.js";

const AGENT: ObservedAgent = {
  id: "agent-1",
  provider: "codex",
  cwd: "/tmp/project",
  workspaceId: "wks-1",
  title: "test agent",
};

const COMPLETED: Extract<AgentStreamEvent, { type: "turn_completed" }> = {
  type: "turn_completed",
  provider: "codex",
  turnId: "turn-1",
};

let seq = 0;
function row(item: AgentTimelineItem, turnId = "turn-1"): AgentTimelineRow {
  seq += 1;
  return { seq, timestamp: "2026-09-17T00:00:00.000Z", item, turnId };
}

type ToolCallDetail = Extract<AgentTimelineItem, { type: "tool_call" }>["detail"];

function completedToolCall(detail: ToolCallDetail): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `call-${seq}`,
    name: "shell",
    status: "completed",
    error: null,
    detail,
  };
}

describe("buildAgentTrace", () => {
  test("maps a completed run into the allowlisted contract state", () => {
    const rows: AgentTimelineRow[] = [
      row({ type: "user_message", text: "implement the decision fabric client" }),
      row({ type: "assistant_message", text: "on it" }),
      row(
        completedToolCall({
          type: "shell",
          command: "npx vitest run trace.test.ts",
          output: "12 tests passed",
          exitCode: 0,
        }),
      ),
      row(
        completedToolCall({
          type: "edit",
          filePath: "src/trace.ts",
          unifiedDiff: "+code",
        }),
      ),
      row({ type: "assistant_message", text: "all green" }),
    ];

    const trace = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });

    expect(() => AgentTraceStateSchema.parse(trace.state)).not.toThrow();
    expect(trace.state.mission).toBe("implement the decision fabric client");
    expect(trace.state.final_response).toBe("all green");
    expect(trace.state.conversation).toHaveLength(3);
    expect(trace.state.conversation?.[0]).toMatchObject({ role: "user" });
    expect(trace.state.tool_calls).toHaveLength(2);
    expect(trace.state.test_evidence).toHaveLength(1);
    expect(trace.state.test_evidence?.[0]).toMatchObject({
      command: "npx vitest run trace.test.ts",
      exit_code: 0,
    });
    expect(trace.state.source_refs).toContain("file:src/trace.ts");
    expect(trace.state.deterministic_audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "terminal_outcome" })]),
    );
    expect(trace.state.deterministic_inputs).toMatchObject({
      agent_id: "agent-1",
      provider: "codex",
      terminal_event: "turn_completed",
      outcome: "completed",
    });
    expect(trace.sourceRunId).toBe("paseo:agent-1:turn-1");
    expect(trace.sourceEvidenceIds[0]).toBe("paseo-agent-agent-1");
  });

  test("scopes rows to the terminal event turn id", () => {
    const rows: AgentTimelineRow[] = [
      row({ type: "user_message", text: "earlier mission text" }, "turn-0"),
      row({ type: "user_message", text: "current mission text" }, "turn-1"),
      row({ type: "assistant_message", text: "done" }, "turn-1"),
    ];
    const trace = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });
    expect(trace.state.mission).toBe("current mission text");
    expect(trace.state.conversation).toHaveLength(2);
  });

  test("falls back to a synthetic mission when no user prompt exists", () => {
    const rows: AgentTimelineRow[] = [row({ type: "assistant_message", text: "done" })];
    const trace = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });
    expect(trace.state.mission.length).toBeGreaterThanOrEqual(8);
    expect(() => AgentTraceStateSchema.parse(trace.state)).not.toThrow();
  });

  test("redacts secrets inside state content before egress", () => {
    const rows: AgentTimelineRow[] = [
      row({
        type: "user_message",
        text: "deploy with ANTHROPIC_API_KEY=sk-ant-api03-SECRETVALUE",
      }),
      row(
        completedToolCall({
          type: "shell",
          command: "curl -H 'Authorization: Bearer abcdef123456' https://example.com",
          output: "token=ghp_abcdefghijklmnopqrstuvwxyz1234",
          exitCode: 0,
        }),
      ),
      row({ type: "assistant_message", text: "used key sk-1234567890abcdef" }),
    ];
    const trace = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });
    const serialized = JSON.stringify(trace.state);
    expect(serialized).not.toContain("sk-ant-");
    expect(serialized).not.toContain("sk-1234567890");
    expect(serialized).not.toContain("abcdef123456");
    expect(serialized).not.toContain("ghp_");
    expect(serialized).toContain("[REDACTED_SECRET]");
  });

  test("only emits allowlisted state keys", () => {
    const rows: AgentTimelineRow[] = [
      row({ type: "user_message", text: "do the mission thing" }),
      row({ type: "assistant_message", text: "done" }),
    ];
    const trace = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });
    const allowed = new Set([
      "mission",
      "conversation",
      "tool_calls",
      "final_response",
      "user_feedback",
      "test_evidence",
      "source_refs",
      "deterministic_audit",
      "deterministic_inputs",
    ]);
    for (const key of Object.keys(trace.state)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  test("bounds state size under the internal budget for huge timelines", () => {
    const rows: AgentTimelineRow[] = [row({ type: "user_message", text: "x".repeat(64 * 1024) })];
    for (let i = 0; i < 200; i += 1) {
      rows.push(row({ type: "assistant_message", text: "y".repeat(16 * 1024) }));
      rows.push(
        row(
          completedToolCall({
            type: "shell",
            command: `echo ${"z".repeat(4000)}`,
            output: "o".repeat(32 * 1024),
            exitCode: 0,
          }),
        ),
      );
    }
    const trace = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });
    const bytes = Buffer.byteLength(JSON.stringify(trace.state), "utf8");
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
    expect(() => AgentTraceStateSchema.parse(trace.state)).not.toThrow();
  });

  test("produces deterministic source refs and run ids", () => {
    const rows: AgentTimelineRow[] = [
      row({ type: "user_message", text: "stable mission text" }),
      row(completedToolCall({ type: "read", filePath: "src/a.ts" })),
    ];
    const a = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });
    const b = buildAgentTrace({ agent: AGENT, event: COMPLETED, rows });
    expect(a.sourceRunId).toBe(b.sourceRunId);
    expect(a.sourceEvidenceIds).toEqual(b.sourceEvidenceIds);
    expect(a.state).toEqual(b.state);
  });
});
