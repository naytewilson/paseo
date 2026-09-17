import { z } from "zod";

export const AGENT_TRACE_CONTRACT_ID = "anvil.agent-trace-observability.v1";
export const AGENT_TRACE_CONTRACT_VERSION = "1.0.0";
export const DECIDE_PATH = "/v1/decide";

export const POLICY_OUTCOMES = [
  "WOULD_CLOSE",
  "WOULD_REVIEW",
  "WOULD_PRIORITY_REVIEW",
  "WOULD_FILE_ISSUE",
  "WOULD_ESCALATE",
  "WOULD_ABSTAIN_INSUFFICIENT_EVIDENCE",
] as const;

const ConversationEntrySchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    timestamp: z.string().optional(),
  })
  .strict();

const ToolCallEntrySchema = z
  .object({
    seq: z.number().int().nonnegative(),
    tool: z.string(),
    arguments: z.unknown().optional(),
    result: z.string().optional(),
    exit_code: z.number().nullable().optional(),
  })
  .strict();

const TestEvidenceEntrySchema = z
  .object({
    command: z.string(),
    exit_code: z.number().nullable(),
    summary: z.string(),
  })
  .strict();

const DeterministicAuditEntrySchema = z
  .object({
    check: z.string(),
    result: z.unknown(),
  })
  .strict();

/**
 * Provider-bound state for `anvil.agent-trace-observability.v1@1.0.0`. Only the
 * allowlisted keys below may leave the machine; the frozen wire contract
 * rejects anything else with STATE_SCHEMA_VIOLATION.
 */
export const AgentTraceStateSchema = z
  .object({
    mission: z.string().min(8),
    conversation: z.array(ConversationEntrySchema).optional(),
    tool_calls: z.array(ToolCallEntrySchema).optional(),
    final_response: z.string().optional(),
    user_feedback: z.string().optional(),
    test_evidence: z.array(TestEvidenceEntrySchema).optional(),
    source_refs: z.array(z.string()).optional(),
    deterministic_audit: z.array(DeterministicAuditEntrySchema).optional(),
    deterministic_inputs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type AgentTraceState = z.infer<typeof AgentTraceStateSchema>;

/**
 * Outbound decide request. `.strict()` keeps the wire payload inside the
 * frozen contract's allowlist — anything else (including every forbidden key)
 * fails validation before it can leave the machine.
 */
export const DecideRequestSchema = z
  .object({
    contract_id: z.string().min(1),
    contract_version: z.string().min(1),
    request_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    source_run_id: z.string().min(1),
    state: AgentTraceStateSchema,
    source_evidence_ids: z.array(z.string()).min(1),
    authorized_dynamic_options: z.record(z.string(), z.array(z.string())).optional(),
    correlation_id: z.string().optional(),
    shadow_tags: z.array(z.string()).optional(),
  })
  .strict();

export type DecideRequest = z.infer<typeof DecideRequestSchema>;

const DecideAnswerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("choice"),
      choice: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("score"),
      score: z.number(),
    })
    .passthrough(),
]);

export const DecideResponseSchema = z.object({
  request_id: z.string(),
  contract_id: z.string(),
  contract_version: z.string(),
  contract_digest: z.string().optional(),
  requested_model: z.string(),
  effective_model: z.string(),
  answers: z.record(z.string(), DecideAnswerSchema),
  policy_mode: z.string(),
  policy_outcome: z.enum(POLICY_OUTCOMES),
  policy_version: z.string().optional(),
  escalation_reason: z.string().optional(),
  receipt_id: z.string().min(1),
  receipt_digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type DecideResponse = z.infer<typeof DecideResponseSchema>;

const DecideErrorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export function parseDecideErrorBody(
  body: string,
): { code: string; message: string; retryable?: boolean } | null {
  try {
    const parsed = DecideErrorBodySchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      return null;
    }
    return {
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      retryable: parsed.data.error.retryable,
    };
  } catch {
    return null;
  }
}
