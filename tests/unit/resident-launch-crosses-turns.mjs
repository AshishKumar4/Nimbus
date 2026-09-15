#!/usr/bin/env bun
//
// A resident launch must not be spent in one Durable Object turn.
//
// Building a resident process held the session DO's only thread for 15-35 s,
// and the terminal WebSocket does not survive a session that cannot reach its
// thread — the launch turn finished outcome=ok and the terminal died anyway.
// So the property under test is not "the launch is faster", it is "the launch
// suspends": an ordinary program must cross several turns, and what it built
// must still be correct when it does.
//
// The chunk bound is forced small here so an ordinary program exercises the
// multi-turn path. Left at its production default only the very largest
// programs would ever reach a second turn, and the interesting path would be
// tested by nothing — the same reason `git/commands.ts` carries
// NIMBUS_GIT_CHECKOUT_CHUNK_ENTRIES for its chunked checkout.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FACET_IMAGE_DIR } from '../../packages/fabric/src/process-fabric.ts';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

function makeManager(label, turns) {
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const ctx = createFacetCtx(world, label);
  const env = {
    LOADER: world.loader,
    // Force a bound an ordinary program crosses many times over.
    NIMBUS_LAUNCH_CHUNK_BYTES: '2048',
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        return new Response(
          readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
          { status: 200 },
        );
      },
    },
  };
  const manager = new FacetManager(
    ctx, env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor,
    {
      // Stand in for the session's alarm. Counting the grants is how we see
      // that the launch really did suspend rather than run straight through.
      requestLaunchTurn: () => {
        turns.count++;
        setTimeout(() => { void manager.pumpResidentLaunches(); }, 0);
      },
    },
  );
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  manager.setVfs(vfs);
  return { manager, world, vfs };
}

/** A dependency big enough to be worth chunking, small enough to be ordinary. */
function seedProgram(vfs, marker) {
  const fs = vfs.as(CRED_KERNEL);
  fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
  fs.writeFile(
    'home/user/node_modules/dep/package.json',
    JSON.stringify({ name: 'dep', main: 'lib/index.js' }),
    { mode: 0o644 },
  );
  // A bare token, not a string literal: the bundle is JSON-encoded into the
  // generated module map, so a quoted marker would be escaped there and a
  // substring check for it would fail for reasons that have nothing to do
  // with chunking.
  const mods = 40;
  fs.writeFile(
    'home/user/node_modules/dep/lib/index.js',
    Array.from({ length: mods }, (_, i) => `require('./mod${i}');`).join('\n')
      + `\nmodule.exports = 1; // ${marker}\n`,
    { mode: 0o644 },
  );
  // Required, not merely present: the passes carry the reachable closure, so
  // files nothing requires would leave the bundle too small to chunk and the
  // multi-turn path would go untested.
  for (let i = 0; i < mods; i++) {
    fs.writeFile(
      `home/user/node_modules/dep/lib/mod${i}.js`,
      `module.exports = ${i};\n// ${'p'.repeat(400)}\n`,
      { mode: 0o644 },
    );
  }
  return fs;
}

