#!/usr/bin/env bun
// node/staged-bundle-survives-first-barrier — a staged cell is not thrown away
// by the process's own first async read.
//
// The supervisor stages a snapshot of the filesystem into every facet so that
// synchronous fs works at all, and stamps the snapshot with the VFS cursor it
// was read at. The cursor is what makes the first ACQUIRE an ordinary delta: a
// facet that arrives without one asks the authority about a null epoch, which
// is not a cursor any delta can be computed from, so the only answer is poison
// — drop the whole resident set. One `fs.promises` call then costs the process
// every staged cell it holds, and the next synchronous read of any of them
// raises EAGAIN for content that was staged correctly and never changed.
//
// Measured on 3d262c5: `pi`, launched as an installed bin, was handed all 3210
// cells of its bundle and lost them to its own startup config read, then died
// on `readFileSync` of its `dist/modes/interactive/theme/dark.json`. The
// one-shot facet body seeded the cursor; the long-running body — every server,
// every `--watch`, every bin promoted to resident — never did.
//
// The probe is deliberately not pi. What fails is any long-running process
// that reads a staged file synchronously after touching async fs, so the
// witness is exactly that and nothing else: read the file, await one async
// read, read it again. Same path, same process, no writer anywhere.

import {
  connectProcessTerminal, deleteSession, heredocCommand, makeAsserter,
  mintSession, stripAnsi, Terminal,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/staged-bundle-survives-first-barrier');

const STAGED = '/home/user/staged-cell.txt';
const OTHER = '/home/user/other-cell.txt';
const VALUE = 'STAGED-VALUE';

// --watch promotes the script to the resident (long-running) facet, which is
// the body that carries the defect. The absolute literals are what stage both
// files, so the "before" read proves the cell really was resident.
const script = `
const fs = require('fs');
const fsp = require('fs/promises');
const read = () => { try { return fs.readFileSync('${STAGED}', 'utf8').trim(); } catch (e) { return 'ERR:' + e.code; } };
(async () => {
  console.log('BEFORE=' + read());
  await fsp.readFile('${OTHER}', 'utf8');
  console.log('AFTER=' + read());
  console.log('PROBEDONE');
})();
// Hold the process open past the reads; the facet is resident by construction.
setInterval(() => {}, 60000);
`.trim();

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run(`printf '%s\\n' ${VALUE} > ${STAGED}`, 30_000);
  await t.run(`printf '%s\\n' other > ${OTHER}`, 30_000);
  await t.run(heredocCommand('/home/user/barrier-probe.js', script), 30_000);

  const launch = stripAnsi((await t.run('node --watch /home/user/barrier-probe.js', 60_000)).output);
  const pid = Number((launch.match(/pid=(\d+)/) || [])[1] || 0);
  a.check('the script runs in a resident facet', pid > 0, JSON.stringify(launch.slice(-400)));

  let out = launch;
  if (pid > 0) {
    const proc = await connectProcessTerminal(sid, pid);
    await proc.waitFor((o) => o.includes('PROBEDONE'), 90_000, 'probe output').catch(() => {});
    out = stripAnsi(proc.output);
    try { proc.ws.close(); } catch { /* probe teardown */ }
  }

  // The "before" read is the control: without it a green "after" could mean
  // the file was never staged and the async read repaired it on the way past.
  a.check('the staged cell is readable synchronously',
    out.includes(`BEFORE=${VALUE}`), JSON.stringify(out.slice(-800)));
  a.check('the staged cell survives the process\'s first async read',
    out.includes(`AFTER=${VALUE}`), JSON.stringify(out.slice(-800)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
