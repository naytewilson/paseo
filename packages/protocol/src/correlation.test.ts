/**
 * Boundary tests: Correlation Envelope V1 (wire `anvil.correlation.v2`) —
 * Paseo carrier semantics.
 *
 * Paseo never mints, infers, repairs, or advances ANVIL fields. These tests
 * prove the carrier laws against the NORMATIVE JSON Schema vendored at
 * ./correlation-envelope-v1.schema.json:
 * - the vendored copy is byte-identical to the frozen contract artifact
 *   (sha256 pinned);
 * - carried envelopes satisfy the schema's const/required/pattern/atomicity
 *   rules as read from the schema itself;
 * - unknown top-level fields survive the carry; unknown schema versions are
 *   carried opaquely, never rejected;
 * - on a new observation Paseo adds ONLY paseo_agent_id / paseo_server_id
 *   to plane_identity — ANVIL fields pass through byte-identical, the
 *   Hub-owned executionId is never mapped into execution_id, and no prompt
 *   material can enter the envelope;
 * - absent stays absent: with no inbound envelope Paseo emits null.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CORRELATION_ENVELOPE_WIRE_SCHEMA,
  CorrelationEnvelopeSchema,
  correlationEnvelopeFromUnknown,
  withPaseoPlaneIdentity,
  type CorrelationEnvelope,
} from "./correlation.js";
import { HubExecutionAgentCreateRequestSchema, HubExecutionAgentUpdateSchema } from "./messages.js";

/** sha256 of the frozen contract artifact ~/workspace/i5-wave/envelope/correlation-envelope-v1.schema.json */
const FROZEN_SCHEMA_SHA256 = "95d8e3108ca9c4c38d2c398e0c86cbca0ea6a54cd5b3f9b4f6c2d2188b0ea037";

const SCHEMA_PATH = new URL("./correlation-envelope-v1.schema.json", import.meta.url);
const SCHEMA_BYTES = readFileSync(SCHEMA_PATH);
const normativeSchema = JSON.parse(SCHEMA_BYTES.toString("utf8")) as {
  properties: {
    schema: { const: string };
    plane_identity: { properties: Record<string, unknown> };
  } & Record<string, { pattern?: string }>;
  required: string[];
};

const ANVIL_EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const ANVIL_CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const ANVIL_BINDING_ID = "33333333-3333-4333-8333-333333333333";
const HUB_EXECUTION_ID = "hub-owned-execution-id-not-a-uuid";
const PASEO_AGENT_ID = "agent-abc-123";
const PASEO_SERVER_ID = "server-xyz-789";

function carriedEnvelope(): CorrelationEnvelope {
  const envelope = correlationEnvelopeFromUnknown({
    schema: "anvil.correlation.v2",
    correlation_id: ANVIL_CORRELATION_ID,
    causation_id: "hub:control:grant-1",
    campaign_id: null,
    task_ref: null,
    execution_id: ANVIL_EXECUTION_ID,
    execution_binding_id: ANVIL_BINDING_ID,
    binding_generation: 4,
    producer: "hub:control",
    observed_at: "2026-09-23T21:42:00.123Z",
    idempotency_key: "k-1",
    source_ref: "control_operations:op-1",
    plane_identity: { control_operation_id: "op-1", hub_execution_id: HUB_EXECUTION_ID },
    future_field: "preserved",
  });
  expect(envelope).not.toBeNull();
  return envelope!;
}

