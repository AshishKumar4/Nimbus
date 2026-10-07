#!/usr/bin/env bun
// fanout-dynamic-worker-routing — Fanout spends the Durable Object's
// documented Dynamic Worker budget, and only what is left of it.
//
// Cloudflare's contract (2026-08-28 changelog): a Durable Object may have 10
// distinct Dynamic Workers with in-flight requests, shared across every
// concurrent request to it; repeated requests to one Dynamic Worker count
// once. What has to hold through the public Fanout API:
//
//   (1) a batch the headroom holds runs in-DO, every task at once — widths
//       past the old 4-cap included, up to the limit itself;
//   (2) one task past the headroom goes to sibling DOs instead;
//   (3) Dynamic Workers the DO already has in flight shrink the headroom,
//       and repeated requests to one of them count once;
//   (4) a fan-out's width stays claimed while it runs, so a concurrent one
//       sizes against what is left, and the claim is returned after;
//   (5) a fan-out sized to the whole budget right after another runs, when
//       the platform still counts the first one's workers for a moment
//       after their calls return: a refused call waits and is sent again,
//       as the platform asks. npm install spawned from a node process
//       (create-next-app) ran its resolver's last layer in-DO and then its
//       8-shard batch at once; a deployed Durable Object refused the batch
//       with "Dynamic worker concurrency limit exceeded" (3/3, the ledger
//       at exactly 10), and admitted it after a 6 s pause.

import assert from 'node:assert/strict';
import { Fanout } from '../../packages/fabric/src/fanout.ts';
import { beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT } from '../../packages/fabric/src/budgets.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

assert.equal(DO_DYNAMIC_WORKER_LIMIT, 10, 'the documented per-DO limit');

/** An env whose loader and peer namespace record where tasks ran. */
function makeWorld({ gate } = {}) {
  const world = { inDo: 0, inDoPeak: 0, inDoIds: new Set(), peerTasks: 0 };
  let live = 0;
  world.env = {
    LOADER: {
      get(id) {
        return {
          getEntrypoint: () => ({
            async execute(arg) {
              world.inDo++;
              world.inDoIds.add(id);
              live++;
              world.inDoPeak = Math.max(world.inDoPeak, live);
              try {
                await (gate ?? new Promise((resolve) => setTimeout(resolve, 5)));
                return arg;
              } finally {
                live--;
              }
            },
          }),
        };
      },
    },
    NIMBUS_SESSION: {
      idFromName(name) { return { toString: () => name, name }; },
      idFromString(id) { return { toString: () => id, name: id }; },
      get() {
        return {
          async supervisorOp(envelope) {
            const [, args] = envelope.args;
            world.peerTasks += args.length;
            return { results: args };
          },
        };
      },
    },
  };
  return world;
}

let ctxSeq = 0;
function freshCtx() {
  const name = `routing-coordinator-${ctxSeq++}`;
  return { id: { toString: () => name } };
}

async function run(width, { ctx = freshCtx(), world = makeWorld() } = {}) {
  const routes = [];
  const pool = new Fanout(world.env, ctx, {
    network: ISOLATE_NETWORK,
    tag: 'routing-test',
    omitSupervisor: true,
    onRoute: (route) => routes.push(route),
  });
  const tasks = Array.from({ length: width }, (_, i) => ({ key: `task-${i}`, args: i }));
  const results = await pool.submitMany(tasks, (x) => x);
  assert.deepEqual(results, tasks.map((t) => t.args), `width ${width}: results in input order`);
  return { world, route: routes[0], routes };
}

// ── (1) past the old threshold, up to the limit: in-DO, all at once ────────
for (const width of [5, 8, DO_DYNAMIC_WORKER_LIMIT]) {
  const { world, route } = await run(width);
  assert.equal(world.peerTasks, 0, `width ${width}: no task reaches a sibling DO`);
  assert.equal(world.inDo, width, `width ${width}: every task runs on the coordinator's loader`);
  assert.equal(world.inDoIds.size, width, `width ${width}: one Dynamic Worker per task`);
  assert.equal(world.inDoPeak, width, `width ${width}: all ${width} in flight at once`);
  assert.deepEqual(route, { topology: 'in-do', tasks: width, headroom: DO_DYNAMIC_WORKER_LIMIT });
}

// ── (2) one past the headroom: sibling DOs ──────────────────────────────────
{
  const width = DO_DYNAMIC_WORKER_LIMIT + 1;
  const { world, route } = await run(width);
  assert.equal(world.inDo, 0, 'a batch wider than the headroom spends no coordinator loader');
  assert.equal(world.peerTasks, width, 'every task goes to a sibling');
  assert.equal(route.topology, 'peer-do');
}

