#!/usr/bin/env bun
// one-shot-placement — where a session's one-shot runs (fabric one-shot-peer.ts).
//
// A call runs on the session's peer when the peer answered a call of the same
// worker within ONE_SHOT_WARM_MS; otherwise it runs in the session and the
// peer is warmed beside it. Asserted through the real loader host, the real
// placement and the real peer leg (the session's op routes and rpc.ts), with
// each Durable Object's Worker Loader a fake that records what it loaded and
// what ran on it:
//   1. a cold peer: the call runs in the session, and the peer is warmed;
//   2. a warm peer: the call runs there, as the session's process, its
//      images read in the session;
//   3. what the task threw comes back as it was thrown, and the peer stays warm;
//   4. a peer lost after it took the call: the run ends, is not run again,
//      says so, and the next call runs in the session;
//   5. a peer that refused the call before taking it: it runs in the session;
//   6. a kill reaches the peer's call;
//   7. a stateful facet stays in the session;
//   8. past ONE_SHOT_WARM_MS the peer is cold again;
//   9. peers that share the session's isolate are no peer;
//  10. a facet with no warm worker runs on the peer once its object is up;
//  11. a warming in flight when the peer is forgotten marks nothing warm, and
//      the next cold call warms the peer again;
//  12. a facet whose network goes out through an egress stays in the session;
//  13. a call carries its preamble only until the peer holds it, and again
//      when the peer no longer does; a kill between the two ends the call;
//  14. a call with images of its own warms, then runs on, the worker with them.

import assert from 'node:assert/strict';
import { adoptCtxExports, composeFabric } from '../../packages/fabric/src/composition.ts';
import { ONE_SHOT_WARM_MS, oneShotPlacement, oneShotPlacementDiagnostics } from '../../packages/fabric/src/one-shot-peer.ts';
import { isolateToken } from '../../packages/fabric/src/peer-host.ts';
import { recentFacetCalls } from '../../packages/fabric/src/isolate-pool.ts';
import { loaderFacetHost } from '../../packages/worker/src/runtime/facet-loader-host.ts';
import * as rpc from '../../packages/worker/src/session/rpc.ts';
import { SUPERVISOR_OP_ROUTES } from '../../packages/core/src/workspace/supervisor-op.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { ISOLATE_NETWORK, workspaceNetwork } from '../../packages/core/src/_shared/workspace-network.ts';

composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });
adoptCtxExports({ SupervisorRPC: (options) => ({ supervisorProps: options.props }) });

const TASK = facetTaskSource('async (args) => args');
const IMAGE_BYTES = new Uint8Array([0, 97, 115, 109]);

/**
 * A Durable Object: its state, and a Worker Loader that keeps each worker it
 * builds (its callback runs once per id, as workerd's does) and runs a call
 * by `run`.
 */
function object(name, objects) {
  const pending = [];
  const built = new Map();
  const record = { name, loads: 0, ran: [], warmed: 0, run: async (arg) => ({ ranOn: name, arg }) };
  record.ctx = { id: { toString: () => name }, waitUntil(promise) { pending.push(Promise.resolve(promise).catch(() => {})); } };
  record.settled = async () => { while (pending.length > 0) await Promise.all(pending.splice(0)); };
  record.env = {
    LOADER: {
      get(id, build) {
        if (!built.has(id)) {
          record.loads++;
          built.set(id, build());
        }
        const code = built.get(id);
        return {
          getEntrypoint: () => ({
            async execute(arg, bindings) {
              const loaded = await code;
              record.ran.push({ arg, supervisor: (bindings ?? loaded.env)?.SUPERVISOR?.supervisorProps, modules: loaded.modules });
              return record.run(arg);
            },
            async warm() { await code; await record.warmGate; record.warmed++; },
          }),
        };
      },
    },
    NIMBUS_SESSION: objects.ns,
  };
  return record;
}

