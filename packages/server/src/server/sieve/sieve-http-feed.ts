import { randomUUID } from "node:crypto";
import type pino from "pino";
import type {
  SieveLensStatus,
  SieveObservation,
  SieveProvenance,
  SieveSavings,
  SieveStatusSnapshot,
  SieveStreamCursor,
} from "../messages.js";
import type { SieveLensFeed, SieveLensFeedSnapshot, SieveLensFeedSubscription } from "./feed.js";

/**
 * Concrete SieveLensFeed: a read-only HTTP adapter over the SIEVE daemon's own
 * control surface. It polls exactly one route — GET /sieve/stats — which SIEVE
 * answers locally with its measured telemetry aggregate. The adapter shapes
 * and labels those facts into Lens status objects; it never mints them. Fields
 * with no authoritative source stay absent.
 *
 * Authority discipline:
 * - The URL path is fixed at construction. No caller input reaches the request
 *   line, so the adapter can never be coerced into /sieve/config, /sieve/audit,
 *   or any mutation route.
 * - No credentials are sent. The SIEVE read surface is loopback and unauthenti-
 *   cated by design; there is nothing to prove and nothing to send.
 * - Per-observation `observedAt` is the upstream clock: the HTTP Date header on
 *   the stats response, emitted by SIEVE's own server. A response without a
 *   parseable Date header is malformed and fails closed.
 * - The snapshot-level `observedAt` is the adapter's own clock — the moment
 *   this daemon produced the disposition — kept distinct from upstream time.
 *
 * Stream contract: epoch is minted per feed instance (daemon restart replaces
 * state atomically under a new epoch); seq is monotonic within it. Every
 * completed poll produces one stream event — a real authority observation —
 * appended to a bounded replay buffer so a resumed subscription dedupes by
 * cursor instead of re-seeing events.
 *
 * Demand: the poll loop runs only while at least one subscription exists. A
 * bare getStatus() performs a one-shot read rather than spinning the loop.
 */

export interface SieveHttpLensFeedOptions {
  /** e.g. "http://127.0.0.1:8899" — any path component is replaced by the fixed route. */
  baseUrl: string;
  logger: pino.Logger;
  fetchImpl?: typeof fetch;
  /** Millisecond clock; injectable for tests. */
  now?: () => number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  replayBufferSize?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;
const DEFAULT_REPLAY_BUFFER_SIZE = 256;
const MIN_POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

type SieveStatsFetchOutcome =
  | { ok: true; body: SieveStatsBody; upstreamAt: string }
  | { ok: false; reason: string };

/** The subset of the /sieve/stats payload this adapter reads. */
interface SieveStatsBody {
  ok: boolean;
  today?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSieveStatsBody(value: unknown): value is SieveStatsBody {
  return isRecord(value) && value.ok === true && isRecord(value.today);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a SIEVE `{ value, status, source }` wrapped measurement, accepting it
 * only when its label matches `expectedStatus`. An UNMEASURED or relabeled
 * figure yields null — the field then stays absent.
 */
function labeledNumber(value: unknown, expectedStatus: string): number | null {
  if (!isRecord(value) || value.status !== expectedStatus) return null;
  return numberOrNull(value.value);
}

export class SieveHttpLensFeed implements SieveLensFeed {
  private readonly statsUrl: string;
  private readonly logger: pino.Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly replayBufferSize: number;
  private readonly epoch = randomUUID();
  private seq = 0;
  private readonly subscriptions = new Map<string, (event: SieveLensFeedSnapshot) => void>();
  private readonly replay: SieveLensFeedSnapshot[] = [];
  private current: SieveLensFeedSnapshot | null = null;
  private lastGood: { snapshot: SieveStatusSnapshot; upstreamAt: string } | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight: Promise<SieveLensFeedSnapshot> | null = null;
  private abortPoll: (() => void) | null = null;
  private stopped = false;

  constructor(options: SieveHttpLensFeedOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new Error(`Invalid SIEVE baseUrl "${options.baseUrl}" — expected an http(s) URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Invalid SIEVE baseUrl "${options.baseUrl}" — only http(s) endpoints are supported.`,
      );
    }
    // The route is owned by this adapter, not by configuration — /sieve/stats
    // is the only surface it may read.
    this.statsUrl = new URL("/sieve/stats", parsed).toString();
    this.logger = options.logger.child({ module: "sieve-http-feed" });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.replayBufferSize = Math.max(1, options.replayBufferSize ?? DEFAULT_REPLAY_BUFFER_SIZE);
  }

  async getStatus(): Promise<SieveLensFeedSnapshot> {
    this.assertRunning();
    // While subscriptions keep the loop alive, the head of the stream is at
    // most one poll old — returning it is fresher than a second fetch. With no
    // demand, or before the first poll lands, do a one-shot read.
    if (this.current && this.subscriptions.size > 0) {
      return this.current;
    }
    return this.pollOnce();
  }

  async subscribe(params: {
    after?: SieveStreamCursor;
    onEvent: (event: SieveLensFeedSnapshot) => void;
  }): Promise<SieveLensFeedSubscription> {
    this.assertRunning();
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, params.onEvent);
    // Same-epoch resume replays strictly-after-cursor events. A foreign epoch
    // gets no replay: the subscribe response's status + cursor replace the
    // client's stream position atomically.
    if (params.after && params.after.epoch === this.epoch) {
      for (const event of this.replay) {
        if (event.cursor.seq > params.after.seq) {
          try {
            params.onEvent(event);
          } catch (error) {
            this.logger.warn({ err: error }, "SIEVE subscriber callback threw during replay");
          }
        }
      }
    }
    this.ensurePolling();
    return { subscriptionId, cursor: this.headCursor() };
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptions.size === 0) {
      this.pausePolling();
    }
  }

