/**
 * apps/probe/src/index.ts — authenticated behavioral-probe target.
 *
 * A minimal Nimbus embedder with JWT auth enforced and the remote SDK
 * API enabled. CI and local behavioral runs point BASE at this Worker
 * so the public hosted demo can stay behind interactive Cloudflare
 * login. Probes clean up with `DELETE /s/<id>/`, the core router's
 * session destroy. Aside from the embedder-worker route below, this is
 * exactly the shape a third-party embedder ships.
 *
 * The class re-exports let wrangler and `enable_ctx_exports` discover
 * the DO/RPC classes from the main module — see apps/hosted-demo.
 */
import {
  NimbusSession as SdkNimbusSession,
  NimbusPublicDirectory,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
  createNimbusHandler,
} from '@nimbus-sh/sdk/worker';
import { Nimbus } from '@nimbus-sh/sdk';
import {
  verifyRequestToken,
  requireScopes,
  requireSessionPin,
  authErrorResponse,
  NimbusAuthError,
} from '@nimbus-sh/worker/auth';

import { WorkerEntrypoint } from 'cloudflare:workers';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { CANARY_PROJECT, CANARY_WHEEL, canaryPypiJson, canaryWheel } from './egress-canary.js';

/**
 * The host the test egress answers itself: unresolvable anywhere else, so a
 * request that reaches it went through the egress.
 */
const EGRESS_TEST_HOST = 'egress-test.invalid';

/** What the egress answers a plain-HTTP request to EGRESS_TEST_HOST with, over TCP: the canary wheel, or its request line. */
function egressTcpHttpResponse(requestLine: string): Uint8Array {
  const [method = '', path = ''] = requestLine.split(' ');
  const wheel = method === 'GET' && path === `/${CANARY_WHEEL}`;
  const body = wheel ? canaryWheel() : new TextEncoder().encode(`via-egress-tcp ${method} ${path}`);
  const head = new TextEncoder().encode(
    `HTTP/1.1 200 OK\r\ncontent-type: ${wheel ? 'application/octet-stream' : 'text/plain'}\r\n`
    + `content-length: ${body.byteLength}\r\nconnection: close\r\n\r\n`,
  );
  const response = new Uint8Array(head.byteLength + body.byteLength);
  response.set(head);
  response.set(body, head.byteLength);
  return response;
}

