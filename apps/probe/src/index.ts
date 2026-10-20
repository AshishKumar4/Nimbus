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
import { createNimbusHandler } from '@nimbus-sh/sdk/worker';
import { NimbusSession as SdkNimbusSession } from '@nimbus-sh/sdk/entrypoints';
export * from '@nimbus-sh/sdk/entrypoints';
import { Nimbus } from '@nimbus-sh/sdk';
import {
  verifyRequestToken,
  requireScopes,
  requireSessionPin,
  authErrorResponse,
  NimbusAuthError,
} from '@nimbus-sh/worker/auth';

import { WorkerEntrypoint } from 'cloudflare:workers';
import { measureGuestTails } from '@nimbus-sh/fabric/facet-limits.js';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { processHostMode } from '../../../packages/worker/src/loaders/process-host.js';
import { nimbusDebugEnabled } from '../../../packages/worker/src/_shared/nimbus-debug.js';
import { disposeRpcResource } from '../../../packages/platform/src/rpc-dispose.js';
import { peerPlacement } from '@nimbus-sh/fabric/process-host.js';
import { abortFacet } from '@nimbus-sh/fabric/workerd-facet-host.js';
import { z } from 'zod/v4';
import type { EgressProcess, EgressStreams, EgressTlsTarget, WorkspaceEgress, WorkspaceEgressTls } from '@nimbus-sh/core/_shared/workspace-network.js';
import { CANARY_PROJECT, CANARY_WHEEL, canaryPypiJson, canaryWheel } from './egress-canary.js';

/**
 * The host the test egress answers itself: unresolvable anywhere else, so a
 * request that reaches it went through the egress.
 */
const EGRESS_TEST_HOST = 'egress-test.invalid';
/** What test egresses were asked under /who/ (TestEgress), as `<path> <exec>`: one isolate's, for a test to read back. */
const WHO_SEEN: string[] = [];

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
/** Who a test egress was minted for: the session, and with a per-process egress (NIMBUS_TEST_EGRESS_PER_PROCESS=1) the process and its exec. */
interface TestEgressProps {
  session: string;
  pid?: number;
  execId?: string;
}

export class TestEgress extends WorkerEntrypoint<Cloudflare.Env, TestEgressProps> {
  /** The exec this egress was minted for, as its answers to /who, TCP port 9 and TLS /who name it: '-' for none. */
  protected who(): string {
    return this.ctx.props.execId ?? '-';
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'pypi.org' && (url.pathname === `/pypi/${CANARY_PROJECT}/json` || url.pathname === `/pypi/${CANARY_PROJECT}/1.0/json`)) {
      return Response.json(canaryPypiJson(`http://${EGRESS_TEST_HOST}/${CANARY_WHEEL}`));
    }
    if (url.hostname !== EGRESS_TEST_HOST) return fetch(request);
    // Which egress answered: /who itself, and any path under it refused with that name as text (git shows it as `remote:`).
    if (url.pathname === '/who' || url.pathname.startsWith('/who.')) {
      return new Response(`via-egress who ${this.who()}`, { status: url.pathname === '/who' ? 200 : 403, headers: { 'content-type': 'text/plain' } });
    }
    // Any other path under /who is recorded with the exec that asked; /who-seen lists them, oldest first.
    if (url.pathname.startsWith('/who/')) {
      WHO_SEEN.push(`${url.pathname.slice('/who/'.length)} ${this.who()}`);
      return Response.json({});
    }
    if (url.pathname === '/who-seen') return new Response(WHO_SEEN.join('\n'), { headers: { 'content-type': 'text/plain' } });
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
    if (localAddress === `${EGRESS_TEST_HOST}:9`) {
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(`via-egress-tcp who ${this.who()}\n`));
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

export class TestTlsEgress extends TestEgress implements WorkspaceEgressTls {
  override async connect(socket: Socket): Promise<void> {
    const { localAddress } = await socket.opened as { localAddress?: string };
    if (localAddress === 'tcp-refused.invalid:7') throw new Error('egress refused this TCP destination');
    if (localAddress === `${EGRESS_TEST_HOST}:7`) {
      const reader = socket.readable.getReader();
      const first = await reader.read();
      reader.releaseLock();
      const writer = socket.writable.getWriter();
      if (!first.done) await writer.write(first.value);
      await writer.close();
      return;
    }
    if (localAddress !== `${EGRESS_TEST_HOST}:443`) return super.connect(socket);
    await readRequestLine(socket.readable);
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode('plain-egress-ready\n'));
    await socket.closed.catch(() => {});
    writer.releaseLock();
  }

