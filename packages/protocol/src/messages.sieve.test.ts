import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  SieveLensStatusSchema,
  SieveStatusEventSchema,
  SieveStatusGetRequestSchema,
  SieveStatusGetResponseSchema,
  SieveStatusSubscribeRequestSchema,
  SieveStatusSubscribeResponseSchema,
  SieveStatusUnsubscribeRequestSchema,
  SieveStatusUnsubscribeResponseSchema,
} from "./messages.js";

const unavailableStatus = {
  state: "unavailable" as const,
  reason: "no_feed_attached" as const,
};

const okStatus = {
  state: "ok" as const,
  snapshot: {
    mode: "observe" as const,
    health: "ok" as const,
    run: { runId: "run_1", sessionId: "sess_1", agentId: "agent_1" },
    savings: {
      pristineTokens: {
        value: 100000,
        unit: "tokens" as const,
        provenance: "measured" as const,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
      presentedTokens: {
        value: 40000,
        unit: "tokens" as const,
        provenance: "measured" as const,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
      savedRatio: {
        value: 0.6,
        unit: "ratio" as const,
        provenance: "reported" as const,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
    },
    cache: {
      prefixRetainedRatio: {
        value: 0.95,
        unit: "ratio" as const,
        provenance: "measured" as const,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
    },
    fallback: { state: "none" as const },
  },
};

describe("sieve.status.get", () => {
  test("request round-trips through the inbound union", () => {
    const message = { type: "sieve.status.get.request", requestId: "req_1" };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
    expect(SieveStatusGetRequestSchema.parse(message)).toEqual(message);
  });

  test("response carries the typed unavailable disposition through the outbound union", () => {
    const message = {
      type: "sieve.status.get.response",
      payload: {
        requestId: "req_1",
        status: unavailableStatus,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(SieveStatusGetResponseSchema.parse(message)).toEqual(message);
  });

  test("response carries a full snapshot when the feed reports ok", () => {
    const message = {
      type: "sieve.status.get.response",
      payload: {
        requestId: "req_1",
        status: okStatus,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

describe("sieve.status.subscribe", () => {
  test("request accepts an optional resume cursor", () => {
    const bare = { type: "sieve.status.subscribe.request", requestId: "req_2" };
    const resumed = {
      type: "sieve.status.subscribe.request",
      requestId: "req_2",
      after: { epoch: "epoch-1", seq: 42 },
    };
    expect(SessionInboundMessageSchema.parse(bare)).toEqual(bare);
    expect(SieveStatusSubscribeRequestSchema.parse(resumed)).toEqual(resumed);
  });

  test("refused subscription is a typed disposition, not an error", () => {
    const message = {
      type: "sieve.status.subscribe.response",
      payload: {
        requestId: "req_2",
        accepted: false,
        status: unavailableStatus,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(SieveStatusSubscribeResponseSchema.parse(message)).toEqual(message);
  });

  test("accepted subscription reports subscription id and stream cursor", () => {
    const message = {
      type: "sieve.status.subscribe.response",
      payload: {
        requestId: "req_2",
        accepted: true,
        subscriptionId: "sub_1",
        cursor: { epoch: "epoch-1", seq: 42 },
        status: okStatus,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

describe("sieve.status.unsubscribe", () => {
  test("pair round-trips through both unions", () => {
    const request = {
      type: "sieve.status.unsubscribe.request",
      requestId: "req_3",
      subscriptionId: "sub_1",
    };
    const response = {
      type: "sieve.status.unsubscribe.response",
      payload: { requestId: "req_3", released: true },
    };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    expect(SieveStatusUnsubscribeRequestSchema.parse(request)).toEqual(request);
    expect(SieveStatusUnsubscribeResponseSchema.parse(response)).toEqual(response);
  });
});

describe("sieve.status.event", () => {
  test("stream event carries cursor and status through the outbound union", () => {
    const message = {
      type: "sieve.status.event",
      payload: {
        subscriptionId: "sub_1",
        cursor: { epoch: "epoch-1", seq: 43 },
        status: okStatus,
        observedAt: "2026-09-17T00:00:00.000Z",
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(SieveStatusEventSchema.parse(message)).toEqual(message);
  });
});

describe("SieveLensStatusSchema", () => {
  test("a bare unavailable disposition parses; fabricated counters are absent by construction", () => {
    const parsed = SieveLensStatusSchema.parse(unavailableStatus);
    expect(parsed.state).toBe("unavailable");
    expect("snapshot" in parsed).toBe(false);
  });

  test("degraded carries an optional partial snapshot and stale marker", () => {
    const parsed = SieveLensStatusSchema.parse({
      state: "degraded",
      staleSince: "2026-09-17T00:00:00.000Z",
      snapshot: { health: "degraded" },
    });
    expect(parsed.state).toBe("degraded");
  });

  test("observations require provenance and freshness", () => {
    expect(
      SieveLensStatusSchema.safeParse({
        state: "ok",
        snapshot: { savings: { savedTokens: { value: 12 } } },
      }).success,
    ).toBe(false);
  });
});
