#!/usr/bin/env bun
/**
 * wasi-resident-rewrite — a WASI process (the real body, codec and resident
 * filesystem, holding what it writes) that rewrites files it has not listed:
 * os.makedirs(d, exist_ok=True), then open(…, 'w') and a write of each, then
 * os.listdir(d) and os.path.exists. It lists every file it wrote, and each is
 * there. Red before (live, python, wasi-fs-load's second run): the directory
 * listed empty and every file just written was missing.
 */

import assert from 'node:assert/strict';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';

if (!canPark) {
  console.log('wasi-resident-rewrite: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

const N = 20;
const g = await residentGuest();
const name = (i) => `home/user/d/f${String(i).padStart(4, '0')}.txt`;
// What a first run left: the files are the session's, the guest has not listed their directory.
g.kernel.mkdir('home/user/d', { mode: 0o755 });
g.kernel.chown('home/user/d', USER.uid, USER.gid);
for (let i = 0; i < N; i++) {
  g.kernel.writeFile(name(i), String(i).repeat(10));
  g.kernel.chown(name(i), USER.uid, USER.gid);
}
assert.equal(await g.mkdir('home/user/d'), 20, 'mkdir of a directory there is EEXIST (20)');
for (let i = 0; i < N; i++) {
  const fd = await g.open(name(i), { create: true, truncate: true, write: true });
  assert.equal(await g.write(fd, String(i).repeat(10)), 0);
  assert.equal(await g.close(fd), 0);
}
const listed = await g.listdir('home/user/d');
assert.equal(listed.length, N, `the directory it rewrote listed ${listed.length} of ${N}: ${JSON.stringify(g.stats())}`);
for (const i of [0, 1, N - 1]) assert.equal(await g.statSize(name(i)), 10 * String(i).length, `${name(i)}, just written, was not there`);
await g.P.__wasiSettleWrites?.();
await g.dispose();
console.log('wasi-resident-rewrite: ok');
process.exit(0);
