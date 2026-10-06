// @serial
// Durable Objects whose build facets share one isolate, and so one rolldown
// binding, building at once in one workerd process (Kinu's ask 22). Each
// object's plugin hooks must run in its own context: workerd refuses I/O on
// behalf of another Durable Object ("Cannot perform I/O on behalf of a
// different Durable Object ... (I/O type: Client)"), which is what a build
// got when the binding's pump, started by one object's build, ran another's
// hooks. The binding now runs each call in a lane of its own
// (napi-wasm-loader's callLanes): this checks, against the real facet code,
// staged assets and workerd:
//
//   - one object reset mid-build fifty times, a hook in flight each time: a
//     reset call never settles (its context is gone, and its `finally` with
//     it), so its object's next build takes its lane over and the binding
//     refuses what it awaited there. The facet's lanes, calls in flight and
//     binding memory stay flat (before, each reset left a lane, a call and
//     the build's state on the binding for good);
//   - four objects, three builds each, staggered (the reproduction);
//   - one object's build returning while another's still needs the pump;
//   - one object reset mid-build, and one whose request ends mid-build,
//     while another builds;
//   - one object's build failing with reads in flight while another builds
//     (a hook whose lane has ended is build-facet-lanes.mjs's: rolldown
//     settles a build's hooks before it returns, so workerd shows none);
//   - the esbuild facet's builds and transforms from several objects;
//   - pre-bundles from several objects through the awaited slice resolver;
//   - what lanes rest on, deterministically: a job another object posts to
//     a held lane calls the holder's plugin (a real RPC) in the holder's
//     context, while the same call made directly from the other object is
//     refused. Should workerd ever continue a promise in the context that
//     resolved it instead of the one that made it, this fails.
//
// Every call is answered within its deadline (nothing waits forever), every
// build that should succeed does, each object builds again after its
// trouble, and workerd logs no cross-object I/O.

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const REPO = resolve(import.meta.dirname, '../..');
const DEADLINE_MS = 120_000;

const dir = mkdtempSync(join(tmpdir(), 'nimbus-build-facet-isolation-'));
// The facet's own count of its lanes, calls in flight and binding memory,
// read after a collection (workerd runs with --expose-gc).
const FACET_CLASS = "  'export class BuildFacet extends DurableObject {',\n";
const FACET_STATS = "  '  async stats() { gc(); await new Promise((resolve) => setTimeout(resolve, 20)); return { lanes: [...lanes.live()].length, inFlight: inFlight.size, memory: memory ? memory.buffer.byteLength : 0 }; }',\n";
const bundled = await build({
  entryPoints: [join(import.meta.dirname, 'lib/build-facet-workerd-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  // As wrangler bundles the worker: the facets' generated source is function text.
  keepNames: true,
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  external: ['cloudflare:*', 'node:*'],
  nodePaths: [join(REPO, 'packages/worker/node_modules')],
  write: false,
  logLevel: 'error',
  plugins: [{
    name: 'facet-stats',
    setup(on) {
      on.onLoad({ filter: /facets[\\/]build-facet\.ts$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        if (!source.includes(FACET_CLASS)) throw new Error('build-facet-isolation-workerd: BUILD_FACET_BODY no longer opens its class as this test expects');
        return { contents: source.replace(FACET_CLASS, FACET_CLASS + FACET_STATS), loader: 'ts' };
      });
    },
  }],
});
writeFileSync(join(dir, 'main.js'), bundled.outputFiles[0].text);

const require = createRequire(import.meta.url);
const workerd = createRequire(require.resolve('wrangler/package.json'))('workerd').default;
const free = net.createServer();
const listening = Promise.withResolvers();
free.listen(0, '127.0.0.1', listening.resolve);
await listening.promise;
const port = free.address().port;
const closed = Promise.withResolvers();
free.close(closed.resolve);
await closed.promise;
writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "main.js", esModule = embed "main.js")],
      compatibilityDate = "2026-09-26",
      durableObjectNamespaces = [(className = "Workspace", uniqueKey = "build-facet-isolation", enableSql = true)],
      durableObjectStorage = (inMemory = void),
      bindings = [
        (name = "WS", durableObjectNamespace = "Workspace"),
        (name = "LOADER", workerLoader = ()),
        (name = "ASSETS", service = "assets"),
      ],
    )),
    (name = "assets", disk = (path = ${JSON.stringify(join(REPO, 'packages/worker/public'))}, writable = false)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
  v8Flags = ["--expose-gc"],
);`);
const child = spawn(workerd, ['serve', 'config.capnp', '--experimental'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });

/** `object`'s `method`(...args), answered within `deadline` ms. */
async function call(object, method, args, deadline = DEADLINE_MS) {
  const query = new URLSearchParams({ object, method, args: JSON.stringify(args) });
  const response = await fetch(`http://127.0.0.1:${port}/call?${query}`, { signal: AbortSignal.timeout(deadline) });
  return response.json();
}
const sleep = (ms) => {
  const slept = Promise.withResolvers();
  setTimeout(slept.resolve, ms);
  return slept.promise;
};
const failures = [];
/** Every result ok, else each failure recorded under `name`. */
function expectOk(name, results) {
  const bad = results.filter((result) => !result.ok);
  for (const result of bad) failures.push(`${name}: ${result.error ?? result.thrown ?? JSON.stringify(result)}`);
  console.log(`  ${bad.length === 0 ? 'ok ' : 'RED'} ${name} (${results.length - bad.length}/${results.length})${bad.length ? ': ' + JSON.stringify(bad[0]).slice(0, 300) : ''}`);
}

