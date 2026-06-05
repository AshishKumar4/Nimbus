#!/usr/bin/env bun
// behavioral/git-clone — clone the Nimbus repo over HTTPS; assert the
// clone completes (no freeze) and produces an expected file count.
//
// Black-box surfaces only. NO _diag.

import { mintSession, Terminal, makeAsserter, sleep } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('git-clone');
console.log(`behavioral/git-clone — clone Nimbus, count files\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await sleep(2_000);

await t.run('cd /home/user', 10_000);

// Clone the Cloudflare-public Hello-World mirror — small (~10 files)
// so the test stays fast. The Nimbus's git command doesn't accept
// `--depth` flags (cf-git argv parsing), so this is a full clone.
const REPO = 'https://github.com/octocat/Hello-World.git';
const t0 = Date.now();
let cloneOk = false;
let fileCount = 0;
let cloneOutput = '';
try {
  const r = await t.run(`git clone ${REPO} cloned-repo`, 180_000);
  cloneOutput = r.output;
  cloneOk = /Cloning into|done\.|Receiving objects/.test(r.output) && !/clone failed/.test(r.output);
  // Count files — exclude .git/ to focus on "useful" tree.
  const r2 = await t.run('ls -1 cloned-repo | wc -l', 30_000);
  const m = r2.output.match(/(\d+)/g);
  if (m && m.length > 0) fileCount = parseInt(m[m.length - 1], 10);
} catch (e) {
  console.error(`clone failed: ${e?.message ?? e}`);
}
const elapsed = Date.now() - t0;

a.check(`git clone produced "Cloning into" marker AND no "clone failed" (within 180s)`,
  cloneOk, `elapsed=${elapsed}ms output=${cloneOutput.slice(-200)}`);
a.check(`cloned tree has ≥1 file (got ${fileCount})`, fileCount >= 1, `fileCount=${fileCount}`);
a.check(`clone completed under 180s wall (${(elapsed/1000).toFixed(1)}s)`, elapsed < 180_000);

// Now also test the bigger 1600-file clone (Nimbus repo) to validate
// the W7 writeBatchStream pipeline doesn't freeze. This is the
// git-freeze-Q-fix regression target.
const BIG_REPO = 'https://github.com/AshishKumar4/Nimbus.git';
const tBig0 = Date.now();
let bigOk = false;
let bigFileCount = 0;
try {
  const r = await t.run(`git clone ${BIG_REPO} cloned-nimbus`, 180_000);
  bigOk = /Cloning into|Receiving objects/.test(r.output) && !/clone failed/.test(r.output);
  const r2 = await t.run('ls -1 cloned-nimbus | wc -l', 30_000);
  const m = r2.output.match(/(\d+)/g);
  if (m && m.length > 0) bigFileCount = parseInt(m[m.length - 1], 10);
} catch (e) {
  console.error(`big clone failed: ${e?.message ?? e}`);
}
const bigElapsed = Date.now() - tBig0;
a.check(`Nimbus clone (1600+ file repo) completes within 180s (no freeze)`,
  bigOk, `elapsed=${bigElapsed}ms`);
a.check(`Nimbus clone tree has top-level entries (got ${bigFileCount})`,
  bigFileCount >= 5, `fileCount=${bigFileCount}`);

await t.close();
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
