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

import { isLoopbackHost, type Kernel } from '../../kernel/index.js';
import {
  awaitServedEnd,
  routeToLoopback,
  serveFromPort,
  servedReason,
  type WorkspaceRequestResult,
} from '../../kernel/local-serve.js';
import { ISOLATE_NETWORK } from '../../../../_shared/workspace-network.js';
import { isNullBodyStatus } from '../../../../_shared/null-body-status.js';
import { followRedirects, type RedirectHop, type RedirectWalk } from '../../../../runtime/http-redirect-policy.js';

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
    if (served === null) return { kind: 'refused' };
    // An aborted request is aborted, though its handler has already ended the response.
    if (request.signal.aborted) return { kind: 'aborted' };
    const ended = served._donePromise === undefined ? 'ended' : await awaitServedEnd(served._donePromise, request.signal);
    if (ended !== 'ended') return { kind: ended };
    const status = served.statusCode;
    return {
      kind: 'response',
      response: new Response(isNullBodyStatus(status) ? null : served.body, {
        status,
        statusText: servedReason(served),
        headers: served.headers,
      }),
    };
  }

  return kernel.routeLoopback ? await routeToLoopback(kernel.routeLoopback, port, request) : { kind: 'refused' };
}

/** One hop's request init, as fetch and the port registry take it: GET and HEAD carry no body. */
export function hopInit(hop: RedirectHop<string>, signal: AbortSignal): RequestInit {
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

/** Where a command's walk ended: its final response and the URL it came from, the hop that failed, or the cap. */
export type RedirectWalkResult = RedirectWalk<'refused' | 'aborted' | 'timeout'>;

/**
 * Send `start`, and while `follow` holds, the requests its redirects make,
 * as a command follows them (followRedirects' 'command' policy): any 3xx
 * whose Location parses, 301 and 302 making a POST a bodyless GET and 303
 * anything but HEAD one, content headers going with the body and
 * credential headers when a hop crosses origins. `send` serves one hop
 * (the caller's policy: loopback, a gateway, fetch); `arrived` sees each
 * response before its body is read or dropped.
 */
export async function walkRedirects(
  start: RedirectHop<string>,
  options: {
    follow: boolean;
    send: (hop: RedirectHop<string>) => Promise<WorkspaceRequestResult>;
    arrived?: (response: Response) => Promise<void>;
  },
): Promise<RedirectWalkResult> {
  return await followRedirects(start, 'command', {
    follow: options.follow,
    arrived: options.arrived,
    send: async (hop) => {
      const result = await options.send(hop);
      return result.kind === 'response' ? result.response : result.kind;
    },
  });
}