try {
  for (const until = Date.now() + 30_000; ;) {
    try {
      await fetch(`http://127.0.0.1:${port}/ready`);
      break;
    } catch {}
    if (child.exitCode !== null || Date.now() > until) throw new Error(`workerd did not start:\n${logs}`);
    await sleep(50);
  }

  // ── One object reset mid-build, fifty times ───────────────────────────
  // First, on a fresh binding: what a reset build leaves shows as growth.
  {
    expectOk('an object builds before the resets', [await call('resets-observer', 'build', ['ro', 20])]);
    const before = await call('resets-observer', 'facetStats', []);
    const resets = 50;
    // Read every ten resets, alike: each time with one reset call not yet
    // taken over, and after a collection, as a long-lived isolate collects.
    const readings = [];
    let finished = 0;
    for (let n = 1; n <= resets; n++) {
      const result = await call('resets', 'build', [`rs${n}`, 300, { slowMs: 10, abortAfterMs: 200 }]);
      if (result.ok) finished++;
      if (n % 10 === 0) readings.push(await call('resets-observer', 'facetStats', []));
    }
    if (finished > 0) failures.push(`${finished} of ${resets} builds finished before their reset`);
    expectOk('the object reset fifty times builds again', [await call('resets', 'build', ['rs-after', 50])]);
    const after = await call('resets-observer', 'facetStats', []);
    const rss = Number(readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? NaN) / 1024;
    const mib = (bytes) => (bytes / 1048576).toFixed(1);
    console.log(`  facet before: ${JSON.stringify(before)}; every 10 resets: lanes ${readings.map((r) => r.lanes)}, calls ${readings.map((r) => r.inFlight)}, MiB ${readings.map((r) => mib(r.memory))}; after its next build: ${JSON.stringify(after)}; workerd RSS ${rss.toFixed(0)} MiB`);
    const flat = readings.every((r) => r.lanes <= 1 && r.inFlight <= 1) && after.lanes === 0 && after.inFlight === 0;
    console.log(`  ${flat ? 'ok ' : 'RED'} the facet's lanes and calls in flight stay flat across ${resets} resets`);
    if (!flat) failures.push(`lanes and calls in flight grew: ${JSON.stringify({ readings, after })}`);
    const grown = readings.at(-1).memory - readings[0].memory;
    console.log(`  ${grown <= 1024 * 1024 ? 'ok ' : 'RED'} the binding's memory stays flat across ${resets - 10} more resets (+${mib(grown)} MiB)`);
    if (grown > 1024 * 1024) failures.push(`the binding's memory grew ${mib(grown)} MiB over ${resets - 10} resets`);
  }

  // ── The reproduction: four objects, three builds each, staggered ──────
  {
    const results = await Promise.all(Array.from({ length: 4 }, async (_, object) => {
      await sleep(37 * object);
      const out = [];
      for (let n = 0; n < 3; n++) out.push(await call(`repro${object}`, 'build', [`r${object}x${n}`, 300]));
      return out;
    }));
    expectOk('four objects build three times each, at once', results.flat());
  }

  // ── One object's build returns while another's still needs the pump ───
  for (let round = 0; round < 3; round++) {
    const [short, long] = await Promise.all([
      call(`short${round}`, 'build', [`s${round}`, 5]),
      call(`long${round}`, 'build', [`l${round}`, 600]),
    ]);
    expectOk(`a short build returns first, the long one finishes (round ${round})`, [short, long]);
    if (short.ok && long.ok && !(short.ms < long.ms)) failures.push(`round ${round}: the short build (${short.ms} ms) did not return before the long one (${long.ms} ms)`);
  }

  // ── One object reset mid-build while another builds ───────────────────
  {
    const [reset, peer] = await Promise.all([
      call('reset', 'build', ['reset', 300, { slowMs: 10, abortAfterMs: 500 }]),
      call('reset-peer', 'build', ['resetpeer', 300, { slowMs: 5 }]),
    ]);
    assert.ok(!reset.ok, `the object reset mid-build has no build: ${JSON.stringify(reset)}`);
    expectOk('another object builds while one is reset mid-build', [peer]);
    expectOk('the reset object builds again', [await call('reset', 'build', ['reset2', 100])]);
  }

  // ── One object's request ends mid-build while another builds ──────────
  {
    const dropped = call('dropped', 'build', ['dropped', 300, { slowMs: 10 }], 400).then(
      (result) => ({ answered: result }),
      (error) => ({ ended: error.name }),
    );
    const peer = call('dropped-peer', 'build', ['droppedpeer', 300, { slowMs: 5 }]);
    assert.deepEqual(await dropped, { ended: 'TimeoutError' }, 'the request ends mid-build');
    expectOk('another object builds while one\'s request ends mid-build', [await peer]);
    await sleep(4000);
    expectOk('the object whose request ended builds again', [await call('dropped', 'build', ['dropped2', 100])]);
  }

  // ── A build failing with reads in flight, beside another ──────────────
  {
    // Every module imported at once by the entry; one fails at once, the
    // others answer slowly.
    const [failed, peer] = await Promise.all([
      call('ended', 'build', ['ended', 300, { fanout: true, failAt: 5, slowMs: 20 }]),
      call('ended-peer', 'build', ['endedpeer', 300]),
    ]);
    assert.ok(!failed.ok && /m5\.js/.test(failed.error ?? ''), `the failing build fails on m5: ${JSON.stringify(failed)}`);
    expectOk('another object builds beside a build that failed with hooks in flight', [peer]);
    await sleep(3000);
    const late = await call('ended', 'lateReads', ['ended']);
    assert.equal(late, 0, 'rolldown asks for nothing after the build returned');
    expectOk('the object whose build failed builds again', [await call('ended', 'build', ['ended2', 100])]);
  }

  // ── The esbuild facet, from several objects at once ───────────────────
  {
    const results = await Promise.all([
      ...Array.from({ length: 2 }, (_, object) => (async () => [
        await call(`esbuild${object}`, 'build', [`e${object}a`, 200, { esbuild: true }]),
        await call(`esbuild${object}`, 'build', [`e${object}b`, 200, { esbuild: true }]),
      ])()),
      ...Array.from({ length: 3 }, (_, object) => call(`transform${object}`, 'transforms', [`t${object}`, 200]).then((r) => [r])),
    ]);
    expectOk('the esbuild facet builds and transforms for several objects at once', results.flat());
  }

  // ── Pre-bundles from several objects, through the awaited slice resolver ─
  {
    const results = await Promise.all(Array.from({ length: 4 }, async (_, object) => {
      await sleep(15 * object);
      const out = [];
      for (let n = 0; n < 3; n++) out.push(await call(`prebundle${object}`, 'prebundle', [`p${object}x${n}`, 200]));
      return out;
    }));
    expectOk('four objects pre-bundle three times each, at once', results.flat());
  }

  if (/Cannot perform I\/O on behalf of a different Durable Object/.test(logs)) failures.push('workerd logged I/O on behalf of a different Durable Object');

  // ── What lanes rest on, with a real plugin RPC ────────────────────────
  {
    /** `holder` holds a lane of its probe open; `other` calls its plugin, posted to that lane or directly. */
    const probe = async (key, direct) => {
      const held = call('probe-holder', 'probeHold', [key, 'probe-holder']);
      let delivered = 'not held';
      for (const until = Date.now() + 10_000; delivered === 'not held' && Date.now() < until;) {
        await sleep(50);
        delivered = await call('probe-other', 'probeDeliver', [key, direct]);
      }
      return { delivered, answer: await held };
    };
    const posted = await probe('posted', false);
    const postedOk = posted.delivered === 'posted' && posted.answer.ok && posted.answer.said === 'pong probe-holder';
    console.log(`  ${postedOk ? 'ok ' : 'RED'} a job another object posts to a held lane calls the holder's plugin there`);
    if (!postedOk) failures.push(`a job posted to another object's lane: ${JSON.stringify(posted)}`);
    const direct = await probe('direct', true);
    const refused = direct.delivered === 'called here' && !direct.answer.ok && /Cannot perform I\/O on behalf of a different Durable Object/.test(direct.answer.error ?? '');
    console.log(`  ${refused ? 'ok ' : 'RED'} the same call made directly from the other object is refused`);
    if (!refused) failures.push(`the direct call from another object: ${JSON.stringify(direct)}`);
  }
} finally {
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}

assert.equal(failures.length, 0, `${failures.length} failures:\n  ${failures.join('\n  ')}`);
console.log('build-facet-isolation-workerd OK');
