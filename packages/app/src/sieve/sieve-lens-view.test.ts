import { describe, expect, it } from "vitest";
import type { SieveLensStatus } from "@getpaseo/protocol/messages";
import {
  describeUnavailableReason,
  formatObservation,
  resolveSieveLensRenderState,
} from "./sieve-lens-view";

const unavailable: SieveLensStatus = { state: "unavailable", reason: "no_feed_attached" };

describe("resolveSieveLensRenderState", () => {
  it("reports no host before any capability check", () => {
    expect(
      resolveSieveLensRenderState({
        serverId: null,
        isConnected: false,
        featureAdvertised: undefined,
        update: null,
      }),
    ).toEqual({ kind: "no_host" });
  });

  it("stays connecting until the session is connected", () => {
    expect(
      resolveSieveLensRenderState({
        serverId: "s1",
        isConnected: false,
        featureAdvertised: true,
        update: null,
      }),
    ).toEqual({ kind: "connecting" });
  });

  it("gates on features.sieveLens once connected", () => {
    expect(
      resolveSieveLensRenderState({
        serverId: "s1",
        isConnected: true,
        featureAdvertised: undefined,
        update: null,
      }),
    ).toEqual({ kind: "gate_update_host" });
    expect(
      resolveSieveLensRenderState({
        serverId: "s1",
        isConnected: true,
        featureAdvertised: false,
        update: null,
      }),
    ).toEqual({ kind: "gate_update_host" });
  });

  it("renders the typed status once advertised and received", () => {
    const update = { status: unavailable, observedAt: "2026-09-17T00:00:00Z" };
    expect(
      resolveSieveLensRenderState({
        serverId: "s1",
        isConnected: true,
        featureAdvertised: true,
        update,
      }),
    ).toEqual({ kind: "status", update });
  });
});

describe("describeUnavailableReason", () => {
  it("maps the typed reason to operator text", () => {
    expect(describeUnavailableReason(unavailable)).toContain("No SIEVE feed");
  });

  it("appends detail when the daemon provides it", () => {
    const withDetail: SieveLensStatus = {
      state: "unavailable",
      reason: "feed_unreachable",
      detail: "gateway handshake failed",
    };
    expect(describeUnavailableReason(withDetail)).toContain("gateway handshake failed");
  });
});

describe("formatObservation", () => {
  it("labels provenance and freshness explicitly", () => {
    expect(
      formatObservation({
        value: 1200,
        unit: "tokens",
        provenance: "measured",
        observedAt: "2026-09-17T00:00:00Z",
      }),
    ).toBe("1200 tokens · measured · 2026-09-17T00:00:00Z");
  });

  it("renders ratios as percentages", () => {
    expect(
      formatObservation({
        value: 0.42,
        unit: "ratio",
        provenance: "reported",
        observedAt: "t",
      }),
    ).toBe("42.0% · reported · t");
  });
});
