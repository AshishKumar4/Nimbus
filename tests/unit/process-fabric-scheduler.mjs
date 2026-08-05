#!/usr/bin/env bun
// process-fabric — there is ONE way to run a resident process, and it is a DO
// Facet of the session. The fabric must:
//   (1) mint the facet from the session's OWN loader, keyed on the pid, with
//       the class name fixed — nothing about WHICH program is running reaches
//       the fabric;
//   (2) bind SUPERVISOR to the COORDINATOR, so syscalls land on the user's
//       session however the process was started;
//   (3) resolve a code spec's by-path members off the session disk inside the
//       loader's cache-miss callback, and verify a generated image against the
//       digest its own path claims;
//   (4) expose one handle surface — boot payload, route target, done, kill —
//       for both start contracts;
//   (5) evaluate the user's program EXACTLY ONCE and never again: a released
//       or lost facet fails loud instead of silently booting a second copy;
//   (6) activate a writer identity before any facet exists and retire it only
//       after the facet is gone.
// Behavior is asserted through the public ProcessFabric surface only.
//
// [placement-collapse] There is no `light`/`heavy` split to test any more.
// The peer-DO leg it selected between is deleted: a facet gives independent
// memory without a sibling DO, serves inbound HTTP (which a peer cannot),
// spawns 20-30x cheaper, and carries a boot spec of any size because the map
// never crosses an RPC boundary.

import assert from 'node:assert/strict';
import {
  ProcessFabric,
  ResidentProcessHandle,
  RESIDENT_PROCESS_CLASS,
  facetImageDigest,
  facetImagePath,
  residentFacetName,
} from '../../packages/worker/src/loaders/process-fabric.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';

// The staged (opencode) spec kind assembles its module map from ASSETS; that
// leg is covered where the artifact is — opencode-server-facet-routeable-stub.
const RUBY_IMAGE = '/opt/ruby/share/ruby/ruby+stdlib.wasm';
const WORKER_SOURCE = 'export default {}';
const WORKER_IMAGE = facetImagePath(await facetImageDigest(WORKER_SOURCE));
const CODE_BOOT = {
  kind: 'code',
  code: {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'worker.js',
    modules: { 'boot.js': 'export const x = 1' },
    vfsWasmModules: { 'ruby+stdlib.wasm': RUBY_IMAGE },
    vfsTextModules: { 'worker.js': WORKER_IMAGE },
  },
};

setCtxExports({
  SupervisorRPC(options) {
    return { props: options.props };
  },
});

/** The session's disk, as the fabric reads it: whole files, by path. */
function makeDisk(reads) {
  const files = new Map([
    [RUBY_IMAGE, new TextEncoder().encode('\0asm-ruby')],
    [WORKER_IMAGE, new TextEncoder().encode(WORKER_SOURCE)],
  ]);
  return {
    files,
    reader: {
      readFile(path) {
        reads.push(path);
        const bytes = files.get(path);
        if (!bytes) throw new Error(`ENOENT: ${path}`);
        return bytes;
      },
    },
  };
}

/** A running process, standing in for the generated runner's class. */
function makeProgram(onStart) {
  return (config, info) => ({
    config,
    info,
    startProcess(args) {
      return onStart ? onStart(args, info) : Promise.resolve({ ok: true, port: 8080 });
    },
    handleHttpRequest(request) {
      return Promise.resolve(new Response(`served ${new URL(request.url).pathname} by ${info.facetName}`));
    },
  });
}

const WRITER_LIFECYCLE = { onWriterActivated() {}, onWriterRetired() {} };

function makeFabric(world, disk) {
  return new ProcessFabric(
    createFacetCtx(world, 'coord-do-id'),
    { LOADER: world.loader, ASSETS: { async fetch() { return new Response('', { status: 404 }); } } },
    () => disk,
  );
}

