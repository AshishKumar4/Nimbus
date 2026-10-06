/**
 * kernel-fetch.ts — the workspace-local request dispatcher.
 *
 * curl and wget are each bound to one kernel, and a loopback hop — including
 * one a redirect lands on — is served by that kernel's port registry or its
 * host's loopback router, never by fetch. The outcome is explicit rather
 * than null: 'aborted' and 'timeout' surface to the caller's own reporting
 * instead of being mistaken for "no listener".
 */

import {
  isLoopbackHost,
  type Kernel,
  type VirtualRequest,
  type VirtualResponse,
} from '../../kernel/index.js';
import { waitForSignalOrTimeout } from '../signal.js';

/** Outcomes of one workspace-local hop, for callers that report failure. */
export type WorkspaceRequestResult =
  | { kind: 'response'; response: Response }
  | { kind: 'refused' }
  | { kind: 'aborted' }
  | { kind: 'timeout' };

/**
 * The loopback port a URL asks for, or null when it is not loopback. A name
 * is resolved through the kernel's /etc/hosts; a caller that holds no
 * resolver (a curl bound to a bare port registry) knows loopback by name only.
 */
export function workspaceRequestPort(kernel: Partial<Pick<Kernel, 'dns'>>, url: URL): number | null {
  let host = url.hostname;
  if (!isLoopbackHost(host)) host = kernel.dns?.lookup(host)?.value ?? host;
  if (!isLoopbackHost(host)) return null;
  return url.port ? Number(url.port) : (url.protocol === 'http:' ? 80 : 443);
}

/** HTTP reason phrase — virtual responses carry no status text. */
export function statusText(status: number): string {
  const map: Record<number, string> = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
    304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error',
    502: 'Bad Gateway', 503: 'Service Unavailable',
  };
  return map[status] ?? '';
}

/**
 * Serve `request` through the kernel's port registry, else its host's
 * loopback router. The handler's virtual response is adapted to a real
 * Response so callers hold exactly one response shape for local and remote
 * traffic alike. `request.signal` is the only cancellation channel — a
 * parked local handler and the loopback router both observe it.
 */
export async function dispatchWorkspaceRequest(
  kernel: Pick<Kernel, 'portRegistry' | 'routeLoopback'>,
  port: number,
  request: Request,
): Promise<WorkspaceRequestResult> {
  const handler = kernel.portRegistry.get(port);
  if (handler) {
    const vReq: VirtualRequest = {
      method: request.method,
      url: new URL(request.url).pathname + new URL(request.url).search,
      headers: Object.fromEntries(request.headers.entries()),
      body: request.body ? await request.text() : '',
    };
    const vRes: VirtualResponse & { _donePromise?: Promise<void> } = {
      statusCode: 200,
      headers: {},
      body: '',
    };
    try {
      handler(vReq, vRes);
      if (vRes._donePromise) {
        const result = await waitForSignalOrTimeout(vRes._donePromise, request.signal, 30_000);
        if (result.type === 'aborted') return { kind: 'aborted' };
        if (result.type === 'timeout') return { kind: 'timeout' };
      }
    } catch {
      return { kind: 'refused' };
    }
    const status = vRes.statusCode;
    const body = (status === 204 || status === 304) ? null : vRes.body;
    return {
      kind: 'response',
      response: new Response(body, {
        status,
        statusText: statusText(status),
        headers: vRes.headers,
      }),
    };
  }

  if (kernel.routeLoopback) {
    const routed = await waitForSignalOrTimeout(
      kernel.routeLoopback(port, request),
      request.signal,
      30_000,
    );
    if (routed.type === 'aborted') return { kind: 'aborted' };
    if (routed.type === 'timeout') return { kind: 'timeout' };
    if (routed.value) return { kind: 'response', response: routed.value };
  }

  return { kind: 'refused' };
}

/** How many redirects a walk follows before it gives up: curl's and wget's default. */
export const MAX_REDIRECTS = 20;

