#!/usr/bin/env bun
// A facet name belongs to the process last given it. A process released
// after a newer one took its name (Kinu's ask 59: the platform ended an
// activation and kept its facets, and the next activation launched the same
// durable application into its app-slot) must not end, drain or delete the
// facet its successor now runs in.

import assert from 'node:assert/strict';
import { answerHostWatch } from './lib/host-watch-socket.mjs';
import { processes } from '../../packages/fabric/src/workerd-facet-host.ts';

/**
 * One object's `ctx.facets`, as the platform keeps it: get starts a facet
 * only when none runs under the name (a running one answers, whatever class
 * is asked for), abort ends the running one and keeps its storage, delete
 * ends it and drops its storage. Every incarnation of the object sees it.
 */
function platformFacets() {
  let made = 0;
  const running = new Map();
  const stored = new Set();
  const ended = [];
  const facets = {
    get(name, start) {
      let instance = running.get(name);
      if (instance === undefined) {
        instance = { id: ++made, name };
        running.set(name, instance);
        stored.add(name);
        Promise.resolve().then(start).catch(() => {});
      }
      const id = instance.id;
      return {
        async startProcess() { return { instance: id }; },
        async handleHttpRequest() { return new Response(`instance ${id}`); },
        async settle() {},
        fetch: answerHostWatch(),
      };
    },
    abort(name, reason) {
      const instance = running.get(name);
      if (instance !== undefined) ended.push({ name, instance: instance.id, why: reason?.message });
      running.delete(name);
    },
    delete(name) {
      facets.abort(name, new Error('deleted'));
      stored.delete(name);
    },
  };
  return { facets, running: (name) => running.get(name)?.id, stored: (name) => stored.has(name), ended };
}

/** An incarnation of the object: a ctx of its own over the same facets and storage. */
const incarnation = (platform, id = 'session') => ({ id: { toString: () => id }, storage: {}, facets: platform.facets });

const env = { LOADER: { get: () => ({ getDurableObjectClass: () => class {} }) } };
const disk = () => ({});
const spawn = (ctx, pid, facet) => processes(ctx, env).spawn(
  disk,
  { doId: ctx.id.toString(), pid, writerId: `w${pid}` },
  { pid, writerId: `w${pid}`, startArgs: {}, boot: { kind: 'code', code: {} }, ...(facet === undefined ? {} : { facet }) },
);

// ── a durable application, its activation ended and its facets kept ─────────
{
  const platform = platformFacets();
  const ended = incarnation(platform);
  const next = incarnation(platform);
  const before = spawn(ended, 1000002, { name: 'app-slot-0', durable: true });
  await before.started;
  const after = spawn(next, 2000002, { name: 'app-slot-0', durable: true });
  const booted = await after.started;
  // The ended activation sees its process gone and releases it.
  await before.release();
  assert.equal(platform.running('app-slot-0'), booted.instance, `the next activation's application still runs: ${JSON.stringify(platform.ended)}`);
  assert.ok(!platform.ended.some((e) => e.instance === booted.instance), 'and nothing the ended activation released ended it');
  console.log('  ✓ a release leaves the facet its successor runs in alone (durable)');
}

// ── an ephemeral process, the same shape ─────────────────────────────────────
{
  const platform = platformFacets();
  const ended = incarnation(platform);
  const next = incarnation(platform);
  const before = spawn(ended, 1000003);
  await before.started;
  const after = spawn(next, 2000003);
  assert.equal(after.name, before.name, 'the next incarnation numbers its slots from 0 again');
  const booted = await after.started;
  await before.release();
  assert.equal(platform.running(after.name), booted.instance, 'the successor still runs');
  assert.ok(platform.stored(after.name), 'and its store was not deleted');
  console.log('  ✓ a release leaves the facet its successor runs in alone (ephemeral)');
}

// ── one incarnation: a name shared by two of its processes ──────────────────
// A spawn never ends what its own incarnation runs under a name
// (durable-facet-storage 5b): the second process shares the facet. The
// first one's release leaves it to the second, whose release ends it.
{
  const platform = platformFacets();
  const ctx = incarnation(platform);
  const first = spawn(ctx, 3000001, { name: 'app-slot-1', durable: true });
  const shared = (await first.started).instance;
  const second = spawn(ctx, 3000002, { name: 'app-slot-1', durable: true });
  assert.equal((await second.started).instance, shared, 'the second shares the running facet');
  await first.release();
  assert.equal(platform.running('app-slot-1'), shared, 'the first one\'s release leaves it running for the second');
  await second.release();
  assert.equal(platform.running('app-slot-1'), undefined, 'the last holder\'s release ends it');
  console.log('  ✓ a facet two processes of one incarnation share ends with the last one\'s release');
}

// ── the holder's own release still ends its facet ───────────────────────────
{
  const platform = platformFacets();
  const ctx = incarnation(platform);
  const durable = spawn(ctx, 4000001, { name: 'app-slot-2', durable: true });
  const ephemeral = spawn(ctx, 4000002);
  await Promise.all([durable.started, ephemeral.started]);
  await durable.release();
  await ephemeral.release();
  assert.equal(platform.running('app-slot-2'), undefined, 'a durable release ends its facet');
  assert.ok(platform.stored('app-slot-2'), 'and keeps its store');
  assert.equal(platform.running(ephemeral.name), undefined, 'an ephemeral release ends its facet');
  assert.ok(!platform.stored(ephemeral.name), 'and drops its store');
  console.log('  ✓ a holder\'s release ends its facet as before');
}
console.log('facet-name-successor: ok');
