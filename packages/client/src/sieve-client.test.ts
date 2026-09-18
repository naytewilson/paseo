import { describe, expect, it } from "vitest";
import type {
  SieveStatusEvent,
  SieveStatusGetPayload,
  SieveStatusSubscribePayload,
  SieveStatusUnsubscribePayload,
  SieveStreamCursor,
} from "@getpaseo/protocol/messages";
import { SieveLensClient, type SieveLensTransport } from "./sieve-client.js";
import type { ConnectionState, DaemonClient } from "./daemon-client.js";

const UNAVAILABLE = {
  state: "unavailable",
  reason: "no_feed_attached",
} as const;

class FakeTransport implements SieveLensTransport {
  subscribedWith: (SieveStreamCursor | undefined)[] = [];
  unsubscribed: string[] = [];
  private connectionListener: ((state: ConnectionState) => void) | null = null;
  private eventHandler: ((message: SieveStatusEvent) => void) | null = null;
  connectionState: ConnectionState = { status: "connected" };
  nextSubscribeResponse: SieveStatusSubscribePayload = {
    requestId: "r",
    accepted: true,
    subscriptionId: "sub-1",
    cursor: { epoch: "e1", seq: 0 },
    status: UNAVAILABLE,
    observedAt: "2026-09-17T00:00:00Z",
  };

  async getSieveLensStatus(): Promise<SieveStatusGetPayload> {
    return { requestId: "r", status: UNAVAILABLE, observedAt: "2026-09-17T00:00:00Z" };
  }

  async subscribeSieveLensStatus(options?: {
    after?: SieveStreamCursor;
  }): Promise<SieveStatusSubscribePayload> {
    this.subscribedWith.push(options?.after);
    return this.nextSubscribeResponse;
  }

  async unsubscribeSieveLensStatus(subscriptionId: string): Promise<SieveStatusUnsubscribePayload> {
    this.unsubscribed.push(subscriptionId);
    return { requestId: "r", released: true };
  }

  on: DaemonClient["on"] = ((_type: string, handler?: (message: unknown) => void) => {
    this.eventHandler = (handler as ((message: SieveStatusEvent) => void) | undefined) ?? null;
    return () => {
      this.eventHandler = null;
    };
  }) as DaemonClient["on"];

  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    this.connectionListener = listener;
    listener(this.connectionState);
    return () => {
      this.connectionListener = null;
    };
  }

  setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.connectionListener?.(state);
  }

  emitEvent(payload: SieveStatusEvent["payload"]): void {
    this.eventHandler?.({ type: "sieve.status.event", payload });
  }
}

