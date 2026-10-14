/**
 * kernel-fetch.ts — the workspace-local request dispatcher.
 *
 * curl and wget are each bound to one kernel, and a loopback hop — including
 * one a redirect lands on — is served by that kernel's port registry or its
 * host's loopback router, never by fetch; any other hop goes off the box
 * through the workspace's network. The outcome is explicit rather
 * than null: 'aborted' and 'timeout' surface to the caller's own reporting
 * instead of being mistaken for "no listener".
 */

import {
  isLoopbackHost,
  type Kernel,
  type VirtualRequest,
  type VirtualRequestHandler,
  type VirtualResponse,
} from '../../kernel/index.js';
import { waitForSignalOrTimeout } from '../signal.js';
import { ISOLATE_NETWORK } from '../../../../_shared/workspace-network.js';
import { applyRedirectPolicy, isRedirectStatus } from '../../../../runtime/http-redirect-policy.js';

/** Outcomes of one workspace-local hop, for callers that report failure. */
export type WorkspaceRequestResult =
  | { kind: 'response'; response: Response }
  | { kind: 'refused' }
  | { kind: 'aborted' }
  | { kind: 'timeout' };

/**
 * How a server of a port registry took a request: its response, with the end
 * still to wait for when its handler returned before ending it (the
 * _donePromise a ServerResponse attaches while the response is open); or a
 * refusal, when the handler threw.
 */
export type Served =
  | { kind: 'served'; response: VirtualResponse; end: Promise<void> | null }
  | { kind: 'refused' };

/** `request` handed to `handler`, a server of a port registry, synchronously, as a server takes a request. */
export function serveFromPort(handler: VirtualRequestHandler, request: VirtualRequest): Served {
  const response: VirtualResponse & { _donePromise?: Promise<void> } = { statusCode: 200, headers: {}, body: '' };
  try {
    handler(request, response);
  } catch {
    return { kind: 'refused' };
  }
  return { kind: 'served', response, end: response._donePromise ?? null };
}

/**
 * The wait for a served response's `end`, however late its handler ends it,
 * unless `signal` aborts first or 30 s pass: `ended`, or how the wait stopped.
 */
export async function awaitServedEnd(end: Promise<void>, signal: AbortSignal): Promise<'ended' | 'refused' | 'aborted' | 'timeout'> {
  try {
    const result = await waitForSignalOrTimeout(end, signal, 30_000);
    return result.type === 'aborted' ? 'aborted' : result.type === 'timeout' ? 'timeout' : 'ended';
  } catch {
    return 'refused';
  }
}

/** A served response's body as HTTP carries it: none for 204 and 304. */
export function servedBody(response: VirtualResponse): string | null {
  return response.statusCode === 204 || response.statusCode === 304 ? null : response.body;
}

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
const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error',
  502: 'Bad Gateway', 503: 'Service Unavailable',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? '';
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
    const url = new URL(request.url);
    const served = serveFromPort(handler, {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      body: request.body ? await request.text() : '',
    });
    if (served.kind === 'refused') return served;
    const ended = served.end === null ? 'ended' : await awaitServedEnd(served.end, request.signal);
    if (ended !== 'ended') return { kind: ended };
    const status = served.response.statusCode;
    return {
      kind: 'response',
      response: new Response(servedBody(served.response), {
        status,
        statusText: statusText(status),
        headers: served.response.headers,
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
 * nothing listens, never fetched; any other off the box through the
 * network of the command's process `pid` (its host's egress, when it
 * supplied one). With no kernel, every hop goes through the isolate's own
 * network.
 */
export async function sendHop(
  kernel: Pick<Kernel, 'portRegistry' | 'routeLoopback' | 'network'> & Partial<Pick<Kernel, 'dns'>> | undefined,
  pid: number,
  url: URL,
  init: RequestInit,
): Promise<WorkspaceRequestResult> {
  const port = kernel ? workspaceRequestPort(kernel, url) : null;
  if (kernel && port !== null) return await dispatchWorkspaceRequest(kernel, port, new Request(url, init));
  return { kind: 'response', response: await (kernel?.network ?? ISOLATE_NETWORK).forProcess(pid).fetch(url, init) };
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
    const location = options.follow && isRedirectStatus(response.status, 'command')
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
    applyRedirectPolicy(hop, response.status, next, 'command');
  }
}
