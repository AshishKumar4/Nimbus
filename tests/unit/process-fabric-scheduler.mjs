#!/usr/bin/env bun
// process-fabric — one way to run a resident process, on either substrate.
//
// EVERY case below runs twice: once with NIMBUS_PROCESS_HOST unset (the
// process is a facet of the user's own session DO) and once with it set to
// `peer` (the process is a facet of a sibling DO, reached over the real
// _rpcHostProcess / _rpcAwaitHostedOpen / _rpcAwaitHostedBoot /
// _rpcRouteHostedHttp / _rpcCancelHostProcess legs). An abstraction that only
// works one way is not an abstraction, so the assertions are shared and only
// the placement STRING differs.
//
// The fabric must:
//   (1) mint the facet from the HOST's loader, keyed on the pid, with the
//       class name fixed — nothing about WHICH program is running reaches the
//       fabric, and nothing about the program reaches the substrate choice;
//   (2) bind SUPERVISOR to the COORDINATOR, so syscalls land on the user's
//       session wherever the process runs;
//   (3) resolve a code spec's by-path members inside the loader's cache-miss
//       callback, and verify a generated image against the digest its own path
//       claims;
//   (4) expose one handle surface — boot payload, route target, done, kill —
//       for both start contracts;
//   (5) evaluate the user's program EXACTLY ONCE and never again: a released
//       or lost facet fails loud instead of silently booting a second copy;
//   (6) activate a writer identity before any facet exists and retire it only
//       after the facet is gone.
// Behavior is asserted through the public ProcessFabric surface only.

import assert from 'node:assert/strict';
import {
  DYNAMIC_WORKER_CODE_LIMIT_BYTES,
  ProcessFabric,
  ResidentProcessHandle,
  RESIDENT_PROCESS_CLASS,
  facetImageDigest,
  facetImagePath,
  residentFacetName,
} from '../../packages/worker/src/loaders/process-fabric.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import {
  PROCESS_HOST_MODES,
  createCtxExports,
  createFacetWorld,
  createFacetCtx,
  createProcessHost,
} from './facet-host-harness.mjs';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';

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

// ctx.exports is first-write-wins, so it is installed once and reads through a
// pointer each case re-aims at its own disk.
let currentRead = () => { throw new Error('no disk'); };
setCtxExports(createCtxExports((path) => currentRead(path)));

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

/**
 * The disk every arm reads. A coordinator-hosted process reads it
 * synchronously; a peer-hosted one reads the same bytes through SUPERVISOR, in
 * ranges. `reads` records the paths either way, and the module map that comes
 * out has to be identical.
 */
function setupDisk(reads) {
  const files = new Map([
    [RUBY_IMAGE, new TextEncoder().encode('\0asm-ruby')],
    [WORKER_IMAGE, new TextEncoder().encode(WORKER_SOURCE)],
  ]);
  const read = (path) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  };
  currentRead = (path) => { reads.push(path); return read(path); };
  return { files, reader: { readFile: (path) => { reads.push(path); return read(path); } } };
}

for (const mode of PROCESS_HOST_MODES) {
  const placement = mode === 'facet' ? /^facet 'proc-\d+'/ : /^peer 'coord-do-id:proc:/;
  const makeFabric = (world, disk) => new ProcessFabric(createProcessHost(mode, world, disk));

  // ── (1) a resident process is a facet keyed on its pid ───────────────────
  {
    const reads = [];
    const world = createFacetWorld(makeProgram());
    const fabric = makeFabric(world, setupDisk(reads).reader);
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
    assert.match(handle.describePlacement(), placement);
    await handle.done;

    assert.equal(world.boots.length, 1, "the user's program evaluated exactly once");
    const [boot] = world.boots;
    assert.equal(boot.facetName, residentFacetName(42), 'the facet is named for the pid');
    assert.equal(boot.className, RESIDENT_PROCESS_CLASS, 'one class name for every runtime');
    assert.equal(boot.loaderId, 'nimbus-process:coord-do-id:42', 'the loader id is the process key');
    // (2) syscalls route to the coordinator, whatever the process is and
    // wherever it runs — a peer mints the binding for the COORDINATOR's doId.
    const supervisor = boot.config.env.SUPERVISOR;
    assert.equal(supervisor.props.doId, 'coord-do-id');
    assert.equal(supervisor.props.pid, 42);
    assert.equal(supervisor.props.writerId, activatedWriter);
    assert.match(supervisor.props.writerId, /^[0-9a-f-]{36}$/);
    assert.equal(retiredAfterFacetGone, true, 'the writer is retired only once the facet is gone');
    assert.deepEqual(world.liveFacets(), [], 'a finished lifetime process leaves no facet behind');
    console.log(`  [${mode}] case1: a resident process is a pid-keyed facet with a coordinator supervisor`);
  }

  // ── (3) a code spec resolves its by-path members inside the loader callback ──
  {
    const reads = [];
    const world = createFacetWorld(makeProgram());
    const fabric = makeFabric(world, setupDisk(reads).reader);
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
    assert.deepEqual([...new Set(reads)].sort(), [RUBY_IMAGE, WORKER_IMAGE].sort(),
      'both by-path members are read, when the facet loads');
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
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(world.liveFacets(), [], 'kill releases the facet');
    console.log(`  [${mode}] case3: a code spec resolves its by-path members on the session disk`);
  }

  // ── (3b) a corrupt image is refused by the digest its own path claims ─────
  {
    const reads = [];
    const disk = setupDisk(reads);
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
    console.log(`  [${mode}] case3b: a corrupt facet image never becomes the program`);
  }

  // ── (5) the program evaluates exactly once — no ghost, ever ───────────────
  {
    const reads = [];
    const world = createFacetWorld(makeProgram());
    const fabric = makeFabric(world, setupDisk(reads).reader);
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
    await new Promise((r) => setTimeout(r, 0));
    await assert.rejects(
      handle.routeTarget.handleHttpRequest(new Request('http://x/dead')),
      /no longer running|hosts no process/,
      'a killed process fails loud',
    );
    assert.equal(world.boots.length, 1);
    console.log(`  [${mode}] case5: one evaluation per process; a lost or killed facet never re-boots`);
  }

  // ── (6) kill() is idempotent and releases the facet exactly once ──────────
  {
    const reads = [];
    const world = createFacetWorld(makeProgram(() => new Promise(() => {})));
    const fabric = makeFabric(world, setupDisk(reads).reader);
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
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(world.liveFacets(), []);
    assert.equal(retired.length, 1, 'the writer identity is retired exactly once');
    console.log(`  [${mode}] case6: kill() releases the facet once and stays idempotent`);
  }

  // ── (7) a host without the loader binding fails loud ──────────────────────
  {
    const reads = [];
    const world = createFacetWorld(makeProgram());
    const fabric = new ProcessFabric(
      createProcessHost(mode, world, setupDisk(reads).reader, { env: {} }),
    );
    const handle = await fabric.startResidentProcess({
      ...WRITER_LIFECYCLE,
      startContract: 'boot', pid: 47, workerKey: 'k47', boot: CODE_BOOT,
    });
    await assert.rejects(handle.booted(), /env\.LOADER/);
    console.log(`  [${mode}] case7: a missing Worker Loader binding fails loud`);
  }
}