// ── (1) a resident process is a facet keyed on its pid ─────────────────────
{
  const reads = [];
  const world = createFacetWorld(makeProgram());
  const fabric = makeFabric(world, makeDisk(reads).reader);
  let activatedWriter;
  let retiredAfterFacetGone;
  const handle = await fabric.startResidentProcess({
    startContract: 'lifetime',
    pid: 42,
    workerKey: 'nimbus-process:coord-do-id:42',
    boot: CODE_BOOT,
    onWriterActivated(writerId) {
      assert.deepEqual(world.liveFacets(), [], 'the writer is trusted before any facet exists');
      activatedWriter = writerId;
    },
    onWriterRetired(writerId) {
      assert.equal(writerId, activatedWriter);
      retiredAfterFacetGone = world.liveFacets().length === 0;
    },
  });
  assert.ok(handle instanceof ResidentProcessHandle);
  assert.match(handle.describePlacement(), /^facet 'proc-42'/);
  await handle.done;

  assert.equal(world.boots.length, 1, "the user's program evaluated exactly once");
  const [boot] = world.boots;
  assert.equal(boot.facetName, residentFacetName(42), 'the facet is named for the pid');
  assert.equal(boot.className, RESIDENT_PROCESS_CLASS, 'one class name for every runtime');
  assert.equal(boot.loaderId, 'nimbus-process:coord-do-id:42', 'the loader id is the process key');
  // (2) syscalls route to the coordinator, whatever the process is.
  const supervisor = boot.config.env.SUPERVISOR;
  assert.equal(supervisor.props.doId, 'coord-do-id');
  assert.equal(supervisor.props.pid, 42);
  assert.equal(supervisor.props.writerId, activatedWriter);
  assert.match(supervisor.props.writerId, /^[0-9a-f-]{36}$/);
  assert.equal(retiredAfterFacetGone, true, 'the writer is retired only once the facet is gone');
  assert.deepEqual(world.liveFacets(), [], 'a finished lifetime process leaves no facet behind');
  console.log('  case1: a resident process is a pid-keyed facet with a coordinator supervisor');
}

// ── (3) a code spec resolves its by-path members inside the loader callback ──
{
  const reads = [];
  const world = createFacetWorld(makeProgram());
  const fabric = makeFabric(world, makeDisk(reads).reader);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    startContract: 'boot',
    pid: 43,
    workerKey: 'k43',
    boot: CODE_BOOT,
    startArgs: { userCode: 'puts 1' },
  });
  assert.deepEqual(await handle.booted(), { ok: true, port: 8080 }, 'the boot payload surfaces');
  const [boot] = world.boots;
  assert.deepEqual(reads.slice().sort(), [RUBY_IMAGE, WORKER_IMAGE].sort(),
    'both by-path members are read once, when the facet loads');
  assert.equal(boot.config.modules['worker.js'], WORKER_SOURCE,
    'the generated image is materialized into the module map');
  assert.ok(boot.config.modules['ruby+stdlib.wasm'].wasm instanceof ArrayBuffer,
    'a wasm image arrives as bytes the loader can compile');
  assert.equal(boot.config.modules['boot.js'], 'export const x = 1', 'inline modules survive');
  assert.equal(boot.config.mainModule, 'worker.js');

  // (4) one handle surface: the route target reaches the running facet.
  const routed = await handle.routeTarget.handleHttpRequest(new Request('http://x/hi'));
  assert.equal(await routed.text(), 'served /hi by proc-43');
  // A `boot` runner stays resident after its payload: `done` must not settle.
  let settled = false;
  handle.done.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'residency outlives the boot payload');
  assert.equal(world.boots.length, 1, 'routing booted nothing');
  handle.kill();
  await handle.done;
  assert.deepEqual(world.liveFacets(), [], 'kill releases the facet');
  console.log('  case3: a code spec resolves its by-path members on the session disk');
}

