/**
 * realm-egress.ts — a realm's requests off the box, through the workspace's
 * egress.
 *
 * A realm (runtime/realm.ts: a worker thread, or under Bun a process) cannot
 * be handed a Fetcher, so under an egress its `fetch` crosses to the host,
 * which sends the request out through the workspace's network and sends the
 * response back as it arrives (realm-egress-guest.ts is the realm's side).
 * The inline `node` (node-realm.ts) and the facets of a local facet host
 * (local-facet-host.ts) cross the same way.
 *
 * Its fetch is Node's: the head arrives first and the body as the realm reads
 * it; the realm's redirect mode is applied here, each hop its own request
 * through the egress, as workerd's fetch follows a Fetcher's.
 */

import type { WorkspaceNetwork } from '../_shared/workspace-network.js';
import { isWebSocketGuestEvent, isWebSocketHostEvent, RealmWebSockets, type WebSocketGuestEvent, type WebSocketHostEvent } from './realm-websocket.js';
import { followRedirects, isRedirectStatus } from './http-redirect-policy.js';

// ── The protocol ────────────────────────────────────────────────────────────

/** A header list as it crosses: in order, a name once per value (set-cookie). */
export type HeaderPairs = readonly (readonly [string, string])[];

/** A request the realm sends off the box: its body whole, its redirect mode the realm's. */
export interface EgressRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: HeaderPairs;
  readonly body: Uint8Array | null;
  readonly redirect: 'follow' | 'manual' | 'error';
}

/** Its response's head. A body, when there is one, crosses a chunk per `egress-pull`. */
export interface EgressHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeaderPairs;
  /** Where the response came from, after any redirect followed. */
  readonly url: string;
  readonly redirected: boolean;
  readonly body: boolean;
}

/** What the realm posts for a request. */
export type EgressGuestEvent =
  | WebSocketGuestEvent
  | { readonly type: 'egress'; readonly id: number; readonly request: EgressRequest }
  /** The realm reads the response's body: the next chunk, or its end. */
  | { readonly type: 'egress-pull'; readonly id: number }
  /** The realm is done with the request (it cancelled the body, or aborted). */
  | { readonly type: 'egress-cancel'; readonly id: number };

/** What the host posts back for it. */
export type EgressHostEvent =
  | WebSocketHostEvent
  | { readonly type: 'egress-head'; readonly id: number; readonly head: EgressHead }
  | { readonly type: 'egress-chunk'; readonly id: number; readonly chunk: Uint8Array }
  | { readonly type: 'egress-end'; readonly id: number }
  /** The request failed, or its body did after the head: what a failed connection is in Node. */
  | { readonly type: 'egress-error'; readonly id: number; readonly message: string };

// Each side receives a structured clone it must narrow.
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const headerPairs = (value: unknown): value is HeaderPairs =>
  Array.isArray(value) && value.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string');
const REDIRECT_MODES: readonly unknown[] = ['follow', 'manual', 'error'];
const isEgressRequest = (value: unknown): value is EgressRequest =>
  record(value) && typeof value.url === 'string' && typeof value.method === 'string' && headerPairs(value.headers)
  && (value.body === null || value.body instanceof Uint8Array) && REDIRECT_MODES.includes(value.redirect);
const isEgressHead = (value: unknown): value is EgressHead =>
  record(value) && typeof value.status === 'number' && typeof value.statusText === 'string' && headerPairs(value.headers)
  && typeof value.url === 'string' && typeof value.redirected === 'boolean' && typeof value.body === 'boolean';

export function isEgressGuestEvent(value: unknown): value is EgressGuestEvent {
  if (isWebSocketGuestEvent(value)) return true;
  if (!record(value) || !Number.isSafeInteger(value.id)) return false;
  switch (value.type) {
    case 'egress': return isEgressRequest(value.request);
    case 'egress-pull':
    case 'egress-cancel': return true;
    default: return false;
  }
}

export function isEgressHostEvent(value: unknown): value is EgressHostEvent {
  if (isWebSocketHostEvent(value)) return true;
  if (!record(value) || typeof value.id !== 'number') return false;
  switch (value.type) {
    case 'egress-head': return isEgressHead(value.head);
    case 'egress-chunk': return value.chunk instanceof Uint8Array;
    case 'egress-end': return true;
    case 'egress-error': return typeof value.message === 'string';
    default: return false;
  }
}

// ── The host's side ─────────────────────────────────────────────────────────

