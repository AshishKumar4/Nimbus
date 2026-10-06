/**
 * realm-egress-guest.ts — a realm's side of realm-egress.ts: its `fetch`,
 * crossing to the host.
 */

import type { EgressGuestEvent, EgressHead, EgressHostEvent, EgressRequest } from './realm-egress.js';

/** A realm's fetch, routed through its host: the answers that cross back go to `answer`. */
export interface RealmEgressGuest {
  answer(event: EgressHostEvent): void;
  /** Answers the realm waits on now: a head, a chunk of a body it is reading. */
  readonly awaited: number;
}

/** A Request's redirect mode, as its type names it (a string, in the platform's typing). */
function redirectMode(mode: string): EgressRequest['redirect'] {
  if (mode === 'follow' || mode === 'manual' || mode === 'error') return mode;
  throw new TypeError(`fetch: unknown redirect mode ${JSON.stringify(mode)}`);
}

/** Statuses whose response has no body (the Response constructor refuses one). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

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
export function routeFetchThroughHost(post: (event: EgressGuestEvent) => void, waiting: () => void, webSocketRefusal: string): RealmEgressGuest {
  /** The realm's requests, by id: each takes the answers that cross back for it. */
  const requests = new Map<number, (answer: EgressHostEvent) => void>();
  let ids = 0;
  let awaited = 0;

  const send = (request: Request, body: Uint8Array | null): Promise<Response> => new Promise<Response>((resolve, reject) => {
    const id = ++ids;
    const signal = request.signal;
    let awaiting = false;
    const await_ = (on: boolean) => {
      if (awaiting === on) return;
      awaiting = on;
      awaited += on ? 1 : -1;
      waiting();
    };
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    /** Settles the stream's pull, once its chunk, end or error has arrived. */
    let pulled: (() => void) | undefined;
    const done = () => {
      requests.delete(id);
      signal.removeEventListener('abort', aborted);
      await_(false);
      pulled?.();
      pulled = undefined;
    };
    const aborted = () => {
      post({ type: 'egress-cancel', id });
      if (stream) stream.error(signal.reason);
      else reject(signal.reason);
      done();
    };
    const head = (answer: EgressHead) => {
      await_(false);
      const withBody = answer.body && !NULL_BODY_STATUSES.has(answer.status);
      if (answer.body && !withBody) {
        post({ type: 'egress-cancel', id });
        done();
      } else if (!withBody) {
        done();
      }
      const source = withBody ? new ReadableStream<Uint8Array>({
        start: (controller) => { stream = controller; },
        pull: () => new Promise<void>((settle) => {
          pulled = settle;
          await_(true);
          post({ type: 'egress-pull', id });
        }),
        cancel: () => {
          post({ type: 'egress-cancel', id });
          done();
        },
      }, { highWaterMark: 0 }) : null;
      let response: Response;
      try {
        response = new Response(source, { status: answer.status, statusText: answer.statusText, headers: answer.headers.map(([name, value]) => [name, value]) });
      } catch (error) {
        post({ type: 'egress-cancel', id });
        done();
        reject(new TypeError('fetch failed', { cause: error }));
        return;
      }
      // Where the response came from, as Node's fetch reports it.
      Object.defineProperties(response, { url: { value: answer.url }, redirected: { value: answer.redirected } });
      resolve(response);
    };
    requests.set(id, (answer) => {
      switch (answer.type) {
        case 'egress-head':
          head(answer.head);
          return;
        case 'egress-chunk':
          await_(false);
          stream?.enqueue(answer.chunk);
          pulled?.();
          pulled = undefined;
          return;
        case 'egress-end':
          stream?.close();
          done();
          return;
        case 'egress-error': {
          const cause = new Error(answer.message);
          if (stream) stream.error(new TypeError('terminated', { cause }));
          else reject(new TypeError('fetch failed', { cause }));
          done();
          return;
        }
      }
    });
    signal.addEventListener('abort', aborted, { once: true });
    await_(true);
    post({ type: 'egress', id, request: { url: request.url, method: request.method, headers: [...request.headers], body, redirect: redirectMode(request.redirect) } });
  });

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    request.signal.throwIfAborted();
    return await send(request, body);
  };
  globalThis.WebSocket = class {
    constructor() {
      throw new Error(webSocketRefusal);
    }
  } as unknown as typeof WebSocket;
  return {
    answer: (event) => requests.get(event.id)?.(event),
    get awaited() { return awaited; },
  };
}