/** A session and its siblings: each sibling answers the ops a session sends it, through the real routes. */
function world({ colocated = false } = {}) {
  const objects = { byName: new Map(), sent: [] };
  objects.ns = {
    idFromName: (name) => name,
    idFromString: (id) => id,
    get(name) {
      let peer = objects.byName.get(name);
      if (!peer) objects.byName.set(name, peer = Object.assign(object(name, objects), { token: colocated ? isolateToken() : `isolate-${name}` }));
      return {
        [Symbol.dispose]() {},
        async supervisorOp({ op, args }) {
          objects.sent.push({ to: name, op, args });
          objects.onSent?.({ to: name, op, args });
          if (peer.fail?.(op)) throw peer.fail(op);
          if (op === 'processHostProbe') return { isolateToken: peer.token };
          const route = SUPERVISOR_OP_ROUTES[op];
          return rpc[route.method]({ ctx: peer.ctx, env: peer.env }, ...route.args.map((at) => args[at]));
        },
      };
    },
  };
  const session = object('session-0123456789', objects);
  const host = loaderFacetHost(session.env, session.ctx, ISOLATE_NETWORK);
  const image = () => ({
    path: '/usr/lib/probe.wasm', identity: 'content:probe:4', size: 4, peak: 4,
    read: async () => { session.imageReads = (session.imageReads ?? 0) + 1; return IMAGE_BYTES; },
  });
  /** One one-shot, as cpython opens one: a warm key (none for null), the process's syscalls, an image. */
  const oneShot = async (arg, { warm = { session: 'session-0123456789', name: 'probe-1' }, stateful, signal } = {}) => {
    const facet = host.open({ tag: 'probe-runner', concurrency: 1, syscalls: { vfs: {}, pid: 4242 }, preamble: 'const p = 1;', wasmModules: { 'probe.wasm': image() }, warm: warm ?? undefined, stateful });
    try { return await facet.submit(TASK, arg, { signal }); } finally { facet.dispose(); }
  };
  const peerOf = () => objects.byName.get(oneShotPlacementDiagnostics(session.ctx)?.peer ?? '');
  const settled = async () => {
    await session.settled();
    for (const peer of objects.byName.values()) await peer.settled();
  };
  return { objects, session, oneShot, peerOf, settled };
}

// ── 1 + 2: cold, then warm ──────────────────────────────────────────────────
{
  const w = world();
  assert.deepEqual(await w.oneShot('first'), { ranOn: 'session-0123456789', arg: 'first' }, 'a cold peer: the call runs in the session');
  await w.settled();
  const peer = w.peerOf();
  assert.ok(peer, 'and the peer was found, outside the session\'s isolate');
  assert.equal(peer.name, 'session-0123456789:one-shot:0');
  assert.equal(peer.warmed, 1, 'and warmed: the call\'s worker loaded there, nothing run');
  assert.equal(peer.ran.length, 0);

  const reads = w.session.imageReads;
  assert.deepEqual(await w.oneShot('second'), { ranOn: peer.name, arg: 'second' }, 'a warm peer: the call runs there');
  assert.equal(peer.loads, 1, 'on the worker the warming loaded');
  assert.equal(w.session.imageReads, reads, 'which read its image in the session, once');
  const { writerId: peerRun, ...onPeer } = peer.ran[0].supervisor;
  const { writerId: sessionRun, ...inSession } = w.session.ran[0].supervisor;
  assert.deepEqual(onPeer, inSession, 'its SUPERVISOR is what its session mints for its processes: the session\'s object, the process\'s pid, the way back');
  assert.equal(onPeer.doId, 'session-0123456789');
  assert.equal(onPeer.pid, 4242);
  assert.ok(peerRun !== sessionRun && /^[0-9a-f-]{36}$/.test(peerRun), 'under its own run');
  assert.deepEqual(new Uint8Array(peer.ran[0].modules['probe.wasm'].wasm), IMAGE_BYTES, 'with the image the session read');
  const calls = oneShotPlacementDiagnostics(w.session.ctx).calls.map((c) => c.host);
  assert.deepEqual(calls, ['session', 'peer']);
  assert.deepEqual(recentFacetCalls(w.session.ctx).map((c) => [c.tag, c.cold]), [['probe-runner', true], ['probe-runner', false]],
    'the session\'s record of its facet calls holds both: cold in the session, then warm on the peer');
  assert.deepEqual(recentFacetCalls(peer.ctx), [], 'the peer keeps none of it');
  console.log('  ok  cold: in the session, the peer warmed beside it; warm: on the peer, as the session\'s process');
}

// ── 3: what the task threw ──────────────────────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  const peer = w.peerOf();
  const fails = async () => { throw new Error('ENOENT: no such file'); };
  peer.run = fails;
  const onPeer = await w.oneShot('fails').catch((error) => error);
  assert.equal(w.session.ran.length, 1, 'not run again in the session');
  // The same failure in the session: past the warm window.
  w.session.run = fails;
  const now = Date.now;
  const at = now();
  Date.now = () => at + ONE_SHOT_WARM_MS;
  const inSession = await w.oneShot('fails').catch((error) => error).finally(() => { Date.now = now; });
  w.session.run = async (arg) => ({ ranOn: w.session.name, arg });
  assert.match(onPeer.message, /ENOENT: no such file/);
  assert.deepEqual({ message: onPeer.message, unsettled: onPeer.unsettled }, { message: inSession.message, unsettled: inSession.unsettled },
    'it is thrown as the session\'s own pool throws it, with what the run may have lost');
  await w.settled();
  peer.run = async (arg) => ({ ranOn: peer.name, arg });
  assert.equal((await w.oneShot('again')).ranOn, peer.name, 'the peer stays warm');
  console.log('  ok  a task\'s failure comes back as thrown; the peer stays warm');
}

