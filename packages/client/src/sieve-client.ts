import type {
  SieveLensStatus,
  SieveStatusEvent,
  SieveStatusGetPayload,
  SieveStatusSubscribePayload,
  SieveStatusUnsubscribePayload,
  SieveStreamCursor,
} from "@getpaseo/protocol/messages";
import type { ConnectionState, DaemonClient } from "./daemon-client.js";

// ---------------------------------------------------------------------------
// SIEVE Lens client — owns subscription demand across reconnects.
//
// Mirrors the ConnectionSubscriptions pattern: the caller declares interest
// once, this object re-issues sieve.status.subscribe whenever the connection
// reaches `connected`, and resumes from the last cursor it observed so a
// reconnect continues the stream rather than restarting it. When the daemon
// has no SIEVE feed, subscribe resolves `accepted:false` carrying the same
// typed `unavailable` status a get returns — no phantom membership is held.
// ---------------------------------------------------------------------------

/** Narrow structural surface over DaemonClient — keeps this module testable. */
export interface SieveLensTransport {
  getSieveLensStatus(requestId?: string): Promise<SieveStatusGetPayload>;
  subscribeSieveLensStatus(options?: {
    after?: SieveStreamCursor;
    requestId?: string;
  }): Promise<SieveStatusSubscribePayload>;
  unsubscribeSieveLensStatus(
    subscriptionId: string,
    requestId?: string,
  ): Promise<SieveStatusUnsubscribePayload>;
  on: DaemonClient["on"];
  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void;
}

export interface SieveLensUpdate {
  status: SieveLensStatus;
  observedAt: string;
}

export class SieveLensClient {
  private desired = false;
  private subscriptionId: string | null = null;
  private lastCursor: SieveStreamCursor | null = null;
  private lastUpdate: SieveLensUpdate | null = null;
  private readonly listeners = new Set<(update: SieveLensUpdate) => void>();
  private syncChain: Promise<void> = Promise.resolve();
  private readonly unsubscribeTransport: () => void;
  private readonly unsubscribeEvents: () => void;

  constructor(private readonly transport: SieveLensTransport) {
    this.unsubscribeTransport = transport.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        // Membership died with the socket; re-declare demand on the new
        // connection, resuming from the last cursor we observed.
        this.subscriptionId = null;
        if (this.desired) this.enqueueSync();
      } else {
        this.subscriptionId = null;
      }
    });
    this.unsubscribeEvents = transport.on("sieve.status.event", (message) => {
      this.handleEvent(message);
    });
  }

  getStatus(requestId?: string): Promise<SieveStatusGetPayload> {
    return this.transport.getSieveLensStatus(requestId);
  }

  /** Replay the latest update to the new listener, then forward live updates. */
  onUpdate(listener: (update: SieveLensUpdate) => void): () => void {
    this.listeners.add(listener);
    if (this.lastUpdate) listener(this.lastUpdate);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get current(): SieveLensUpdate | null {
    return this.lastUpdate;
  }

  /** Declare or release subscription demand. Resolves once the daemon answered. */
  setSubscribed(want: boolean): Promise<void> {
    this.desired = want;
    return this.enqueueSync();
  }

  private enqueueSync(): Promise<void> {
    const run = this.syncChain.then(() => this.sync());
    // Serialize syncs; rejections surface to the awaiting caller, not the chain.
    this.syncChain = run.catch(() => {});
    return run;
  }

  private async sync(): Promise<void> {
    if (this.desired && !this.subscriptionId) {
      const response = await this.transport.subscribeSieveLensStatus(
        this.lastCursor ? { after: this.lastCursor } : undefined,
      );
      if (!this.desired) return;
      this.lastUpdate = { status: response.status, observedAt: response.observedAt };
      for (const listener of this.listeners) listener(this.lastUpdate);
      if (response.accepted) {
        this.subscriptionId = response.subscriptionId ?? null;
        this.lastCursor = response.cursor ?? this.lastCursor;
      }
      return;
    }
    if (!this.desired && this.subscriptionId) {
      const id = this.subscriptionId;
      this.subscriptionId = null;
      await this.transport.unsubscribeSieveLensStatus(id);
    }
  }

  private handleEvent(message: SieveStatusEvent): void {
    if (this.subscriptionId && message.payload.subscriptionId !== this.subscriptionId) return;
    const { cursor } = message.payload;
    if (
      this.lastCursor &&
      this.lastCursor.epoch === cursor.epoch &&
      cursor.seq <= this.lastCursor.seq
    ) {
      return;
    }
    this.lastCursor = cursor;
    this.lastUpdate = { status: message.payload.status, observedAt: message.payload.observedAt };
    for (const listener of this.listeners) listener(this.lastUpdate);
  }

  dispose(): void {
    this.unsubscribeTransport();
    this.unsubscribeEvents();
    this.listeners.clear();
    this.subscriptionId = null;
  }
}