// ── (3b) a corrupt image is refused by the digest its own path claims ───────
{
  const reads = [];
  const disk = makeDisk(reads);
  disk.files.set(WORKER_IMAGE, new TextEncoder().encode('export default { hacked: true }'));
  const world = createFacetWorld(makeProgram());
  const fabric = makeFabric(world, disk.reader);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    startContract: 'boot', pid: 44, workerKey: 'k44', boot: CODE_BOOT,
  });
  await assert.rejects(handle.booted(), /does not match its digest/,
    'an image that is not what its name says cannot boot');
  assert.equal(world.boots.length, 0, 'nothing evaluated');
  console.log('  case3b: a corrupt facet image never becomes the program');
}

// ── (5) the program evaluates exactly once — no ghost, ever ─────────────────
{
  const reads = [];
  const world = createFacetWorld(makeProgram());
  const fabric = makeFabric(world, makeDisk(reads).reader);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    startContract: 'boot', pid: 45, workerKey: 'k45', boot: CODE_BOOT,
  });
  await handle.booted();
  for (let i = 0; i < 20; i++) {
    const res = await handle.routeTarget.handleHttpRequest(new Request(`http://x/p${i}`));
    assert.equal(await res.text(), `served /p${i} by proc-45`);
  }
  assert.equal(world.boots.length, 1, '20 routed requests booted nothing');

  // A facet lost to a platform reset is reported, not silently replaced.
  world.lose(residentFacetName(45));
  await assert.rejects(
    handle.routeTarget.handleHttpRequest(new Request('http://x/after')),
    /no longer loaded/,
    'a lost facet fails loud',
  );
  assert.equal(world.boots.length, 1, 'a lost facet booted NO replacement');

  // And so is a released one.
  handle.kill();
  await assert.rejects(
    handle.routeTarget.handleHttpRequest(new Request('http://x/dead')),
    /no longer running/,
    'a killed process fails loud',
  );
  assert.equal(world.boots.length, 1);
  console.log('  case5: one evaluation per process; a lost or killed facet never re-boots');
}

// ── (6) kill() is idempotent and releases the facet exactly once ────────────
{
  const reads = [];
  const world = createFacetWorld(makeProgram(() => new Promise(() => {})));
  const fabric = makeFabric(world, makeDisk(reads).reader);
  const retired = [];
  const handle = await fabric.startResidentProcess({
    startContract: 'lifetime', pid: 46, workerKey: 'k46', boot: CODE_BOOT,
    onWriterActivated() {},
    onWriterRetired: (writerId) => retired.push(writerId),
  });
  await handle.routeTarget.handleHttpRequest(new Request('http://x/up'));
  assert.deepEqual(world.liveFacets(), [residentFacetName(46)]);
  handle.kill();
  handle.kill();
  assert.equal(handle.killed, true);
  assert.deepEqual(world.liveFacets(), []);
  assert.equal(retired.length, 1, 'the writer identity is retired exactly once');
  console.log('  case6: kill() releases the facet once and stays idempotent');
}

// ── (7) a session without the loader binding fails loud ────────────────────
{
  const world = createFacetWorld(makeProgram());
  const fabric = new ProcessFabric(createFacetCtx(world), {}, () => makeDisk([]).reader);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    startContract: 'boot', pid: 47, workerKey: 'k47', boot: CODE_BOOT,
  });
  await assert.rejects(handle.booted(), /env\.LOADER/);
  console.log('  case7: a missing Worker Loader binding fails loud');
}

// ── (8) a session whose DO has no facet host fails loud ────────────────────
{
  const world = createFacetWorld(makeProgram());
  const fabric = new ProcessFabric(
    { id: { toString: () => 'coord-do-id' }, waitUntil() {} },
    { LOADER: world.loader },
    () => makeDisk([]).reader,
  );
  await assert.rejects(
    fabric.startResidentProcess({
      ...WRITER_LIFECYCLE,
      startContract: 'boot', pid: 48, workerKey: 'k48', boot: CODE_BOOT,
    }),
    /ctx\.facets is unavailable/,
  );
  console.log('  case8: a DO without ctx.facets cannot host resident processes');
}

console.log('process-fabric-scheduler: all cases passed');
