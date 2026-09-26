#!/usr/bin/env bun
// read-profile: a synchronous read one session missed can be held by later
// sessions' launches of the same installed package (same tarball
// integrity), and nothing a program says can poison what other tenants
// stage: evidence is what the supervisor served, an entry is shared only
// after two principals (verified tenant + subject, never session ids, which
// are free) observed it, anonymous sessions only read, a principal's writes
// are capped, a launch's share is bounded in bytes, a program's word can
// only lower an entry, and a hostile object can at worst make a session
// stage more of its own files.

import assert from 'node:assert/strict';
import {
  profilePrincipal,
  ReadProfile,
  READ_PROFILE_MAX_ENTRIES,
  READ_PROFILE_WRITES_PER_WINDOW,
  ServedReads,
  principalTag,
  validProfilePath,
  verifiedEvidence,
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
const integrities = {
  'home/user/app/node_modules/astro': ASTRO,
  'home/user/other/node_modules/astro': ASTRO,
  'home/user/fork/node_modules/astro': 'sha512-YW5vdGhlciB0YXJiYWxs',
  'home/user/app/node_modules/@scope/pkg': 'sha512-c2NvcGU=',
};
const integrityOf = (root) => integrities[root] ?? null;
const APP = 'home/user/app/node_modules/astro';
const OTHER = 'home/user/other/node_modules/astro';
const ENTRY = 'dist/runtime/client/dev-toolbar/entrypoint.js';

// The files as each session's process credential stats them.
const files = new Map([
  [`${APP}/${ENTRY}`, 1200],
  [`${APP}/big.bin`, 900_000],
  [`${APP}/small.json`, 40],
  ['home/user/app/node_modules/@scope/pkg/data/table.bin', 300],
  ['home/user/app/src/secret.txt', 10],
]);
const stat = async (path) => {
  const key = path.replace(/^\/+/, '');
  if (files.has(key)) return { type: 'file', size: files.get(key) };
  if (key === `${APP}/dist`) return { type: 'directory', size: 0 };
  return null;
};

// ── Evidence: only what the supervisor served, and only regular files in a package ──
{
  const served = new ServedReads();
  served.note(7, `/${APP}/${ENTRY}`);
  served.note(7, `/${APP}/small.json`);
  served.note(7, '/home/user/app/src/secret.txt');
  served.note(7, `/${APP}/dist`);
  served.note(8, `/${APP}/big.bin`); // another process's reads
  const reported = [
    `/${APP}/${ENTRY}`,               // served: evidence
    `/${APP}/small.json`,             // served: evidence
    `/${APP}/big.bin`,                // a lie: never served to pid 7
    '/home/user/app/src/secret.txt',  // served, but not in a package
    `/${APP}/dist`,                   // served, but a directory
    `/${APP}/../../../etc/passwd`,    // junk
    `/${APP}/nope.js`,                // junk: not served, not there
    42, null,                         // junk
  ];
  const evidence = await verifiedEvidence(reported, served.take(7), stat);
  assert.deepEqual(evidence.map((e) => e.path).sort(), [`${APP}/${ENTRY}`, `${APP}/small.json`]);
  assert.equal(evidence.find((e) => e.path.endsWith('small.json')).size, 40, 'the size is the stat\'s');
  assert.deepEqual([...served.take(7)], [], 'take forgets the process');
  assert.deepEqual([...served.take(8)], [`${APP}/big.bin`]);
}

const tagA = await principalTag('acme:alice');
const tagB = await principalTag('globex:bob');
assert.match(tagA, /^[0-9a-f]{16}$/);
assert.notEqual(tagA, tagB);

// ── One session alone shares nothing; a second session's observation shares it ──
const store = bucket();
const evidence = [{ path: `${APP}/${ENTRY}`, size: 1200 }, { path: `${APP}/small.json`, size: 40 }];
assert.equal(await new ReadProfile(store).observe(evidence, tagA, integrityOf), 2);
assert.equal(store.objects.size, 1, 'one object per installed package');
const stored = [...store.objects.values()][0];
assert.ok(!stored.includes('home/user') && !stored.includes('acme:alice'), 'package-relative paths and principal tags only');
assert.deepEqual(await new ReadProfile(store).lookup([OTHER], integrityOf, 1 << 20), [], 'observed by one session: not shared');
// The same session again does not count twice.
await new ReadProfile(store).observe(evidence, tagA, integrityOf);
assert.deepEqual(await new ReadProfile(store).lookup([OTHER], integrityOf, 1 << 20), []);
await new ReadProfile(store).observe([{ path: `${OTHER}/${ENTRY}`, size: 1200 }], tagB, integrityOf);
const shared = await new ReadProfile(store).lookup([OTHER], integrityOf, 1 << 20);
assert.deepEqual(shared.map((e) => e.path), [`${OTHER}/${ENTRY}`], 'shared once a second session saw it, at the looking session\'s root');
// A different tarball of the same name learned nothing.
assert.deepEqual(await new ReadProfile(store).lookup(['home/user/fork/node_modules/astro'], integrityOf, 1 << 20), []);
// Junk tags are refused.
assert.equal(await new ReadProfile(store).observe(evidence, 'not-a-tag', integrityOf), 0);

// ── The byte cap: best first, within the budget ──
{
  const capped = bucket();
  const many = [
    { path: `${APP}/a.js`, size: 600 }, { path: `${APP}/b.js`, size: 300 },
    { path: `${APP}/c.js`, size: 200 }, { path: `${APP}/d.js`, size: 5000 },
  ];
  await new ReadProfile(capped).observe(many, tagA, integrityOf);
  await new ReadProfile(capped).observe(many, tagB, integrityOf);
  const within = await new ReadProfile(capped).lookup([APP], integrityOf, 1000);
  assert.deepEqual(within.map((e) => e.path.slice(APP.length + 1)), ['c.js', 'b.js'], 'smallest first at equal score');
  assert.ok(within.reduce((n, e) => n + e.size, 0) <= 1000);
  assert.deepEqual(await new ReadProfile(capped).lookup([APP], integrityOf, 0), [], 'no budget, nothing');
}

// ── Pruning: only the supervisor raises; a program's word only lowers ──
{
  const pruned = bucket();
  const obs = [{ path: `${APP}/x.js`, size: 10 }, { path: `${APP}/y.js`, size: 10 }, { path: `${APP}/gone.js`, size: 10 }];
  await new ReadProfile(pruned).observe(obs, tagA, integrityOf);
  await new ReadProfile(pruned).observe(obs, tagB, integrityOf);
  const score = (rel) => JSON.parse(pruned.objects.values().next().value).entries[rel]?.score;
  const profile = new ReadProfile(pruned);
  let offered = await profile.lookup([APP], integrityOf, 1 << 20);
  assert.equal(offered.length, 3);
  // x: staged and never faulted in (the supervisor's evidence it was held) -> up.
  // y: the program says it never read it -> down, and at zero it is gone.
  // gone.js: the plan found no regular file -> removed.
  await profile.settle(offered, new Set([`${APP}/y.js`]), new Set(), new Set([`${APP}/gone.js`]), tagA);
  assert.equal(score('x.js'), 2);
  assert.equal(score('y.js'), undefined);
  assert.equal(score('gone.js'), undefined);
  // A lying program cannot raise: claiming nothing is unread while the
  // supervisor served x (it was faulted in, so not held) leaves x as it was.
  offered = await profile.lookup([APP], integrityOf, 1 << 20);
  await profile.settle(offered, new Set(), new Set([`${APP}/x.js`]), new Set(), tagB);
  assert.equal(score('x.js'), 2);
  // Nor can it settle an entry it was never offered.
  await profile.settle([{ path: `${APP}/x.js`, size: 10, object: 'v2/t/sha512/evil.tgz', rel: 'x.js' }], new Set([`${APP}/x.js`]), new Set(), new Set(), tagB);
  assert.equal(score('x.js'), 2);
  // A session vouches once: its later launches that held x, and reported
  // nothing unread, add nothing (Main's P2 on 76d0a14a: ten attacker launches
  // took one entry to 8). A second session's launch is a second voucher.
  for (let i = 0; i < 10; i++) {
    await profile.settle(await profile.lookup([APP], integrityOf, 1 << 20), new Set(), new Set(), new Set(), tagA);
  }
  assert.equal(score('x.js'), 2, 'one session raises an entry at most once');
  await profile.settle(await profile.lookup([APP], integrityOf, 1 << 20), new Set(), new Set(), new Set(), tagB);
  assert.equal(score('x.js'), 3, 'a second vouching session raises it once more');
  // A launch with no unread list at all (it died before reporting) is no
  // information: it neither raises nor lowers.
  await profile.settle(await profile.lookup([APP], integrityOf, 1 << 20), null, new Set(), new Set(), await principalTag('session-c'));
  assert.equal(score('x.js'), 3, 'no report raises nothing');
  // A stored score past its vouchers is not one this module wrote.
  const raw = JSON.parse(pruned.objects.values().next().value);
  raw.entries['x.js'].score = 8;
  pruned.objects.set(pruned.objects.keys().next().value, JSON.stringify(raw));
  assert.equal((await profile.lookup([APP], integrityOf, 1 << 20)).length, 1);
  await profile.settle(await profile.lookup([APP], integrityOf, 1 << 20), new Set([`${APP}/x.js`]), new Set(), new Set(), tagA);
  assert.equal(score('x.js'), 2, 'a forged score is read as observation plus its distinct vouchers');
}

// ── A full profile keeps its shared entries ──
{
  const full = bucket();
  const sharedObs = [{ path: `${APP}/keep.js`, size: 1 }];
  await new ReadProfile(full).observe(sharedObs, tagA, integrityOf);
  await new ReadProfile(full).observe(sharedObs, tagB, integrityOf);
  const flood = Array.from({ length: READ_PROFILE_MAX_ENTRIES + 50 }, (_, i) => ({ path: `${APP}/flood/${i}.js`, size: 1 }));
  await new ReadProfile(full).observe(flood, await principalTag('flooder'), integrityOf);
  const entries = JSON.parse(full.objects.values().next().value).entries;
  assert.ok(Object.keys(entries).length <= READ_PROFILE_MAX_ENTRIES, 'bounded');
  assert.ok(entries['keep.js'], 'one session\'s flood never evicts a shared entry');
  assert.deepEqual((await new ReadProfile(full).lookup([APP], integrityOf, 1 << 20)).map((e) => e.rel), ['keep.js']);
}

// ── Hostile objects are dropped on the way out ──
{
  const hostile = bucket();
  await new ReadProfile(hostile).observe([{ path: `${APP}/ok.txt`, size: 3 }], tagA, integrityOf);
  const key = [...hostile.objects.keys()][0];
  const entry = { size: 3, seen: [tagA, tagB], score: 1 };
  hostile.objects.set(key, JSON.stringify({ entries: {
    '../../../../etc/passwd': entry, '/etc/passwd': entry, 'a/../../b': entry, './x': entry, 'a//b': entry,
    'node_modules/evil/x.js': entry, 'x\0y': entry, ['z'.repeat(600)]: entry,
    'neg.txt': { ...entry, size: -1 }, 'zero.txt': { ...entry, score: 0 }, 'tags.txt': { ...entry, seen: [tagA, tagA, 'bad'] },
    'ok.txt': entry,
  } }));
  const looked = await new ReadProfile(hostile).lookup([APP], integrityOf, 1 << 20);
  assert.deepEqual(looked.map((e) => e.rel), ['ok.txt'], JSON.stringify(looked.map((e) => e.rel)));
  hostile.objects.set(key, 'not json');
  assert.deepEqual(await new ReadProfile(hostile).lookup([APP], integrityOf, 1 << 20), []);
  for (const bad of ['../x', '/x', 'a/./b', '', 'a\\b']) assert.equal(validProfilePath(bad), false, bad);
}

// ── A learned path widens only what the session's own listing has ──
{
  const listing = new Map([
    ['home', 'directory'], ['home/user', 'directory'], ['home/user/app', 'directory'],
    ['home/user/app/node_modules', 'directory'], [APP, 'directory'], [`${APP}/ok.txt`, 'file'],
  ]);
  const source = {
    list: async () => ({ entries: [...listing].map(([path, kind]) => ({ path, kind, size: 3 })), next: null }),
    readText: async () => null,
    stat: async () => null,
  };
  const plan = await planFacetData(source, {
    cwd: '/srv', home: '/nobody', closure: [], refs: [], learned: [`${APP}/ok.txt`, `${APP}/missing.txt`],
  });
  assert.deepEqual(plan.paths, [`${APP}/ok.txt`]);
}

// ── A package no lockfile pins is identified by its package.json's content key ──
{
  const linked = bucket();
  const key = 'pkgjson:' + 'ab'.repeat(32);
  const byKey = (root) => (root.endsWith('/linked') ? key : null);
  const obs = [{ path: 'home/user/app/node_modules/linked/tpl/x.hbs', size: 5 }];
  await new ReadProfile(linked).observe(obs, tagA, byKey);
  await new ReadProfile(linked).observe(obs, tagB, byKey);
  assert.deepEqual(
    (await new ReadProfile(linked).lookup(['home/user/other/node_modules/linked'], byKey, 1 << 20)).map((e) => e.path),
    ['home/user/other/node_modules/linked/tpl/x.hbs'],
  );
  assert.equal(await new ReadProfile(linked).observe(obs, tagA, () => 'name@1.0.0'), 0, 'anything else as an identity is refused');
}


// ── Principals: who a session writes as, and what anonymous sessions may do ──
{
  assert.equal(profilePrincipal('acme:alice'), 'acme:alice', 'a verified tenant and subject');
  assert.equal(profilePrincipal('acme:_'), 'acme:_', 'a tenant-wide token');
  assert.equal(profilePrincipal('anon:anon'), null, 'anonymous sessions are one principal that never writes');
  assert.equal(profilePrincipal('legacy:public:_'), null, 'legacy-public sessions are anonymous');
  assert.equal(profilePrincipal(undefined), null, 'no Durable Object name: nothing to write as');

  // rp-attack2: one principal with any number of sessions. Every session of
  // one tenant+subject is the same principal, so its observations never share
  // and its launches vouch once.
  const target = `${APP}/dist/huge-asset.js`;
  const attacked = bucket();
  const attacker = await principalTag('mallory:m');
  for (let session = 0; session < 20; session++) {
    await new ReadProfile(attacked).observe([{ path: target, size: 2 << 20 }], attacker, integrityOf);
  }
  assert.deepEqual(await new ReadProfile(attacked).lookup([APP], integrityOf, 4 << 20), [], 'one principal never shares, whatever its session count');

  // Anonymous sessions read, and never write: not an observation, not a vouch.
  const anon = bucket();
  assert.equal(await new ReadProfile(anon).observe([{ path: target, size: 10 }], null, integrityOf), 0);
  assert.equal(anon.objects.size, 0, 'an anonymous observation writes nothing');
  await new ReadProfile(anon).observe([{ path: target, size: 10 }], tagA, integrityOf);
  await new ReadProfile(anon).observe([{ path: target, size: 10 }], tagB, integrityOf);
  const before = [...anon.objects.values()][0];
  const offer = await new ReadProfile(anon).lookup([APP], integrityOf, 1 << 20);
  assert.equal(offer.length, 1, 'anonymous sessions read what two principals shared');
  await new ReadProfile(anon).settle(offer, new Set(), new Set(), new Set(), null);
  await new ReadProfile(anon).settle(offer, new Set([target]), new Set(), new Set(), null);
  assert.equal([...anon.objects.values()][0], before, 'an anonymous launch neither raises nor lowers');

  // Two principals share, as above; each vouches once.
  const score = () => JSON.parse([...anon.objects.values()][0]).entries['dist/huge-asset.js'].score;
  for (let i = 0; i < 5; i++) await new ReadProfile(anon).settle(await new ReadProfile(anon).lookup([APP], integrityOf, 1 << 20), new Set(), new Set(), new Set(), tagA);
  assert.equal(score(), 2);

  // A principal's writes to one profile are capped per window.
  let now = 1_000_000;
  const capped = bucket();
  const writer = await principalTag('acme:writer');
  const profile = new ReadProfile(capped, () => now);
  let writes = 0;
  const put = capped.put;
  capped.put = async (k, v) => { writes++; return put(k, v); };
  for (let i = 0; i < READ_PROFILE_WRITES_PER_WINDOW + 5; i++) {
    await profile.observe([{ path: `${APP}/f${i}.js`, size: 1 }], writer, integrityOf);
  }
  assert.equal(writes, READ_PROFILE_WRITES_PER_WINDOW, 'writes past the cap are dropped');
  await profile.observe([{ path: `${APP}/other.js`, size: 1 }], tagA, integrityOf);
  assert.equal(writes, READ_PROFILE_WRITES_PER_WINDOW + 1, 'the cap is per principal');
  now += 60 * 60_000;
  await profile.observe([{ path: `${APP}/late.js`, size: 1 }], writer, integrityOf);
  assert.equal(writes, READ_PROFILE_WRITES_PER_WINDOW + 2, 'a new window admits writes again');
}

console.log('read-profile: ok');
