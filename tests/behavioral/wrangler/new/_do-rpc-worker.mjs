// The Worker both DO RPC checks run under `wrangler dev` (the local-workerd
// unit test and the live behavioral probe): a classic Durable Object binding,
// its methods called as on Cloudflare, and what each answered.

export const WRANGLER_CONFIG = {
  name: 'do-rpc',
  main: 'src/index.js',
  compatibility_date: '2026-09-26',
  vars: { GREETING: 'hi from vars' },
  durable_objects: { bindings: [{ name: 'P', class_name: 'P' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['P'] }],
};

export const WORKER = `import { DurableObject } from 'cloudflare:workers';
export class P extends DurableObject {
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
  async fetch(request) { return new Response('fetched ' + new URL(request.url).pathname + ' ' + request.method); }
}
export default {
  async fetch(request, env) {
    const out = {};
    const step = async (key, run) => {
      try { out[key] = await run(); } catch (e) { out[key] = { threw: e && e.constructor && e.constructor.name, message: String(e && e.message) }; }
    };
    const id = env.P.idFromName('x');
    const stub = env.P.get(id);
    await step('hello', () => stub.hello());
    await step('add', () => stub.add(2, 3));
    await step('echo', () => stub.echo({ nested: [1, 'two', { three: 3 }] }));
    await step('pipelined', () => stub.info().field);
    await step('pipelinedDeeper', () => stub.info().nested.deeper);
    await step('boom', () => stub.boom());
    await step('put', () => stub.put('k', 'v1'));
    await step('get', () => stub.get('k'));
    await step('rows', async () => [await stub.rows(), await stub.rows()]);
    await step('greeting', () => stub.greeting());
    await step('fetch', async () => (await stub.fetch('https://do.example/path', { method: 'POST', body: 'b' })).text());
    await step('byName', () => env.P.getByName('x').get('k'));
    await step('otherObject', () => env.P.get(env.P.idFromName('y')).get('k'));
    await step('idRoundTrip', () => env.P.idFromString(id.toString()).equals(id) && id.name === 'x');
    await step('missingMethod', () => stub.nope());
    return Response.json(out);
  },
};
`;

/** What each step answers on Cloudflare (rows: the table grows by one per call). */
export function expectedAnswers(rowsBefore) {
  return {
    hello: 'hello',
    add: 5,
    echo: { nested: [1, 'two', { three: 3 }] },
    pipelined: 'pipelined',
    pipelinedDeeper: 42,
    boom: { threw: 'TypeError', message: 'boom from the object' },
    put: true,
    get: 'v1',
    rows: [rowsBefore + 1, rowsBefore + 2],
    greeting: 'hi from vars',
    fetch: 'fetched /path POST',
    byName: 'v1',
    otherObject: null,
    idRoundTrip: true,
  };
}
