#!/usr/bin/env bun
// read-profile: a synchronous read one session missed is held by the next
// session's launch of the same installed package (same tarball integrity),
// and a hostile profile can at worst make a session stage more of its own
// files, never different bytes and never anything outside the package.

import assert from 'node:assert/strict';
import {
  ReadProfile,
  READ_PROFILE_MAX_PATHS,
  validProfilePath,
} from '../../packages/worker/src/facets/read-profile.ts';
import { planFacetData } from '../../packages/worker/src/facets/data-plan.ts';

/** An R2 bucket in memory, with list pagination. */
function bucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) { return objects.has(key) ? { text: async () => objects.get(key) } : null; },
    async put(key, value) { objects.set(key, value); },
    async list({ prefix, cursor }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 2);
      return { objects: page.map((key) => ({ key })), truncated: start + 2 < keys.length, cursor: String(start + 2) };
    },
  };
}

const ASTRO = 'sha512-QXN0cm8gNi4xLjI=';
const ASTRO_OTHER_BUILD = 'sha512-YW5vdGhlciB0YXJiYWxs';
const integrities = {
  'home/user/app/node_modules/astro': ASTRO,
  'home/user/other/node_modules/astro': ASTRO,
  'home/user/fork/node_modules/astro': ASTRO_OTHER_BUILD,
  'home/user/app/node_modules/@scope/pkg': 'sha512-c2NvcGU=',
};
const integrityOf = (root) => integrities[root] ?? null;

const store = bucket();
const sessionA = new ReadProfile(store);
const added = await sessionA.record([
  '/home/user/app/node_modules/astro/dist/runtime/client/dev-toolbar/entrypoint.js',
  'home/user/app/node_modules/@scope/pkg/data/table.bin',
  'home/user/app/src/secret.txt', // a session's own file: not shared
  'home/user/app/node_modules/astro/node_modules/x/y.js', // another package's file
  'home/user/nolock/node_modules/pkg/a.json', // no integrity: not shared
], integrityOf);
assert.equal(added, 2);
assert.equal(store.objects.size, 2, 'one object per installed package');
assert.ok([...store.objects.keys()].every((k) => k.includes('sha512')), 'keyed by integrity');
assert.ok(![...store.objects.values()].some((v) => v.includes('secret') || v.includes('home/user')), 'package-relative paths only');

// Another session, another project, the same tarball: held at its own root.
const sessionB = new ReadProfile(store);
assert.deepEqual(
  await sessionB.lookup(['home/user/other/node_modules/astro'], integrityOf),
  ['home/user/other/node_modules/astro/dist/runtime/client/dev-toolbar/entrypoint.js'],
);
// The same name and version from a different tarball learned nothing.
assert.deepEqual(await sessionB.lookup(['home/user/fork/node_modules/astro'], integrityOf), []);

// Hostile entries are dropped on the way out, whatever is stored.
const hostileKey = [...store.objects.keys()].find((k) => k.includes(encodeURIComponent(ASTRO)));
store.objects.set(hostileKey, JSON.stringify({
  paths: ['../../../../etc/passwd', '/etc/passwd', 'a/../../b', './x', 'a//b', 'node_modules/evil/x.js', 'x\0y',
    'z'.repeat(600), 42, 'ok.txt', ...Array.from({ length: READ_PROFILE_MAX_PATHS + 50 }, (_, i) => `many/${i}.txt`)],
}));
const looked = await new ReadProfile(store).lookup(['home/user/app/node_modules/astro'], integrityOf);
assert.ok(looked.includes('home/user/app/node_modules/astro/ok.txt'));
assert.ok(looked.every((p) => p.startsWith('home/user/app/node_modules/astro/') && !p.includes('..') && !p.includes('/node_modules/evil')));
assert.ok(looked.length <= READ_PROFILE_MAX_PATHS, `bounded (${looked.length})`);
for (const bad of ['../x', '/x', 'a/./b', '', 'a\\b']) assert.equal(validProfilePath(bad), false, bad);

// Recording never grows a profile past its bound.
await new ReadProfile(store).record(
  Array.from({ length: READ_PROFILE_MAX_PATHS + 100 }, (_, i) => `home/user/app/node_modules/@scope/pkg/more/${i}.js`),
  integrityOf,
);
const scoped = [...store.objects].find(([k]) => k.includes(encodeURIComponent('sha512-c2NvcGU=')))[1];
assert.equal(JSON.parse(scoped).paths.length, READ_PROFILE_MAX_PATHS);

// A learned path widens only what the session's own listing has: one naming
// no file there plans nothing, and bytes still come from the session.
const files = new Map([
  ['home', 'directory'], ['home/user', 'directory'], ['home/user/app', 'directory'],
  ['home/user/app/node_modules', 'directory'], ['home/user/app/node_modules/astro', 'directory'],
  ['home/user/app/node_modules/astro/ok.txt', 'file'],
]);
const source = {
  list: async () => ({ entries: [...files].map(([path, kind]) => ({ path, kind, size: 3 })), next: null }),
  readText: async () => null,
  stat: async () => null,
};
const plan = await planFacetData(source, {
  cwd: '/srv', home: '/nobody', closure: [], refs: [], learned: looked,
});
assert.deepEqual(plan.paths, ['home/user/app/node_modules/astro/ok.txt']);

// A package no lockfile pins is identified by its package.json's content key.
{
  const linked = bucket();
  const key = 'pkgjson:' + 'ab'.repeat(32);
  const byKey = (root) => (root.endsWith('/linked') ? key : null);
  assert.equal(await new ReadProfile(linked).record(['home/user/app/node_modules/linked/tpl/x.hbs'], byKey), 1);
  assert.deepEqual(
    await new ReadProfile(linked).lookup(['home/user/other/node_modules/linked'], byKey),
    ['home/user/other/node_modules/linked/tpl/x.hbs'],
  );
  // Anything else as an identity is refused.
  assert.equal(await new ReadProfile(linked).record(['home/user/app/node_modules/z/a.js'], () => 'name@1.0.0'), 0);
}

console.log('read-profile: ok');
