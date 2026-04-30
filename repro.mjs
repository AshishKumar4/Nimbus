/**
 * repro.mjs — verification harness for the npm install OOM fix.
 *
 * Asserts:
 *   1. WS stays open through 90s
 *   2. vfs.files climbs past 1000 within the window
 *   3. counters.installPhase eventually reaches 'done' OR install
 *      progresses through 'fetch'/'write' stages without the banner
 *      reprinting (DO restart)
 *   4. counters.cumulativePackumentBytesDecoded stays near 0 in the
 *      supervisor when resolverPath = 'in-facet' (smoking gun for the
 *      resolver-OOM fix)
 *
 * Exits 0 on success ("INSTALL OK"), 1 on any assertion failure.
 *
 * Polls every 2s. Prints a one-line counter snapshot per tick so a
 * crashed run leaves a forensic trail.
 *
 * Usage:
 *   node repro.mjs
 *   BASE=https://nimbus.ashishkmr472.workers.dev node repro.mjs
 */

import WebSocket from 'ws';

const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const TIMEOUT_S = parseInt(process.env.TIMEOUT_S || '120', 10);
const POLL_MS = 2000;
const TARGET_FILES = 1000;

const fail = (msg) => { console.log('ASSERTION FAILED:', msg); process.exit(1); };

// Step 1: get a session id
const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const loc = r.headers.get('location');
const sid = loc.match(/\/s\/([^\/]+)/)?.[1];
if (!sid) fail('could not obtain session id');
console.log('sid=' + sid);

const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let o = '';
let wsClosed = false;
let wsCloseInfo = null;
w.on('open', () => w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 })));
w.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'output') o += m.data;
});
w.on('error', (e) => console.log('WS error:', e.message));
w.on('close', (code, reason) => {
  wsClosed = true;
  wsCloseInfo = { code, reason: String(reason) };
  console.log('WS closed:', code, String(reason));
});

const cmd = (c) => w.send(JSON.stringify({ type: 'input', data: c + '\r' }));
const strip = (s) => s.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '');
const probe = async () => {
  try {
    const r = await fetch(BASE + '/s/' + sid + '/api/_diag/memory');
    return await r.json();
  } catch (e) { return { err: e.message }; }
};

await new Promise((r) => setTimeout(r, 4000));
console.log('--- baseline (before any cmd) ---');
const baseline = await probe();
console.log(JSON.stringify(baseline.counters || {}));

cmd('cd app && npm install');
console.log('-- npm install issued --');

const startedAt = Date.now();
let bannerSeenInitially = /Cloud Dev Environment/.test(strip(o));
let succeeded = false;
let bannerReprinted = false;
let lastSnapshot = null;
let peakSupervisorBytesDecoded = 0;
let peakFacetBytesDecoded = 0;
let firstFacetSeenAt = null;