// ── 4: a peer lost after it took the call ───────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  const peer = w.peerOf();
  peer.fail = (op) => (op === 'oneShotSubmit' ? new Error('Network connection lost.') : undefined);
  const lost = await w.oneShot('lost').catch((error) => error);
  assert.match(lost.message, /the session's one-shot host was lost while it ran: Network connection lost/, 'the run ends, naming the cause');
  assert.equal(lost.unsettled, true, 'with what it may have lost');
  assert.equal(w.session.ran.length, 1, 'and is not run again: it may have done things');
  assert.equal(oneShotPlacementDiagnostics(w.session.ctx).peer, null, 'the peer is forgotten');
  peer.fail = undefined;
  assert.equal((await w.oneShot('next')).ranOn, 'session-0123456789', 'the next call runs in the session');
  await w.settled();
  assert.equal((await w.oneShot('after')).ranOn, peer.name, 'and the peer, warmed again, takes the one after');
  console.log('  ok  a peer lost mid-run ends the run, never reruns it, and is warmed again');
}

// ── 5: refused before it was taken ──────────────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  const peer = w.peerOf();
  peer.fail = (op) => (op === 'oneShotSubmit' ? Object.assign(new Error('Durable Object is overloaded. Too many requests queued.'), { overloaded: true }) : undefined);
  assert.deepEqual(await w.oneShot('refused'), { ranOn: 'session-0123456789', arg: 'refused' }, 'an overloaded peer never took it: it runs in the session');
  console.log('  ok  a call the peer refused unsent runs in the session');
}

// ── 6: a kill ───────────────────────────────────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  const peer = w.peerOf();
  let release;
  peer.run = (arg) => new Promise((resolve) => { release = () => resolve({ ranOn: peer.name, arg }); });
  const kill = new AbortController();
  const running = w.oneShot('killed', { signal: kill.signal });
  while (release === undefined) await new Promise((r) => setTimeout(r, 1));
  kill.abort(new Error('SIGINT'));
  await w.settled();
  const submit = w.objects.sent.find((s) => s.op === 'oneShotSubmit' && s.args[3] === 'killed');
  const cancel = w.objects.sent.find((s) => s.op === 'oneShotCancel');
  assert.ok(cancel && cancel.args[0] === submit.args[1], 'the kill reaches the peer, for that call');
  release();
  await running;
  console.log('  ok  a kill reaches the peer\'s call');
}

// ── 7: a stateful facet ─────────────────────────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  assert.equal((await w.oneShot('stateful', { stateful: true })).ranOn, 'session-0123456789', 'stays in the session, peer or no');
  console.log('  ok  a stateful facet stays in the session');
}

// ── 8: warmth expires ───────────────────────────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  const now = Date.now;
  try {
    const at = now();
    Date.now = () => at + ONE_SHOT_WARM_MS;
    assert.deepEqual(oneShotPlacementDiagnostics(w.session.ctx).warm, {}, `${ONE_SHOT_WARM_MS} ms after its last answer the peer is warm for nothing`);
    assert.equal((await w.oneShot('later')).ranOn, 'session-0123456789', 'and a call runs in the session');
  } finally {
    Date.now = now;
  }
  console.log('  ok  past the warm window a call runs in the session');
}

// ── 9: co-located candidates ────────────────────────────────────────────────
{
  const w = world({ colocated: true });
  await w.oneShot('first');
  await w.settled();
  assert.equal(oneShotPlacementDiagnostics(w.session.ctx).peer, null, 'a peer in the session\'s isolate frees nothing: none is chosen');
  assert.equal((await w.oneShot('second')).ranOn, 'session-0123456789');
  console.log('  ok  candidates sharing the session\'s isolate are no peer');
}

// ── 10: a facet with no warm worker ─────────────────────────────────────────
{
  const w = world();
  assert.equal((await w.oneShot('first', { warm: null })).ranOn, 'session-0123456789');
  await w.settled();
  const peer = w.peerOf();
  assert.equal(peer.warmed, 0, 'its worker is its own, cold on either host: nothing is warmed');
  assert.equal((await w.oneShot('second', { warm: null })).ranOn, peer.name, 'it runs on the peer once the peer\'s object is up');
  console.log('  ok  a facet with no warm worker runs on the peer once its object answered');
}