// ── (3) workers already in flight shrink the headroom; repeats count once ──
{
  const ctx = freshCtx();
  // A resident process with two open requests, and the esbuild facet.
  const endA = beginLoaderFetch(ctx, 'resident:proc-1');
  const endA2 = beginLoaderFetch(ctx, 'resident:proc-1');
  const endB = beginLoaderFetch(ctx, 'esbuild-facet');
  const headroom = DO_DYNAMIC_WORKER_LIMIT - 2;

  const fits = await run(headroom, { ctx });
  assert.equal(fits.route.topology, 'in-do', 'two distinct workers in flight leave room for 8');
  assert.equal(fits.route.headroom, headroom);

  const over = await run(headroom + 1, { ctx });
  assert.equal(over.route.topology, 'peer-do', 'the ninth would exceed the limit, so it shards');
  assert.equal(over.world.inDo, 0);

  // One of resident:proc-1's two requests ends: the worker is still in flight.
  endA2();
  assert.equal((await run(headroom + 1, { ctx })).route.topology, 'peer-do',
    'a worker with any request still open keeps its slot');
  endA();
  endB();
  assert.equal((await run(DO_DYNAMIC_WORKER_LIMIT, { ctx })).route.topology, 'in-do',
    'once they end, the whole budget is back');
}

// ── (4) a running fan-out's width stays claimed ─────────────────────────────
{
  const ctx = freshCtx();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const first = run(6, { ctx, world: makeWorld({ gate }) });
  // Let the first batch route and dispatch.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await run(6, { ctx });
  assert.equal(second.route.topology, 'peer-do', 'a concurrent batch sees only what the first left');
  assert.equal(second.world.inDo, 0);
  open();
  assert.equal((await first).route.topology, 'in-do');
  assert.equal((await run(DO_DYNAMIC_WORKER_LIMIT, { ctx })).route.topology, 'in-do',
    'the claim is returned when the batch settles');
}

// ── (4b) the claim is returned when a batch fails, too ──────────────────────
{
  const ctx = freshCtx();
  const world = makeWorld();
  world.env.LOADER.get = () => ({
    getEntrypoint: () => ({ async execute() { throw new Error('task failed'); } }),
  });
  const pool = new Fanout(world.env, ctx, { network: ISOLATE_NETWORK, tag: 'routing-test', omitSupervisor: true, timeoutMs: 0 });
  await assert.rejects(pool.submitMany([{ key: 'k', args: 1 }, { key: 'l', args: 2 }], (x) => x), /task failed/);
  assert.equal((await run(DO_DYNAMIC_WORKER_LIMIT, { ctx })).route.topology, 'in-do',
    'a failed batch gives its width back');
}

// ── (5) back-to-back fan-outs, each the whole budget ────────────────────────
{
  const ctx = freshCtx();
  const CAP = 'Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.';
  // The platform: a worker stays counted 20 ms after its call returns, and
  // an eleventh distinct one is refused before it starts.
  const counted = new Set();
  let refused = 0;
  let ran = 0;
  const env = {
    LOADER: {
      get(id) {
        return {
          getEntrypoint: () => ({
            async execute(arg) {
              if (!counted.has(id) && counted.size >= DO_DYNAMIC_WORKER_LIMIT) { refused++; throw new Error(CAP); }
              counted.add(id);
              ran++;
              await new Promise((resolve) => setTimeout(resolve, 1));
              setTimeout(() => counted.delete(id), 20);
              return arg;
            },
          }),
        };
      },
    },
  };
  const batch = (tag) => new Fanout(env, ctx, { network: ISOLATE_NETWORK, tag, omitSupervisor: true, timeoutMs: 0 }).submitMany(
    Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => ({ key: `${tag}-${i}`, args: i })),
    (x) => x,
  );
  const first = await batch('resolve-layer');
  assert.deepEqual(first, [...Array(DO_DYNAMIC_WORKER_LIMIT).keys()]);
  const second = await batch('install-batch');
  assert.deepEqual(second, [...Array(DO_DYNAMIC_WORKER_LIMIT).keys()], 'the next fan-out, the whole budget, runs in-DO');
  assert.ok(refused > 0, 'the platform did refuse the second fan-out at first');
  assert.equal(ran, 2 * DO_DYNAMIC_WORKER_LIMIT, 'every task ran exactly once: a refused call had not started');
}

console.log('ok - fanout-dynamic-worker-routing (in-DO to the headroom, peers past it, live holds and claims respected)');
