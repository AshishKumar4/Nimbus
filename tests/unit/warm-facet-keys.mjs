#!/usr/bin/env bun
// Warm facets belong to one session. A runtime's warm keys are made from
// its session, a worker kept warm serves that session's processes only, and
// one process runs on a key at a time. Two sessions in one isolate, over
// one loader, never share a worker, though their runtime and their key
// counts are the same.

import assert from 'node:assert/strict';
import { warmFacetKeys, warmFacetScope } from '../../packages/core/src/runtime/warm-facets.ts';
import { loaderFacetHost } from '../../packages/worker/src/runtime/facet-loader-host.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

// ── the keys ─────────────────────────────────────────────────────────────
{
  const keys = warmFacetKeys('session-a', 'git', 2);
  const first = keys.take();
  const second = keys.take();
  assert.equal(first.session, 'session-a');
  assert.notEqual(first.name, second.name, 'two processes at once take two keys');
  keys.give(first);
  assert.equal(keys.take(), first, 'a key given back is taken again');
  const third = keys.take();
  keys.give(first);
  keys.give(second);
  keys.give(third);
  const again = [keys.take(), keys.take(), keys.take()];
  assert.equal(again.filter((key) => [first, second, third].includes(key)).length, 2, 'no more than `kept` are kept idle: the third taken is new');
  assert.equal(new Set(again.map((k) => k.name)).size, 3);
  assert.throws(() => keys.give({ session: 'session-b', name: first.name }), /another session/, 'a key of another session is refused');
  assert.throws(() => warmFacetKeys('', 'git', 2), /belongs to a session/, 'a warm facet without a session is refused');
  assert.notEqual(warmFacetKeys('session-a', 'git', 2).take().name, first.name, 'another incarnation never names a key twice');
  assert.ok(warmFacetScope(first).startsWith('session-a:'), 'the scope names the session first');
  console.log('  ✓ warm keys: taken, given back, bounded, a session\'s own');
}

// ── two sessions, one isolate's loader ───────────────────────────────────
// Both sessions use the same warm name, and their ids share more than the
// pool's short id: only the session in the key keeps their workers apart.
{
  const built = [];
  const loader = {
    LOADER: {
      cache: new Map(),
      get(id, load) {
        if (!this.cache.has(id)) {
          built.push(id);
          this.cache.set(id, load());
        }
        const ready = this.cache.get(id);
        return { getEntrypoint: () => ({ async execute() { await ready; return 'ok'; } }) };
      },
    },
  };
  const ctxOf = (name) => ({ id: { toString: () => name }, waitUntil() {} });
  const sessions = ['0123456789abcdef-one', '0123456789abcdef-two'].map((id) => ({ ctx: ctxOf(id), key: { session: id, name: 'ruby-1' } }));
  const task = facetTaskSource('async () => "ok"');
  const run = async ({ ctx, key }) => {
    const facet = loaderFacetHost(loader, ctx, ISOLATE_NETWORK).open({ tag: 'ruby-runner', concurrency: 1, warm: key });
    try {
      assert.equal(await facet.submit(task, {}), 'ok');
    } finally {
      facet.dispose();
    }
  };
  for (let i = 0; i < 3; i++) for (const session of sessions) await run(session);
  assert.equal(built.length, 2, `one worker per session, kept warm across its processes: ${JSON.stringify(built)}`);
  console.log('  ✓ two sessions in one isolate never share a warm worker');

  // A key that names no session is refused where the host reads it.
  for (const key of [{ session: '', name: 'ruby-1' }, { name: 'ruby-1' }]) {
    assert.throws(() => loaderFacetHost(loader, ctxOf('0123456789abcdef-one'), ISOLATE_NETWORK).open({ tag: 'ruby-runner', concurrency: 1, warm: key }), /belongs to a session/);
  }
  console.log('  ✓ a warm key without a session is refused by the host');
}
console.log('warm-facet-keys: ok');