  async connectTls(target: EgressTlsTarget): Promise<EgressStreams> {
    if (target.hostname === 'tls-refused.invalid') throw new Error('egress refused this TLS destination');
    if (target.hostname !== EGRESS_TEST_HOST) {
      // Any other server, as an embedder's egress reaches it: the session presents the servername and checks the server by it.
      const { connect } = await import('cloudflare:sockets');
      const address = { hostname: target.hostname, port: target.port };
      const socket = target.servername === undefined
        ? connect(address, { secureTransport: 'on', allowHalfOpen: true })
        : connect(address, { secureTransport: 'starttls', allowHalfOpen: true }).startTls({ expectedServerHostname: target.servername });
      await socket.opened;
      return { readable: socket.readable, writable: socket.writable };
    }
    if (target.port !== 443) throw new Error('unexpected TLS destination');
    let reply: ReadableByteStreamController;
    let input = '';
    // The name the session presents and checks the server by, when the program named one other than the host.
    const named = target.servername === undefined ? '' : ' as ' + target.servername;
    const who = this.who();
    return {
      readable: new ReadableStream<Uint8Array>({ type: 'bytes', start(controller) { reply = controller; } }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          input += new TextDecoder().decode(chunk);
          if (!input.includes('\r\n\r\n')) return;
          const line = input.split('\r\n', 1)[0] ?? '';
          const answer = line.split(' ')[1] === '/who' ? 'via-egress-tls who ' + who : 'via-egress-tls ' + target.hostname + ':' + target.port + named + ' ' + line;
          reply.enqueue(new TextEncoder().encode(answer + '\n'));
          reply.close();
        },
      }),
    };
  }
}

/**
 * Measurement: every Worker the fabric creates reports here (measureGuestTails),
 * so each guest invocation's CPU, wall time, outcome and measure lines land in
 * this Worker's logs, read back by the observability API.
 */
export class GuestTail extends WorkerEntrypoint<Cloudflare.Env, { kind: string }> {
  tail(events: TraceItem[]): void {
    for (const event of events) {
      const logs: string[] = [];
      for (const log of event.logs) {
        const text = log.message.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ');
        if (text.startsWith('[fs-measure]') || text.startsWith('[mem-probe]')) logs.push(text);
      }
      const info = event.event as { rpcMethod?: string; request?: { url?: string } } | null;
      console.log(JSON.stringify({
        guestTail: this.ctx.props.kind,
        at: event.eventTimestamp,
        cpuMs: event.cpuTime,
        wallMs: event.wallTime,
        outcome: event.outcome,
        entrypoint: event.entrypoint ?? null,
        model: event.executionModel,
        rpc: info?.rpcMethod ?? null,
        url: info?.request?.url ?? null,
        exceptions: event.exceptions.slice(0, 3).map((e) => `${e.name}: ${e.message}`.slice(0, 300)),
        logs,
      }));
    }
  }
}

/** The SDK's session under the embedder's per-session test egress. */
export class NimbusSession extends SdkNimbusSession {
  constructor(...args: ConstructorParameters<typeof SdkNimbusSession>) {
    super(...args);
    const ctx = args[0] as unknown as { exports: { GuestTail(options: { props: { kind: string } }): Fetcher } };
    measureGuestTails((props) => ctx.exports.GuestTail({ props }));
  }