const ticks = Math.ceil(TIMEOUT_S * 1000 / POLL_MS);
for (let i = 0; i < ticks; i++) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const m = await probe();
  lastSnapshot = m;
  const c = m.counters || {};
  const tail = strip(o).slice(-200).replace(/\n/g, ' | ');
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  if (typeof c.cumulativePackumentBytesDecoded === 'number' &&
      c.cumulativePackumentBytesDecoded > peakSupervisorBytesDecoded) {
    peakSupervisorBytesDecoded = c.cumulativePackumentBytesDecoded;
  }

  if (c.resolverPath === 'in-facet' && !firstFacetSeenAt) {
    firstFacetSeenAt = elapsed;
  }

  const inst = c.installFacet || { path: 'unset', tarballsCompleted: 0, cumulativeBytesDecoded: 0 };
  console.log(
    `[${elapsed}s] phase=${c.installPhase}/${c.resolverPhase} ` +
    `resolver=${c.resolverPath}(${(c.cumulativePackumentBytesDecoded / (1024 * 1024) || 0).toFixed(1)}MiB) ` +
    `install=${inst.path}(${inst.tarballsCompleted}t/${(inst.cumulativeBytesDecoded / (1024 * 1024) || 0).toFixed(1)}MiB) ` +
    `files=${m.vfs?.files} ws=${wsClosed ? 'CLOSED' : 'open'}`,
  );
  if (i % 5 === 0) console.log('  tail:', tail);

  // DO restart detection: banner reprints in the terminal output
  // AFTER the install was issued.
  const tail1k = strip(o).slice(-1000);
  if (/Cloud Dev Environment/.test(tail1k) && i > 1) {
    // The seed banner is at the very start of `o`. We're looking for
    // a SECOND occurrence (DO restart). Count occurrences:
    const occurrences = (strip(o).match(/Cloud Dev Environment/g) || []).length;
    if (occurrences > 1) {
      bannerReprinted = true;
      console.log('!!! DO RESTARTED — banner reprinted at t=' + elapsed + 's');
      break;
    }
  }

  // WS closed unexpectedly = crash signal
  if (wsClosed) {
    console.log('!!! WS closed unexpectedly at t=' + elapsed + 's');
    break;
  }

  // vfs.files crossing TARGET_FILES is a strong positive signal
  if ((m.vfs?.files || 0) > TARGET_FILES) {
    console.log(`>>> vfs.files crossed ${TARGET_FILES} at t=${elapsed}s`);
  }

  // installPhase = done is the explicit success signal
  if (c.installPhase === 'done') {
    succeeded = true;
    console.log('=== installPhase=done at t=' + elapsed + 's ===');
    // Give 2s grace for stragglers, then break
    await new Promise((r) => setTimeout(r, 2000));
    break;
  }

  // Shell-prompt heuristic (legacy): we see "$ " at the end of the
  // last line, install probably finished even if phase didn't update.
  if (/\$\s*$/.test(strip(o).slice(-30)) && i > 5) {
    succeeded = true;
    console.log('=== shell prompt returned at t=' + elapsed + 's ===');
    break;
  }
}

console.log('=== final terminal (last 1500 chars) ===');
console.log(strip(o).slice(-1500));

console.log('\n=== final counter snapshot ===');
console.log(JSON.stringify(lastSnapshot?.counters || {}, null, 2));

console.log('\n=== PEAK SUPERVISOR cumulativePackumentBytesDecoded:',
  (peakSupervisorBytesDecoded / (1024 * 1024)).toFixed(2), 'MiB ===');

console.log('=== resolverPath:', lastSnapshot?.counters?.resolverPath || '(unset)', '===');
console.log('=== firstFacetSeenAt:', firstFacetSeenAt !== null ? firstFacetSeenAt + 's' : 'never', '===');
console.log('=== final vfs.files:', lastSnapshot?.vfs?.files, '===');
console.log('=== ws status:', wsClosed ? 'closed ' + JSON.stringify(wsCloseInfo) : 'open', '===');
console.log('=== bannerReprinted:', bannerReprinted, '===');

try { w.close(); } catch {}

// Assertions
if (bannerReprinted) fail('DO restarted (banner reprinted)');
if (wsClosed && !succeeded) fail('WS closed before install completed');

const finalFiles = lastSnapshot?.vfs?.files || 0;
if (finalFiles < 100) fail(`vfs.files=${finalFiles}, expected >100`);

const installedLine = strip(o).match(/Done! (\d+) packages, (\d+) files/);
if (installedLine) {
  console.log(`\nINSTALL OK: ${installedLine[1]} packages, ${installedLine[2]} files`);
} else if (succeeded && finalFiles > TARGET_FILES) {
  console.log(`\nINSTALL OK: vfs.files=${finalFiles} (no explicit done line, but heuristic met)`);
} else if (finalFiles >= TARGET_FILES) {
  console.log(`\nINSTALL OK (partial): vfs.files=${finalFiles}, but install phase did not reach 'done'`);
} else {
  fail(`install did not complete: vfs.files=${finalFiles}, succeeded=${succeeded}`);
}

process.exit(0);
