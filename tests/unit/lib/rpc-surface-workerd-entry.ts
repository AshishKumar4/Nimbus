// The Worker rpc-private-surface-workerd.mjs runs in workerd: the platform's
// own RPC classes, beside a stand-in for the session they reach, and a guest
// that holds each as a guest is given it. Each check is made through real
// Workers RPC, and answers what the guest got and what the session was asked.

import { DurableObject } from 'cloudflare:workers';
import { CirrusHmrRPC } from '../../../packages/worker/src/facets/real-vite-hmr.ts';
import { SupervisorRPC } from '../../../packages/worker/src/session/supervisor-rpc.ts';
import { ProcessSupervisor } from '../../../packages/worker/src/session/process-supervisor.ts';
import { HostedSession } from '../../../packages/worker/src/hosted/session.ts';
import {
  NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusAssetsRPC, NimbusDurableObjectNamespace,
  NimbusKVNamespace, NimbusD1Binding, NimbusR2Bucket,
} from '../../../packages/fabric/src/bindings.ts';
import { NimbusFsJournalReader } from '../../../packages/core/src/_shared/process-fs-journal-reader.ts';

export {
  CirrusHmrRPC, SupervisorRPC, NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, NimbusAssetsRPC, NimbusDurableObjectNamespace,
  NimbusKVNamespace, NimbusD1Binding, NimbusR2Bucket, NimbusFsJournalReader,
};

/** The credential a run-as process acts as. */
export const RUN_AS = { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 };

/** The session, as the platform's RPC classes reach it: each envelope it is asked to dispatch is kept. */
export class Session extends DurableObject {
  private envelopes: unknown[] = [];

  async supervisorOp(envelope: { op?: string }): Promise<unknown> {
    this.envelopes.push(envelope);
    if (envelope.op === 'readFileBytes') return new TextEncoder().encode('<h1>asset</h1>');
    if (envelope.op === 'kvCall') return 'kv answer';
    if (envelope.op === 'd1Query') return { success: true, results: { queryResults: [] } };
    return envelope.op === 'hmrNextEvent' ? [] : null;
  }

  /** A one-shot's SUPERVISOR, as its host hands it in the call that runs it (workerd-facet-host.ts). */
  processSupervisor(): ProcessSupervisor {
    const props = { doId: this.ctx.id.toString(), pid: 9, bindingKind: 'process', writerId: 'run-9' };
    return new ProcessSupervisor(props as unknown as ConstructorParameters<typeof ProcessSupervisor>[0], this.env, (envelope) => this.supervisorOp(envelope));
  }

  async asked(): Promise<unknown[]> {
    return this.envelopes;
  }

