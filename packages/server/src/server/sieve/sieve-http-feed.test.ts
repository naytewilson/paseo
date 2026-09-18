import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SieveLensStatus, SieveStreamCursor } from "../messages.js";
import type { SieveLensFeedSnapshot } from "./feed.js";
import { SieveHttpLensFeed } from "./sieve-http-feed.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const logger = {
  child: () => logger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as import("pino").Logger;

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
}

interface StubSieve {
  baseUrl: string;
  requests: RecordedRequest[];
  respond: (req: IncomingMessage, res: ServerResponse) => void;
  setRespond(fn: (req: IncomingMessage, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

/** A real loopback HTTP server standing in for SIEVE's control surface. */
async function startStubSieve(
  initial: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<StubSieve> {
  const requests: RecordedRequest[] = [];
  let respond = initial;
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stub sieve did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    get respond() {
      return respond;
    },
    setRespond(fn) {
      respond = fn;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/** The real /sieve/stats payload shape (measured window with real traffic). */
function healthyStatsBody() {
  return {
    ok: true,
    port: 8899,
    upstream: "",
    uptimeMs: 4321,
    today: {
      requests: 3,
      syntheticDropped: 0,
      tokensIn: 50_000,
      tokensOut: 48_800,
      savedTokens: 1_200,
      savingsPctTokens: 2.4,
      tokensRemoved: { value: 1_200, status: "MEASURED", source: "provider_count_tokens" },
      roughTokenProxy: { value: null, status: "UNMEASURED", source: "no_char_savings_for_proxy" },
      charsSaved: { value: 9_000, status: "OBSERVED", source: "event.characters_saved" },
      medianTransformOverheadMs: {
        value: 41.5,
        status: "MEASURED",
        source: "event.durationMs",
      },
      autoFallbacks: 0,
      exactValueViolations: 0,
      fallbackCounts: {},
    },
    sessionMeasurement: { requests: 3 },
    activeProfile: null,
    disabledEngines: [],
  };
}

function healthySieve(req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, healthyStatsBody());
}

async function reserveDeadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function createFeed(baseUrl: string, options: Record<string, unknown> = {}): SieveHttpLensFeed {
  const feed = new SieveHttpLensFeed({ baseUrl, logger, ...options });
  openResources.add({ close: () => feed.stop() });
  return feed;
}

const openResources = new Set<{ close(): Promise<unknown> | unknown }>();
afterEach(async () => {
  for (const resource of openResources) {
    await Promise.resolve(resource.close()).catch(() => undefined);
  }
  openResources.clear();
});

function track<T extends { close(): Promise<unknown> | unknown }>(resource: T): T {
  openResources.add(resource);
  return resource;
}

describe("SieveHttpLensFeed status mapping", () => {
  test("healthy SIEVE maps to ok with source-backed fields and upstream timestamps", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl);
    const snapshot = await feed.getStatus();

    expect(snapshot.status.state).toBe("ok");
    if (snapshot.status.state !== "ok") throw new Error("expected ok");
    const s = snapshot.status.snapshot;
    expect(s.health).toBe("ok");
    // Absent-authority fields stay absent.
    expect(s.mode).toBeUndefined();
    expect(s.run).toBeUndefined();
    expect(s.cache).toBeUndefined();
    expect(s.fallback).toEqual({ state: "none" });
    expect(s.integrityFaults).toMatchObject({ value: 0, unit: "count", provenance: "measured" });
    expect(s.overhead).toMatchObject({ value: 41.5, unit: "milliseconds", provenance: "measured" });
    expect(s.savings).toMatchObject({
      pristineTokens: { value: 50_000, unit: "tokens", provenance: "measured" },
      presentedTokens: { value: 48_800, unit: "tokens", provenance: "measured" },
      savedTokens: { value: 1_200, unit: "tokens", provenance: "measured" },
      savedRatio: { value: 0.024, unit: "ratio", provenance: "measured" },
    });
    // Every observation carries the upstream clock (the response Date header),
    // and all observations from one poll share one observation time.
    const stamps = [
      s.savings!.pristineTokens!,
      s.savings!.savedTokens!,
      s.overhead!,
      s.integrityFaults!,
    ].map((o) => o.observedAt);
    for (const stamp of stamps) {
      expect(Number.isFinite(Date.parse(stamp))).toBe(true);
    }
    expect(new Set(stamps).size).toBe(1);
    // The snapshot-level observedAt is the adapter's own clock — a different
    // axis from upstream time and always present.
    expect(Number.isFinite(Date.parse(snapshot.observedAt))).toBe(true);
  });

  test("absent measurements stay absent — nothing is minted from a quiet window", async () => {
    const sieve = track(
      await startStubSieve((_req, res) =>
        sendJson(res, {
          ok: true,
          port: 8899,
          upstream: "",
          uptimeMs: 100,
          today: {
            requests: 0,
            tokensIn: null,
            tokensOut: null,
            savedTokens: null,
            savingsPctTokens: null,
            tokensRemoved: { value: null, status: "UNMEASURED", source: "none_today" },
            roughTokenProxy: { value: null, status: "UNMEASURED", source: "none" },
            medianTransformOverheadMs: { value: null, status: "UNMEASURED", source: "none" },
            autoFallbacks: 0,
            exactValueViolations: 0,
            fallbackCounts: {},
          },
        }),
      ),
    );
    const feed = createFeed(sieve.baseUrl);
    const snapshot = await feed.getStatus();
    expect(snapshot.status.state).toBe("ok");
    if (snapshot.status.state !== "ok") throw new Error("expected ok");
    const s = snapshot.status.snapshot;
    expect(s.savings).toBeUndefined();
    expect(s.overhead).toBeUndefined();
    expect(s.fallback).toEqual({ state: "none" });
    expect(s.integrityFaults?.value).toBe(0);
    expect(s.mode).toBeUndefined();
    expect(s.cache).toBeUndefined();
  });

  test("SIEVE's labeled estimate lands as estimated, never measured", async () => {
    const body = healthyStatsBody();
    body.today.tokensRemoved = { value: null, status: "UNMEASURED", source: "no_measure" };
    body.today.savedTokens = null;
    body.today.tokensIn = null;
    body.today.tokensOut = null;
    body.today.savingsPctTokens = null;
    body.today.roughTokenProxy = {
      value: 500,
      status: "ESTIMATED",
      source: "chars_saved / 4 (NOT provider tokens)",
    };
    const sieve = track(await startStubSieve((_req, res) => sendJson(res, body)));
    const feed = createFeed(sieve.baseUrl);
    const snapshot = await feed.getStatus();
    if (snapshot.status.state !== "ok") throw new Error("expected ok");
    const s = snapshot.status.snapshot;
    expect(s.savings?.savedTokens).toMatchObject({ value: 500, provenance: "estimated" });
    expect(s.savings?.pristineTokens).toBeUndefined();
    expect(s.savings?.savedRatio).toBeUndefined();
  });

  test("fallback counters project the fallback state with reasons", async () => {
    const body = healthyStatsBody();
    body.today.autoFallbacks = 3;
    body.today.fallbackCounts = { profile_rollback: 2, governor_pause: 1 };
    const sieve = track(await startStubSieve((_req, res) => sendJson(res, body)));
    const feed = createFeed(sieve.baseUrl);
    const snapshot = await feed.getStatus();
    if (snapshot.status.state !== "ok") throw new Error("expected ok");
    expect(snapshot.status.snapshot.fallback).toEqual({
      state: "degraded",
      reason: "profile_rollback (2), governor_pause (1)",
    });
  });
});

describe("SieveHttpLensFeed failure handling", () => {
  test("unreachable feed reports unavailable feed_unreachable", async () => {
    const port = await reserveDeadPort();
    const feed = createFeed(`http://127.0.0.1:${port}`);
    const snapshot = await feed.getStatus();
    expect(snapshot.status).toMatchObject({ state: "unavailable", reason: "feed_unreachable" });
  });

  test("a stale last-known degrades and is never presented as ok", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl);
    const good = await feed.getStatus();
    if (good.status.state !== "ok") throw new Error("expected ok");
    const upstreamAt = good.status.snapshot.overhead!.observedAt;

    sieve.setRespond((_req, res) => {
      res.writeHead(500).end();
    });
    const stale = await feed.getStatus();
    expect(stale.status.state).toBe("degraded");
    if (stale.status.state !== "degraded") throw new Error("expected degraded");
    expect(stale.status.staleSince).toBe(upstreamAt);
    // The surviving snapshot is the last authoritative one, unchanged.
    expect(stale.status.snapshot).toEqual(good.status.snapshot);

    // Recovery returns to ok with fresh authority.
    sieve.setRespond(healthySieve);
    const recovered = await feed.getStatus();
    expect(recovered.status.state).toBe("ok");
  });

  test("non-2xx with no last-known fails closed to unavailable", async () => {
    const sieve = track(
      await startStubSieve((_req, res) => {
        res.writeHead(503).end();
      }),
    );
    const feed = createFeed(sieve.baseUrl);
    const snapshot = await feed.getStatus();
    expect(snapshot.status).toMatchObject({ state: "unavailable", reason: "feed_unreachable" });
  });

  test.each([
    ["not JSON", (_req: IncomingMessage, res: ServerResponse) => res.end("<<garbage>>")],
    [
      "ok:false",
      (_req: IncomingMessage, res: ServerResponse) => sendJson(res, { ok: false, today: {} }),
    ],
    [
      "missing today",
      (_req: IncomingMessage, res: ServerResponse) => sendJson(res, { ok: true, port: 1 }),
    ],
    [
      "no Date header",
      (_req: IncomingMessage, res: ServerResponse) => {
        res.sendDate = false;
        sendJson(res, healthyStatsBody());
      },
    ],
  ])("malformed status (%s) fails closed", async (_label, handler) => {
    const sieve = track(await startStubSieve(handler));
    const feed = createFeed(sieve.baseUrl);
    const snapshot = await feed.getStatus();
    expect(snapshot.status).toMatchObject({ state: "unavailable", reason: "feed_unreachable" });
  });

  test("a hung upstream fails closed on the request timeout", async () => {
    const sieve = track(
      await startStubSieve((_req, _res) => {
        // Never respond.
      }),
    );
    const feed = createFeed(sieve.baseUrl, { requestTimeoutMs: 50 });
    const snapshot = await feed.getStatus();
    expect(snapshot.status).toMatchObject({
      state: "unavailable",
      reason: "feed_unreachable",
      detail: expect.stringContaining("timed out"),
    });
  });

  test("malformed after healthy degrades instead of minting", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl);
    await feed.getStatus();
    sieve.setRespond((_req, res) => res.end("<<garbage>>"));
    const snapshot = await feed.getStatus();
    expect(snapshot.status.state).toBe("degraded");
    if (snapshot.status.state !== "degraded") throw new Error("expected degraded");
    expect(snapshot.status.snapshot?.savings?.savedTokens?.value).toBe(1_200);
  });
});

