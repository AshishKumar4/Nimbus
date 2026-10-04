// The Workers both Durable Object RPC checks run under `wrangler dev` (the
// local-workerd unit test and the live behavioral probe), and what each
// answers on Cloudflare. tests/unit/wrangler-dev-do-rpc-workerd.mjs runs the
// same sources on plain workerd with a real Durable Object namespace, and
// checks it answers exactly these, so they are Cloudflare's answers, not
// ones written down.

export const WRANGLER_CONFIG = {
  name: 'do-rpc',
  main: 'src/index.js',
  compatibility_date: '2026-09-26',
  vars: { GREETING: 'hi from vars' },
  durable_objects: { bindings: [{ name: 'P', class_name: 'P' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['P'] }],
  worker_loaders: [{ binding: 'LOADER' }],
};

/** The object, its RpcTarget, and the step runner every Worker below shares. */
const COMMON = `import { DurableObject, RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
class Counter extends RpcTarget {
  #n; #onDispose;
  constructor(start, onDispose) { super(); this.#n = start; this.#onDispose = onDispose; }
  increment(by = 1) { this.#n += by; return this.#n; }
  get value() { return this.#n; }
  [Symbol.dispose]() { this.#onDispose?.(); }
}
export class P extends DurableObject {
  disposed = 0;
  async hello() { return 'hello'; }
  async add(a, b) { return a + b; }
  async echo(value) { return value; }
  async info() { return { field: 'pipelined', nested: { deeper: 42 } }; }
  async boom() { throw new TypeError('boom from the object'); }
  async put(key, value) { await this.ctx.storage.put(key, value); return true; }
  async get(key) { return (await this.ctx.storage.get(key)) ?? null; }
  async rows() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS t (v)');
    this.ctx.storage.sql.exec('INSERT INTO t VALUES (1)');
    return this.ctx.storage.sql.exec('SELECT count(*) AS n FROM t').one().n;
  }
  async greeting() { return this.env.GREETING; }
  get value() { return 42; }
  get obj() { return { x: 1, nested: { y: 2 }, f: () => 'from obj' }; }
  async callTarget(target) { return await target.increment(5); }
  async callFunction(fn, x) { return await fn(x); }
  makeAdder(a) { return (b) => a + b; }
  makeCounter(start) { return new Counter(start, () => { this.disposed++; }); }
  disposedCount() { return this.disposed; }
  async useStub(counter) { return await counter.increment(10); }
  async callOther(other) { return [await other.hello(), typeof other.id, Object.keys(other)]; }
  async helloFrom(name) { return await this.env.P.get(this.env.P.idFromName(name)).hello(); }
  stubOf(name) { return this.env.P.get(this.env.P.idFromName(name)); }
  stream() {
    return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('a')); c.enqueue(new TextEncoder().encode('b')); c.close(); } });
  }
  response() { return new Response('body', { status: 201, headers: { 'x-h': 'v' } }); }
  async fetch(request) { return new Response('fetched ' + new URL(request.url).pathname + ' ' + request.method); }
}
const step = async (out, key, run) => {
  try { out[key] = await run(); } catch (e) { out[key] = { threw: e?.constructor?.name, message: String(e?.message) }; }
};
const disposedOn = async (stub) => {
  for (let i = 0; i < 200; i++) {
    const n = await stub.disposedCount();
    if (n) return n;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return 0;
};
`;

/** The Worker that calls every part of a stub's RPC surface. */
export const WORKER = `${COMMON}
export default {
  async fetch(request, env) {
    const out = {};
    const id = env.P.idFromName('x');
    const stub = env.P.get(id);
    // Calls, answers, errors, pipelining, storage and the object's env.
    await step(out, 'hello', () => stub.hello());
    await step(out, 'add', () => stub.add(2, 3));
    await step(out, 'echo', () => stub.echo({ nested: [1, 'two', { three: 3 }] }));
    await step(out, 'pipelined', () => stub.info().field);
    await step(out, 'pipelinedDeeper', () => stub.info().nested.deeper);
    await step(out, 'boom', () => stub.boom());
    await step(out, 'missingMethod', () => stub.nope());
    await step(out, 'put', () => stub.put('k', 'v1'));
    await step(out, 'get', () => stub.get('k'));
    await step(out, 'rows', async () => [await stub.rows(), await stub.rows()]);
    await step(out, 'greeting', () => stub.greeting());
    await step(out, 'fetch', async () => (await stub.fetch('https://do.example/path', { method: 'POST', body: 'b' })).text());
    await step(out, 'byName', () => env.P.getByName('x').get('k'));
    await step(out, 'otherObject', () => env.P.get(env.P.idFromName('y')).get('k'));
    await step(out, 'fromObject', () => stub.helloFrom('y'));
    // Members read, and paths through them.
    await step(out, 'getter', () => stub.value);
    await step(out, 'getterType', () => typeof stub.value);
    await step(out, 'getterByName', () => env.P.getByName('x').value);
    await step(out, 'getterPath', () => stub.obj.nested.y);
    await step(out, 'getterPathCall', () => stub.obj.f());
    // The namespace, ids and stubs as objects.
    await step(out, 'idRoundTrip', () => env.P.idFromString(id.toString()).equals(id) && id.name === 'x');
    await step(out, 'namespaceKeys', () => Object.keys(env.P));
    await step(out, 'stubKeys', () => Object.keys(stub));
    await step(out, 'stubType', () => typeof stub);
    await step(out, 'stubName', () => stub.name);
    await step(out, 'stubIdName', () => stub.id.name);
    await step(out, 'uniqueStub', () => { const s = env.P.get(env.P.newUniqueId()); return [Object.keys(s), s.name, s.id.name]; });
    await step(out, 'stubThenable', () => typeof stub.then);
    await step(out, 'stubDisposable', () => typeof stub[Symbol.dispose]);
    // What crosses: RpcTargets, stubs and functions both ways, streams, responses.
    await step(out, 'rpcTargetArgument', () => stub.callTarget(new Counter(1)));
    await step(out, 'functionArgument', () => stub.callFunction((x) => x * 2, 21));
    await step(out, 'functionReturned', async () => { const add = await stub.makeAdder(2); return await add(3); });
    await step(out, 'targetReturned', async () => { const c = await stub.makeCounter(1); return [await c.increment(), await c.value]; });
    await step(out, 'targetPipelined', () => stub.makeCounter(5).increment());
    await step(out, 'stubArgument', async () => stub.useStub(await stub.makeCounter(0)));
    await step(out, 'objectStubArgument', () => stub.callOther(env.P.get(env.P.idFromName('y'))));
    await step(out, 'objectStubReturned', async () => (await stub.stubOf('y')).hello());
    await step(out, 'dupOnStub', () => stub.dup());
    await step(out, 'streamReturned', async () => new Response(await stub.stream()).text());
    await step(out, 'responseReturned', async () => { const r = await stub.response(); return [r.status, r.headers.get('x-h'), await r.text()]; });
    // Lifetimes: dup, dispose, using, and the target told it was disposed.
    await step(out, 'dup', async () => {
      const c = await stub.makeCounter(0);
      const d = c.dup();
      c[Symbol.dispose]();
      let after;
      try { await c.increment(); after = 'worked'; } catch (e) { after = e.constructor.name + ': ' + e.message; }
      return [await d.increment(), after];
    });
    await step(out, 'using', async () => {
      const s = env.P.get(env.P.newUniqueId());
      { using c = await s.makeCounter(0); await c.increment(); }
      return await disposedOn(s);
    });
    await step(out, 'disposeNotified', async () => {
      const s = env.P.get(env.P.newUniqueId());
      (await s.makeCounter(0))[Symbol.dispose]();
      return await disposedOn(s);
    });
    // A stub is a value a Worker Loader env can carry; a namespace is not.
    await step(out, 'stubInLoaderEnv', async () => {
      const child = env.LOADER.load({
        compatibilityDate: '2026-09-26',
        mainModule: 'child.js',
        modules: { 'child.js': 'export default { async fetch(r, env) { return new Response(await env.S.hello()); } }' },
        env: { S: stub },
      });
      return await (await child.getEntrypoint().fetch('http://child/')).text();
    });
    await step(out, 'namespaceInLoaderEnv', async () => {
      const child = env.LOADER.load({
        compatibilityDate: '2026-09-26',
        mainModule: 'child.js',
        modules: { 'child.js': 'export default { fetch() { return new Response("child"); } }' },
        env: { P: env.P },
      });
      return await (await child.getEntrypoint().fetch('http://child/')).text();
    });
    return Response.json(out);
  },
};
`;

/** What WORKER answers on Cloudflare (rows: the table grows by one per call). */
export function expectedAnswers(rowsBefore) {
  return {
    hello: 'hello',
    add: 5,
    echo: { nested: [1, 'two', { three: 3 }] },
    pipelined: 'pipelined',
    pipelinedDeeper: 42,
    boom: { threw: 'TypeError', message: 'boom from the object' },
    missingMethod: { threw: 'TypeError', message: 'The RPC receiver does not implement the method "nope".' },
    put: true,
    get: 'v1',
    rows: [rowsBefore + 1, rowsBefore + 2],
    greeting: 'hi from vars',
    fetch: 'fetched /path POST',
    byName: 'v1',
    otherObject: null,
    fromObject: 'hello',
    getter: 42,
    getterType: 'function',
    getterByName: 42,
    getterPath: 2,
    getterPathCall: 'from obj',
    idRoundTrip: true,
    namespaceKeys: [],
    stubKeys: ['name', 'id'],
    stubType: 'object',
    stubName: 'x',
    stubIdName: 'x',
    uniqueStub: [['name', 'id'], null, null],
    stubThenable: 'undefined',
    stubDisposable: 'undefined',
    rpcTargetArgument: 6,
    functionArgument: 42,
    functionReturned: 5,
    targetReturned: [2, 2],
    targetPipelined: 6,
    stubArgument: 10,
    objectStubArgument: ['hello', 'function', []],
    objectStubReturned: 'hello',
    dupOnStub: { threw: 'TypeError', message: "'dup' is a reserved method and cannot be called over RPC." },
    streamReturned: 'ab',
    responseReturned: [201, 'v', 'body'],
    dup: [1, 'Error: RPC stub used after being disposed.'],
    using: 1,
    disposeNotified: 1,
    stubInLoaderEnv: 'hello',
    namespaceInLoaderEnv: { threw: 'DOMException', message: 'Could not serialize object of type "DurableObjectNamespace". This type does not support serialization.' },
  };
}

/**
 * Where Nimbus answers otherwise, and why. A stub is an RPC stub of a local
 * target (packages/fabric/src/inner-do-env.ts): an entrypoint of a
 * dynamically-loaded Worker is not transferable, and the inner Worker can
 * make nothing else at once. The runtime makes every RPC stub callable, and
 * not persistent; and Nimbus's Worker Loader keeps a child's code and loads
 * it again in each later request, so the child's env can carry nothing made
 * in one request.
 */
export const NIMBUS_DIFFERS = {
  stubType: 'function',
  stubInLoaderEnv: { threw: 'DOMException', message: 'RpcStub cannot be serialized in this context because it is not a persistent stub.' },
};

/**
 * Workers whose default export is not a plain object of own handlers: each
 * must run as it is, with its env's namespace working. Each answers
 * `{ shape, hello, getter }`.
 */
export const SHAPED_WORKERS = {
  // The handler's fetch is on its prototype.
  prototype: `${COMMON}
class Handler {
  async fetch(request, env) { return Response.json({ shape: this.shape(), hello: await env.P.getByName('x').hello(), getter: await env.P.getByName('x').value }); }
  shape() { return 'prototype'; }
}
export default new Handler();
`,
  // The handler's fetch is an own property that is not enumerable.
  hidden: `${COMMON}
const handler = { shape: 'hidden' };
Object.defineProperty(handler, 'fetch', {
  enumerable: false,
  value: async function (request, env) { return Response.json({ shape: this.shape, hello: await env.P.getByName('x').hello(), getter: await env.P.getByName('x').value }); },
});
export default handler;
`,
  // The default export is an entrypoint class.
  entrypoint: `${COMMON}
export default class extends WorkerEntrypoint {
  async fetch() { return Response.json({ shape: 'entrypoint', hello: await this.env.P.getByName('x').hello(), getter: await this.env.P.getByName('x').value }); }
}
`,
};

/** What a shaped Worker answers on Cloudflare. */
export function expectedShapedAnswer(shape) {
  return { shape, hello: 'hello', getter: 42 };
}