/** The request line of the HTTP request at the head of `readable` (read to its blank line). */
async function readRequestLine(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  let text = '';
  while (!text.includes('\r\n\r\n')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split('\r\n', 1)[0] ?? '';
}

/**
 * A recording egress for tests (NIMBUS_TEST_EGRESS=1): it answers
 * EGRESS_TEST_HOST itself (HTTP, encoded bodies at /encoded-<gzip|br|deflate>,
 * WebSocket upgrades and an echo server at /ws-echo, a refused upgrade at
 * /ws-refused (and held open at /ws-refused-open, /ws-refused-64k, and after
 * 2 s at /ws-refused-slow), an
 * echo answered after 2 s at /ws-slow, plain TCP on port 7, plain
 * HTTP over TCP on port 80) and PyPI's metadata for its canary project
 * (egress-canary.ts), and sends everything else on to the network, so a
 * session under it can still install packages. What an embedder supplies is
 * the same shape: a Fetcher, minted per session with its identity in props.
 */
export class TestEgress extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'pypi.org' && (url.pathname === `/pypi/${CANARY_PROJECT}/json` || url.pathname === `/pypi/${CANARY_PROJECT}/1.0/json`)) {
      return Response.json(canaryPypiJson(`http://${EGRESS_TEST_HOST}/${CANARY_WHEEL}`));
    }
    if (url.hostname !== EGRESS_TEST_HOST) return fetch(request);
    const encoding = /^\/encoded-(gzip|br|deflate)$/.exec(url.pathname)?.[1];
    if (encoding !== undefined) {
      // As a server compresses: the body encoded, sent as it is (encodeBody 'manual').
      const zlib = await import('node:zlib');
      const json = JSON.stringify({ encoding, accepted: request.headers.get('accept-encoding') });
      const body = encoding === 'gzip' ? zlib.gzipSync(json) : encoding === 'br' ? zlib.brotliCompressSync(json) : zlib.deflateSync(json);
      return new Response(body, { headers: { 'content-type': 'application/json', 'content-encoding': encoding }, encodeBody: 'manual' });
    }
    if (url.pathname === '/ws-refused') {
      return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    }
    // A refusal whose body is sent and then held open: a short one, or exactly 64 KiB, or a short one after 2 s.
    if (url.pathname === '/ws-refused-slow') await new Promise((resolve) => setTimeout(resolve, 2000));
    if (url.pathname === '/ws-refused-open' || url.pathname === '/ws-refused-64k' || url.pathname === '/ws-refused-slow') {
      const body = url.pathname === '/ws-refused-64k' ? new Uint8Array(65536).fill(97) : new TextEncoder().encode('partial');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(body); } }),
        { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'text/plain' } });
    }
    // An upgrade answered after 2 s.
    if (url.pathname === '/ws-slow') await new Promise((resolve) => setTimeout(resolve, 2000));
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].binaryType = 'arraybuffer';
      if (url.pathname === '/ws-echo' || url.pathname === '/ws-slow') {
        // An echo server, as a test's host-side twin answers: a message back
        // as it came; 'headers' answers with the upgrade's Authorization and
        // Origin; 'close' closes 4001 'bye'; the first subprotocol offered.
        pair[1].addEventListener('message', (event) => {
          if (event.data === 'headers') pair[1].send(JSON.stringify({ authorization: request.headers.get('authorization'), origin: request.headers.get('origin') }));
          else if (event.data === 'close') pair[1].close(4001, 'bye');
          else pair[1].send(event.data);
        });
        const protocol = request.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim();
        return new Response(null, { status: 101, webSocket: pair[0], headers: protocol ? { 'sec-websocket-protocol': protocol } : {} });
      }
      pair[1].addEventListener('message', (event) => pair[1].send(`via-egress:${String(event.data)}`));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(`via-egress ${request.method} ${url.pathname}`, { headers: { 'x-nimbus-test-egress': 'yes' } });
  }

  async connect(socket: Socket): Promise<void> {
    const { localAddress } = await socket.opened as { localAddress?: string };
    if (localAddress === `${EGRESS_TEST_HOST}:80`) {
      const response = egressTcpHttpResponse(await readRequestLine(socket.readable));
      const writer = socket.writable.getWriter();
      await writer.write(response);
      await writer.close();
      return;
    }
    if (localAddress?.startsWith(`${EGRESS_TEST_HOST}:`)) {
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode('via-egress-tcp\n'));
      await writer.close();
      return;
    }
    // Loaded here, not at the top: a module that imports this app (a test's) need not provide sockets.
    const { connect } = await import('cloudflare:sockets');
    const upstream = connect(localAddress!, { allowHalfOpen: true });
    await Promise.all([socket.readable.pipeTo(upstream.writable), upstream.readable.pipeTo(socket.writable)]).catch(() => {});
  }
}

/**
 * The SDK's session, its workspace under the test egress when the probe runs
 * with NIMBUS_TEST_EGRESS=1, as an embedder that names each session to its
 * egress would write it.
 */
export class NimbusSession extends SdkNimbusSession {
  /** The embedder mount at /mnt/data, made once per instance with its filesystem. */
  #dataMounted = false;

  /**
   * The session's filesystem, with the embedder-mount surface the probes
   * exercise: a MemoryVFS at /mnt/data, as an embedder mounts its own
   * filesystem (CompositeVFS.mount). Its limits are the probe's, not a
   * mount's: it is not durable (an isolate reset empties it) and it lives
   * in the session DO's heap, so only small repositories and files go there.
   */
  override getFilesystemAuthority() {
    const files = super.getFilesystemAuthority();
    if (!this.#dataMounted) {
      files.vfs.mount('/mnt/data', new MemoryVFS({ uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid }));
      this.#dataMounted = true;
    }
    return files;
  }