describe("SieveLensClient", () => {
  it("passes through the typed unavailable disposition on get", async () => {
    const client = new SieveLensClient(new FakeTransport());
    const payload = await client.getStatus();
    expect(payload.status).toEqual(UNAVAILABLE);
  });

  it("exposes accepted:false as an update without holding membership", async () => {
    const transport = new FakeTransport();
    transport.nextSubscribeResponse = {
      requestId: "r",
      accepted: false,
      status: UNAVAILABLE,
      observedAt: "2026-09-17T00:00:00Z",
    };
    const client = new SieveLensClient(transport);
    const updates: string[] = [];
    client.onUpdate((u) => updates.push(u.status.state));
    await client.setSubscribed(true);
    expect(updates).toEqual(["unavailable"]);
    // Refused subscription: nothing to release on the other side.
    await client.setSubscribed(false);
    expect(transport.unsubscribed).toEqual([]);
  });

  it("re-subscribes with the last observed cursor after reconnect", async () => {
    const transport = new FakeTransport();
    const client = new SieveLensClient(transport);
    await client.setSubscribed(true);
    transport.emitEvent({
      subscriptionId: "sub-1",
      cursor: { epoch: "e1", seq: 5 },
      status: UNAVAILABLE,
      observedAt: "2026-09-17T00:00:01Z",
    });
    transport.setConnectionState({ status: "disconnected" });
    transport.setConnectionState({ status: "connected" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.subscribedWith[1]).toEqual({ epoch: "e1", seq: 5 });
  });

  it("drops duplicate or rewound events within an epoch", async () => {
    const transport = new FakeTransport();
    const client = new SieveLensClient(transport);
    const updates: string[] = [];
    await client.setSubscribed(true);
    client.onUpdate((u) => updates.push(u.observedAt));
    transport.emitEvent({
      subscriptionId: "sub-1",
      cursor: { epoch: "e1", seq: 3 },
      status: UNAVAILABLE,
      observedAt: "t3",
    });
    transport.emitEvent({
      subscriptionId: "sub-1",
      cursor: { epoch: "e1", seq: 3 },
      status: UNAVAILABLE,
      observedAt: "t3-dup",
    });
    transport.emitEvent({
      subscriptionId: "sub-1",
      cursor: { epoch: "e1", seq: 2 },
      status: UNAVAILABLE,
      observedAt: "t2-rewind",
    });
    // First entry is the replayed subscribe-response status; only t3 is live.
    expect(updates).toEqual(["2026-09-17T00:00:00Z", "t3"]);
  });

  it("ignores events for a foreign subscription id", async () => {
    const transport = new FakeTransport();
    const client = new SieveLensClient(transport);
    const updates: string[] = [];
    await client.setSubscribed(true);
    client.onUpdate((u) => updates.push(u.observedAt));
    transport.emitEvent({
      subscriptionId: "other-sub",
      cursor: { epoch: "e1", seq: 9 },
      status: UNAVAILABLE,
      observedAt: "foreign",
    });
    // Only the replayed subscribe-response status — the foreign event is dropped.
    expect(updates).toEqual(["2026-09-17T00:00:00Z"]);
  });

  it("releases membership on unsubscribe", async () => {
    const transport = new FakeTransport();
    const client = new SieveLensClient(transport);
    await client.setSubscribed(true);
    await client.setSubscribed(false);
    expect(transport.unsubscribed).toEqual(["sub-1"]);
  });

  it("releases the prior server-side membership after reconnect", async () => {
    const transport = new FakeTransport();
    const client = new SieveLensClient(transport);
    await client.setSubscribed(true);

    transport.nextSubscribeResponse = {
      requestId: "r",
      accepted: true,
      subscriptionId: "sub-2",
      cursor: { epoch: "e1", seq: 5 },
      status: UNAVAILABLE,
      observedAt: "2026-09-17T00:00:01Z",
    };
    transport.setConnectionState({ status: "disconnected" });
    transport.setConnectionState({ status: "connected" });
    await new Promise((resolve) => setImmediate(resolve));

    // A daemon session that survived the socket drop still held sub-1; the
    // resubscribe released it rather than orphaning it.
    expect(transport.unsubscribed).toEqual(["sub-1"]);
    expect(transport.subscribedWith).toHaveLength(2);
  });

  it("releases a membership granted after demand was withdrawn mid-flight", async () => {
    const transport = new FakeTransport();
    let resolveSubscribe: (payload: SieveStatusSubscribePayload) => void = () => {};
    transport.subscribeSieveLensStatus = () =>
      new Promise<SieveStatusSubscribePayload>((resolve) => {
        resolveSubscribe = resolve;
      });
    const client = new SieveLensClient(transport);

    const pending = client.setSubscribed(true);
    // Let sync reach the in-flight subscribe before demand is withdrawn.
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = client.setSubscribed(false);
    resolveSubscribe({
      requestId: "r",
      accepted: true,
      subscriptionId: "sub-1",
      cursor: { epoch: "e1", seq: 0 },
      status: UNAVAILABLE,
      observedAt: "2026-09-17T00:00:00Z",
    });
    await pending;
    await cancelled;

    expect(transport.unsubscribed).toEqual(["sub-1"]);
  });

  it("releases a held membership on dispose", async () => {
    const transport = new FakeTransport();
    const client = new SieveLensClient(transport);
    await client.setSubscribed(true);

    client.dispose();

    expect(transport.unsubscribed).toEqual(["sub-1"]);
  });
});
