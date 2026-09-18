import { describe, expect, test, vi } from "vitest";
import type { SessionOutboundMessage, SieveLensStatus } from "../messages.js";
import type { SieveLensFeed, SieveLensFeedSnapshot } from "./feed.js";
import { SieveSession } from "./sieve-session.js";

const logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as import("pino").Logger;

function createHost() {
  const messages: SessionOutboundMessage[] = [];
  return {
    messages,
    host: {
      emit: (msg: SessionOutboundMessage) => {
        messages.push(msg);
      },
    },
  };
}

const OK_STATUS: SieveLensStatus = {
  state: "ok",
  snapshot: {
    mode: "observe",
    run: { runId: "run_1" },
  },
};

function createFeed(status: SieveLensStatus = OK_STATUS) {
  const listeners = new Map<string, (event: SieveLensFeedSnapshot) => void>();
  let nextSubscription = 0;
  const feed: SieveLensFeed = {
    getStatus: vi.fn(async () => ({
      status,
      cursor: { epoch: "epoch-1", seq: 7 },
      observedAt: "2026-09-17T00:00:00.000Z",
    })),
    subscribe: vi.fn(async ({ onEvent }) => {
      const subscriptionId = `sub_${++nextSubscription}`;
      listeners.set(subscriptionId, onEvent);
      return { subscriptionId, cursor: { epoch: "epoch-1", seq: 7 } };
    }),
    unsubscribe: vi.fn(async (subscriptionId: string) => {
      listeners.delete(subscriptionId);
    }),
  };
  return { feed, listeners };
}

describe("SieveSession with no feed attached", () => {
  test("status.get answers the typed unavailable disposition", async () => {
    const { host, messages } = createHost();
    const session = new SieveSession({
      host,
      feed: null,
      logger,
      now: () => "2026-09-17T12:00:00.000Z",
    });

    await session.handleStatusGetRequest({
      type: "sieve.status.get.request",
      requestId: "req_get",
    });

    expect(messages).toEqual([
      {
        type: "sieve.status.get.response",
        payload: {
          requestId: "req_get",
          status: { state: "unavailable", reason: "no_feed_attached" },
          observedAt: "2026-09-17T12:00:00.000Z",
        },
      },
    ]);
  });

  test("status.subscribe is refused in-band with the same disposition", async () => {
    const { host, messages } = createHost();
    const session = new SieveSession({ host, feed: null, logger });

    await session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_sub",
    });

    expect(messages).toEqual([
      {
        type: "sieve.status.subscribe.response",
        payload: {
          requestId: "req_sub",
          accepted: false,
          status: { state: "unavailable", reason: "no_feed_attached" },
          observedAt: expect.any(String),
        },
      },
    ]);
  });

  test("status.unsubscribe reports nothing was released", async () => {
    const { host, messages } = createHost();
    const session = new SieveSession({ host, feed: null, logger });

    await session.handleStatusUnsubscribeRequest({
      type: "sieve.status.unsubscribe.request",
      requestId: "req_unsub",
      subscriptionId: "sub_missing",
    });

    expect(messages).toEqual([
      {
        type: "sieve.status.unsubscribe.response",
        payload: { requestId: "req_unsub", released: false },
      },
    ]);
  });
});

