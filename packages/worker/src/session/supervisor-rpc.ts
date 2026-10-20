import { WorkerEntrypoint } from 'cloudflare:workers';
import type { HostRoute } from '@nimbus-sh/platform/composition.js';
import { traced } from '@nimbus-sh/platform/tracing.js';
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hostNamespaceBinding, hostOpDispatch } from '@nimbus-sh/fabric/host-dispatch.js';
import { idempotent } from '@nimbus-sh/fabric/do-calls.js';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { FILESYSTEM_METHODS, FilesystemMethod } from '@nimbus-sh/core/runtime/filesystem-methods.js';
import type { RuntimeFsBridge, RuntimeMutationOwner } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type RecordedResponse, type RecordedBody } from '../runtime/stop-replay-contracts.js';
import { ReplayBodyRecord, recordFailure, failureOf } from '../runtime/stop-replay-body.js';
// Every symbol the mixin's methods are keyed by is imported, though not all
// are used here: the class's declaration names them.
import {
  supervisorCalls, TRANSPORT, OP, CALLER, FS_OP, FS_READ, FS_MUTATION, RESENT, MUTATION_OWNER, HOST_INCARNATION, REPORTING_PID, CALL, CACHE_READ, INFRASTRUCTURE_CACHE, NETWORK, PID, RUN_ID,
  type Resend, type SupervisorTransport,
} from './supervisor-calls.js';

/**
 * Runs whose network the session no longer records: each did something
 * outside itself, so it cannot be run again and nothing it reads is checked
 * (worker runtime/stop-replay.ts ReplayJournal.disqualify). Its requests and
 * connections go straight out, without asking the session first. A run's
 * identity is never reused; the oldest are forgotten past the bound (a
 * forgotten run only asks again).
 */
const UNRECORDED_RUNS = new Set<string>();
const UNRECORDED_RUNS_MAX = 4096;
function unrecorded(run: string): void {
  if (UNRECORDED_RUNS.size >= UNRECORDED_RUNS_MAX) {
    const oldest = UNRECORDED_RUNS.values().next().value;
    if (oldest !== undefined) UNRECORDED_RUNS.delete(oldest);
  }
  UNRECORDED_RUNS.add(run);
}

/** A fresh stub for the host, by the route the props carry: they were minted in the host's isolate. */
function hostStub(props: unknown, env: unknown): object {
  const doId = (props as { doId?: unknown } | undefined)?.doId;
  if (typeof doId !== 'string' || doId.length === 0) {
    throw new Error('SupervisorRPC: missing doId in props');
  }
  const namespace = hostNamespaceBinding(env as object, 'SupervisorRPC', routeOf(props));
  return namespace.get(namespace.idFromString(doId));
}

function routeOf(props: unknown): HostRoute | undefined {
  return (props as { route?: HostRoute } | undefined)?.route;
}

/**
 * `envelope` on a fresh stub; a re-sent one again on another while the
 * platform drops it retryably, in the span that classifies a lost call:
 * `nimbus.supervisor.<kind>`, naming which process and writer sent which
 * operation under which id, how many attempts it took, whether a hedge
 * fired, which attempt answered, and how each lost one failed (fabric
 * do-calls `span`). The session's side of a delivery or a read is its
 * `nimbus.session.*` span, under the RPC span of the attempt that reached it.
 */
function sendToHost(props: unknown, env: unknown, envelope: SupervisorOpEnvelope, resend?: Resend): Promise<unknown> {
  if (!resend) {
    const host = hostStub(props, env);
    return useRpcResource(Promise.resolve(host), (stub) => hostOpDispatch(stub, 'SupervisorRPC', routeOf(props))(envelope));
  }
  const operation = envelope.delivery?.op ?? envelope.op;
  // The binding's props, minted by supervisorBindingProps: attribute values only, nothing trusted.
  const doId = typeof props === 'object' && props !== null && 'doId' in props && typeof props.doId === 'string'
    ? props.doId : undefined;
  const writerId = typeof props === 'object' && props !== null && 'writerId' in props && typeof props.writerId === 'string'
    ? props.writerId : undefined;
  return traced(`nimbus.supervisor.${resend.trace.kind}`, {
    'nimbus.op': operation,
    'nimbus.pid': envelope.pid,
    'nimbus.session_do': doId,
    'nimbus.writer_id': envelope.writerId ?? writerId,
    'nimbus.operation_id': resend.trace.operationId,
    'nimbus.host_incarnation': envelope.delivery?.hostIncarnation,
    'nimbus.read_id': envelope.readId,
  }, (span) => idempotent(
    operation,
    () => hostStub(props, env),
    (host) => hostOpDispatch(host, 'SupervisorRPC', routeOf(props))(envelope),
    { ...resend.policy, span },
  ));
}