/**
 * `request` through `network`, each hop its own request with redirect
 * 'manual', and the realm's redirect mode applied here: as workerd's fetch
 * follows a Fetcher's redirects (each hop to the Fetcher) and as Node's fetch
 * follows them (the HTTP-redirect fetch of https://fetch.spec.whatwg.org,
 * undici lib/web/fetch/index.js), so the egress sees every request the
 * realm's redirects make (followRedirects' 'fetch' policy). Rejects as
 * Node's fetch fails: 'unexpected redirect' under 'error', 'redirect count
 * exceeded' past 20.
 */
async function fetchFollowing(network: WorkspaceNetwork, request: EgressRequest, signal: AbortSignal): Promise<{ response: Response; url: string; redirected: boolean }> {
  const url = new URL(request.url);
  url.hash = '';
  const walk = await followRedirects<Uint8Array | null>(
    { url, method: request.method, body: request.body, headers: new Headers(request.headers.map(([name, value]) => [name, value])) },
    'fetch',
    {
      follow: request.redirect !== 'manual',
      send: (hop) => network.fetch(hop.url.href, { method: hop.method, headers: hop.headers, body: hop.body, redirect: 'manual', signal }),
      arrived: async (response) => {
        if (request.redirect !== 'error' || !isRedirectStatus(response.status, 'fetch')) return;
        response.body?.cancel().catch(() => {});
        throw new Error('unexpected redirect');
      },
    },
  );
  if (walk.kind !== 'response') throw new Error('redirect count exceeded');
  return { response: walk.response, url: walk.url.href, redirected: walk.redirected };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The host's side: a realm's requests, each sent out through the workspace's
 * network, and its response crossing back as it arrives: the head first, then
 * one chunk of the body each time the realm reads one. A response that does
 * not end (server-sent events) is read as it comes, and a body the realm does
 * not read is not read here either: nothing of it waits in this isolate.
 */
export class RealmEgress {
  private readonly open = new Map<number, { readonly abort: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> }>();
  private readonly sockets: RealmWebSockets;

  constructor(private readonly network: WorkspaceNetwork, private readonly post: (event: EgressHostEvent) => void) {
    this.sockets = new RealmWebSockets(network, post);
  }

  /** One of the realm's events: a request, a read of a body, or a cancel. */
  handle(event: EgressGuestEvent): void {
    if (isWebSocketGuestEvent(event)) { this.sockets.handle(event); return; }
    switch (event.type) {
      case 'egress': this.start(event.id, event.request); return;
      case 'egress-pull': this.pull(event.id); return;
      case 'egress-cancel': this.cancel(event.id); return;
    }
  }

  private start(id: number, request: EgressRequest): void {
    const entry: { readonly abort: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> } = { abort: new AbortController() };
    this.open.set(id, entry);
    void (async () => {
      try {
        if (this.network.egress === undefined) throw new Error('the workspace has no egress');
        const { response, url, redirected } = await fetchFollowing(this.network, request, entry.abort.signal);
        if (this.open.get(id) !== entry) {
          await response.body?.cancel();
          return;
        }
        if (response.body) entry.reader = response.body.getReader();
        else this.open.delete(id);
        this.post({ type: 'egress-head', id, head: { status: response.status, statusText: response.statusText, headers: [...response.headers], url, redirected, body: entry.reader !== undefined } });
      } catch (error) {
        if (this.open.get(id) !== entry) return;
        this.open.delete(id);
        this.post({ type: 'egress-error', id, message: errorText(error) });
      }
    })();
  }

  private pull(id: number): void {
    const entry = this.open.get(id);
    const reader = entry?.reader;
    if (!reader) return;
    reader.read().then(({ done, value }) => {
      if (this.open.get(id) !== entry) return;
      if (done) {
        this.open.delete(id);
        this.post({ type: 'egress-end', id });
      } else {
        this.post({ type: 'egress-chunk', id, chunk: value });
      }
    }, (error: unknown) => {
      if (this.open.get(id) !== entry) return;
      this.open.delete(id);
      this.post({ type: 'egress-error', id, message: errorText(error) });
    });
  }

  private cancel(id: number): void {
    const entry = this.open.get(id);
    if (!entry) return;
    this.open.delete(id);
    entry.abort.abort();
    entry.reader?.cancel().catch(() => {});
  }

  /** The realm has ended: what it left open is closed. */
  close(): void {
    this.sockets.close();
    for (const id of [...this.open.keys()]) this.cancel(id);
  }
}
