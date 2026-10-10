#!/usr/bin/env bun
// Which programs start as residents directly (facets/server-hints.ts): hints
// only. A program that listens runs on as a resident however it started
// (FacetManager._promote); a hint saves a known server's first launch the
// run up to its listen.

import assert from 'node:assert/strict';
import { firstPositional, knownServerBin, LearnedServers, LEARNED_SERVERS_MAX } from '../../packages/worker/src/facets/server-hints.ts';

// ── serving subcommands stay resident ───────────────────────────────────────
// `preview` is a serving verb wherever it exists, so it is pinned across every
// server-shaped bin rather than for one of them.
for (const bin of ['astro', 'nuxt', 'remix', 'next', 'vite']) {
  for (const argv of [[], ['dev'], ['preview'], ['preview', '--port', '4321']]) {
    assert.equal(
      knownServerBin(bin, argv), true,
      `${bin} ${argv.join(' ')} serves and must be routed long-running`,
    );
  }
}

// ── the subcommand that ends ────────────────────────────────────────────────
// `build` produces an artifact and exits: started as a resident it would pay
// for a facet it does not need.
for (const bin of ['astro', 'nuxt', 'remix', 'vite']) {
  assert.equal(
    knownServerBin(bin, ['build']), false,
    `${bin} build exits and must stay one-shot`,
  );
}

// ── queries answer and exit ─────────────────────────────────────────────────
for (const arg of ['--help', '-h', 'help', '--version', '-v', 'version']) {
  assert.equal(
    knownServerBin('astro', [arg]), false,
    `astro ${arg} is a query, not a server`,
  );
  assert.equal(
    knownServerBin('astro', ['preview', arg]), false,
    `astro preview ${arg} is a query, not a server`,
  );
}

// ── bins outside the known-server set ───────────────────────────────────────
// Judged only by flags that ask for residency; one that listens anyway is
// run on as a resident, and learned.
assert.equal(knownServerBin('tsc', ['--noEmit']), false);
assert.equal(knownServerBin('tsc', ['--watch']), true);
assert.equal(knownServerBin('some-cli', ['preview']), false,
  'an unknown bin is not promoted by a subcommand name alone');

// ── learned: a bin that listened, in this workspace ─────────────────────────
assert.equal(firstPositional([]), '');
assert.equal(firstPositional(['--open', 'dev', '--port', '3000']), 'dev');
{
  const kept = new Map();
  const storage = {
    async get(key) { return kept.get(key); },
    async put(key, value) { kept.set(key, structuredClone(value)); },
  };
  const vite = { package: 'vite@8.0.0', bin: 'vite', arg0: '' };
  const learned = new LearnedServers(storage);
  assert.equal(await learned.has(vite), false);
  await learned.learn(vite);
  assert.equal(await learned.has(vite), true);
  assert.equal(await new LearnedServers(storage).has(vite), true, 'kept in the workspace\'s storage, for a later isolate');
  assert.equal(await learned.has({ ...vite, arg0: 'build' }), false, 'by its first positional argument');
  assert.equal(await learned.has({ ...vite, package: 'vite@8.0.1' }), false, 'and by its version');
  for (let i = 0; i < LEARNED_SERVERS_MAX; i++) await learned.learn({ package: `p${i}@1`, bin: 'b', arg0: '' });
  assert.equal(await learned.has(vite), false, 'the least recently learned leaves past the bound');
  assert.equal(kept.get('server-hints').length, LEARNED_SERVERS_MAX);
}

console.log('server-hints: known servers by name, learned ones by package, bin and first argument');
