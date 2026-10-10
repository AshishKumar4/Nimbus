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

import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FACET_IMAGE_DIR } from '../../packages/fabric/src/process-fabric.ts';
import { moduleMapText, storedBootModules } from './lib/module-map-bundle.mjs';
import { launchManager } from './lib/facet-launch-harness.mjs';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

function makeManager(label, turns) {
  const { manager, world, vfs } = launchManager(label, {
    // Force a bound an ordinary program crosses many times over.
    env: { NIMBUS_LAUNCH_CHUNK_BYTES: '2048' },
    hooks: {
      // Stand in for the session's alarm. Counting the grants is how we see
      // that the launch really did suspend rather than run straight through.
      requestLaunchTurn: () => {
        turns.count++;
        setTimeout(() => { void manager.pumpResidentLaunches(); }, 0);
      },
    },
  });
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
  assert.ok(
    moduleMapText(config.modules).includes('marker-first'),
    'a launch spread across turns still carries the program it was asked to run',
  );

  assert.deepEqual(await storedBootModules(world, fs), config.modules,
    'every process-owned chunk and immutable source reached the module map');
}

// ── 2. an image is claimed before the launch can be suspended on it ──────
//
// The invariant that makes chunking safe: every image this launch writes is
// in the sweep's root set before the launch can yield with any of its bytes
// on disk, so a sweep running while the launch is suspended never sees a file
// it has written but not yet claimed. The old loop achieved this by taking no
// awaits at all, which reads as "the writes must not be interrupted" — they
// may be; what must not be interrupted is the gap between writing and
// rooting. Here a launch is suspended part-way through its second image, a
// whole image and a slice of the next on disk, and another launch sweeps;
// both are left alone (an orphan is not), whether given whole or as a pack.
{
  const { ImageStore, FACET_IMAGE_WRITE_SLICE_BYTES } = await import('../../packages/fabric/src/image-store.ts');
  const { encodeCommonJsPack } = await import('../../packages/fabric/src/process-fabric.ts');
  for (const shape of ['whole', 'pack']) {
    const files = new Map();
    const dir = FACET_IMAGE_DIR;
    const orphan = `${dir}/${'0'.repeat(64)}.js`;
    files.set(orphan, new Uint8Array(3));
    const append = (path, bytes) => {
      const prior = files.get(path);
      const next = new Uint8Array(prior.byteLength + bytes.byteLength);
      next.set(prior);
      next.set(bytes, prior.byteLength);
      files.set(path, next);
    };
    const store = new ImageStore(() => ({
      mkdirp() {},
      sizeOf: (path) => files.get(path)?.byteLength ?? null,
      writeFile: (path, bytes) => files.set(path, bytes.slice()),
      writeRange: (path, offset, bytes) => { assert.equal(offset, files.get(path).byteLength); append(path, bytes); },
      list: (at) => [...files.keys()].filter((path) => path.startsWith(`${at}/`)).map((path) => path.slice(at.length + 1)),
      unlink: (path) => files.delete(path),
    }), () => true);
    const big = 'module.exports = 1;\n'.repeat(Math.ceil((2.5 * FACET_IMAGE_WRITE_SLICE_BYTES) / 20));
    let spends = 0;
    let suspended;
    const resume = new Promise((resolve) => { suspended = resolve; });
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    const pacer = {
      chunks: 0,
      async spend() {
        // The second image's first slice is on disk: suspend the launch there.
        if (++spends === 2) { suspended(); await released; }
      },
    };
    const source = shape === 'whole' ? big : encodeCommonJsPack({ 'big.js': big });
    const length = new TextEncoder().encode(shape === 'whole' ? source : source.join('')).byteLength;
    const launch = store.materialize(1, [['small.js', 'module.exports = 0;'], ['big.js', source]], pacer);
    await resume;
    const written = [...files.keys()].filter((path) => path !== orphan);
    assert.equal(written.length, 2, `${shape}: one whole image and one slice of the next are on disk`);
    await store.materialize(2, [], { chunks: 0, async spend() {} });
    assert.ok(!files.has(orphan), `${shape}: the sweep ran, and collected what nothing roots`);
    for (const path of written) assert.ok(files.has(path), `${shape}: a suspended launch's ${path} survives the sweep`);
    release();
    const paths = await launch;
    assert.equal(paths['big.js'].replace(/^\/+/, ''), written[1], `${shape}: the image it was writing`);
    assert.equal(files.get(written[1]).byteLength, length, `${shape}: is completed once the launch resumes`);
  }
  console.log('  a suspended launch\'s images are claimed before it yields');
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