  /** A session scoped to one shell, as a hosted runtime hands one to an embedder's client in another isolate. */
  scoped(): HostedSession {
    // Only what a scoped call that reaches its owner needs; each reach is kept.
    const owner = { noteClientActivity: () => { this.envelopes.push({ op: 'owner: client activity' }); } };
    return new HostedSession(owner as unknown as ConstructorParameters<typeof HostedSession>[0], { shellId: 'scoped' });
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/** What a Response a method answered served: its status and body. */
class Served {
  constructor(readonly status: number, readonly body: string) {}
}

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/** What a guest can do with what it holds: `method`, as any caller of the stub can name it. */
async function asGuest(binding: object, method: string, args: unknown[]): Promise<Outcome & { forged?: Outcome }> {
  const called = await outcome(async () => {
    const named: unknown = Reflect.get(binding, method);
    // A property read (`read:<name>`): what awaiting it answers, as a caller would read a field.
    if (method.startsWith('read:')) return await Reflect.get(binding, method.slice('read:'.length));
    if (typeof named !== 'function') throw new TypeError(`the stub has no ${method}`);
    const value: unknown = await Reflect.apply(named, binding, args);
    // A Response is answered as its body, so a positive check sees what it served.
    return value instanceof Response ? new Served(value.status, await value.text()) : value;
  });
  if (called.ok && called.value instanceof Served) return { ok: true, value: { status: called.value.status, body: called.value.body } };
  if (!called.ok || called.value === null || typeof called.value !== 'object') return called;
  const answered = called.value;
  // Whatever it answered, used as the guest would: a dispatch it holds, asked to act as the kernel.
  if (!('dispatch' in answered) || typeof answered.dispatch !== 'function') return { ok: true, value: Object.keys(answered) };
  const dispatch = answered.dispatch;
  const forged = await outcome(async () => await Reflect.apply(dispatch, undefined, [{
    op: 'hmrRelay', args: ['forged', 'as the kernel'], cred: { uid: 0, gid: 0, groups: [0], umask: 0o022 },
  }]));
  return { ok: true, value: Object.keys(answered), forged };
}

type Env = {
  NIMBUS_SESSION: DurableObjectNamespace<Session>;
  READER: DurableObjectNamespace<NimbusFsJournalReader>;
};
type Exports = Record<string, (options: { props: unknown }) => object>;

const GUEST_WORKER = {
  compatibilityDate: '2026-09-26',
  mainModule: 'w.js',
  modules: { 'w.js': 'export default { fetch() { return new Response("guest"); } };' },
};

/** The stub a guest of `kind` is given, for the session `id`. */
async function held(kind: string, id: DurableObjectId, env: Env, exports: Exports): Promise<object> {
  switch (kind) {
    // The real-Vite resident's env.CIRRUS_HMR (cirrus-real.ts).
    case 'CirrusHmrRPC':
      return exports.CirrusHmrRPC({ props: { doId: id.toString() } });
    // A process's env.SUPERVISOR, as supervisorBindingProps mints it.
    case 'SupervisorRPC':
      return exports.SupervisorRPC({ props: { doId: id.toString(), pid: 7, bindingKind: 'process', writerId: 'run-7' } });
    // A wrangler-dev guest's worker_loaders binding (nimbus-wrangler.ts), and what its load hands back.
    case 'NimbusLoaderRPC':
      return exports.NimbusLoaderRPC({ props: { depth: 1, namespace: 'owner:LOADER' } });
    case 'NimbusLoadedWorker': {
      const loader = exports.NimbusLoaderRPC({ props: { depth: 1, namespace: 'owner:LOADER' } });
      return await Reflect.apply(Reflect.get(loader, 'load'), loader, [GUEST_WORKER]);
    }
    case 'NimbusLoadedEntrypoint': {
      const loader = exports.NimbusLoaderRPC({ props: { depth: 1, namespace: 'owner:LOADER' } });
      const loaded: object = await Reflect.apply(Reflect.get(loader, 'load'), loader, [GUEST_WORKER]);
      return await Reflect.apply(Reflect.get(loaded, 'getEntrypoint'), loaded, []);
    }
    // A one-shot's SUPERVISOR, handed by its host.
    case 'ProcessSupervisor': {
      const session = env.NIMBUS_SESSION.get(id);
      return await session.processSupervisor();
    }
    // A wrangler-dev guest's assets binding, minted for a run-as server (nimbus-wrangler.ts).
    case 'NimbusAssetsRPC':
      return exports.NimbusAssetsRPC({ props: { vfsRoot: 'home/run-as/site', assetsDir: 'public', doId: id.toString(), cred: RUN_AS } });
    // A wrangler-dev guest's Durable Object namespace binding.
    case 'NimbusDurableObjectNamespace':
      return exports.NimbusDurableObjectNamespace({ props: { bindingName: 'COUNTER', supervisorDoId: id.toString() } });
    // A wrangler-dev guest's KV, D1 and R2 bindings, each minted for one store (nimbus-wrangler.ts).
    case 'NimbusKVNamespace':
      return exports.NimbusKVNamespace({ props: { doId: id.toString(), root: 'home/run-as/app', store: 'KV', cred: RUN_AS } });
    case 'NimbusD1Binding':
      return exports.NimbusD1Binding({ props: { doId: id.toString(), root: 'home/run-as/app', store: 'db' } });
    case 'NimbusR2Bucket':
      return exports.NimbusR2Bucket({ props: { doId: id.toString(), root: 'home/run-as/app', store: 'BUCKET', cred: RUN_AS } });
    // A hosted runtime's scoped session, held by an embedder's client.
    case 'HostedSession': {
      const session = env.NIMBUS_SESSION.get(id);
      return await session.scoped();
    }
    // An ended process's journal reader, as the session's drain holds it.
    case 'NimbusFsJournalReader':
      return env.READER.get(env.READER.idFromName(id.toString()));
    default:
      throw new Error(`no such class: ${kind}`);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { exports: Exports }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ready') return new Response('ok');
    const id = env.NIMBUS_SESSION.idFromName(url.searchParams.get('session') ?? 'session');
    if (url.pathname === '/asked') return Response.json(await env.NIMBUS_SESSION.get(id).asked());
    const binding = await held(url.searchParams.get('class') ?? 'CirrusHmrRPC', id, env, ctx.exports);
    const method = url.searchParams.get('method') ?? '';
    const args: unknown[] = JSON.parse(url.searchParams.get('args') ?? '[]');
    if (url.searchParams.get('request') !== null) args.push(new Request('https://guest.test/'));
    return Response.json(await asGuest(binding, method, args));
  },
};
