import type { SieveLensStatus, SieveStreamCursor } from "../messages.js";

/**
 * A single SIEVE status observation as delivered by the authority plane. The
 * cursor is the stream position this status was current at — epoch/seq follow
 * the same contract family as agent timelines: an epoch change replaces state
 * atomically, seq is monotonic within an epoch.
 */
export interface SieveLensFeedSnapshot {
  status: SieveLensStatus;
  cursor: SieveStreamCursor;
  observedAt: string;
}

export interface SieveLensFeedSubscription {
  subscriptionId: string;
  cursor: SieveStreamCursor;
}

/**
 * The seam where a real SIEVE data plane attaches.
 *
 * Implementations project the upstream authority plane (SIEVE gateway /
 * Chronicle query interface) into Lens status objects. The daemon owns no
 * SIEVE semantics: it relays what the feed reports and, when no feed is
 * attached, answers every sieve.* request with a typed `unavailable`
 * disposition instead of fabricating counters.
 *
 * A feed is scoped read-only by construction — this interface exposes no
 * mutation surface. Control verbs do not belong here.
 */
export interface SieveLensFeed {
  getStatus(): Promise<SieveLensFeedSnapshot>;
  subscribe(params: {
    after?: SieveStreamCursor;
    onEvent: (event: SieveLensFeedSnapshot) => void;
  }): Promise<SieveLensFeedSubscription>;
  unsubscribe(subscriptionId: string): Promise<void>;
}