describe("vendored normative schema", () => {
  it("is byte-identical to the frozen contract artifact", () => {
    const digest = createHash("sha256").update(SCHEMA_BYTES).digest("hex");
    expect(digest).toBe(FROZEN_SCHEMA_SHA256);
  });

  it("wire version matches the schema const", () => {
    expect(CORRELATION_ENVELOPE_WIRE_SCHEMA).toBe(normativeSchema.properties.schema.const);
    expect(CORRELATION_ENVELOPE_WIRE_SCHEMA).toBe("anvil.correlation.v2");
  });

  it("carried envelopes satisfy the schema's required fields and patterns", () => {
    const envelope = carriedEnvelope() as unknown as Record<string, unknown>;
    for (const field of normativeSchema.required) {
      expect(envelope).toHaveProperty(field);
    }
    for (const [field, rule] of Object.entries(normativeSchema.properties)) {
      const value = envelope[field];
      if (value === null || value === undefined || rule.pattern === undefined) continue;
      expect(String(value)).toMatch(new RegExp(rule.pattern));
    }
  });

  it("paseo_agent_id and paseo_server_id are contract-defined plane_identity keys", () => {
    const defined = Object.keys(normativeSchema.properties.plane_identity.properties);
    expect(defined).toContain("paseo_agent_id");
    expect(defined).toContain("paseo_server_id");
  });
});

describe("correlationEnvelopeFromUnknown (opaque carry)", () => {
  it("carries the envelope as-given and preserves unknown top-level fields", () => {
    const envelope = carriedEnvelope();
    expect(envelope.future_field).toBe("preserved");
    expect(envelope.execution_binding_id).toBe(ANVIL_BINDING_ID);
    expect(envelope.binding_generation).toBe(4);
  });

  it("carries unknown schema versions opaquely instead of rejecting them", () => {
    const envelope = correlationEnvelopeFromUnknown({
      schema: "anvil.correlation.v9",
      correlation_id: null,
      producer: "hub:control",
      observed_at: "2026-09-23T21:42:00.123Z",
    });
    expect(envelope).not.toBeNull();
    expect(envelope!.schema).toBe("anvil.correlation.v9");
  });

  it("carries unknown schemas VERBATIM even when field types differ from v2", () => {
    // A future schema may type fields differently — the carrier must not
    // shape-check anything it does not know. Verbatim means verbatim.
    const raw = {
      schema: "anvil.correlation.v9",
      binding_generation: "four",
      plane_identity: ["not", "an", "object"],
      brand_new_field: { nested: [1, 2, 3] },
    };
    const envelope = correlationEnvelopeFromUnknown(raw);
    expect(envelope).not.toBeNull();
    expect(envelope).toEqual(raw);
  });

  it("carries a missing/non-string schema opaquely — never inferred", () => {
    const raw = { correlation_id: ANVIL_CORRELATION_ID, whatever: true };
    expect(correlationEnvelopeFromUnknown(raw)).toEqual(raw);
  });

  it("drops a KNOWN-schema envelope with malformed field types to null", () => {
    // v2 is the known contract: shape violations are malformed, not carried.
    expect(
      correlationEnvelopeFromUnknown({
        schema: "anvil.correlation.v2",
        correlation_id: ANVIL_CORRELATION_ID,
        producer: "hub:control",
        observed_at: "2026-09-23T21:42:00.123Z",
        binding_generation: "four",
      }),
    ).toBeNull();
  });

  it("drops non-objects to null — never repaired, never minted", () => {
    expect(correlationEnvelopeFromUnknown(null)).toBeNull();
    expect(correlationEnvelopeFromUnknown("envelope")).toBeNull();
    expect(correlationEnvelopeFromUnknown(42)).toBeNull();
    expect(correlationEnvelopeFromUnknown([{ schema: "anvil.correlation.v2" }])).toBeNull();
  });
});