  /** Stop the loop and release every subscription. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.pausePolling();
    this.subscriptions.clear();
    this.abortPoll?.();
  }

  /**
   * Force one poll cycle now. Concurrent callers share the in-flight request —
   * the loop, getStatus(), and tests can never double-fetch the same instant.
   */
  async pollOnce(): Promise<SieveLensFeedSnapshot> {
    this.assertRunning();
    if (this.pollInFlight) {
      return this.pollInFlight;
    }
    const run = this.executePoll();
    this.pollInFlight = run;
    try {
      return await run;
    } finally {
      this.pollInFlight = null;
    }
  }

  /** Every completed poll is one stream event: observed, sequenced, replayable. */
  private async executePoll(): Promise<SieveLensFeedSnapshot> {
    const status = await this.readStatus();
    const snapshot: SieveLensFeedSnapshot = {
      status,
      cursor: { epoch: this.epoch, seq: ++this.seq },
      observedAt: new Date(this.now()).toISOString(),
    };
    this.current = snapshot;
    this.replay.push(snapshot);
    if (this.replay.length > this.replayBufferSize) {
      this.replay.shift();
    }
    for (const onEvent of this.subscriptions.values()) {
      try {
        onEvent(snapshot);
      } catch (error) {
        this.logger.warn({ err: error }, "SIEVE subscriber callback threw");
      }
    }
    return snapshot;
  }

  private async readStatus(): Promise<SieveLensStatus> {
    const outcome = await this.fetchStats();
    if (!outcome.ok) {
      return this.failureStatus(outcome.reason);
    }
    const snapshot = mapStatsToSnapshot(outcome.body, outcome.upstreamAt);
    this.lastGood = { snapshot, upstreamAt: outcome.upstreamAt };
    return { state: "ok", snapshot };
  }

  /**
   * Fail closed. With no prior authoritative observation the Lens is
   * unavailable; with one it is degraded — the last-good snapshot survives,
   * labeled stale since its own upstream observation time.
   */
  private failureStatus(reason: string): SieveLensStatus {
    if (this.lastGood) {
      return {
        state: "degraded",
        detail: reason,
        staleSince: this.lastGood.upstreamAt,
        snapshot: this.lastGood.snapshot,
      };
    }
    return { state: "unavailable", reason: "feed_unreachable", detail: reason };
  }