describe("SieveHttpLensFeed stream contract", () => {
  test("seq is monotonic within an epoch and epochs differ across feed instances", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feedA = createFeed(sieve.baseUrl);
    const feedB = createFeed(sieve.baseUrl);
    const one = await feedA.pollOnce();
    const two = await feedA.pollOnce();
    expect(two.cursor.seq).toBe(one.cursor.seq + 1);
    expect(one.cursor.epoch).toBe(two.cursor.epoch);
    const other = await feedB.pollOnce();
    expect(other.cursor.epoch).not.toBe(one.cursor.epoch);
  });

  test("subscribe replays buffered events after a same-epoch cursor, no duplicates", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl);
    await feed.pollOnce();
    const second = await feed.pollOnce();
    await feed.pollOnce();

    const replayed: SieveLensFeedSnapshot[] = [];
    const sub = await feed.subscribe({
      after: { epoch: second.cursor.epoch, seq: second.cursor.seq },
      onEvent: (event) => replayed.push(event),
    });
    expect(replayed.map((e) => e.cursor.seq)).toEqual([3]);
    expect(sub.cursor).toEqual({ epoch: second.cursor.epoch, seq: 3 });
    await feed.unsubscribe(sub.subscriptionId);
  });

  test("a foreign-epoch cursor gets no replay — state replaces atomically", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl);
    await feed.pollOnce();
    await feed.pollOnce();
    const replayed: SieveLensFeedSnapshot[] = [];
    const sub = await feed.subscribe({
      after: { epoch: "epoch-from-another-generation", seq: 1 },
      onEvent: (event) => replayed.push(event),
    });
    expect(replayed).toEqual([]);
    expect(sub.cursor.epoch).not.toBe("epoch-from-another-generation");
    await feed.unsubscribe(sub.subscriptionId);
  });

  test("subscriptions drive the poll loop and the last unsubscribe stops it", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl, { pollIntervalMs: 15 });

    const events: SieveLensFeedSnapshot[] = [];
    const sub = await feed.subscribe({ onEvent: (e) => events.push(e) });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2), {
      timeout: 2_000,
    });

    await feed.unsubscribe(sub.subscriptionId);
    await new Promise((r) => setTimeout(r, 30));
    const settled = sieve.requests.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(sieve.requests.length).toBe(settled);
  });

  test("bare getStatus performs a one-shot read and never starts the loop", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl, { pollIntervalMs: 15 });
    await feed.getStatus();
    await feed.getStatus();
    expect(sieve.requests.length).toBe(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(sieve.requests.length).toBe(2);
  });

  test("concurrent readers share one in-flight upstream request", async () => {
    let release: (() => void) | null = null;
    const sieve = track(
      await startStubSieve((_req, res) => {
        release = () => sendJson(res, healthyStatsBody());
      }),
    );
    const feed = createFeed(sieve.baseUrl);
    const first = feed.pollOnce();
    const second = feed.getStatus();
    const third = feed.pollOnce();
    await vi.waitFor(() => expect(sieve.requests.length).toBe(1), { timeout: 1_000 });
    release!();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(b.cursor).toEqual(a.cursor);
    expect(c.cursor).toEqual(a.cursor);
    expect(sieve.requests.length).toBe(1);
  });
});

