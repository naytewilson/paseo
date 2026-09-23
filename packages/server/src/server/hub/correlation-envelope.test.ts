/**
 * Strict boundary test: Correlation Envelope V1 against the NORMATIVE JSON
 * Schema, using ajv (already a server dependency).
 *
 * The vendored schema lives in @getpaseo/protocol
 * (./correlation-envelope-v1.schema.json, byte-identical to the frozen
 * contract artifact — proven by packages/protocol/src/correlation.test.ts).
 * This test proves a carried envelope — including one merged with Paseo's
 * plane-native ids — validates strictly, and that the schema's own
 * atomicity/pattern rules reject malformed envelopes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { withPaseoPlaneIdentity } from "@getpaseo/protocol/correlation";

/** sha256 of the frozen contract artifact ~/workspace/i5-wave/envelope/correlation-envelope-v1.schema.json */
const FROZEN_SCHEMA_SHA256 = "95d8e3108ca9c4c38d2c398e0c86cbca0ea6a54cd5b3f9b4f6c2d2188b0ea037";

const SCHEMA_PATH = new URL(
  "../../../../protocol/src/correlation-envelope-v1.schema.json",
  import.meta.url,
);
const SCHEMA_BYTES = readFileSync(SCHEMA_PATH);
const normativeSchema = JSON.parse(SCHEMA_BYTES.toString("utf8"));

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(normativeSchema);

function baseEnvelope() {
  return {
    schema: "anvil.correlation.v2",
    correlation_id: "22222222-2222-4222-8222-222222222222",
    causation_id: "hub:control:grant-1",
    campaign_id: null,
    task_ref: null,
    execution_id: "11111111-1111-4111-8111-111111111111",
    execution_binding_id: "33333333-3333-4333-8333-333333333333",
    binding_generation: 4,
    producer: "hub:control",
    observed_at: "2026-09-23T21:42:00.123Z",
    idempotency_key: "k-1",
    source_ref: "control_operations:op-1",
    plane_identity: { control_operation_id: "op-1" },
  };
}

describe("correlation envelope strict JSON Schema boundary", () => {
  it("vendored schema is byte-identical to the frozen contract artifact", () => {
    const digest = createHash("sha256").update(SCHEMA_BYTES).digest("hex");
    expect(digest).toBe(FROZEN_SCHEMA_SHA256);
  });

  it("accepts a carried envelope merged with Paseo plane-native ids", () => {
    const merged = withPaseoPlaneIdentity(baseEnvelope(), {
      paseo_agent_id: "agent-abc-123",
      paseo_server_id: "server-xyz-789",
    });
    expect(validate(merged)).toBe(true);
  });

  it("accepts unknown top-level fields (carriers preserve them)", () => {
    expect(validate({ ...baseEnvelope(), future_field: "preserved" })).toBe(true);
  });

  it("rejects a partial binding pair (atomicity)", () => {
    expect(validate({ ...baseEnvelope(), binding_generation: null })).toBe(false);
    expect(validate({ ...baseEnvelope(), execution_binding_id: null })).toBe(false);
  });

  it("rejects malformed uuid fields", () => {
    expect(validate({ ...baseEnvelope(), correlation_id: "not-a-uuid" })).toBe(false);
  });

  it("rejects a wrong schema const", () => {
    expect(validate({ ...baseEnvelope(), schema: "anvil.correlation.v9" })).toBe(false);
  });

  it("rejects a non-positive binding generation", () => {
    expect(validate({ ...baseEnvelope(), binding_generation: 0 })).toBe(false);
  });
});