  private requireProbeDiagnostics(): void {
    if (!this.nimbusDebug) throw new Error('probe diagnostics are disabled');
  }
  _rpcProbePlacement(pid: number) {
    this.requireProbeDiagnostics();
    return peerPlacement(this.ctx, pid);
  }
  _rpcProbeCoordinatorReset(): never {
    this.requireProbeDiagnostics();
    this.ctx.abort('probe: coordinator reset');
  }
  async _rpcProbePeer(workerKey: string, action: 'inspect' | 'facet-reset' | 'host-reset', coordinator: string) {
    this.requireProbeDiagnostics();
    const current = await this.peerHost.inspect(workerKey);
    if (!current.found) return current;
    if (current.coordinator !== coordinator) throw new Error('the probe placement belongs to another coordinator');
    if (action === 'host-reset') this.ctx.abort('probe: hosting actor reset');
    if (action === 'facet-reset') {
      if (current.facet === null) throw new Error('the probe process is already absent');
      abortFacet(this.ctx, current.facet,
        Object.assign(new Error('Durable Object reset because its code was updated.'), { durableObjectReset: true }));
    }
    return current;
  }
  /**
   * The session's filesystem, with the embedder-mount surface the probes
   * exercise: a MemoryVFS at /mnt/data, as an embedder mounts its own
   * filesystem (CompositeVFS.mount). Its limits are the probe's, not a
   * mount's: it is not durable (an isolate reset empties it) and it lives
   * in the session DO's heap, so only small repositories and files go there.
   */
  override getFilesystemAuthority() {
    const files = super.getFilesystemAuthority();
    if (!files.vfs.mounts().some((mount) => mount.point === '/mnt/data')) {
      files.vfs.mount('/mnt/data', new MemoryVFS({ uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid }));
    }
    return files;
  }

  protected override workspaceEgress() {
    if ((this.env as { NIMBUS_TEST_EGRESS?: string }).NIMBUS_TEST_EGRESS !== '1') return super.workspaceEgress();
    return this.#testEgress({ session: this.ctx.id.toString() });
  }

  /** With NIMBUS_TEST_EGRESS_PER_PROCESS=1, each process's own test egress, minted with its pid and exec. */
  protected override egressFor(process: EgressProcess): WorkspaceEgress | undefined {
    if ((this.env as { NIMBUS_TEST_EGRESS_PER_PROCESS?: string }).NIMBUS_TEST_EGRESS_PER_PROCESS !== '1') return undefined;
    return this.#testEgress({ session: this.ctx.id.toString(), pid: process.pid, ...(process.execId === undefined ? {} : { execId: process.execId }) });
  }

  #testEgress(props: TestEgressProps): Fetcher {
    if ((this.env as { NIMBUS_TEST_EGRESS_TLS?: string }).NIMBUS_TEST_EGRESS_TLS === '1') {
      return (this.ctx as unknown as { exports: { TestTlsEgress(options: { props: TestEgressProps }): Fetcher } })
        .exports.TestTlsEgress({ props });
    }
    return (this.ctx as unknown as { exports: { TestEgress(options: { props: TestEgressProps }): Fetcher } })
      .exports.TestEgress({ props });
  }
}

const nimbus = createNimbusHandler({
  auth: { mode: 'enforce' },
  sdk: { remote: true },
});

const EMBEDDER_WORKER_RE = /^\/api\/embedder\/([A-Za-z0-9._-]+)\/(spawn-worker|host-loss|quiet-websocket)$/;
type ProbeEnv = Omit<Parameters<typeof nimbus.fetch>[1], 'NIMBUS_SESSION'> & {
  NIMBUS_SESSION: DurableObjectNamespace<NimbusSession>;
  NIMBUS_DEBUG?: string;
};
const HostLossProbe = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mode') }),
  z.object({ action: z.enum(['inspect', 'state', 'facet-reset', 'host-reset', 'coordinator-reset']), pid: z.number().int().positive().safe() }),
  z.object({ action: z.literal('placement-state'), peerName: z.string(), workerKey: z.string() }),
]);