// ── (8) a DO with no facet host cannot host resident processes ──────────────
{
  const reads = [];
  const world = createFacetWorld(makeProgram());
  const fabric = new ProcessFabric(processHostFor(
    { id: { toString: () => 'coord-do-id' }, waitUntil() {} },
    { LOADER: world.loader },
    () => setupDisk(reads).reader,
  ));
  await assert.rejects(
    fabric.startResidentProcess({
      ...WRITER_LIFECYCLE,
      startContract: 'boot', pid: 48, workerKey: 'k48', boot: CODE_BOOT,
    }),
    /ctx\.facets is unavailable/,
  );
  console.log('  case8: a DO without ctx.facets cannot host resident processes');
}

// ── (9) the substrate is one deployment-wide value, and a typo is refused ───
{
  const world = createFacetWorld(makeProgram());
  const ctx = createFacetCtx(world, 'coord-do-id');
  const disk = () => setupDisk([]).reader;
  assert.doesNotThrow(() => processHostFor(ctx, { LOADER: world.loader }, disk));
  assert.doesNotThrow(() => processHostFor(ctx, { LOADER: world.loader, NIMBUS_PROCESS_HOST: '' }, disk));
  assert.throws(
    () => processHostFor(ctx, { NIMBUS_PROCESS_HOST: 'Peer' }, disk),
    /must be 'facet' or 'peer'/,
    'a misspelt substrate is refused, not silently defaulted',
  );
  assert.throws(
    () => processHostFor(ctx, { NIMBUS_PROCESS_HOST: 'peer' }, disk),
    /NIMBUS_SESSION/,
    'peer hosting without the sibling namespace fails loud',
  );
  console.log('  case9: one value picks the substrate, and an unknown one is refused');
}

// ── (10) the one thing the substrates do NOT share is stated, not hidden ────
//
// Everything above asserts the two substrates behave identically. Whole-session
// filesystem delivery is where they do not, and an abstraction that let that
// difference go unsaid would be lying to whoever flips the config: a facet can
// receive the session's SQLite by same-object copy-on-write, and a peer can
// never receive it that way at all — clone and bookmarks are both
// same-Durable-Object, and workerd has no VACUUM INTO, ATTACH or
// sqlite3_backup to reach across one. The cost runs the other way too, so
// neither substrate simply wins: a facet spends the session's storage budget,
// a peer brings its own.
{
  const world = createFacetWorld(makeProgram());
  const disk = () => setupDisk([]).reader;
  const facetHost = processHostFor(createFacetCtx(world, 'coord-do-id'), { LOADER: world.loader }, disk);
  const peerHost = createProcessHost('peer', world, setupDisk([]).reader);

  assert.equal(facetHost.imageDelivery.reflink, 'same-object');
  assert.equal(peerHost.imageDelivery.reflink, 'impossible');
  assert.equal(facetHost.imageDelivery.storageSharedWithSession, true);
  assert.equal(peerHost.imageDelivery.storageSharedWithSession, false);
  // The module map is the channel that works on BOTH, and its ceiling is a
  // property of the dynamic-Worker loader rather than of either substrate.
  assert.equal(
    facetHost.imageDelivery.moduleCeilingBytes,
    peerHost.imageDelivery.moduleCeilingBytes,
    'the module map is the one whole-image channel both substrates share',
  );
  assert.equal(facetHost.imageDelivery.moduleCeilingBytes, DYNAMIC_WORKER_CODE_LIMIT_BYTES);
  console.log('  case10: the substrates state where they are not interchangeable');
}

console.log('process-fabric-scheduler: all cases passed on both substrates');
