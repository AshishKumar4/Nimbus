// @serial
// @tier slow — drives a local workerd
// What an expired helper call relies on (helper-facet.ts boundedCalls),
// proved against workerd itself: aborting a facet ends every call in flight
// on it, loudly, and an answer that arrives after the abort resumes nothing.
// A second facet of the same Loader worker (the esbuild command's facet,
// apart from its compute calls) is not touched by that abort.
//
// Each facet call waits on an answer the host gives later, as a build waits
// on a plugin's answer from the session. The compute facet gets two
// overlapping calls; the command's facet one. The compute facet is aborted
// with a deadline error, then every answer is given. Expected: both compute
// calls rejected, neither resumed (a resumed call writes a row to the facet's
// storage, which a fresh actor of that facet would see), and the command's
// call answered as if nothing happened.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = `
import { DurableObject, RpcTarget } from 'cloudflare:workers';
const LEAF = {
  compatibilityDate: '2026-09-26',
  mainModule: 'leaf.js',
  modules: { 'leaf.js': \`
import { DurableObject } from 'cloudflare:workers';
export class Leaf extends DurableObject {
  async compute(id, answer) {
    const value = await answer.get();
    await this.ctx.storage.put('resumed:' + id, value);
    return value;
  }
  async resumed() { return [...(await this.ctx.storage.list({ prefix: 'resumed:' })).keys()]; }
}\` },
};
class Answer extends RpcTarget {
  constructor() { super(); this.value = new Promise((resolve) => { this.give = resolve; }); }
  get() { return this.value; }
}
const settle = (call) => call.then((value) => ({ value }), (error) => ({ error: String(error?.message ?? error), name: error?.name ?? null }));
export class Host extends DurableObject {
  async run() {
    const leaf = this.env.LOADER.get('leaf-v1', () => LEAF).getDurableObjectClass('Leaf');
    const compute = this.ctx.facets.get('compute', async () => ({ class: leaf }));
    const command = this.ctx.facets.get('compute:cli', async () => ({ class: leaf }));
    const answers = [new Answer(), new Answer(), new Answer()];
    const one = settle(compute.compute('one', answers[0]));
    const two = settle(compute.compute('two', answers[1]));
    const cli = settle(command.compute('cli', answers[2]));
    await new Promise((r) => setTimeout(r, 300));
    const reason = new Error('the esbuild facet\\'s transformMany gave no answer within 300000 ms');
    reason.name = 'FacetCallDeadlineError';
    this.ctx.facets.abort('compute', reason);
    const aborted = await Promise.race([Promise.all([one, two]), new Promise((r) => setTimeout(() => r('hung'), 10000))]);
    for (const answer of answers) answer.give('late');
    const commandResult = await Promise.race([cli, new Promise((r) => setTimeout(() => r('hung'), 10000))]);
    await new Promise((r) => setTimeout(r, 300));
    const fresh = this.ctx.facets.get('compute', async () => ({ class: leaf }));
    return { aborted, commandResult, computeResumed: await fresh.resumed(), commandResumed: await command.resumed() };
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/ready') return new Response('ok');
    return Response.json(await env.HOST.get(env.HOST.idFromName('one')).run());
  },
};
`;

async function freePort() {
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  return port;
}

const require = createRequire(import.meta.url);
const workerd = createRequire(require.resolve('wrangler/package.json'))('workerd').default;
const dir = mkdtempSync(join(tmpdir(), 'facet-abort-'));
writeFileSync(join(dir, 'main.js'), MAIN);
const port = await freePort();
writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "2026-09-26",
      durableObjectNamespaces = [(className = "Host", uniqueKey = "facet-abort", enableSql = true)],
      durableObjectStorage = (inMemory = void),
      bindings = [
        (name = "HOST", durableObjectNamespace = "Host"),
        (name = "LOADER", workerLoader = ()),
      ],
    )),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`);
const child = spawn(workerd, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });
try {
  for (const until = Date.now() + 30_000; ;) {
    try { await fetch(`http://127.0.0.1:${port}/ready`); break; } catch {}
    if (child.exitCode !== null || Date.now() > until) throw new Error(`workerd did not start:\n${logs}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const result = await (await fetch(`http://127.0.0.1:${port}/run`)).json();
  assert.notEqual(result.aborted, 'hung', 'the aborted facet\'s calls end, not hang');
  for (const call of result.aborted) {
    assert.ok(call.error, `an overlapping call on the aborted facet fails loudly: ${JSON.stringify(call)}`);
  }
  assert.deepEqual(result.computeResumed, [], 'a late answer after the abort resumes nothing');
  assert.deepEqual(result.commandResult, { value: 'late' }, 'the command\'s facet, of the same Loader worker, is untouched');
  assert.deepEqual(result.commandResumed, ['resumed:cli']);
  console.log(`facet-abort-overlapping-workerd: ok (${JSON.stringify(result.aborted.map((c) => c.error))})`);
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
