#!/usr/bin/env bun
// inner-do-env: a classic Durable Object binding inside a `wrangler dev`
// inner Worker is a local namespace, as on Cloudflare (packages/fabric/src/
// inner-do-env.ts). The modules innerWorkerModules builds are imported here as
// the loader would run them, over a fake of the binding the loader passes.
//
//   - env.P.idFromName / idFromString / newUniqueId answer at once; get and
//     getByName answer a stub at once (it used to be RPC: an RpcPromise that
//     get() could not take, "Could not serialize object of type RpcPromise").
//   - a stub's method is one call on the binding (callOn: id, name, args),
//     its fetch one fetchOn; the stub is not thenable.
//   - the default export's handlers, a default entrypoint class and each
//     Durable Object class get the wrapped env; the bundle's other exports
//     and every other binding are as they were.
//   - a Worker with no Durable Object binding runs its bundle unchanged.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { innerDoIdFromName, innerWorkerModules } from '../../packages/fabric/src/inner-do-env.ts';

const BUNDLE = `
export class P {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export class Entrypoint {
  constructor(ctx, env) { this.env = env; }
}
export const helper = 'kept';
export default {
  label: 'default object',
  async fetch(request, env, ctx) {
    const id = env.P.idFromName('x');
    const stub = env.P.get(id);
    return {
      self: this.label,
      ctx,
      greeting: env.GREETING,
      id: id.toString(),
      name: id.name,
      roundTrip: env.P.idFromString(id.toString()).equals(id),
      uniq: env.P.newUniqueId().toString(),
      hello: await stub.hello(1, 'two'),
      byName: await env.P.getByName('y').who(),
      fetched: await (await stub.fetch('https://do.example/p', { method: 'POST', body: 'b' })).text(),
      thenable: typeof stub.then,
      stubId: stub.id === id,
    };
  },
};
`;

const calls = [];
/** The binding the loader passes: one call on one object. */
const remote = {
  async callOn(id, method, args) { calls.push(['callOn', id, method, args]); return method === 'who' ? id : `${method}:${args.join(',')}`; },
  async fetchOn(id, request) { calls.push(['fetchOn', id, request.method, request.url]); return new Response(`fetched ${await request.text()}`); },
};

const dir = mkdtempSync(join(tmpdir(), 'inner-do-env-'));
try {
  const load = async (bundle, bindings, tag) => {
    const { mainModule, modules } = innerWorkerModules(bundle, bindings);
    for (const [name, source] of Object.entries(modules)) writeFileSync(join(dir, `${tag}-${name}`), source.replaceAll("'./", `'./${tag}-`));
    return { mainModule, modules, main: await import(pathToFileURL(join(dir, `${tag}-${mainModule}`)).href) };
  };

  const { main, mainModule } = await load(BUNDLE, [{ name: 'P', class_name: 'P' }], 'one');
  assert.equal(mainModule, 'nimbus-main.js');
  const env = { P: remote, GREETING: 'hi' };
  const answered = await main.default.fetch(new Request('https://w.example/'), env, 'the-ctx');
  const idX = innerDoIdFromName('x');
  assert.deepEqual(answered, {
    self: 'default object',
    ctx: 'the-ctx',
    greeting: 'hi',
    id: idX,
    name: 'x',
    roundTrip: true,
    uniq: answered.uniq,
    hello: 'hello:1,two',
    byName: innerDoIdFromName('y'),
    fetched: 'fetched b',
    thenable: 'undefined',
    stubId: true,
  });
  assert.match(answered.uniq, /^uniq:[0-9a-f]{32}$/);
  assert.deepEqual(calls, [
    ['callOn', idX, 'hello', [1, 'two']],
    ['callOn', innerDoIdFromName('y'), 'who', []],
    ['fetchOn', idX, 'POST', 'https://do.example/p'],
  ], 'each stub call is one call on the binding, nothing else');

  // A Durable Object class gets the wrapped env; its other bindings as they were.
  const object = new main.P('object-ctx', env);
  assert.equal(object.ctx, 'object-ctx');
  assert.equal(typeof object.env.P.idFromName('z').toString(), 'string', 'the object sees the local namespace');
  assert.equal(object.env.GREETING, 'hi');
  assert.equal(main.helper, 'kept', 'other exports are re-exported');
  assert.equal(new main.Entrypoint(null, env).env, env, 'a class no binding names is the bundle\'s own');

  // A default entrypoint class gets the wrapped env too.
  const { main: classMain } = await load(
    'export class P {}\nexport default class { constructor(ctx, env) { this.env = env; } }',
    [{ name: 'P', class_name: 'P' }], 'two');
  assert.equal(typeof new classMain.default(null, env).env.P.get, 'function');
  assert.notEqual(new classMain.default(null, env).env.P, remote);

  // No Durable Object binding: the bundle as it is.
  assert.deepEqual(innerWorkerModules('export default {}', []), { mainModule: 'worker.js', modules: { 'worker.js': 'export default {}' } });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('inner-do-env: a Durable Object binding is a local namespace whose stub calls cross as RPC');