/** Request headers fetch-follow strips when a redirect crosses origins. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'cookie2'];

/** Content headers that only make sense on a request that carries a body. */
const CONTENT_HEADERS = ['content-type', 'content-length', 'transfer-encoding', 'expect'];

/** A request as it goes from hop to hop of a redirect walk. */
export interface HopRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: string;
}

/** One hop's request init, as fetch and the port registry take it: GET and HEAD carry no body. */
export function hopInit(hop: HopRequest, signal: AbortSignal): RequestInit {
  const hasBody = hop.method !== 'GET' && hop.method !== 'HEAD' && hop.body !== undefined;
  return { method: hop.method, headers: hop.headers, body: hasBody ? hop.body : undefined, redirect: 'manual', signal };
}

/**
 * One hop as a kernel serves it: a loopback URL (by name through its
 * resolver) from its port registry or loopback router, refused there if
 * nothing listens, never fetched; any other with fetch. With no kernel,
 * every hop is fetched.
 */
export async function sendHop(
  kernel: Pick<Kernel, 'portRegistry' | 'routeLoopback'> & Partial<Pick<Kernel, 'dns'>> | undefined,
  url: URL,
  init: RequestInit,
): Promise<WorkspaceRequestResult> {
  const port = kernel ? workspaceRequestPort(kernel, url) : null;
  if (kernel && port !== null) return await dispatchWorkspaceRequest(kernel, port, new Request(url, init));
  return { kind: 'response', response: await fetch(url, init) };
}

/** Where a walk ended: its final response and the URL it came from, the hop that failed, or the cap. */
export type RedirectWalkResult =
  | { kind: 'response'; response: Response; url: URL }
  | { kind: 'refused'; url: URL }
  | { kind: 'aborted'; url: URL }
  | { kind: 'timeout'; url: URL }
  | { kind: 'too-many-redirects' };

/**
 * Send `start`, and while `follow` holds and the answer is a 3xx with a
 * Location, send the request it redirects to, at most MAX_REDIRECTS times.
 * `send` serves one hop (the caller's policy: loopback, a gateway, fetch);
 * `arrived` sees each response before its body is read or dropped. A hop
 * is rewritten as fetch-follow rewrites it: 301 and 302 make a POST a
 * bodyless GET, 303 makes anything but HEAD one, content headers go with
 * the body, and credential headers when the hop crosses origins. A
 * redirect without a usable Location is final; a followed one's body is
 * cancelled.
 */
export async function walkRedirects(
  start: HopRequest,
  options: {
    follow: boolean;
    send: (hop: HopRequest) => Promise<WorkspaceRequestResult>;
    arrived?: (response: Response) => Promise<void>;
  },
): Promise<RedirectWalkResult> {
  const hop: HopRequest = { ...start, headers: new Headers(start.headers) };
  for (let redirects = 0; ; redirects++) {
    const result = await options.send(hop);
    if (result.kind !== 'response') return { kind: result.kind, url: hop.url };
    const { response } = result;
    await options.arrived?.(response);
    const location = options.follow && response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null;
    if (!location) return { kind: 'response', response, url: hop.url };
    if (redirects === MAX_REDIRECTS) {
      response.body?.cancel().catch(() => {});
      return { kind: 'too-many-redirects' };
    }
    let next: URL;
    try {
      next = new URL(location, hop.url);
    } catch {
      return { kind: 'response', response, url: hop.url };
    }
    response.body?.cancel().catch(() => {});
    if (([301, 302].includes(response.status) && hop.method === 'POST') || (response.status === 303 && hop.method !== 'HEAD')) {
      hop.method = 'GET';
      hop.body = undefined;
    }
    if (hop.body === undefined) for (const name of CONTENT_HEADERS) hop.headers.delete(name);
    if (next.origin !== hop.url.origin) for (const name of CREDENTIAL_HEADERS) hop.headers.delete(name);
    hop.url = next;
  }
}