// Readiness replies carry x-nimbus-version from createNimbusHandler itself.
export default {
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
    const match = request.method === 'POST' ? EMBEDDER_WORKER_RE.exec(new URL(request.url).pathname) : null;
    if (!match) return nimbus.fetch(request, env, ctx);
    return match[2] === 'host-loss' ? probeHostLoss(request, env, match[1])
      : match[2] === 'quiet-websocket' ? spawnQuietWebSocket(request, env, match[1]) : spawnEmbedderWorker(request, env, match[1]);
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

async function probeHostLoss(request: Request, env: ProbeEnv, sessionId: string): Promise<Response> {
  let owner: DurableObjectStub<NimbusSession> | undefined;
  try {
    if (!nimbusDebugEnabled(env)) return new Response('Not found', { status: 404 });
    const verified = await verifyRequestToken(request, env);
    if (!verified) return authRequiredResponse();
    requireScopes(verified, ['sandbox:use']);
    requireSessionPin(verified, sessionId);
    const parsed = HostLossProbe.safeParse(await request.json());
    if (!parsed.success) return new Response('Bad probe request', { status: 400 });
    const input = parsed.data;
    if (input.action === 'mode') return Response.json({ mode: processHostMode(env) });
    const coordinator = env.NIMBUS_SESSION.idFromName(`${verified.claims.tn}:${verified.claims.sub ?? '_'}:${sessionId}`).toString();
    if (input.action === 'placement-state') {
      const peer = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(input.peerName));
      try { return Response.json(await peer._rpcProbePeer(input.workerKey, 'inspect', coordinator)); }
      finally { disposeRpcResource(peer); }
    }
    owner = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromString(coordinator));
    const rows = await owner._rpcListProcesses();
    const process = rows.find((row) => row.pid === input.pid);
    if (!process) return new Response('Unknown process', { status: 404 });
    if (input.action === 'state') return Response.json(process);
    const placement = await owner._rpcProbePlacement(input.pid);
    if (!placement) return new Response('Peer process not found', { status: 404 });
    if (input.action === 'coordinator-reset') {
      try { await owner._rpcProbeCoordinatorReset(); }
      catch { return Response.json({ reset: true, placement }); }
      throw new Error('the coordinator reset returned normally');
    }
    const peer = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(placement.peerName));
    try {
      const before = await peer._rpcProbePeer(placement.workerKey, 'inspect', coordinator);
      if (!before.found) return new Response('Peer process not found', { status: 404 });
      if (input.action === 'inspect') return Response.json({ ...before, placement });
      try {
        return Response.json(await peer._rpcProbePeer(placement.workerKey, input.action, coordinator));
      } catch (error) {
        if (input.action !== 'host-reset') throw error;
        const fresh = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(placement.peerName));
        try {
          const after = await fresh._rpcProbePeer(placement.workerKey, 'inspect', coordinator);
          if (after.incarnation === before.incarnation) throw new Error('the hosting actor did not reset');
          return Response.json({ reset: true, before: before.incarnation, after: after.incarnation });
        } finally { disposeRpcResource(fresh); }
      }
    } finally { disposeRpcResource(peer); }
  } catch (error) {
    if (error instanceof NimbusAuthError) return authErrorResponse(error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally { disposeRpcResource(owner); }
}

async function spawnQuietWebSocket(request: Request, env: ProbeEnv, sessionId: string): Promise<Response> {
  let stub: DurableObjectStub<NimbusSession> | undefined;
  try {
    const verified = await verifyRequestToken(request, env);
    if (!verified) return authRequiredResponse();
    requireScopes(verified, ['sandbox:use']); requireSessionPin(verified, sessionId);
    const box = Nimbus.fromEnv(env).sandbox(sessionId, { tenant: verified.claims.tn, subject: verified.claims.sub ?? '_' });
    await box.ready();
    stub = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(`${verified.claims.tn}:${verified.claims.sub ?? '_'}:${sessionId}`));
    const code = `import { DurableObject } from 'cloudflare:workers';
export class NimbusProcess extends DurableObject {
  nonce = crypto.randomUUID();
  startProcess() { return { nonce: this.nonce }; }
  handleHttpRequest() { return Response.json(this.startProcess()); }
  fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return this.handleHttpRequest(request);
    const [client, server] = Object.values(new WebSocketPair());
    server.addEventListener('message', () => server.send(JSON.stringify(this.startProcess())));
    server.addEventListener('close', () => server.close());
    server.accept(); server.send(JSON.stringify(this.startProcess()));
    return new Response(null, { status: 101, webSocket: client });
  }
}`;
    const spawned = await stub._rpcSpawnWorker(code, 'quiet preview socket', '/home/user', { port: 3248 });
    try { return Response.json({ pid: spawned.pid, port: 3248, boot: z.object({ nonce: z.string().uuid() }).parse(spawned.boot) }); }
    finally { disposeRpcResource(spawned); }
  } catch (error) {
    if (error instanceof NimbusAuthError) return authErrorResponse(error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally { disposeRpcResource(stub); }
}

function authRequiredResponse(): Response {
  return Response.json(
    { error: 'Authentication required', code: 'E_TOKEN_REQUIRED' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}