// ── 11: forgotten while warming ─────────────────────────────────────────────
{
  const w = world();
  // The first peer's warming waits until released.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstPeer = w.objects.ns.get('session-0123456789:one-shot:0');
  firstPeer[Symbol.dispose]();
  w.objects.byName.get('session-0123456789:one-shot:0').warmGate = gate;
  await w.oneShot('first');
  while (w.objects.sent.filter((s) => s.op === 'oneShotWarm').length === 0) await new Promise((r) => setTimeout(r, 1));
  oneShotPlacement(w.session.ctx, w.session.env).forgetPeer();
  w.objects.byName.get('session-0123456789:one-shot:0').warmGate = undefined;
  assert.equal((await w.oneShot('second')).ranOn, 'session-0123456789', 'forgotten: the next call runs in the session');
  release();
  await w.settled();
  const sentWarm = w.objects.sent.filter((s) => s.op === 'oneShotWarm').length;
  assert.equal(sentWarm, 2, 'and warms the peer again, though the first warming was still in flight');
  assert.equal((await w.oneShot('third')).ranOn, 'session-0123456789:one-shot:0', 'the peer, warmed since it was forgotten, takes the next call');
  console.log('  ok  a warming in flight across a forget marks nothing; the next cold call warms the peer again');
}

// ── 12: an egress ───────────────────────────────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  const egress = { fetch: async () => new Response('egress'), connect() { throw new Error('no TCP'); } };
  const facet = loaderFacetHost(w.session.env, w.session.ctx, workspaceNetwork(egress)).open({
    tag: 'probe-runner', concurrency: 1, syscalls: { vfs: {}, pid: 4242 }, preamble: 'const p = 1;',
    warm: { session: 'session-0123456789', name: 'probe-1' },
  });
  try {
    assert.equal((await facet.submit(TASK, 'egress')).ranOn, 'session-0123456789',
      'a warm worker keeps the outbound it loaded with, which on the peer would be one call\'s: it runs in the session');
  } finally { facet.dispose(); }
  console.log('  ok  a facet that goes out through an egress stays in the session');
}

// ── 13: the preamble ────────────────────────────────────────────────────────
{
  const w = world();
  await w.oneShot('warm it');
  await w.settled();
  const peer = w.peerOf();
  const carried = () => w.objects.sent.filter((s) => s.op === 'oneShotSubmit').map((s) => s.args[0].preamble !== undefined);
  await w.oneShot('first');
  await w.oneShot('second');
  assert.deepEqual(carried(), [false, false], 'the warming carried it: no call carries it again');
  // The peer reset: a new instance, holding nothing.
  peer.ctx = { ...peer.ctx };
  assert.equal((await w.oneShot('after reset')).ranOn, peer.name, 'a call to a peer that no longer holds it still runs there');
  assert.deepEqual(carried(), [false, false, false, true], 'sent again, carrying it');
  await w.oneShot('then');
  assert.deepEqual(carried().at(-1), false, 'and not after');

  // Killed while the peer answers that it lost the preamble: not sent again.
  peer.ctx = { ...peer.ctx };
  const kill = new AbortController();
  w.objects.onSent = (sent) => { if (sent.op === 'oneShotSubmit' && sent.args[3] === 'killed') kill.abort(new Error('SIGINT')); };
  const killed = await w.oneShot('killed', { signal: kill.signal }).catch((error) => error);
  w.objects.onSent = undefined;
  assert.equal(killed.message, 'SIGINT', 'the call ends as killed');
  assert.equal(w.objects.sent.filter((s) => s.op === 'oneShotSubmit' && s.args[3] === 'killed').length, 1, 'and is not sent again');
  console.log('  ok  a preamble crosses once per peer, and again when the peer lost it, unless the call was killed meanwhile');
}

// ── 14: a call's own images ─────────────────────────────────────────────────
{
  const w = world();
  const extra = { path: '/usr/lib/extra.wasm', identity: 'content:extra:4', size: 4, peak: 4, read: async () => IMAGE_BYTES };
  const host = loaderFacetHost(w.session.env, w.session.ctx, ISOLATE_NETWORK);
  const call = async (arg) => {
    const facet = host.open({ tag: 'probe-runner', concurrency: 1, syscalls: { vfs: {}, pid: 4242 }, preamble: 'const p = 1;', warm: { session: 'session-0123456789', name: 'probe-1' } });
    try { return await facet.submit(TASK, arg, { wasmModules: { 'extra.wasm': extra } }); } finally { facet.dispose(); }
  };
  assert.equal((await call('cold')).ranOn, 'session-0123456789');
  await w.settled();
  const peer = w.peerOf();
  assert.equal(peer.warmed, 1, 'the warming loaded the worker with the call\'s own image');
  assert.equal((await call('warm')).ranOn, peer.name, 'the next such call runs on the peer');
  assert.equal(peer.loads, 1, 'on that worker, warm');
  console.log('  ok  a call with images of its own warms and runs on the worker with them');
}

console.log('one-shot-placement: ok');
