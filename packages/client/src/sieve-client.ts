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
  // Memberships the daemon may still hold that this client no longer wants —
  // e.g. a subscription granted on a session that survived a socket drop, or
  // one granted after demand was withdrawn mid-flight. Released on the next
  // sync; the server rejects unknown ids harmlessly, so retrying is cheap.
  private readonly orphanedIds = new Set<string>();
  private lastCursor: SieveStreamCursor | null = null;
  private lastUpdate: SieveLensUpdate | null = null;
  private readonly listeners = new Set<(update: SieveLensUpdate) => void>();
  private syncChain: Promise<void> = Promise.resolve();
  private readonly unsubscribeTransport: () => void;
  private readonly unsubscribeEvents: () => void;

  constructor(private readonly transport: SieveLensTransport) {
    this.unsubscribeTransport = transport.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        // Re-declare demand on the new connection, resuming from the last
        // cursor we observed.
        if (this.subscriptionId) this.orphanedIds.add(this.subscriptionId);
        this.subscriptionId = null;
        if (this.desired) this.enqueueSync();
      } else if (this.subscriptionId) {
        // A daemon session that survives the socket drop keeps holding this
        // subscription; remember it so the next sync can release it.
        this.orphanedIds.add(this.subscriptionId);
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
    await this.releaseOrphaned();
    if (this.desired && !this.subscriptionId) {
      const response = await this.transport.subscribeSieveLensStatus(
        this.lastCursor ? { after: this.lastCursor } : undefined,
      );
      if (!this.desired) {
        // Demand flipped while the subscribe was in flight — release the
        // membership the daemon just granted rather than stranding it.
        if (response.accepted && response.subscriptionId) {
          this.orphanedIds.add(response.subscriptionId);
          await this.releaseOrphaned();
        }
        return;
      }
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
      try {
        await this.transport.unsubscribeSieveLensStatus(id);
      } catch (error) {
        this.orphanedIds.add(id);
        throw error;
      }
    }
  }

  private async releaseOrphaned(): Promise<void> {
    for (const id of this.orphanedIds) {
      try {
        await this.transport.unsubscribeSieveLensStatus(id);
        this.orphanedIds.delete(id);
      } catch {
        // Not connected, or the transport failed — keep the id and retry on
        // the next sync. The daemon session drops it on cleanup regardless.
        return;
      }
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
    const id = this.subscriptionId;
    this.desired = false;
    this.subscriptionId = null;
    this.unsubscribeTransport();
    this.unsubscribeEvents();
    this.listeners.clear();
    // Best-effort release — the daemon drops membership on session cleanup,
    // but a shared connection keeps it alive otherwise.
    const release = (orphanId: string): void => {
      try {
        void this.transport.unsubscribeSieveLensStatus(orphanId).catch(() => {});
      } catch {
        // Transport threw synchronously — nothing left to release with.
      }
    };
    if (id) release(id);
    for (const orphan of this.orphanedIds) release(orphan);
    this.orphanedIds.clear();
  }
}
