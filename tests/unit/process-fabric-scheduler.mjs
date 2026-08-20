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
  ProcessFabric,
  ResidentProcessHandle,
  RESIDENT_PROCESS_CLASS,
  facetImageDigest,
  facetImagePath,
} from '../../packages/fabric/src/process-fabric.ts';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES } from '../../packages/fabric/src/budgets.ts';
import { residentFacetName } from '../../packages/fabric/src/workerd-facet-host.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import {
  PROCESS_HOST_MODES,
  createCtxExports,
  createFacetWorld,
  createFacetCtx,
  createProcessHost,
} from './facet-host-harness.mjs';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import {
  _rpcCancelHostProcess,
  _rpcHostProcess,
  _rpcRouteHostedHttp,
} from '../../packages/worker/src/session/rpc.ts';

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
adoptCtxExports(createCtxExports((path) => currentRead(path)));

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
  const placement = mode === 'facet' ? /^facet 'proc-slot-\d+'/ : /^peer 'coord-do-id:proc:/;
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
    // The facet is named for its SLOT, not its pid: a Durable Object never
    // reclaims a facet ID, so names have to be reusable and a pid never is.
    // One process in a fresh host, so it holds the first slot.
    assert.equal(boot.facetName, residentFacetName(0), 'the facet is named for its slot');
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
    assert.equal(await routed.text(), `served /hi by ${residentFacetName(0)}`);
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
      assert.equal(await res.text(), `served /p${i} by ${residentFacetName(0)}`);
    }
    assert.equal(world.boots.length, 1, '20 routed requests booted nothing');

    // A facet lost to a platform reset is reported, not silently replaced.
    world.lose(residentFacetName(0));
    await assert.rejects(
      handle.routeTarget.handleHttpRequest(new Request('http://x/after')),
      /no longer loaded/,
      'a lost facet fails loud',
    );
    assert.equal(world.boots.length, 1, 'a lost facet booted NO replacement');

    // And so is a released one — with the SAME message on both substrates. A
    // peer keeps its hosted record past the kill precisely so this request
    // reaches the released facet instead of timing out on a missing record.
    handle.kill();
    await handle.done.catch(() => {});
    await assert.rejects(
      handle.routeTarget.handleHttpRequest(new Request('http://x/dead')),
      /no longer running/,
      'a killed process fails loud, and says the same thing wherever it ran',
    );
    assert.equal(world.boots.length, 1);
    console.log(`  [${mode}] case5: one evaluation per process; a lost or killed facet never re-boots`);
  }

  // ── (5b) a request survives the trip to the process intact ────────────────
  //
  // On the peer substrate a Request cannot cross the hop by reference, so it is
  // taken apart and rebuilt. Everything a user's HTTP server reads has to come
  // out the other side unchanged — method, headers, body, and the status,
  // status text and headers coming back. None of that is exercised by asserting
  // a 200, which is how a marshalling bug reaches production looking green.
  {
    const reads = [];
    let seen;
    const world = createFacetWorld((config, info) => ({
      config,
      info,
      startProcess: () => Promise.resolve({ ok: true }),
      async handleHttpRequest(request) {
        seen = {
          method: request.method,
          url: request.url,
          header: request.headers.get('x-probe'),
          cookieIn: request.headers.get('cookie'),
          body: await request.text(),
        };
        const headers = new Headers({ 'X-Answer': 'yes' });
        headers.append('Set-Cookie', 'a=1; Path=/');
        headers.append('Set-Cookie', 'b=2; Path=/');
        return new Response('pong', { status: 418, statusText: 'Teapot', headers });
      },
    }));
    const fabric = makeFabric(world, setupDisk(reads).reader);
    const handle = await fabric.startResidentProcess({
      ...WRITER_LIFECYCLE,
      startContract: 'boot', pid: 49, workerKey: 'k49', boot: CODE_BOOT,
    });
    await handle.booted();
    const response = await handle.routeTarget.handleHttpRequest(new Request('http://x/echo?q=1', {
      method: 'POST',
      headers: { 'X-Probe': 'kept', Cookie: 'session=abc' },
      body: 'payload',
    }));

    assert.equal(seen.method, 'POST', 'the method reaches the process');
    assert.equal(seen.url, 'http://x/echo?q=1', 'the URL and its query reach the process');
    assert.equal(seen.header, 'kept', 'request headers reach the process');
    assert.equal(seen.cookieIn, 'session=abc', 'the request cookie reaches the process');
    assert.equal(seen.body, 'payload', 'the request body reaches the process');
    assert.equal(response.status, 418, 'the status comes back');
    assert.equal(response.statusText, 'Teapot', 'the status text comes back');
    assert.equal(response.headers.get('x-answer'), 'yes', 'response headers come back');
    assert.equal(await response.text(), 'pong', 'the response body comes back');
    // Set-Cookie is the one header that cannot be re-split once joined, so a
    // hop that iterates headers naively silently merges two cookies into one
    // malformed one.
    assert.deepEqual(
      response.headers.getSetCookie(),
      ['a=1; Path=/', 'b=2; Path=/'],
      'two cookies stay two cookies across the hop',
    );
    handle.kill();
    console.log(`  [${mode}] case5b: a request and its response cross to the process intact`);
  }

  // ── (5c) startArgs reach the runner ───────────────────────────────────────
  {
    const reads = [];
    let startedWith;
    const world = createFacetWorld((config, info) => ({
      config,
      info,
      startProcess(args) { startedWith = args; return Promise.resolve({ ok: true }); },
      handleHttpRequest: () => Promise.resolve(new Response('')),
    }));
    const fabric = makeFabric(world, setupDisk(reads).reader);
    const handle = await fabric.startResidentProcess({
      ...WRITER_LIFECYCLE,
      startContract: 'boot', pid: 50, workerKey: 'k50', boot: CODE_BOOT,
      startArgs: { argv: ['server.js'], port: 3000 },
    });
    await handle.booted();
    assert.deepEqual(startedWith, { argv: ['server.js'], port: 3000 },
      'the runner is started with the arguments the spawn gave, wherever it runs');
    handle.kill();
    console.log(`  [${mode}] case5c: startArgs reach the runner`);
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
    assert.deepEqual(world.liveFacets(), [residentFacetName(0)]);
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

// ── (P) the peer leg's own obligations ─────────────────────────────────────
//
// The cases above are the ones both substrates must satisfy identically. These
// are the ones only the peer leg can get wrong, and every assertion here was
// written because the shared suite happily passed with the behaviour removed.
{
  const world = createFacetWorld(makeProgram());
  const host = createProcessHost('peer', world, setupDisk([]).reader);
  const handle = await new ProcessFabric(host).startResidentProcess({
    ...WRITER_LIFECYCLE,
    startContract: 'boot', pid: 60, workerKey: 'k60', boot: CODE_BOOT,
  });
  await handle.booted();

  // Placement takes the FIRST peer whose isolate differs from the
  // coordinator's. Without the distinctness check any name would do, and the
  // substrate would quietly stop delivering the independent CPU it exists for.
  assert.deepEqual([...host.peers.keys()], ['coord-do-id:proc:60:0'],
    'a distinct isolate is accepted on the first probe, not after exhausting attempts');
  assert.match(handle.describePlacement(), /^peer 'coord-do-id:proc:60:0' \(isolate /);
  handle.kill();
  await handle.done.catch(() => {});
  // Every stub the leg minted is released. A stub held past its process is a
  // pinned RPC on a sibling for the life of this session.
  assert.ok(host.stubs.length > 0);
  assert.deepEqual(host.stubs.filter((s) => !s.disposed), [],
    'every peer stub is disposed once the process is gone');
  console.log('  caseP1: placement accepts the first peer in a distinct isolate');
}
{
  // …and when every peer reports the COORDINATOR's isolate — a single-process
  // topology — it exhausts its attempts and runs the process anyway rather
  // than refusing to spawn.
  const world = createFacetWorld(makeProgram());
  const host = createProcessHost('peer', world, setupDisk([]).reader, { colocated: true });
  const handle = await new ProcessFabric(host).startResidentProcess({
    ...WRITER_LIFECYCLE,
    startContract: 'boot', pid: 61, workerKey: 'k61', boot: CODE_BOOT,
  });
  await handle.booted();
  assert.equal(host.peers.size, 4, 'every attempt is probed before giving up on distinctness');
  assert.match(handle.describePlacement(), /^peer 'coord-do-id:proc:61:3'/);
  handle.kill();
  await handle.done.catch(() => {});
  console.log('  caseP2: a co-located topology still runs the process');
}
{
  // The host leg is a trust boundary: a sibling accepts a boot spec and a pid
  // from whoever calls it, so both are parsed rather than believed.
  const world = createFacetWorld(makeProgram());
  const peer = {
    ctx: createFacetCtx(world, 'peer-do'),
    env: { LOADER: world.loader },
    _hostedProcesses: new Map(),
    _hostedProcessWaiters: new Map(),
  };
  const goodOpts = {
    coordinatorDoId: 'coord-do-id', pid: 62, writerId: crypto.randomUUID(), workerKey: 'k62',
    webSocketCapability: crypto.randomUUID(),
  };
  const goodOpts2 = { ...goodOpts, writerId: crypto.randomUUID() };
  await assert.rejects(_rpcHostProcess(peer, CODE_BOOT, { ...goodOpts, pid: -1 }),
    /pid|Invalid|expected/i, 'a negative pid is refused');
  await assert.rejects(_rpcHostProcess(peer, CODE_BOOT, { ...goodOpts, writerId: 'not-a-uuid' }),
    /writerId|Invalid|uuid/i, 'a writer identity that is not a uuid is refused');
  await assert.rejects(_rpcHostProcess(peer, { kind: 'nonsense' }, goodOpts),
    /Invalid|kind|expected/i, 'a boot spec of an unknown kind is refused');
  assert.equal(peer._hostedProcesses.size, 0, 'a refused host call registers nothing');

  // A route leg may legitimately arrive BEFORE the host leg — RPC delivery
  // order is not a guarantee — so it parks. But a host runs exactly one
  // process, so it parks exactly one key: anything else is refused at once,
  // and without that anyone holding a sibling stub could pile up map entries
  // and 30-second timers here by the thousand.
  const route = _rpcRouteHostedHttp(peer, 'k62', { method: 'GET', url: 'http://x/', headers: [], body: null });
  route.catch(() => {});
  assert.equal(peer._hostedProcessWaiters.size, 1, 'the first key parks, waiting for its host leg');
  const t0 = Date.now();
  await assert.rejects(_rpcRouteHostedHttp(peer, 'other-key', { method: 'GET', url: 'http://x/', headers: [], body: null }),
    /hosts no process/, 'a second key is refused rather than parked');
  assert.ok(Date.now() - t0 < 1_000, 'and refused immediately, not waited out');
  assert.equal(peer._hostedProcessWaiters.size, 1, 'so the waiter map cannot grow past one key');

  // The parked leg is then served by the host call it was racing, which is the
  // whole reason it waits.
  const hosting = _rpcHostProcess(peer, CODE_BOOT, goodOpts2);
  hosting.catch(() => {});
  assert.equal((await route).status, 200, 'the early route leg is served once its host leg lands');
  await _rpcCancelHostProcess(peer, 'k62');
  await hosting;
  console.log('  caseP3: the host leg parses what it is handed, and parks exactly one key');
}
{
  // A peer that dies under a process that is already up, through the REAL host
  // leg this time: severing the held call is what a Durable Object reset does
  // to it, and the process has to end rather than route to a corpse.
  const world = createFacetWorld(makeProgram());
  const host = createProcessHost('peer', world, setupDisk([]).reader);
  const retired = [];
  const handle = await new ProcessFabric(host).startResidentProcess({
    startContract: 'boot', pid: 64, workerKey: 'k64', boot: CODE_BOOT,
    onWriterActivated() {}, onWriterRetired: (id) => retired.push(id),
  });
  await handle.booted();
  [...host.peers.values()][0].die(new Error('peer reset under a running process'));
  await assert.rejects(handle.done, /peer reset under a running process/,
    'the held host leg severing ends the process');
  assert.equal(retired.length, 1, 'and the writer identity it held is reclaimed');
  console.log('  caseP5: a peer reset ends the process it was hosting');
}
{
  // A host that cannot host at all must reject the SPAWN, not hand back a
  // handle for a process that never existed. On a coordinator that is a throw
  // before any handle exists; on a peer it is a message, and the open
  // acknowledgement is what makes the two the same moment.
  const world = createFacetWorld(makeProgram());
  const host = createProcessHost('peer', world, setupDisk([]).reader, { peerWithoutFacets: true });
  await assert.rejects(
    new ProcessFabric(host).startResidentProcess({
      ...WRITER_LIFECYCLE,
      startContract: 'boot', pid: 65, workerKey: 'k65', boot: CODE_BOOT,
    }),
    /ctx\.facets is unavailable/,
    'a host that cannot host fails the spawn, wherever it is',
  );
  console.log('  caseP6: a peer that cannot host fails the spawn, not a later request');
}
{
  // A peer that dies under a process that is already up ends the process. The
  // facet substrate has no independent host death to report; the peer does,
  // and dropping it would leave a `boot` process routing to a corpse until
  // someone killed it by hand.
  const world = createFacetWorld(makeProgram());
  let killHost = () => {};
  const host = {
    imageDelivery: { reflink: 'impossible', moduleCeilingBytes: 1, storageSharedWithSession: false },
    async open() {
      const lost = new Promise((_, reject) => { killHost = () => reject(new Error('peer reset')); });
      lost.catch(() => {});
      return {
        started: Promise.resolve({ ok: true }),
        lost,
        handleHttpRequest: () => Promise.resolve(new Response('')),
        release: async () => {},
        describe: () => 'test host',
      };
    },
  };
  const retired = [];
  const handle = await new ProcessFabric(host).startResidentProcess({
    startContract: 'boot', pid: 63, workerKey: 'k63', boot: CODE_BOOT,
    onWriterActivated() {}, onWriterRetired: (id) => retired.push(id),
  });
  await handle.booted();
  let settled = false;
  handle.done.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'a live host leaves the process running');
  killHost();
  await assert.rejects(handle.done, /peer reset/, 'the host dying ends the process');
  assert.equal(retired.length, 1, 'and reclaims the writer identity it was holding');
  console.log('  caseP4: a host that dies under a running process ends it');
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