/**
 * A process's SUPERVISOR as a service binding (`env.SUPERVISOR`), and its
 * network when it is the process's globalOutbound. The platform serves it
 * from whichever isolate it likes, so every call reaches the host on a fresh
 * Durable Object stub, by the route its props carry, as a new request there.
 */
export class SupervisorRPC extends supervisorCalls(WorkerEntrypoint) {
  [TRANSPORT](): SupervisorTransport {
    const props = this.ctx.props;
    const env = this.env;
    return { props, env, send: (envelope, resend) => sendToHost(props, env, envelope, resend) };
  }

  /**
   * The program's network, when this binding is its globalOutbound (a run
   * that can stop): a read is recorded with its bytes and answered again to a
   * run after a stop; anything else is something done outside the process.
   */
  async fetch(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    // A run the session no longer records (it did something outside itself
    // and cannot be run again): its network goes straight out.
    const run = this[RUN_ID]();
    // Out through the workspace's egress, when it has one: the record above is unchanged, only the last hop.
    const network = this[NETWORK]();
    if (run !== undefined && UNRECORDED_RUNS.has(run)) return network.fetch(request);
    const outbound = (action: string, payload: Record<string, unknown>) =>
      this[CALL](this[OP]<unknown>('outbound', [action, payload], { pid: this[PID]() }));
    if ((method !== 'GET' && method !== 'HEAD') || request.headers.has('upgrade')) {
      const answer = await outbound('effect', { what: `${method} ${request.url}` }) as { unrecorded?: boolean } | true;
      if (run !== undefined && typeof answer === 'object' && answer.unrecorded) unrecorded(run);
      return network.fetch(request);
    }
    const headers = [...request.headers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const key = `${method} ${request.url} ${JSON.stringify(headers)}`;
    const plan = await outbound('fetch', { key, what: `${method} ${request.url}` }) as
      { replay: RecordedResponse; ticket: string } | { live: string } | { error: string } | { unrecorded: true };
    if ('error' in plan) throw new Error(plan.error);
    if ('unrecorded' in plan) {
      if (run !== undefined) unrecorded(run);
      return network.fetch(request);
    }
    if ('replay' in plan) {
      const r = plan.replay;
      if (!r.hasBody) return new Response(null, { status: r.status, statusText: r.statusText, headers: r.headers });
      const recorder = new ReplayBodyRecord();
      let at = 0, chunk = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (at < r.body.length) {
            const size = r.chunks?.[chunk++] ?? r.body.length;
            const bytes = r.body.subarray(at, at + size);
            at += bytes.length;
            recorder.add(bytes);
            controller.enqueue(bytes);
            return;
          }
          if (r.bodyError) {
            await outbound('fetchBody', { ticket: plan.ticket, result: { ...recorder.finish(), error: r.bodyError, failure: r.bodyFailure } });
            controller.error(r.bodyFailure ? failureOf(r.bodyFailure) : new Error(r.bodyError));
          } else {
            await outbound('fetchBody', { ticket: plan.ticket, result: recorder.finish() });
            controller.close();
          }
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
    }
    const ticket = plan.live;
    let response: Response;
    try {
      response = await network.fetch(request);
    } catch (error) {
      await outbound('fetched', { ticket, result: { error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
    const reader = response.body?.getReader();
    const init = { status: response.status, statusText: response.statusText, headers: response.headers };
    // Headers are their own observation. A body is recorded only while the
    // caller consumes it, with backpressure; an endless SSE never holds them.
    await outbound('fetched', {
      ticket,
      result: { status: response.status, statusText: response.statusText, headers: [...response.headers], hasBody: !!reader },
    });
    if (!reader) return new Response(null, init);
    const recorder = new ReplayBodyRecord();
    let completed = false;
    const finish = async (result: RecordedBody) => {
      if (completed) return;
      completed = true;
      await outbound('fetchBody', { ticket, result });
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { await finish(recorder.finish()); controller.close(); }
          else {
            recorder.add(next.value);
            if (recorder.over) await finish({ tooLarge: true });
            controller.enqueue(next.value);
          }
        } catch (error) {
          const failure = recordFailure(error);
          try { await finish({ ...recorder.finish(), error: failure.message, failure }); }
          catch (journalError) { controller.error(journalError); return; }
          controller.error(failureOf(failure));
        }
      },
      async cancel(reason) {
        await finish({ error: 'response body was canceled: ' + String(reason) });
        await reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    return new Response(body, init);
  }

  /**
   * A connection the program opens. One its TLS shim opened is named
   * `<token>.nimbus-net.invalid`: the session says where it goes, and this
   * side makes the TLS session with the server when the program asks for it
   * (netTls 'upgrade'), then carries the plaintext both ways. workerd's
   * outbound connect cannot carry TLS itself ("Incoming CONNECT with TLS not
   * supported", worker-entrypoint.c++), which is why TLS ends here. Any
   * other connection is proxied as it is.
   */
  async connect(socket: Socket): Promise<void> {
    // Loaded here, not at the module's top: only a connection the program
    // opens needs it, and hosts without it (unit tests under Bun) load this
    // module all the same.
    const { connect: connectSocket } = await import('cloudflare:sockets');
    const outbound = (action: string, payload: Record<string, unknown>) =>
      this[CALL](this[OP]<unknown>('outbound', [action, payload], { pid: this[PID]() }));
    // A program can close its side before anything below is answered (it
    // destroyed the socket at once): then nothing is waited for.
    const gone = socket.closed.then(() => null, () => null);
    const info = await Promise.race([socket.opened, gone]);
    if (info === null) return;
    const address = info.localAddress ?? '';
    const named = /^([0-9a-f]{32})\.nimbus-net\.invalid:\d+$/.exec(address);
    const egress = this[NETWORK]().egress;
    if (named && egress !== undefined) {
      // A TLS socket under an egress (netTls refused it already): nothing goes out.
      await socket.close().catch(() => {});
      return;
    }
    if (!named) {
      const answer = await outbound('connect', { token: address }) as { unrecorded?: boolean };
      const run = this[RUN_ID]();
      if (run !== undefined && answer && answer.unrecorded) unrecorded(run);
      // Through the workspace's egress (its connect carries plain TCP), when it has one.
      const upstream = egress !== undefined
        ? egress.connect(address, { allowHalfOpen: true })
        : connectSocket(address, { allowHalfOpen: true });
      await Promise.all([socket.readable.pipeTo(upstream.writable), upstream.readable.pipeTo(socket.writable)]).catch(() => {});
      return;
    }
    const token = named[1];
    const target = await outbound('connect', { token }) as { host: string; port: number };
    // null: the process ended before it asked for the TLS session.
    const request = await Promise.race([outbound('awaitUpgrade', { token }) as Promise<{ servername?: string } | null>, gone]);
    if (request === null) {
      await socket.close().catch(() => {});
      return;
    }
    let upstream: Socket;
    try {
      // TLS from the first byte: no plaintext was read, so the socket is free
      // to be upgraded. A servername other than the host is the server's
      // expected name (workerd's own node:tls does the same).
      const address = `${target.host}:${target.port}`;
      if (request.servername === undefined || request.servername === target.host) {
        upstream = connectSocket(address, { secureTransport: 'on', allowHalfOpen: true });
      } else {
        upstream = connectSocket(address, { secureTransport: 'starttls', allowHalfOpen: true })
          .startTls({ expectedServerHostname: request.servername });
      }
      await upstream.opened;
    } catch (error) {
      await outbound('upgraded', { token, result: { ok: false, error: error instanceof Error ? error.message : String(error) } });
      await socket.close().catch(() => {});
      return;
    }
    await outbound('upgraded', { token, result: { ok: true } });
    // Both ways, with each side's end carried to the other (half-close), and
    // backpressure as the streams give it.
    await Promise.all([
      socket.readable.pipeTo(upstream.writable).catch(() => upstream.close().catch(() => {})),
      upstream.readable.pipeTo(socket.writable).catch(() => socket.close().catch(() => {})),
    ]);
  }

}

/**
 * What a hop cannot or need not carry, so a supervisor call may leave it out
 * of a bridge method's parameters: the mutation lease its binding presents
 * (a process never names one), and an AbortSignal, which does not cross.
 */
type Uncarried = RuntimeMutationOwner & { signal?: AbortSignal };
type Carried<P extends readonly unknown[]> = Required<P> extends [...infer Head, infer Last]
  ? (keyof NonNullable<Last> extends keyof Uncarried ? Head : Required<P>)
  : Required<P>;
type Arity<P> = P extends readonly unknown[] ? { [I in keyof P]: unknown } : never;
/** The bridge methods whose supervisor call takes fewer parameters than the bridge declares: an option each drops at the hop. */
type Dropped = {
  [K in FilesystemMethod]: SupervisorRPC[typeof FILESYSTEM_METHODS[K]['rpc']] extends (...args: infer A) => unknown
    ? (Arity<Carried<Parameters<RuntimeFsBridge[K]>>> extends infer C extends readonly unknown[]
      ? (Arity<Required<A>> extends [...C, ...unknown[]] ? never : K) : K)
    : K
}[FilesystemMethod];
// Every supervisor call carries each parameter its bridge method declares; one that does not is named here, at compile time.
const everyParameterCarried: [Dropped] extends [never] ? true : Dropped = true;
void everyParameterCarried;
