#!/usr/bin/env bun
// durable/wrangler-dev-user-do — a Worker project's own Durable Object class
// runs under `wrangler dev`, keeps its SQLite storage across requests, and an
// edit to the Worker serves from the rebuilt class with that storage intact.
//
// User scenario: a Workers project whose wrangler.jsonc binds a SQLite-backed
// Durable Object (`new_sqlite_classes`), run with `wrangler dev`, requested,
// edited, requested again.

import { mintSession, Terminal, makeAsserter, sleep, stripAnsi, requestHeaders, heredocCommand, deleteSession, BASE } from '../_driver.mjs';

if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wrangler-dev-user-do');
const APP = '/home/user/counter-worker';
const BUILT = /Worker built|Worker reachable|Worker is ready|Worker loaded|Worker bundled|build complete/i;

const config = JSON.stringify({
  name: 'counter-worker',
  main: 'src/index.ts',
  compatibility_date: '2026-09-01',
  durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
}, null, 2);
const worker = (label) => `import { DurableObject } from 'cloudflare:workers';
export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hits (n INTEGER)');
  }
  async fetch() {
    this.ctx.storage.sql.exec('INSERT INTO hits VALUES (1)');
    return new Response('${label} count=' + this.count());
  }
  count() {
    return this.ctx.storage.sql.exec('SELECT COUNT(*) AS c FROM hits').one().c;
  }
  add(n) {
    for (let i = 0; i < n; i++) this.ctx.storage.sql.exec('INSERT INTO hits VALUES (1)');
    return { label: '${label}', count: this.count() };
  }
}
export default {
  async fetch(request, env) {
    const stub = env.COUNTER.get(env.COUNTER.idFromName('probe'));
    if (new URL(request.url).pathname.endsWith('/rpc')) return Response.json(await stub.add(3));
    return stub.fetch(request);
  },
};
`;

async function hit(path = '') {
  const r = await fetch(`${BASE}/s/${sid}/worker/${path}`, { headers: requestHeaders(), signal: AbortSignal.timeout(30_000) })
    .then(async (res) => ({ status: res.status, body: await res.text() }))
    .catch((e) => ({ status: 0, body: String(e.message) }));
  return r;
}
async function hitUntil(pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await hit();
    if (last.status === 200 && pattern.test(last.body)) return last;
    await sleep(1000);
  }
  return last;
}

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect(); await t.waitForPrompt(60_000);
  await t.run(`mkdir -p ${APP}/src && cd ${APP}`, 10_000);
  await t.run(heredocCommand(`${APP}/wrangler.jsonc`, config), 10_000);
  await t.run(heredocCommand(`${APP}/src/index.ts`, worker('v1')), 10_000);

  t.reset();
  t.cmd('wrangler dev');
  let built = true;
  try { await t.waitFor((b) => BUILT.test(stripAnsi(b)), 120_000, 'wrangler dev build'); }
  catch { built = false; }
  a.check('wrangler dev builds the Worker with its Durable Object class', built, stripAnsi(t.buf).slice(-600));

  const first = await hitUntil(/^v1 count=\d+$/, 60_000);
  const second = await hit();
  const n1 = Number(first?.body.match(/count=(\d+)/)?.[1]);
  const n2 = Number(second.body.match(/count=(\d+)/)?.[1]);
  a.check('the Durable Object answers through the Worker', first?.status === 200 && /^v1 count=\d+$/.test(first.body), `${first?.status} ${first?.body?.slice(0, 200)}`);
  a.check('its SQLite storage persists across requests', n2 === n1 + 1, `first=${first?.body} second=${second.body}`);
  const rpc = await hit('rpc');
  let added = null;
  try { added = JSON.parse(rpc.body); } catch {}
  a.check('an RPC method on the stub runs on the object and returns its value', rpc.status === 200 && added?.count === n2 + 3, `${rpc.status} ${rpc.body.slice(0, 200)}`);

  await t.run(heredocCommand(`${APP}/src/index.ts`, worker('v2')), 10_000);
  const edited = await hitUntil(/^v2 count=\d+$/, 90_000);
  const n3 = Number(edited?.body.match(/count=(\d+)/)?.[1]);
  a.check('an edit serves from the rebuilt class', edited?.status === 200 && /^v2 /.test(edited.body), `${edited?.status} ${edited?.body?.slice(0, 200)}`);
  // Requests during the rebuild may still reach v1 and count, so the floor is
  // what the object held before the edit plus the edit's own request.
  a.check('the rebuilt class keeps the object\'s storage', n3 >= n2 + 3 + 1, `before=${second.body} rpc=${rpc.body} after=${edited?.body}`);
} finally {
  await t.close();
  const d = await deleteSession(sid);
  a.check('probe session deleted', d.ok, `status=${d.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