async function settle(world) {
  for (let i = 0; i < 500 && world.configs.size === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── 1. an ordinary launch suspends, and still builds what it should ───────
{
  const turns = { count: 0 };
  const { manager, world, vfs } = makeManager('launch-crosses-turns', turns);
  const fs = seedProgram(vfs, 'marker-first');

  const spawned = await manager.spawnNode("require('dep');", {
    filename: '/home/user/run.js',
    cwd: '/home/user',
    command: 'dep-tui',
    attachedTty: true,
  });
  assert.ok(spawned.pid > 0, 'the resident process spawned');

  // An attached TTY does not wait for its build: spawnNode returns while the
  // launch is still being assembled. That is the property the terminal needs —
  // the turn that asked for the process is not the turn that builds it.
  assert.equal(
    world.configs.size, 0,
    'spawnNode returned before the module map was built, rather than building it inline',
  );

  await settle(world);
  assert.equal(world.configs.size, 1, 'exactly one module map was built for the launch');
  assert.ok(
    turns.count > 1,
    `the launch crossed several turns rather than running straight through (grants=${turns.count})`,
  );


  const [config] = [...world.configs.values()];
  const entrySource = config.modules['worker.js'];
  assert.ok(
    entrySource.includes('marker-first'),
    'a launch spread across turns still carries the program it was asked to run',
  );

  const images = fs.readdir(FACET_IMAGE_DIR).map((e) => (typeof e === 'string' ? e : e.name));
  assert.ok(
    images.some((name) => new TextDecoder()
      .decode(fs.readFileUncached(`${FACET_IMAGE_DIR}/${name}`)) === entrySource),
    'every chunk of the map reached the image store',
  );
}

// ── 2. the root set is claimed before anything is written ────────────────
//
// The invariant that makes chunking safe: every image this launch will write
// is in the sweep's root set before the first byte of any of them exists, so a
// sweep running while the launch is suspended can never see a file it has
// written but not yet claimed. The old loop achieved this by taking no awaits
// at all, which reads as "the writes must not be interrupted" — they may be;
// what must not be interrupted is the gap between writing and rooting.
//
// Asserted on the order of the source, the way the sibling release invariant
// is asserted in resident-launch-releases-module-map. The interleaving test
// below exercises two chunked launches against each other, but the window in
// which a concurrent sweep would actually collect is not reachable on demand
// through the public interface, so it cannot be what pins this.
{
  const source = readFileSync(
    new URL('../../packages/fabric/src/image-store.ts', import.meta.url), 'utf8',
  );
  const start = source.indexOf('  async materialize(');
  assert.ok(start > 0, 'the image store is written by ImageStore.materialize');
  const body = source.slice(start, source.indexOf('\n  /**', start + 10));

  // The images arrive as a SEQUENCE, so the root set cannot be known up
  // front: each image is rooted as it is named, before its own first byte.
  // That is the same guarantee — a sweep sees every written image rooted, and
  // an image not yet written is not yet a file — and the array identity is
  // what makes an append visible to the sweep.
  const setRoots = body.indexOf('this.residentImages.set(');
  const pushRoot = body.indexOf('rooted.push(');
  const wrote = body.indexOf('fs.writeFile(');
  const swept = body.indexOf('this.sweep(');
  assert.ok(setRoots > 0, 'the launch holds a root set for its pid');
  assert.ok(pushRoot > 0, 'each image is claimed as it is named');
  assert.ok(wrote > 0, 'the launch writes its images');
  assert.ok(swept > 0, 'the launch sweeps once its images are written');
  assert.ok(
    setRoots < pushRoot && pushRoot < wrote,
    'an image is rooted before its own first write — a file written before it is '
    + 'rooted can be collected by a sweep that runs while this launch is suspended, and '
    + 'the facet then boots against a map with holes in it',
  );
  assert.ok(
    wrote < swept,
    'the sweep runs after the writes it is meant to leave alone',
  );
  assert.ok(
    !/this\.residentImages\.set\(pid, \[/.test(body),
    'the root array is appended to, never replaced: a replacement drops the images '
    + 'a suspended launch has already written',
  );

  // Rooting must also precede every suspension point in the write loop, or a
  // launch could yield the turn with images written and unclaimed.
  const firstYield = body.indexOf('pacer.spend(');
  assert.ok(firstYield > 0, 'the write loop is paced');
  assert.ok(pushRoot < firstYield, 'nothing is yielded on before the image is claimed');
}

// ── 2b. materialize holds ONE image's text, not every image's ─────────────
//
// The record-shaped parameter it used to take held every source for the whole
// call while the caller held its own copy beside it; on a real-vite launch the
// second image reported not one slice. Pinned on the contract rather than on a
// heap number, which no runtime here can observe.
{
  const { ImageStore } = await import('../../packages/fabric/src/image-store.ts');
  const written = [];
  const store = new ImageStore(() => ({
    mkdirp() {}, sizeOf: () => null, writeFile(p, b) { written.push([p, b.byteLength]); },
    writeRange(p, o, b) { written.push([p, b.byteLength]); }, list: () => [], unlink() {},
  }), () => true);
  // Each source is produced on demand and the producer records how many it has
  // handed over, so "one at a time" is observable: the consumer must not be
  // able to ask for the next before the previous one's slices are written.
  let produced = 0;
  const liveWhileWriting = [];
  const sources = (function* () {
    for (const name of ['a.js', 'b.js', 'c.js']) {
      produced++;
      liveWhileWriting.push(produced - written.length);
      yield [name, name.repeat(64)];
    }
  })();
  const pacer = { chunks: 0, async spend() {} };
  const paths = await store.materialize(7, sources, pacer);
  assert.deepEqual(Object.keys(paths), ['a.js', 'b.js', 'c.js'], 'every image is named');
  assert.equal(produced, 3, 'every image was produced');
  assert.ok(
    liveWhileWriting.every((live) => live <= 1),
    `at most one image is outstanding at a time, got ${JSON.stringify(liveWhileWriting)}`,
  );
  assert.equal(written.length, 3, 'each image was written');
  console.log('  materialize consumes images one at a time');
}

// ── 3. a sweep between chunks does not collect a suspended launch's images ─
//
// The root set is registered in one synchronous step before any byte is
// written, so a launch suspended mid-write is already rooted. The way to prove
// it is to make a second launch sweep while the first is suspended: two
// launches whose chunks interleave, each of which must still boot from a
// complete map. The old write loop took no awaits at all, which read as "the
// writes must not be interrupted"; if that were the real requirement, this is
// the test that would fail.
{
  const turns = { count: 0 };
  const { manager, world, vfs } = makeManager('launch-sweep-interleave', turns);
  const fs = seedProgram(vfs, 'marker-shared');

  const [a, b] = await Promise.all([
    manager.spawnNode("require('dep'); /* A */", {
      filename: '/home/user/a.js', cwd: '/home/user', command: 'a-tui', attachedTty: true,
    }),
    manager.spawnNode("require('dep'); /* B */", {
      filename: '/home/user/b.js', cwd: '/home/user', command: 'b-tui', attachedTty: true,
    }),
  ]);
  assert.notEqual(a.pid, b.pid, 'two distinct resident processes');

  for (let i = 0; i < 500 && world.configs.size < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(world.configs.size, 2, 'both launches built a module map');

  // Each facet's whole map must still be readable from the store: a sweep that
  // ran while the other launch was suspended must not have taken any of it.
  const present = new Set(
    fs.readdir(FACET_IMAGE_DIR).map((e) => (typeof e === 'string' ? e : e.name)),
  );
  for (const config of world.configs.values()) {
    for (const [name, path] of Object.entries(config.vfsTextModules ?? {})) {
      assert.ok(
        present.has(path.split('/').pop()),
        `${name} survived a concurrent sweep taken while its launch was suspended`,
      );
    }
  }
}

// ── 4. a kill that lands mid-launch stops the launch ─────────────────────
//
// Chunking put awaits inside a span that used to run to completion once it
// started, so every window it opens has to be opened deliberately and shown to
// close. This is the widest of them: a launch now spans many turns, and a kill
// can land in any of them. Before chunking the window was one turn wide and
// nothing could interleave; now the launch must notice it has lost its process
// rather than spend further turns building a facet nothing will attach to, and
// rather than boot one against a pid the session has finished reporting on.
{
  const turns = { count: 0 };
  const { manager, world, vfs } = makeManager('launch-killed-mid-flight', turns);
  seedProgram(vfs, 'marker-killed');

  const spawned = await manager.spawnNode("require('dep');", {
    filename: '/home/user/run.js',
    cwd: '/home/user',
    command: 'doomed-tui',
    attachedTty: true,
  });

  // Kill it while it is suspended between chunks — the window that did not
  // exist before, taken at the first turn boundary.
  await new Promise((resolve) => setTimeout(resolve, 0));
  manager.processes.exit(spawned.pid, 137);
  const grantsAtKill = turns.count;

  // Give the launch every opportunity to carry on and boot anyway.
  for (let i = 0; i < 80; i++) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(
    world.configs.size, 0,
    'a launch whose process was killed while it was suspended does not go on to boot a facet',
  );
  // Not booting is not enough on its own — a launch that ran every remaining
  // phase and only failed at the end would also not boot, while having spent
  // the session's thread on turn after turn of work for a dead pid. An
  // ordinary launch here takes twelve turns; this one must stop within a
  // couple of the kill.
  assert.ok(
    turns.count - grantsAtKill <= 2,
    'the launch stopped taking turns once its process was gone, rather than running to '
    + `completion and failing at the end (grants after the kill: ${turns.count - grantsAtKill})`,
  );
}

console.log('resident-launch-crosses-turns: OK');
