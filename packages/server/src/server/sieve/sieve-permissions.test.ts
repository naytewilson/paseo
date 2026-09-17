import { describe, expect, test } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { SessionAuthorization } from "../authorization/index.js";
import {
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "../authorization/operation-permissions.js";

const SIEVE_INBOUND = [
  "sieve.status.get.request",
  "sieve.status.subscribe.request",
  "sieve.status.unsubscribe.request",
] as const;

const SIEVE_OUTBOUND = [
  "sieve.status.get.response",
  "sieve.status.subscribe.response",
  "sieve.status.unsubscribe.response",
  "sieve.status.event",
] as const;

describe("sieve.* permission classification", () => {
  test("every sieve.* operation is classified, never null", () => {
    for (const type of SIEVE_INBOUND) {
      expect(requiredPermissionForInbound(type)).toBe("daemon.read");
    }
    for (const type of SIEVE_OUTBOUND) {
      expect(requiredPermissionForOutbound({ type } as SessionOutboundMessage)).toBe("daemon.read");
    }
  });

  test("daemon.read sessions may read the Lens; unrelated sessions may not", () => {
    const reader = new SessionAuthorization(["daemon.read"]);
    const other = new SessionAuthorization(["workspace.read"]);

    for (const type of SIEVE_INBOUND) {
      expect(reader.allowsInbound({ type } as SessionInboundMessage)).toBe(true);
      expect(other.allowsInbound({ type } as SessionInboundMessage)).toBe(false);
    }
    for (const type of SIEVE_OUTBOUND) {
      const message = { type } as SessionOutboundMessage;
      expect(reader.allowsOutbound(message)).toBe(true);
      expect(other.allowsOutbound(message)).toBe(false);
    }
  });
});