  protected override workspaceEgress() {
    if ((this.env as { NIMBUS_TEST_EGRESS?: string }).NIMBUS_TEST_EGRESS !== '1') return super.workspaceEgress();
    return (this.ctx as unknown as { exports: { TestEgress(options: { props: object }): Fetcher } })
      .exports.TestEgress({ props: { session: this.ctx.id.toString() } });
  }
}

export {
  NimbusPublicDirectory,
  SupervisorRPC,
  NimbusAssetsRPC,
  NimbusLoaderRPC,
  NimbusLoadedWorker,
  NimbusLoadedEntrypoint,
  NimbusDurableObjectNamespace,
  NimbusDOStub,
  CirrusHmrRPC,
};

const nimbus = createNimbusHandler({
  auth: { mode: 'enforce' },
  sdk: { remote: true },
});

const EMBEDDER_WORKER_RE = /^\/api\/embedder\/([A-Za-z0-9._-]+)\/spawn-worker$/;

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'POST') {
      const match = EMBEDDER_WORKER_RE.exec(new URL(request.url).pathname);
      if (match) return spawnEmbedderWorker(request, env, match[1]);
    }
    return nimbus.fetch(request, env, ctx);
  },
};

/**
 * POST /api/embedder/<id>/spawn-worker — what a colocated embedder does with
 * the session's programmatic `spawnWorker`, driven from outside so the
 * behavioral suite can observe it: a Worker-class program whose main module
 * is `runner.js` and whose `lib.js` is a content-addressed text module read
 * from the session filesystem by path, booted as a resident process; a
 * request through the returned facet; the pid killed; the facet dead after.
 * Requires a `sandbox:use` token pinned (or unpinned) to the session.
 */
async function spawnEmbedderWorker(request: Request, env: any, sessionId: string): Promise<Response> {
  try {
    const verified = await verifyRequestToken(request, env);
    if (!verified) return authRequiredResponse();
    requireScopes(verified, ['sandbox:use']);
    requireSessionPin(verified, sessionId);
    const tenant = verified.claims.tn;
    const subject = verified.claims.sub ?? '_';
    const box = Nimbus.fromEnv(env).sandbox(sessionId, { tenant, subject });
    await box.ready();

    // The text module lives on the session disk under its own digest — the
    // shape the loader verifies on read.
    const lib = 'export const answer = "forty-two";\n';
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lib))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const libPath = `/home/user/${digest}.js`;
    await box.files.write(libPath, lib);

    const runner = [
      'import { DurableObject } from "cloudflare:workers";',
      'import { answer } from "./lib.js";',
      'export class NimbusProcess extends DurableObject {',
      '  async startProcess() { return { ok: true, main: "runner.js", answer }; }',
      '  async fetch(req) { return this.handleHttpRequest(req); }',
      '  async handleHttpRequest(req) {',
      '    return Response.json({ main: "runner.js", answer, path: new URL(req.url).pathname });',
      '  }',
      '}',
    ].join('\n');

    // The same DO the SDK addresses, reached directly for the RPC the SDK's
    // remote surface does not carry.
    const stub = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(`${tenant}:${subject}:${sessionId}`));
    const spawned = await stub._rpcSpawnWorker(runner, 'embedder worker', '/home/user', {
      mainModule: 'runner.js',
      vfsTextModules: { 'lib.js': libPath },
    });
    const first = await spawned.facet.fetch(new Request('http://worker.local/hello?via=facet'));
    const firstBody = await first.json();
    const killed = await stub._rpcKillProcess(spawned.pid);
    let afterKill: { status: number } | { error: string };
    try {
      const second = await spawned.facet.fetch(new Request('http://worker.local/after-kill'));
      afterKill = { status: second.status };
    } catch (e) {
      afterKill = { error: e instanceof Error ? e.message : String(e) };
    }
    return Response.json(
      { pid: spawned.pid, boot: spawned.boot, first: { status: first.status, body: firstBody }, killed, afterKill, libPath },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof NimbusAuthError) return authErrorResponse(e);
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

function authRequiredResponse(): Response {
  return Response.json(
    { error: 'Authentication required', code: 'E_TOKEN_REQUIRED' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}
