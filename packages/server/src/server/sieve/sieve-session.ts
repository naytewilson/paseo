import type pino from "pino";
import type {
  SieveLensStatus,
  SieveStatusGetRequest,
  SieveStatusSubscribeRequest,
  SieveStatusUnsubscribeRequest,
  SessionOutboundMessage,
} from "../messages.js";
import type { SieveLensFeed, SieveLensFeedSnapshot, SieveLensFeedSubscription } from "./feed.js";

export interface SieveSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface SieveSessionOptions {
  host: SieveSessionHost;
  feed?: SieveLensFeed | null;
  logger: pino.Logger;
  now?: () => string;
}

const NO_FEED_STATUS: SieveLensStatus = {
  state: "unavailable",
  reason: "no_feed_attached",
};

/**
 * The daemon's sieve.* read surface. Owns the Lens status RPCs for one client
 * session. With no SieveLensFeed attached — the only shipped configuration
 * today — every request resolves to a typed `unavailable` disposition: the
 * Lens reports absence honestly rather than minting counters. When a feed is
 * attached it is the sole source of status; the session adds nothing of its
 * own beyond correlation ids and timestamps.
 */
export class SieveSession {
  private readonly host: SieveSessionHost;
  private readonly feed: SieveLensFeed | null;
  private readonly logger: pino.Logger;
  private readonly now: () => string;
  private readonly subscriptions = new Map<string, SieveLensFeed>();
  private disposed = false;

  constructor(options: SieveSessionOptions) {
    this.host = options.host;
    this.feed = options.feed ?? null;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async handleStatusGetRequest(msg: SieveStatusGetRequest): Promise<void> {
    this.host.emit({
      type: "sieve.status.get.response",
      payload: {
        requestId: msg.requestId,
        status: await this.currentStatus(),
        observedAt: this.now(),
      },
    });
  }

  async handleStatusSubscribeRequest(msg: SieveStatusSubscribeRequest): Promise<void> {
    if (this.disposed) {
      return;
    }
    const feed = this.feed;
    if (!feed) {
      this.host.emit({
        type: "sieve.status.subscribe.response",
        payload: {
          requestId: msg.requestId,
          accepted: false,
          status: NO_FEED_STATUS,
          observedAt: this.now(),
        },
      });
      return;
    }
    // A feed resuming from a cursor may replay buffered events synchronously
    // inside subscribe() — before the subscription handle exists — or while the
    // status read below is still pending. Buffering until after the response
    // keeps the client from seeing events for a subscriptionId it cannot know
    // yet, which it would have to drop as foreign.
    let subscription: SieveLensFeedSubscription | null = null;
    let responseSent = false;
    const earlyEvents: SieveLensFeedSnapshot[] = [];
    const emitEvent = (event: SieveLensFeedSnapshot): void => {
      if (!subscription || !responseSent) {
        earlyEvents.push(event);
        return;
      }
      this.host.emit({
        type: "sieve.status.event",
        payload: {
          subscriptionId: subscription.subscriptionId,
          cursor: event.cursor,
          status: event.status,
          observedAt: event.observedAt,
        },
      });
    };
    try {
      subscription = await feed.subscribe({
        ...(msg.after ? { after: msg.after } : {}),
        onEvent: emitEvent,
      });
    } catch (error) {
      this.logger.error({ err: error }, "SIEVE feed refused subscription");
      this.host.emit({
        type: "sieve.status.subscribe.response",
        payload: {
          requestId: msg.requestId,
          accepted: false,
          status: {
            state: "unavailable",
            reason: "feed_unreachable",
            detail: error instanceof Error ? error.message : String(error),
          },
          observedAt: this.now(),
        },
      });
      return;
    }
    if (this.disposed) {
      // The session was torn down while subscribe was in flight. Release the
      // membership the feed just granted instead of holding it for a dead host.
      await feed.unsubscribe(subscription.subscriptionId).catch((error: unknown) => {
        this.logger.warn({ err: error }, "SIEVE feed unsubscribe failed after dispose");
      });
      return;
    }
    this.subscriptions.set(subscription.subscriptionId, feed);
    // Membership exists from here on — the response must report it even when
    // the status read fails, or the daemon would hold a subscription the
    // client was told it never got.
    let status: SieveLensStatus;
    try {
      status = (await feed.getStatus()).status;
    } catch (error) {
      this.logger.error({ err: error }, "SIEVE feed status read failed");
      status = {
        state: "unavailable",
        reason: "feed_unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    // dispose() may have won while getStatus() was pending. In that case it
    // already drained/unsubscribed the registered membership, so never publish
    // an accepted subscription that no longer exists.
    if (this.disposed) {
      return;
    }
    this.host.emit({
      type: "sieve.status.subscribe.response",
      payload: {
        requestId: msg.requestId,
        accepted: true,
        subscriptionId: subscription.subscriptionId,
        cursor: subscription.cursor,
        status,
        observedAt: this.now(),
      },
    });
    responseSent = true;
    for (const event of earlyEvents.splice(0)) {
      emitEvent(event);
    }
  }

  async handleStatusUnsubscribeRequest(msg: SieveStatusUnsubscribeRequest): Promise<void> {
    const feed = this.subscriptions.get(msg.subscriptionId);
    let released = false;
    if (feed) {
      this.subscriptions.delete(msg.subscriptionId);
      try {
        await feed.unsubscribe(msg.subscriptionId);
        released = true;
      } catch (error) {
        this.logger.warn({ err: error }, "SIEVE feed unsubscribe failed");
      }
    }
    this.host.emit({
      type: "sieve.status.unsubscribe.response",
      payload: { requestId: msg.requestId, released },
    });
  }

  /** Release every feed subscription this session holds. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.subscriptions.entries()];
    this.subscriptions.clear();
    await Promise.all(
      pending.map(([subscriptionId, feed]) =>
        feed.unsubscribe(subscriptionId).catch((error: unknown) => {
          this.logger.warn({ err: error }, "SIEVE feed unsubscribe failed during dispose");
        }),
      ),
    );
  }

  private async currentStatus(): Promise<SieveLensStatus> {
    const feed = this.feed;
    if (!feed) {
      return NO_FEED_STATUS;
    }
    try {
      return (await feed.getStatus()).status;
    } catch (error) {
      this.logger.error({ err: error }, "SIEVE feed status read failed");
      return {
        state: "unavailable",
        reason: "feed_unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