describe("SieveHttpLensFeed authority discipline", () => {
  test("every request is a bare GET /sieve/stats — no body, no credentials, no other route", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl, { pollIntervalMs: 10 });
    const sub = await feed.subscribe({ onEvent: () => {} });
    await feed.getStatus();
    await feed.pollOnce();
    await vi.waitFor(() => expect(sieve.requests.length).toBeGreaterThanOrEqual(3), {
      timeout: 2_000,
    });
    await feed.unsubscribe(sub.subscriptionId);
    feed.stop();

    expect(sieve.requests.length).toBeGreaterThanOrEqual(3);
    for (const req of sieve.requests) {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/sieve/stats");
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers["proxy-authorization"]).toBeUndefined();
      expect(req.headers["x-sieve-key"]).toBeUndefined();
    }
  });

  test("the adapter cannot reach mutation or audit routes — the path is fixed", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(`${sieve.baseUrl}/sieve/config`);
    await feed.getStatus();
    // A baseUrl carrying a mutation path still resolves to the fixed read route.
    expect(sieve.requests.map((r) => r.url)).toEqual(["/sieve/stats"]);
  });

  test("stop() releases subscriptions and halts the loop", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    const feed = createFeed(sieve.baseUrl, { pollIntervalMs: 10 });
    const events: SieveLensFeedSnapshot[] = [];
    await feed.subscribe({ onEvent: (e) => events.push(e) });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
    feed.stop();
    const settled = sieve.requests.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(sieve.requests.length).toBe(settled);
    await expect(feed.getStatus()).rejects.toThrow();
    await expect(feed.subscribe({ onEvent: () => {} })).rejects.toThrow();
  });

  test("constructor rejects malformed or non-http endpoints", () => {
    expect(() => createFeed("not-a-url")).toThrow();
    expect(() => createFeed("ftp://127.0.0.1:8899")).toThrow();
    expect(() => createFeed("file:///etc/passwd")).toThrow();
  });
});