describe("SieveSession with a feed attached", () => {
  test("status.get relays the feed's status untouched", async () => {
    const { host, messages } = createHost();
    const { feed } = createFeed();
    const session = new SieveSession({ host, feed, logger });

    await session.handleStatusGetRequest({
      type: "sieve.status.get.request",
      requestId: "req_get",
    });

    expect(feed.getStatus).toHaveBeenCalledOnce();
    expect(messages[0]).toMatchObject({
      type: "sieve.status.get.response",
      payload: { requestId: "req_get", status: OK_STATUS },
    });
  });

  test("status.get degrades to feed_unreachable when the feed throws", async () => {
    const { host, messages } = createHost();
    const feed: SieveLensFeed = {
      getStatus: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const session = new SieveSession({ host, feed, logger });

    await session.handleStatusGetRequest({
      type: "sieve.status.get.request",
      requestId: "req_get",
    });

    expect(messages[0]).toMatchObject({
      type: "sieve.status.get.response",
      payload: {
        status: {
          state: "unavailable",
          reason: "feed_unreachable",
          detail: "socket closed",
        },
      },
    });
  });

  test("subscribe forwards feed events as sieve.status.event and unsubscribe releases", async () => {
    const { host, messages } = createHost();
    const { feed, listeners } = createFeed();
    const session = new SieveSession({ host, feed, logger });

    await session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_sub",
      after: { epoch: "epoch-1", seq: 3 },
    });

    expect(feed.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ after: { epoch: "epoch-1", seq: 3 } }),
    );
    expect(messages[0]).toMatchObject({
      type: "sieve.status.subscribe.response",
      payload: {
        requestId: "req_sub",
        accepted: true,
        subscriptionId: "sub_1",
        cursor: { epoch: "epoch-1", seq: 7 },
        status: OK_STATUS,
      },
    });

    const event: SieveLensFeedSnapshot = {
      status: OK_STATUS,
      cursor: { epoch: "epoch-1", seq: 8 },
      observedAt: "2026-09-17T00:00:01.000Z",
    };
    listeners.get("sub_1")?.(event);

    expect(messages[1]).toEqual({
      type: "sieve.status.event",
      payload: {
        subscriptionId: "sub_1",
        cursor: { epoch: "epoch-1", seq: 8 },
        status: OK_STATUS,
        observedAt: "2026-09-17T00:00:01.000Z",
      },
    });

    await session.handleStatusUnsubscribeRequest({
      type: "sieve.status.unsubscribe.request",
      requestId: "req_unsub",
      subscriptionId: "sub_1",
    });

    expect(feed.unsubscribe).toHaveBeenCalledWith("sub_1");
    expect(messages[2]).toEqual({
      type: "sieve.status.unsubscribe.response",
      payload: { requestId: "req_unsub", released: true },
    });
    expect(listeners.size).toBe(0);
  });

  test("subscribe replays events delivered during subscribe after the response", async () => {
    const { host, messages } = createHost();
    const { feed } = createFeed();
    const replayed: SieveLensFeedSnapshot = {
      status: OK_STATUS,
      cursor: { epoch: "epoch-1", seq: 8 },
      observedAt: "2026-09-17T00:00:01.000Z",
    };
    feed.subscribe = vi.fn(async ({ onEvent }) => {
      // A feed resuming from a cursor replays buffered events synchronously —
      // before the subscription handle exists.
      onEvent(replayed);
      return { subscriptionId: "sub_1", cursor: { epoch: "epoch-1", seq: 8 } };
    });
    const session = new SieveSession({ host, feed, logger });

    await session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_sub",
      after: { epoch: "epoch-1", seq: 3 },
    });

    expect(messages[0]).toMatchObject({
      type: "sieve.status.subscribe.response",
      payload: { accepted: true, subscriptionId: "sub_1" },
    });
    expect(messages[1]).toMatchObject({
      type: "sieve.status.event",
      payload: { subscriptionId: "sub_1", cursor: { epoch: "epoch-1", seq: 8 } },
    });
  });

  test("events emitted while the response is pending are emitted after it", async () => {
    const { host, messages } = createHost();
    const { feed, listeners } = createFeed();
    let resolveStatus: (value: SieveLensFeedSnapshot) => void = () => {};
    feed.getStatus = vi.fn(
      () =>
        new Promise<SieveLensFeedSnapshot>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const session = new SieveSession({ host, feed, logger });

    const pending = session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_sub",
    });
    // Let feed.subscribe resolve so the listener is registered before firing.
    await new Promise((resolve) => setImmediate(resolve));
    listeners.get("sub_1")?.({
      status: OK_STATUS,
      cursor: { epoch: "epoch-1", seq: 8 },
      observedAt: "2026-09-17T00:00:01.000Z",
    });
    resolveStatus({
      status: OK_STATUS,
      cursor: { epoch: "epoch-1", seq: 7 },
      observedAt: "2026-09-17T00:00:00.000Z",
    });
    await pending;

    expect(messages[0].type).toBe("sieve.status.subscribe.response");
    expect(messages[1]).toMatchObject({
      type: "sieve.status.event",
      payload: { subscriptionId: "sub_1", cursor: { epoch: "epoch-1", seq: 8 } },
    });
  });

  test("a status read failure after subscribe reports membership, not refusal", async () => {
    const { host, messages } = createHost();
    const { feed } = createFeed();
    feed.getStatus = vi.fn(async () => {
      throw new Error("upstream lost");
    });
    const session = new SieveSession({ host, feed, logger });

    await session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_sub",
    });

    // The feed granted membership — reporting accepted:false would strand it.
    expect(messages[0]).toMatchObject({
      type: "sieve.status.subscribe.response",
      payload: {
        accepted: true,
        subscriptionId: "sub_1",
        status: {
          state: "unavailable",
          reason: "feed_unreachable",
          detail: "upstream lost",
        },
      },
    });

    await session.handleStatusUnsubscribeRequest({
      type: "sieve.status.unsubscribe.request",
      requestId: "req_unsub",
      subscriptionId: "sub_1",
    });
    expect(feed.unsubscribe).toHaveBeenCalledWith("sub_1");
  });

  test("subscribe failure reports feed_unreachable and accepts nothing", async () => {
    const { host, messages } = createHost();
    const feed: SieveLensFeed = {
      getStatus: vi.fn(),
      subscribe: vi.fn(async () => {
        throw new Error("upstream refused");
      }),
      unsubscribe: vi.fn(),
    };
    const session = new SieveSession({ host, feed, logger });

    await session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_sub",
    });

    expect(messages[0]).toMatchObject({
      type: "sieve.status.subscribe.response",
      payload: {
        accepted: false,
        status: {
          state: "unavailable",
          reason: "feed_unreachable",
          detail: "upstream refused",
        },
      },
    });
  });

  test("dispose releases every held subscription", async () => {
    const { host } = createHost();
    const { feed } = createFeed();
    const session = new SieveSession({ host, feed, logger });

    await session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_a",
    });
    await session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_b",
    });

    await session.dispose();

    expect(feed.unsubscribe).toHaveBeenCalledTimes(2);
  });

  test("a subscribe granted after dispose is released, not held", async () => {
    const { host } = createHost();
    let resolveSubscribe: (subscription: {
      subscriptionId: string;
      cursor: { epoch: string; seq: number };
    }) => void = () => {};
    const feed: SieveLensFeed = {
      getStatus: vi.fn(),
      subscribe: vi.fn(
        () =>
          new Promise<{ subscriptionId: string; cursor: { epoch: string; seq: number } }>(
            (resolve) => {
              resolveSubscribe = resolve;
            },
          ),
      ),
      unsubscribe: vi.fn(async () => {}),
    };
    const session = new SieveSession({ host, feed, logger });

    const inFlight = session.handleStatusSubscribeRequest({
      type: "sieve.status.subscribe.request",
      requestId: "req_sub",
    });
    await session.dispose();
    resolveSubscribe({ subscriptionId: "sub_late", cursor: { epoch: "e", seq: 1 } });
    await inFlight;

    expect(feed.unsubscribe).toHaveBeenCalledWith("sub_late");
  });
});
