import { z } from "zod";

// ---------------------------------------------------------------------------
// SIEVE Lens — read-only operator surface for the SIEVE data plane.
//
// The daemon carries no SIEVE objects of its own. These schemas describe a
// projection an upstream authority plane (gateway / Chronicle) attaches through
// a feed the daemon does not yet ship. Every field that reports a measurement
// carries provenance and freshness so a client can distinguish measured from
// inferred, and absent fields mean never observed — nothing here defaults to a
// real-looking zero.
// ---------------------------------------------------------------------------

export const SieveModeSchema = z.enum(["pristine_lock", "observe", "shadow", "canary", "active"]);
export type SieveMode = z.infer<typeof SieveModeSchema>;

// How a reported value came to exist. `measured` is authoritative observation;
// `reported` is an upstream figure the daemon relays without re-deriving it;
// `estimated` and `inferred` are explicitly non-authoritative.
export const SieveProvenanceSchema = z.enum(["measured", "reported", "estimated", "inferred"]);
export type SieveProvenance = z.infer<typeof SieveProvenanceSchema>;

export const SieveObservationSchema = z.object({
  value: z.number(),
  unit: z.enum(["tokens", "bytes", "ratio", "milliseconds", "count"]).optional(),
  provenance: SieveProvenanceSchema,
  // ISO-8601 timestamp from the authority that produced the value — the wire
  // freshness marker. It is the upstream's clock, not the daemon's.
  observedAt: z.string(),
});
export type SieveObservation = z.infer<typeof SieveObservationSchema>;

export const SieveRunIdentitySchema = z.object({
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  nodeId: z.string().optional(),
});
export type SieveRunIdentity = z.infer<typeof SieveRunIdentitySchema>;

// Presented-vs-pristine accounting. Both sides are reported so a client never
// has to derive a savings figure the feed did not actually publish.
export const SieveSavingsSchema = z.object({
  pristineTokens: SieveObservationSchema.optional(),
  presentedTokens: SieveObservationSchema.optional(),
  savedTokens: SieveObservationSchema.optional(),
  savedRatio: SieveObservationSchema.optional(),
});
export type SieveSavings = z.infer<typeof SieveSavingsSchema>;

export const SieveCacheStateSchema = z.object({
  prefixRetainedRatio: SieveObservationSchema.optional(),
  divergences: SieveObservationSchema.optional(),
});
export type SieveCacheState = z.infer<typeof SieveCacheStateSchema>;

export const SieveFallbackSchema = z.object({
  state: z.enum(["none", "degraded", "emergency_pristine"]),
  reason: z.string().optional(),
});
export type SieveFallback = z.infer<typeof SieveFallbackSchema>;

export const SieveStatusSnapshotSchema = z.object({
  mode: SieveModeSchema.optional(),
  health: z.enum(["ok", "degraded", "fault"]).optional(),
  run: SieveRunIdentitySchema.optional(),
  savings: SieveSavingsSchema.optional(),
  cache: SieveCacheStateSchema.optional(),
  fallback: SieveFallbackSchema.optional(),
  overhead: SieveObservationSchema.optional(),
  integrityFaults: SieveObservationSchema.optional(),
});
export type SieveStatusSnapshot = z.infer<typeof SieveStatusSnapshotSchema>;

// The typed disposition every Lens surface keys on. `unavailable` means the
// daemon has no authoritative status — the reason says why. `degraded` carries
// whatever partial snapshot survives, labeled with `staleSince` so stale data
// is never presented as fresh. `ok` is the only state that asserts health.
export const SieveUnavailableReasonSchema = z.enum([
  "no_feed_attached",
  "feed_unreachable",
  "feed_disabled",
]);
export type SieveUnavailableReason = z.infer<typeof SieveUnavailableReasonSchema>;

export const SieveLensStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("unavailable"),
    reason: SieveUnavailableReasonSchema,
    detail: z.string().optional(),
  }),
  z.object({
    state: z.literal("degraded"),
    detail: z.string().optional(),
    staleSince: z.string().optional(),
    snapshot: SieveStatusSnapshotSchema.optional(),
  }),
  z.object({
    state: z.literal("ok"),
    snapshot: SieveStatusSnapshotSchema,
  }),
]);
export type SieveLensStatus = z.infer<typeof SieveLensStatusSchema>;

// Stream position for cursor-resumable subscriptions: an epoch identifies the
// stream generation (epoch change replaces state atomically) and seq is
// monotonic within it — the same contract family as timeline epoch/seq.
export const SieveStreamCursorSchema = z.object({
  epoch: z.string(),
  seq: z.number().int(),
});
export type SieveStreamCursor = z.infer<typeof SieveStreamCursorSchema>;

export const SieveStatusGetRequestSchema = z.object({
  type: z.literal("sieve.status.get.request"),
  requestId: z.string(),
});
export type SieveStatusGetRequest = z.infer<typeof SieveStatusGetRequestSchema>;

export const SieveStatusGetResponseSchema = z.object({
  type: z.literal("sieve.status.get.response"),
  payload: z.object({
    requestId: z.string(),
    status: SieveLensStatusSchema,
    // Daemon clock — when this disposition was produced, so a client can tell
    // a live `unavailable` from a cached one.
    observedAt: z.string(),
  }),
});
export type SieveStatusGetResponse = z.infer<typeof SieveStatusGetResponseSchema>;
export type SieveStatusGetPayload = SieveStatusGetResponse["payload"];

export const SieveStatusSubscribeRequestSchema = z.object({
  type: z.literal("sieve.status.subscribe.request"),
  requestId: z.string(),
  // Resume position from a previous subscription. Omitted means "from now".
  after: SieveStreamCursorSchema.optional(),
});
export type SieveStatusSubscribeRequest = z.infer<typeof SieveStatusSubscribeRequestSchema>;

export const SieveStatusSubscribeResponseSchema = z.object({
  type: z.literal("sieve.status.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    // With no feed attached the daemon refuses the subscription in-band rather
    // than holding phantom membership — `accepted:false` plus the same honest
    // status a `get` would return.
    accepted: z.boolean(),
    subscriptionId: z.string().optional(),
    cursor: SieveStreamCursorSchema.optional(),
    status: SieveLensStatusSchema,
    observedAt: z.string(),
  }),
});
export type SieveStatusSubscribeResponse = z.infer<typeof SieveStatusSubscribeResponseSchema>;
export type SieveStatusSubscribePayload = SieveStatusSubscribeResponse["payload"];

export const SieveStatusUnsubscribeRequestSchema = z.object({
  type: z.literal("sieve.status.unsubscribe.request"),
  requestId: z.string(),
  subscriptionId: z.string(),
});
export type SieveStatusUnsubscribeRequest = z.infer<typeof SieveStatusUnsubscribeRequestSchema>;

export const SieveStatusUnsubscribeResponseSchema = z.object({
  type: z.literal("sieve.status.unsubscribe.response"),
  payload: z.object({
    requestId: z.string(),
    released: z.boolean(),
  }),
});
export type SieveStatusUnsubscribeResponse = z.infer<typeof SieveStatusUnsubscribeResponseSchema>;
export type SieveStatusUnsubscribePayload = SieveStatusUnsubscribeResponse["payload"];

export const SieveStatusEventSchema = z.object({
  type: z.literal("sieve.status.event"),
  payload: z.object({
    subscriptionId: z.string(),
    cursor: SieveStreamCursorSchema,
    status: SieveLensStatusSchema,
    observedAt: z.string(),
  }),
});
export type SieveStatusEvent = z.infer<typeof SieveStatusEventSchema>;
