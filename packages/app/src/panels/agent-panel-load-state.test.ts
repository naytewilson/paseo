import { describe, expect, it } from "vitest";
import type { AgentScreenMissingState } from "@/hooks/use-agent-screen-state-machine";
import {
  type ChatAgentReadiness,
  clearHistorySyncErrorAfterSuccessfulSync,
  isChatAgentReadyForConversation,
  reconcileMissingAgentStateWithPresentAgent,
  resolveChatAgentRecord,
} from "./agent-panel-load-state";

describe("isChatAgentReadyForConversation", () => {
  it("requires an id, status, and cwd before stopping detail hydration", () => {
    expect(
      isChatAgentReadyForConversation({ id: "agent-1", status: "idle", cwd: "/tmp/project" }),
    ).toBe(true);
    expect(
      isChatAgentReadyForConversation({ id: "agent-1", status: null, cwd: "/tmp/project" }),
    ).toBe(false);
    expect(isChatAgentReadyForConversation({ id: "agent-1", status: "idle", cwd: null })).toBe(
      false,
    );
    expect(isChatAgentReadyForConversation({ id: "agent-1", status: "idle", cwd: "" })).toBe(false);
  });
});

describe("resolveChatAgentRecord", () => {
  it("does not let an incomplete active-directory record shadow fetched detail", () => {
    const incomplete: ChatAgentReadiness = { id: "agent-1", status: null, cwd: null };
    const detail: ChatAgentReadiness = { id: "agent-1", status: "idle", cwd: "/tmp/project" };

    expect(resolveChatAgentRecord(incomplete, detail)).toEqual(detail);
  });
});

describe("reconcileMissingAgentStateWithPresentAgent", () => {
  it("clears lookup-only states once the agent record is present", () => {
    expect(reconcileMissingAgentStateWithPresentAgent({ kind: "resolving" })).toEqual({
      kind: "idle",
    });
    expect(
      reconcileMissingAgentStateWithPresentAgent({
        kind: "not_found",
        message: "Agent not found: agent-1",
      }),
    ).toEqual({ kind: "idle" });
  });

  it("preserves history sync errors while the agent record is present", () => {
    const state: AgentScreenMissingState = {
      kind: "error",
      message: "Failed to get logs: session is archived",
    };

    expect(reconcileMissingAgentStateWithPresentAgent(state)).toBe(state);
  });
});

describe("clearHistorySyncErrorAfterSuccessfulSync", () => {
  it("clears a sync error after a later successful refresh", () => {
    expect(
      clearHistorySyncErrorAfterSuccessfulSync({
        kind: "error",
        message: "Failed to get logs: session is archived",
      }),
    ).toEqual({ kind: "idle" });
  });

  it("leaves non-error states alone", () => {
    const state: AgentScreenMissingState = { kind: "resolving" };

    expect(clearHistorySyncErrorAfterSuccessfulSync(state)).toBe(state);
  });
});
