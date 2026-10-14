// The Worker rpc-private-surface-workerd.mjs runs in workerd: the platform's
// own RPC classes, beside a stand-in for the session they reach, and a guest
// that holds each as a guest is given it. Each check is made through real
// Workers RPC, and answers what the guest got and what the session was asked.

import { DurableObject } from 'cloudflare:workers';
import { CirrusHmrRPC } from '../../../packages/worker/src/facets/real-vite-hmr.ts';

export { CirrusHmrRPC };

/** The session, as the platform's RPC classes reach it: each envelope it is asked to dispatch is kept. */
export class Session extends DurableObject {
  private envelopes: unknown[] = [];

  async supervisorOp(envelope: { op?: string }): Promise<unknown> {
    this.envelopes.push(envelope);
    return envelope.op === 'hmrNextEvent' ? [] : null;
  }

  async asked(): Promise<unknown[]> {
    return this.envelopes;
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/** What a guest can do with what it holds: each method a caller of the stub can name. */
async function asGuest(binding: Record<string, unknown>, method: string, args: unknown[]): Promise<Outcome & { forged?: Outcome }> {
  const called = await outcome(async () => {
    const named = binding[method];
    if (typeof named !== 'function') throw new TypeError(`the stub has no ${method}`);
    return await Reflect.apply(named, binding, args);
  });
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

export default {
  async fetch(request: Request, env: { NIMBUS_SESSION: DurableObjectNamespace<Session> }, ctx: ExecutionContext & { exports: Record<string, (options: { props: unknown }) => Record<string, unknown>> }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ready') return new Response('ok');
    const id = env.NIMBUS_SESSION.idFromName(url.searchParams.get('session') ?? 'session');
    const session = env.NIMBUS_SESSION.get(id);
    if (url.pathname === '/asked') return Response.json(await session.asked());
    // The binding as the real-Vite resident holds it (cirrus-real.ts).
    const binding = ctx.exports.CirrusHmrRPC({ props: { doId: id.toString() } });
    const method = url.searchParams.get('method')!;
    const args = JSON.parse(url.searchParams.get('args') ?? '[]') as unknown[];
    return Response.json(await asGuest(binding, method, args));
  },
};
