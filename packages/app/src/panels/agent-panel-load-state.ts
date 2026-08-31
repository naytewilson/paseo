import type { AgentScreenMissingState } from "@/hooks/use-agent-screen-state-machine";

export interface ChatAgentReadiness {
  id: string | null | undefined;
  status: string | null | undefined;
  cwd: string | null | undefined;
}

/**
 * A cached directory entry can contain identity/title metadata before its
 * detail snapshot has arrived. Treat that record as unresolved; otherwise the
 * panel's lookup effect incorrectly stops and leaves the conversation spinner
 * mounted forever.
 */
export function isChatAgentReadyForConversation(
  agent: ChatAgentReadiness | null | undefined,
): boolean {
  return Boolean(agent?.id && agent.status && agent.cwd);
}

/**
 * Prefer a complete agent snapshot. Replica/cache hydration can temporarily
 * put an identity-only record in the active map while a complete detail record
 * is already available in the detail map; the incomplete record must not mask
 * that usable snapshot.
 */
export function resolveChatAgentRecord<T extends ChatAgentReadiness>(
  active: T | null | undefined,
  detail: T | null | undefined,
): T | null {
  if (isChatAgentReadyForConversation(active)) return active ?? null;
  if (detail) return detail;
  return active ?? null;
}

export function reconcileMissingAgentStateWithPresentAgent(
  state: AgentScreenMissingState,
): AgentScreenMissingState {
  if (state.kind === "resolving" || state.kind === "not_found") {
    return { kind: "idle" };
  }
  return state;
}

export function clearHistorySyncErrorAfterSuccessfulSync(
  state: AgentScreenMissingState,
): AgentScreenMissingState {
  if (state.kind === "error") {
    return { kind: "idle" };
  }
  return state;
}
