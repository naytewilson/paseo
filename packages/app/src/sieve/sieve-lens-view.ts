import type { SieveLensStatus, SieveObservation } from "@getpaseo/protocol/messages";
import type { SieveLensUpdate } from "@getpaseo/client";

// ---------------------------------------------------------------------------
// Pure render-model for the SIEVE Lens screen. The screen keys entirely on the
// typed disposition — there is no path that renders measured-looking values
// the daemon did not send.
// ---------------------------------------------------------------------------

export type SieveLensRenderState =
  | { kind: "no_host" }
  // Connected, but the daemon predates the sieve.* surface.
  | { kind: "gate_update_host" }
  | { kind: "connecting" }
  | { kind: "status"; update: SieveLensUpdate };

export function resolveSieveLensRenderState(input: {
  serverId: string | null;
  isConnected: boolean;
  featureAdvertised: boolean | undefined;
  update: SieveLensUpdate | null;
}): SieveLensRenderState {
  if (!input.serverId) return { kind: "no_host" };
  if (!input.isConnected) return { kind: "connecting" };
  if (input.featureAdvertised !== true) return { kind: "gate_update_host" };
  if (!input.update) return { kind: "connecting" };
  return { kind: "status", update: input.update };
}

const UNAVAILABLE_REASON_LABELS: Record<string, string> = {
  no_feed_attached: "No SIEVE feed is attached to this daemon.",
  feed_unreachable: "The SIEVE feed is unreachable.",
  feed_disabled: "The SIEVE feed is disabled upstream.",
};

export function describeUnavailableReason(status: SieveLensStatus): string {
  if (status.state !== "unavailable") return "";
  const base = UNAVAILABLE_REASON_LABELS[status.reason] ?? `Unavailable (${status.reason}).`;
  return status.detail ? `${base} ${status.detail}` : base;
}

const UNIT_SUFFIX: Record<string, string> = {
  tokens: " tokens",
  bytes: " B",
  ratio: "",
  milliseconds: " ms",
  count: "",
};

export function formatObservation(observation: SieveObservation): string {
  const suffix = observation.unit ? (UNIT_SUFFIX[observation.unit] ?? ` ${observation.unit}`) : "";
  const value =
    observation.unit === "ratio" ? `${(observation.value * 100).toFixed(1)}%` : observation.value;
  return `${value}${suffix} · ${observation.provenance} · ${observation.observedAt}`;
}

export function formatMode(mode: string): string {
  return mode.replace(/_/g, " ");
}
