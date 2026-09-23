/**
 * Correlation Envelope V1 (wire `anvil.correlation.v2`) — Paseo carrier.
 *
 * Paseo is a CARRIER, never a minter: envelopes arrive from the owning plane
 * (Hub) on inbound execution messages and are carried verbatim with the
 * daemon's execution ownership. Paseo never invents, infers, repairs,
 * increments, maps, or advances ANVIL binding fields, and never derives ANVIL
 * identity from the Hub-owned executionId — the two namespaces stay split.
 *
 * When Paseo produces a new observation (owned snapshot / stream event) it
 * adds ONLY its plane-native ids to `plane_identity`:
 *   - paseo_agent_id  (the daemon's agent id)
 *   - paseo_server_id (the stable daemon server id)
 *
 * Unknown top-level fields are preserved (passthrough); unknown schema
 * versions are carried opaquely. Absent stays absent: with no inbound
 * envelope Paseo emits null, never a minted one.
 */
import { z } from "zod";

/** Wire schema identifier for Correlation Envelope V1. */
export const CORRELATION_ENVELOPE_WIRE_SCHEMA = "anvil.correlation.v2" as const;

/**
 * Carrier-shape schema: accepts the envelope as-given, preserves unknown
 * top-level fields and unknown plane_identity keys. This is intentionally NOT
 * a strict validator — strictness belongs to the normative JSON Schema
 * (./correlation-envelope-v1.schema.json), exercised by the boundary test.
 * Rejecting a well-formed-but-unknown envelope would break the carry.
 */
export const CorrelationEnvelopeSchema = z
  .object({
    schema: z.string(),
    correlation_id: z.string().nullable().optional(),
    causation_id: z.string().nullable().optional(),
    campaign_id: z.string().nullable().optional(),
    task_ref: z.string().nullable().optional(),
    execution_id: z.string().nullable().optional(),
    execution_binding_id: z.string().nullable().optional(),
    binding_generation: z.number().nullable().optional(),
    producer: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    idempotency_key: z.string().nullable().optional(),
    source_ref: z.string().nullable().optional(),
    plane_identity: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export type CorrelationEnvelope = z.infer<typeof CorrelationEnvelopeSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept an inbound envelope opaquely, in two tiers:
 *
 * - Known contract (`schema === "anvil.correlation.v2"`): shape-checked
 *   against the carrier schema; a present-but-malformed value drops to null,
 *   never repaired.
 * - Unknown (or missing/non-string) schema: carried VERBATIM as a plain
 *   object — never shape-checked, never repaired. Rejecting a
 *   well-formed-but-unknown envelope would break the carry.
 *
 * Non-objects are dropped rather than repaired.
 */
export function correlationEnvelopeFromUnknown(value: unknown): CorrelationEnvelope | null {
  if (!isPlainObject(value)) return null;
  if (value.schema !== CORRELATION_ENVELOPE_WIRE_SCHEMA) {
    return value as CorrelationEnvelope;
  }
  const parsed = CorrelationEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Two-tier wire schema for the `correlation` field on execution messages.
 *
 * - Known contract (`schema === "anvil.correlation.v2"`): carrier-shape
 *   checked — a present-but-malformed value fails the message parse, never
 *   repaired.
 * - Unknown (or missing/non-string) schema: passes unchanged as a plain
 *   object — carried opaquely, never shape-checked.
 * - Non-objects are rejected.
 *
 * The value passes through unmodified; consumers apply
 * `correlationEnvelopeFromUnknown` as the explicit post-validation pass.
 * zod-aot compiles this node via its Zod fallback (partial fallback keeps
 * the rest of the message compiled).
 */
export const CarrierCorrelationSchema = z.custom<CorrelationEnvelope | null>(
  (value) => {
    if (value === null || value === undefined) return true;
    if (!isPlainObject(value)) return false;
    if (value["schema"] === CORRELATION_ENVELOPE_WIRE_SCHEMA) {
      return CorrelationEnvelopeSchema.safeParse(value).success;
    }
    return true;
  },
  { message: "correlation must be a Correlation Envelope object when present" },
);

/**
 * Merge Paseo's plane-native ids into a carried envelope for a new
 * observation. ANVIL fields are preserved byte-identical; only
 * `plane_identity` gains the two native keys. Absent stays absent.
 */
export function withPaseoPlaneIdentity(
  envelope: CorrelationEnvelope | null | undefined,
  ids: { paseo_agent_id: string; paseo_server_id: string },
): CorrelationEnvelope | null {
  if (!envelope) return null;
  const existing =
    envelope.plane_identity && isPlainObject(envelope.plane_identity)
      ? envelope.plane_identity
      : {};
  return {
    ...envelope,
    plane_identity: {
      ...existing,
      paseo_agent_id: ids.paseo_agent_id,
      paseo_server_id: ids.paseo_server_id,
    },
  };
}