  private async fetchStats(): Promise<SieveStatsFetchOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    this.abortPoll = () => controller.abort();
    try {
      const response = await this.fetchImpl(this.statsUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, reason: `SIEVE answered HTTP ${response.status}` };
      }
      // The upstream timestamp is SIEVE's own HTTP Date header — the only
      // observation-time authority on this surface. Absent or unparseable is
      // malformed, not an excuse to stamp the daemon's clock as upstream time.
      const upstreamMs = Date.parse(response.headers.get("date") ?? "");
      if (!Number.isFinite(upstreamMs)) {
        return { ok: false, reason: "SIEVE response lacks a parseable Date header" };
      }
      const advertised = Number(response.headers.get("content-length") ?? 0);
      if (advertised > MAX_BODY_BYTES) {
        return { ok: false, reason: "SIEVE response body exceeds the read bound" };
      }
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) {
        return { ok: false, reason: "SIEVE response body exceeds the read bound" };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, reason: "SIEVE response body is not JSON" };
      }
      if (!isSieveStatsBody(body)) {
        return { ok: false, reason: "SIEVE response is not a stats payload" };
      }
      return { ok: true, body, upstreamAt: new Date(upstreamMs).toISOString() };
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, reason: `SIEVE read timed out after ${this.requestTimeoutMs}ms` };
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
      this.abortPoll = null;
    }
  }

  private ensurePolling(): void {
    if (this.stopped || this.pollTimer || this.subscriptions.size === 0) {
      return;
    }
    this.pollTimer = setTimeout(() => this.tick(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private pausePolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private tick(): void {
    this.pollTimer = null;
    void this.pollOnce()
      .catch((error) => {
        this.logger.warn({ err: error }, "SIEVE poll failed");
      })
      .finally(() => {
        if (!this.stopped && this.subscriptions.size > 0) {
          this.pollTimer = setTimeout(() => this.tick(), this.pollIntervalMs);
          this.pollTimer.unref?.();
        }
      });
  }

  private headCursor(): SieveStreamCursor {
    return { epoch: this.epoch, seq: this.seq };
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("SIEVE feed is stopped");
    }
  }
}

// ---------------------------------------------------------------------------
// Stats → Lens projection. Every mapped field names its authoritative source;
// anything without one is omitted. SIEVE's own evidence labels drive Lens
// provenance: MEASURED → measured, ESTIMATED → estimated. Nothing is upgraded.
// ---------------------------------------------------------------------------

function observation(
  value: number,
  unit: SieveObservation["unit"],
  provenance: SieveProvenance,
  observedAt: string,
): SieveObservation {
  return { value, ...(unit ? { unit } : {}), provenance, observedAt };
}

function mapStatsToSnapshot(body: SieveStatsBody, upstreamAt: string): SieveStatusSnapshot {
  const today = body.today ?? {};
  const snapshot: SieveStatusSnapshot = { health: "ok" };

  const savings: SieveSavings = {};
  const tokensIn = numberOrNull(today.tokensIn);
  const tokensOut = numberOrNull(today.tokensOut);
  if (tokensIn !== null) {
    savings.pristineTokens = observation(tokensIn, "tokens", "measured", upstreamAt);
  }
  if (tokensOut !== null) {
    savings.presentedTokens = observation(tokensOut, "tokens", "measured", upstreamAt);
  }
  // Provider-measured savings win. SIEVE's explicitly-labeled chars÷4 estimate
  // is the only fallback — it lands labeled `estimated`, never dressed as
  // measured, and never displaces a real measurement.
  const measuredSaved = labeledNumber(today.tokensRemoved, "MEASURED");
  if (measuredSaved !== null) {
    savings.savedTokens = observation(measuredSaved, "tokens", "measured", upstreamAt);
  } else {
    const estimatedSaved = labeledNumber(today.roughTokenProxy, "ESTIMATED");
    if (estimatedSaved !== null) {
      savings.savedTokens = observation(estimatedSaved, "tokens", "estimated", upstreamAt);
    }
  }
  const savingsPct = numberOrNull(today.savingsPctTokens);
  if (savingsPct !== null) {
    savings.savedRatio = observation(savingsPct / 100, "ratio", "measured", upstreamAt);
  }
  if (Object.keys(savings).length > 0) {
    snapshot.savings = savings;
  }

  const autoFallbacks = numberOrNull(today.autoFallbacks);
  if (autoFallbacks !== null) {
    if (autoFallbacks > 0) {
      const reason = describeFallbackCounts(today.fallbackCounts);
      snapshot.fallback = { state: "degraded", ...(reason ? { reason } : {}) };
    } else {
      snapshot.fallback = { state: "none" };
    }
  }

  const overhead = labeledNumber(today.medianTransformOverheadMs, "MEASURED");
  if (overhead !== null) {
    snapshot.overhead = observation(overhead, "milliseconds", "measured", upstreamAt);
  }

  const violations = numberOrNull(today.exactValueViolations);
  if (violations !== null) {
    snapshot.integrityFaults = observation(violations, "count", "measured", upstreamAt);
  }

  return snapshot;
}

function describeFallbackCounts(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const parts = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([reason, count]) => `${reason} (${count})`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}
