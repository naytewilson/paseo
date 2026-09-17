import { randomUUID } from "node:crypto";

import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { StoredAgentAdvisoryJev } from "../agent/agent-storage.js";
import {
  AGENT_TRACE_CONTRACT_ID,
  AGENT_TRACE_CONTRACT_VERSION,
  type DecideRequest,
} from "./contract.js";
import {
  DecisionFabricInvalidRequestError,
  DecisionFabricMalformedResponseError,
  DecisionFabricRequestError,
  DecisionFabricTimeoutError,
  DecisionFabricUnavailableError,
  type DecisionFabricClient,
} from "./client.js";
import { buildAgentTrace, sanitizeWireToken, type ObservedAgent } from "./trace.js";

export interface CompletedRunObservation {
  agent: ObservedAgent;
  event: AgentStreamEvent;
  rows: AgentTimelineRow[];
}

export interface CompletedRunObserver {
  /**
   * Submit one completed-run trace to the machine-local Decision Fabric and
   * attach the returned shadow observation under `advisory.jev` on the agent
   * record. Never rejects: failures degrade to a `failed` advisory marker.
   */
  observe(input: CompletedRunObservation): Promise<void>;
}

export interface AdvisoryJevSink {
  recordAdvisoryJev(agentId: string, jev: StoredAgentAdvisoryJev): Promise<unknown>;
}

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  warn(...args: unknown[]): void;
}

interface CompletedRunObserverOptions {
  client: DecisionFabricClient;
  sink: AdvisoryJevSink;
  logger: LoggerLike;
  now?: () => Date;
  requestIdFactory?: () => string;
}

/**
 * Campaign scope: only completed runs are eligible for shadow observation.
 * Failed and canceled turns never reach the fabric.
 */
function isCompletedTurnEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: "turn_completed" }> {
  return event.type === "turn_completed";
}

function errorFields(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (error instanceof DecisionFabricTimeoutError) {
    return { code: "timeout", message: error.message };
  }
  if (error instanceof DecisionFabricUnavailableError) {
    return { code: "unavailable", message: error.message, retryable: true };
  }
  if (error instanceof DecisionFabricRequestError) {
    return {
      code: error.code ?? `http_${error.status}`,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof DecisionFabricMalformedResponseError) {
    return { code: "malformed_response", message: error.message };
  }
  if (error instanceof DecisionFabricInvalidRequestError) {
    return { code: "invalid_request", message: error.message };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createCompletedRunObserver(
  options: CompletedRunObserverOptions,
): CompletedRunObserver {
  const now = options.now ?? (() => new Date());
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const logger = options.logger.child({ module: "decision-fabric" });

  return {
    async observe(input: CompletedRunObservation): Promise<void> {
      const { agent, event, rows } = input;
      if (!isCompletedTurnEvent(event)) {
        return;
      }
      const requestId = sanitizeWireToken(`paseo-${agent.id}-${requestIdFactory()}`, 200);
      const turnId = event.turnId ?? null;
      try {
        const trace = buildAgentTrace({ agent, event, rows });
        const request: DecideRequest = {
          contract_id: AGENT_TRACE_CONTRACT_ID,
          contract_version: AGENT_TRACE_CONTRACT_VERSION,
          request_id: requestId,
          source_run_id: trace.sourceRunId,
          state: trace.state,
          source_evidence_ids: trace.sourceEvidenceIds,
          correlation_id: trace.sourceRunId,
          shadow_tags: ["paseo", "shadow"],
        };
        const response = await options.client.decide(request);
        await options.sink.recordAdvisoryJev(agent.id, {
          status: "observed",
          contractId: response.contract_id,
          contractVersion: response.contract_version,
          ...(response.contract_digest !== undefined
            ? { contractDigest: response.contract_digest }
            : {}),
          requestId: response.request_id,
          sourceRunId: trace.sourceRunId,
          turnId,
          observedAt: now().toISOString(),
          policyMode: "SHADOW_ONLY",
          policyOutcome: response.policy_outcome,
          ...(response.policy_version !== undefined
            ? { policyVersion: response.policy_version }
            : {}),
          ...(response.escalation_reason !== undefined
            ? { escalationReason: response.escalation_reason }
            : {}),
          requestedModel: response.requested_model,
          effectiveModel: response.effective_model,
          answers: response.answers,
          receiptId: response.receipt_id,
          receiptDigest: response.receipt_digest,
        });
      } catch (error) {
        const fields = errorFields(error);
        logger.warn(
          { err: error, agentId: agent.id, turnId, requestId },
          "Completed-run decision observation failed",
        );
        try {
          await options.sink.recordAdvisoryJev(agent.id, {
            status: "failed",
            contractId: AGENT_TRACE_CONTRACT_ID,
            contractVersion: AGENT_TRACE_CONTRACT_VERSION,
            requestId,
            turnId,
            attemptedAt: now().toISOString(),
            error: fields,
          });
        } catch (attachError) {
          logger.warn(
            { err: attachError, agentId: agent.id },
            "Failed to record decision-fabric failure marker",
          );
        }
      }
    },
  };
}