describe("withPaseoPlaneIdentity (new observation)", () => {
  it("adds only the two native Paseo ids; ANVIL fields pass through byte-identical", () => {
    const before = carriedEnvelope();
    const after = withPaseoPlaneIdentity(before, {
      paseo_agent_id: PASEO_AGENT_ID,
      paseo_server_id: PASEO_SERVER_ID,
    });
    expect(after).not.toBeNull();
    expect(after!.schema).toBe(before.schema);
    expect(after!.correlation_id).toBe(before.correlation_id);
    expect(after!.execution_id).toBe(ANVIL_EXECUTION_ID);
    expect(after!.execution_binding_id).toBe(ANVIL_BINDING_ID);
    expect(after!.binding_generation).toBe(4);
    expect(after!.plane_identity).toEqual({
      control_operation_id: "op-1",
      hub_execution_id: HUB_EXECUTION_ID,
      paseo_agent_id: PASEO_AGENT_ID,
      paseo_server_id: PASEO_SERVER_ID,
    });
    // Unknown top-level fields still survive the merge.
    expect((after as Record<string, unknown>)["future_field"]).toBe("preserved");
  });

  it("never maps the Hub-owned executionId into execution_id", () => {
    const after = withPaseoPlaneIdentity(carriedEnvelope(), {
      paseo_agent_id: PASEO_AGENT_ID,
      paseo_server_id: PASEO_SERVER_ID,
    });
    expect(after!.execution_id).toBe(ANVIL_EXECUTION_ID);
    expect(after!.execution_id).not.toBe(HUB_EXECUTION_ID);
    expect(after!.plane_identity?.["hub_execution_id"]).toBe(HUB_EXECUTION_ID);
  });

  it("never introduces prompt-adjacent keys", () => {
    const after = withPaseoPlaneIdentity(carriedEnvelope(), {
      paseo_agent_id: PASEO_AGENT_ID,
      paseo_server_id: PASEO_SERVER_ID,
    }) as unknown as Record<string, unknown>;
    for (const banned of ["prompt", "messages", "tool_args", "content", "input"]) {
      expect(after).not.toHaveProperty(banned);
    }
  });

  it("absent stays absent — Paseo never mints an envelope", () => {
    expect(
      withPaseoPlaneIdentity(null, {
        paseo_agent_id: PASEO_AGENT_ID,
        paseo_server_id: PASEO_SERVER_ID,
      }),
    ).toBeNull();
    expect(
      withPaseoPlaneIdentity(undefined, {
        paseo_agent_id: PASEO_AGENT_ID,
        paseo_server_id: PASEO_SERVER_ID,
      }),
    ).toBeNull();
  });
});