describe("SIEVE Lens end-to-end through the daemon", () => {
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
    await daemon?.close();
    daemon = null;
  });

  test("a configured daemon serves a real ok Lens status over the wire", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    daemon = await createTestPaseoDaemon({ sieve: { baseUrl: sieve.baseUrl } });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.8.0",
    });
    await client.connect();
    const payload = await client.getSieveLensStatus();
    expect(payload.status.state).toBe("ok");
    if (payload.status.state !== "ok") throw new Error("expected ok");
    expect(payload.status.snapshot.savings?.savedTokens).toMatchObject({
      value: 1_200,
      provenance: "measured",
    });
    expect(sieve.requests.every((r) => r.method === "GET" && r.url === "/sieve/stats")).toBe(true);
  });

  test("a daemon with no configured feed keeps the no_feed_attached disposition", async () => {
    daemon = await createTestPaseoDaemon();
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.8.0",
    });
    await client.connect();
    const payload = await client.getSieveLensStatus();
    expect(payload.status).toEqual({ state: "unavailable", reason: "no_feed_attached" });
    const sub = await client.subscribeSieveLensStatus();
    expect(sub.accepted).toBe(false);
    expect(sub.status).toEqual({ state: "unavailable", reason: "no_feed_attached" });
  });

  test("subscribed clients stream live events with cursors and unsubscribe cleanly", async () => {
    const sieve = track(await startStubSieve(healthySieve));
    daemon = await createTestPaseoDaemon({
      sieveLensFeed: new SieveHttpLensFeed({
        baseUrl: sieve.baseUrl,
        logger,
        pollIntervalMs: 15,
      }),
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.8.0",
    });
    await client.connect();

    const events: { cursor: SieveStreamCursor; status: SieveLensStatus }[] = [];
    client.on("sieve.status.event", (msg) => {
      events.push(msg.payload);
    });
    const sub = await client.subscribeSieveLensStatus();
    expect(sub.accepted).toBe(true);
    expect(sub.status.state).toBe("ok");
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    const seqs = events.map((e) => e.cursor.seq);
    expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1])).toBe(true);
    const epoch = sub.cursor!.epoch;
    expect(events.every((e) => e.cursor.epoch === epoch)).toBe(true);
    const released = await client.unsubscribeSieveLensStatus(sub.subscriptionId!);
    expect(released.released).toBe(true);
  });
});
