/**
 * realm-egress-guest.ts — a realm's side of realm-egress.ts: its `fetch`,
 * crossing to the host.
 */
import type { EgressGuestEvent, EgressHostEvent } from './realm-egress.js';
/** A realm's fetch, routed through its host: the answers that cross back go to `answer`. */
export interface RealmEgressGuest {
    answer(event: EgressHostEvent): void;
    /** Answers the realm waits on now: a head, a chunk of a body it is reading. */
    readonly awaited: number;
}
/**
 * Route this realm's `fetch` through its host (`post` crosses to it), and
 * refuse a WebSocket, which cannot cross, with `webSocketRefusal`. The host
 * sends each request out through the egress and follows its redirects as the
 * realm asked; a response is the realm's once its head arrives, and its body
 * is read from the host as the realm reads it. Fails as Node's fetch fails:
 * `fetch failed` before the head, `terminated` in the body, the signal's
 * reason on an abort. `waiting` is called whenever the count of answers the
 * realm waits on changes (a head, a chunk it is reading), for a realm that
 * lives while its event loop has work: each holds it, as an active socket
 * holds a Node process; a body it is not reading holds nothing.
 */
export declare function routeFetchThroughHost(post: (event: EgressGuestEvent) => void, waiting: () => void, webSocketRefusal: string): RealmEgressGuest;
//# sourceMappingURL=realm-egress-guest.d.ts.map