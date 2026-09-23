import { z } from "zod";
import type { CorrelationEnvelope } from "@getpaseo/protocol/correlation";

export const AgentOwnerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daemon"),
    daemonId: z.string(),
    executionId: z.string(),
    /**
     * Carried Correlation Envelope V1 for the owned execution (opaque,
     * as-given). Persisted with the ownership record so a daemon restart
     * keeps carrying it; null/absent = none received. Paseo never mints.
     * Unknown schema versions are carried opaquely — this field is a shape
     * gate only (plain object when present); consumers re-apply
     * correlationEnvelopeFromUnknown after parsing.
     */
    correlation: z
      .custom<CorrelationEnvelope | null>(
        (value) =>
          value === null ||
          value === undefined ||
          (typeof value === "object" && !Array.isArray(value)),
        { message: "correlation must be an object when present" },
      )
      .nullable()
      .optional(),
  }),
]);

export type AgentOwner = z.infer<typeof AgentOwnerSchema>;
export type DaemonAgentOwner = Extract<AgentOwner, { kind: "daemon" }>;

export function daemonExecutionKey(owner: DaemonAgentOwner): string {
  return `${owner.daemonId}\0${owner.executionId}`;
}
