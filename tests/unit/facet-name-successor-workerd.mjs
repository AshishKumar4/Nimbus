#!/usr/bin/env bun
// @serial
// @tier slow — drives a local workerd
// Kinu's ask 59 on workerd's own ctx.facets and Worker Loader: a durable
// application runs, its activation ends keeping its facets, and the next
// activation launches the same owner's application into the same name at
// once. The ended activation's release of its process runs as the new one
// boots. Expected: the new application boots, and the first call answers
// from it.
//
// The activation ends two ways. As Kinu's harness ends one
// (slate-durability-probe.ts forgetActivation): a new ctx over the same
// storage and facets, the ended one's code still running. And as workerd
// ends one (ctx.abort()), with the release in flight: the next activation is
// a new object with a ctx of its own.

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { wranglerNodeBuiltins } from './lib/wrangler-node-builtins.mjs';
import { servePlainWorkerd } from './lib/plain-workerd.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const host = await build({
  entryPoints: [join(REPO, 'packages/fabric/src/workerd-facet-host.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  external: ['cloudflare:*', 'node:*'],
  nodePaths: [join(REPO, 'packages/worker/node_modules')],
  write: false,
  logLevel: 'error',
  plugins: [wranglerNodeBuiltins],
});

const MAIN = `
import { DurableObject } from 'cloudflare:workers';
import { processes } from './host.js';

// The application: each instance answers every request with its own boot id.
// One given lingerMs keeps a timer pending, as an application with work in
// flight outlives its parent's eviction on Cloudflare.
const APP = {
  compatibilityDate: '2026-09-26',
  compatibilityFlags: [],
  mainModule: 'app.js',
  env: {},
  modules: { 'app.js': \`import { DurableObject } from 'cloudflare:workers';
export class NimbusProcess extends DurableObject {
  boot = crypto.randomUUID();
  startProcess(args) {
    if (args?.lingerMs) setTimeout(() => {}, args.lingerMs);
    return { boot: this.boot };
  }
  handleHttpRequest() { return new Response(this.boot); }
}\` },
};
const failure = (error) => ({ error: error instanceof Error ? error.message : String(error) });
const scope = () => ({ signal: new AbortController().signal, settled() {} });

export class Host extends DurableObject {
  // A durable application, launched as the session launches one: into its
  // owner's facet name, its write log drained at its release.
  launch(ctx, pid, name, startArgs = {}) {
    const journal = { opened() {}, async drain(source) { await source.readAfter(0, 1 << 20); } };
    return processes(ctx, this.env).spawn(() => ({}), { doId: ctx.id.toString(), pid, writerId: 'w' + pid },
      { pid, writerId: 'w' + pid, workerKey: 'app-' + pid, startArgs, boot: { kind: 'code', code: APP }, facet: { name, durable: true }, journal });
  }
  async ask(process) {
    try { return await (await process.handleHttpRequest(new Request('https://app.invalid/'), scope())).text(); }
    catch (error) { return failure(error); }
  }
  async booted(process) {
    try { return (await process.started).boot; }
    catch (error) { return failure(error); }
  }

  // Kinu's harness: the next activation is a new ctx over the same storage and facets.
  async forgotten() {
    const ended = this.ctx;
    const before = this.launch(ended, 1000002, 'app-slot-0');
    const first = await this.booted(before);
    const answered = await this.ask(before);
    const next = new Proxy(ended, { get: (target, key) => {
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const after = this.launch(next, 2000002, 'app-slot-0');
    const released = before.release();
    const booted = await this.booted(after);
    const firstCall = await this.ask(after);
    await released;
    return { first, answered, booted, firstCall, later: await this.ask(after) };
  }

  // workerd's own end: held, then ended with its release in flight, then relaunched.
  async hold() {
    this.held = this.launch(this.ctx, 1000003, 'app-slot-1', { lingerMs: 10_000 });
    globalThis.endedFacets = this.ctx.facets;
    return this.booted(this.held);
  }
  end() {
    void this.held.release();
    this.ctx.abort('the activation ends');
  }
  async relaunch() {
    const sameFacets = globalThis.endedFacets === this.ctx.facets;
    const after = this.launch(this.ctx, 2000003, 'app-slot-1');
    const booted = await this.booted(after);
    const firstCall = await this.ask(after);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { sameFacets, booted, firstCall, later: await this.ask(after) };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ready') return new Response('ok');
    const object = env.HOST.get(env.HOST.idFromName(url.searchParams.get('object')));
    try { return Response.json((await object[url.pathname.slice(1)]()) ?? null); }
    catch (error) { return Response.json(failure(error)); }
  },
};
`;

const served = await servePlainWorkerd({
  name: 'facet-name-successor',
  files: { 'main.js': MAIN, 'host.js': host.outputFiles[0].text },
  dirs: ['store'],
  readyPath: '/ready',
  config: ({ port, dir }) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js"), (name = "host.js", esModule = embed "host.js")],
      compatibilityDate = "2026-09-26",
      compatibilityFlags = ["nodejs_compat"],
      durableObjectNamespaces = [(className = "Host", uniqueKey = "facet-name-successor", enableSql = true)],
      durableObjectStorage = (localDisk = "store"),
      bindings = [
        (name = "HOST", durableObjectNamespace = "Host"),
        (name = "LOADER", workerLoader = ()),
      ],
    )),
    (name = "store", disk = (path = ${JSON.stringify(join(dir, 'store'))}, writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);`,
});
const call = async (method, object) => (await fetch(`${served.base}/${method}?object=${object}`, { signal: AbortSignal.timeout(60_000) })).json();

try {
  {
    const run = await call('forgotten', 'forgotten');
    assert.equal(typeof run.first, 'string', `the first activation's application boots: ${JSON.stringify(run)}`);
    assert.equal(run.answered, run.first, 'and answers');
    assert.equal(typeof run.booted, 'string', `the next activation's application boots: ${JSON.stringify(run)}`);
    assert.notEqual(run.booted, run.first, 'as a new instance');
    assert.equal(run.firstCall, run.booted, `the first call answers from it: ${JSON.stringify(run)}`);
    assert.equal(run.later, run.booted, `and so does a call after the ended activation's release: ${JSON.stringify(run)}`);
    console.log('  ✓ ended as Kinu\'s harness ends it: the next activation\'s application answers the first call');
  }
  {
    const first = await call('hold', 'ended');
    assert.equal(typeof first, 'string', `the application boots: ${JSON.stringify(first)}`);
    const ended = await call('end', 'ended');
    const run = await call('relaunch', 'ended');
    assert.equal(typeof run.booted, 'string', `the next activation's application boots: ${JSON.stringify(run)}`);
    assert.notEqual(run.booted, first, 'as a new instance');
    assert.equal(run.firstCall, run.booted, `the first call answers from it: ${JSON.stringify(run)}`);
    assert.equal(run.later, run.booted, `and so does one after the ended activation's release had its time: ${JSON.stringify(run)}`);
    console.log(`  ✓ ended by workerd (${JSON.stringify(ended)}; the next ctx.facets is ${run.sameFacets ? 'the same object' : 'a new object'}): the next activation's application answers the first call`);
  }
} finally {
  await served.stop();
}
console.log('facet-name-successor-workerd: ok');