describe("hub execution message wire compat", () => {
  it("create.request accepts an optional inbound envelope and preserves unknown fields", () => {
    const parsed = HubExecutionAgentCreateRequestSchema.parse({
      type: "hub.execution.agent.create.request",
      requestId: "r-1",
      executionId: HUB_EXECUTION_ID,
      provider: "codex",
      cwd: "/tmp",
      prompt: "do the thing",
      correlation: {
        schema: "anvil.correlation.v2",
        correlation_id: ANVIL_CORRELATION_ID,
        producer: "hub:control",
        observed_at: "2026-09-23T21:42:00.123Z",
        future_field: "preserved",
      },
    });
    expect(parsed.correlation?.correlation_id).toBe(ANVIL_CORRELATION_ID);
    expect((parsed.correlation as Record<string, unknown>)["future_field"]).toBe("preserved");
    // The prompt stays on the message — it never enters the envelope.
    expect(parsed.prompt).toBe("do the thing");
    expect(parsed.correlation).not.toHaveProperty("prompt");
  });

  it("create.request carries an unknown-schema envelope opaquely through the wire gate", () => {
    const parsed = HubExecutionAgentCreateRequestSchema.parse({
      type: "hub.execution.agent.create.request",
      requestId: "r-9",
      executionId: HUB_EXECUTION_ID,
      provider: "codex",
      cwd: "/tmp",
      prompt: "do the thing",
      correlation: {
        schema: "anvil.correlation.v9",
        binding_generation: "four",
        brand_new_field: { nested: [1, 2, 3] },
      },
    });
    const carried = parsed.correlation as unknown as Record<string, unknown>;
    expect(carried["schema"]).toBe("anvil.correlation.v9");
    expect(carried["binding_generation"]).toBe("four");
    expect(carried["brand_new_field"]).toEqual({ nested: [1, 2, 3] });
  });

  it("create.request rejects a malformed KNOWN-schema envelope at the wire gate", () => {
    expect(() =>
      HubExecutionAgentCreateRequestSchema.parse({
        type: "hub.execution.agent.create.request",
        requestId: "r-9",
        executionId: HUB_EXECUTION_ID,
        provider: "codex",
        cwd: "/tmp",
        prompt: "do the thing",
        correlation: {
          schema: "anvil.correlation.v2",
          correlation_id: ANVIL_CORRELATION_ID,
          producer: "hub:control",
          observed_at: "2026-09-23T21:42:00.123Z",
          binding_generation: "four",
        },
      }),
    ).toThrow();
  });

  it("create.request rejects a non-object correlation at the wire gate", () => {
    expect(() =>
      HubExecutionAgentCreateRequestSchema.parse({
        type: "hub.execution.agent.create.request",
        requestId: "r-9",
        executionId: HUB_EXECUTION_ID,
        provider: "codex",
        cwd: "/tmp",
        prompt: "do the thing",
        correlation: "envelope",
      }),
    ).toThrow();
  });

  it("create.request without a correlation still parses (backward compatible)", () => {
    const parsed = HubExecutionAgentCreateRequestSchema.parse({
      type: "hub.execution.agent.create.request",
      requestId: "r-1",
      executionId: HUB_EXECUTION_ID,
      provider: "codex",
      cwd: "/tmp",
      prompt: "do the thing",
    });
    expect(parsed.correlation).toBeUndefined();
  });

  it("agent.update carries the envelope as parsed by the carrier schema", () => {
    const envelope = withPaseoPlaneIdentity(carriedEnvelope(), {
      paseo_agent_id: PASEO_AGENT_ID,
      paseo_server_id: PASEO_SERVER_ID,
    });
    const parsed = HubExecutionAgentUpdateSchema.parse({
      type: "hub.execution.agent.update",
      payload: {
        executionId: HUB_EXECUTION_ID,
        agentId: PASEO_AGENT_ID,
        agent: {
          id: PASEO_AGENT_ID,
          provider: "codex",
          cwd: "/workspace",
          model: null,
          createdAt: "2026-09-23T21:42:00.123Z",
          updatedAt: "2026-09-23T21:42:00.123Z",
          lastUserMessageAt: null,
          status: "running",
          capabilities: {
            supportsStreaming: true,
            supportsSessionPersistence: true,
            supportsDynamicModes: true,
            supportsMcpServers: false,
            supportsReasoningStream: true,
            supportsToolInvocations: true,
            supportsRewindConversation: false,
            supportsRewindFiles: false,
            supportsRewindBoth: false,
          },
          currentModeId: null,
          availableModes: [],
          pendingPermissions: [],
          persistence: null,
          title: null,
          labels: {},
        },
        correlation: envelope,
      },
    });
    expect(parsed.payload.correlation?.plane_identity?.["paseo_agent_id"]).toBe(PASEO_AGENT_ID);
    expect(CorrelationEnvelopeSchema.parse(parsed.payload.correlation ?? null)).toBeTruthy();
  });
});

describe("outbound backward compatibility (pre-field messages still parse)", () => {
  const baseUpdatePayload = {
    executionId: HUB_EXECUTION_ID,
    agentId: PASEO_AGENT_ID,
    agent: {
      id: PASEO_AGENT_ID,
      provider: "codex",
      cwd: "/workspace",
      model: null,
      createdAt: "2026-09-23T21:42:00.123Z",
      updatedAt: "2026-09-23T21:42:00.123Z",
      lastUserMessageAt: null,
      status: "running",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: false,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    },
  };

  it("agent.update written before the field existed parses with correlation undefined", () => {
    const parsed = HubExecutionAgentUpdateSchema.parse({
      type: "hub.execution.agent.update",
      payload: baseUpdatePayload,
    });
    expect(parsed.payload.correlation).toBeUndefined();
  });

  it("agent.update with explicit null correlation still parses", () => {
    const parsed = HubExecutionAgentUpdateSchema.parse({
      type: "hub.execution.agent.update",
      payload: { ...baseUpdatePayload, correlation: null },
    });
    expect(parsed.payload.correlation).toBeNull();
  });
});
