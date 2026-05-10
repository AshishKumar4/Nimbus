#!/usr/bin/env bun
// behavioral/preview/process-logs-stream — vite dev-server's
// per-PID log stream (Process tab) MUST emit at least one entry past
// the synchronous banner once the dev server has handled real work.
//
// User repro (Markflow on prod 0a488bab):
//   `npm run dev` prints the banner, then NOTHING. The Process tab
//   shows the vite proc with the banner content frozen — no request
//   served, no HMR, no module bundled, no warn/error appears.
//
// Public surface this probe touches: WS /api/logs/<pid>. That's the
// surface the in-product Process tab uses; the bug is exactly that
// frames stop arriving past the banner. Strictly black-box (no
// /api/_diag, no /api/_test).
//
// RED before fix:
//   - dev-server's `log()` chokepoint is wired only to a handful of
//     warn/error sites; cold-path bundle errors. Normal request
//     serving / HMR triggers / module-bundle activity never call
//     log() and therefore never reach processLogs.append → no
//     subscriber frame past the banner.
//
// GREEN after fix:
//   - request-serving + HMR + module-bundle path all call log()
//     so subscribers see at least one chunk past the banner within
//     a few seconds of meaningful activity.

import WebSocket from 'ws';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const WS_BASE = BASE.replace(/^http/, 'ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ── mint session + connect terminal ──
const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^/]+)/)[1];
console.log(`behavioral/preview/process-logs-stream — BASE=${BASE} sid=${sid}`);

const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
let buf = '';
let tConn = false, tClosed = false;
ws.on('open', () => { tConn = true; });
ws.on('close', () => { tClosed = true; });
ws.on('error', () => {});
ws.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'output' && typeof m.data === 'string') buf += m.data;
  } catch {}
});
{
  const t0 = Date.now();
  while (!tConn && Date.now() - t0 < 15_000) await sleep(50);
  if (!tConn) { console.error('terminal connect timeout'); process.exit(2); }
}

const cmd = (line) => ws.send(JSON.stringify({ type: 'input', data: line + '\r' }));
async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate(stripAnsi(buf))) return Date.now() - t0;
    if (tClosed) throw new Error(`terminal closed waiting for ${label}`);
    await sleep(50);
  }
  throw new Error(`waitFor(${label}) timeout ${timeoutMs}ms; tail=${JSON.stringify(stripAnsi(buf).slice(-300))}`);
}
async function run(line, timeoutMs = 60_000) {
  const before = buf.length;
  cmd(line);
  await waitFor((b) => buf.length > before && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    timeoutMs, `prompt after ${line}`);
}

await sleep(1500);
await waitFor((b) => /[$#>]\s*$/.test(b.trimEnd().slice(-3)), 10_000, 'initial prompt');

// ── scaffold a tiny vite project (no npm install needed; vite is a builtin) ──
const writeFile = (path, content) => {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`;
};

await run('cd /home/user', 5000);
await run('mkdir -p /home/user/logs-test/src', 5000);
await run(writeFile('/home/user/logs-test/package.json',
  JSON.stringify({ name: 'logs-test', type: 'module', scripts: { dev: 'vite --host 0.0.0.0 --port 5173' } })),
  10_000);
await run(writeFile('/home/user/logs-test/index.html',
  '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>'), 10_000);
await run(writeFile('/home/user/logs-test/src/main.js', 'document.body.textContent = "hello-from-logs-probe";'), 10_000);

await run('cd /home/user/logs-test', 5000);

// ── start vite ──
buf = '';
cmd('npm run dev');
// Banner contains "Nimbus Vite Dev Server".
await waitFor((b) => /Nimbus Vite Dev Server/i.test(b), 30_000, 'vite banner');

// Discover the vite pid from the banner's `pid=N` print.
const pidMatch = stripAnsi(buf).match(/pid=(\d+)/);
if (!pidMatch) { console.error('FATAL: could not extract vite pid from banner'); process.exit(2); }
const vitePid = parseInt(pidMatch[1], 10);
console.log(`  detected vite pid=${vitePid}`);

// ── connect the Process-tab WS for this pid ──
//
// Snapshot what arrives in the FIRST 800 ms (the backlog frame from
// /api/logs/<pid> is sent immediately on accept; that gives us the
// "post-banner state up to now"). Then trigger real dev-server work
// (a /preview/ HEAD + a /preview/src/main.js GET + a file-write to
// trigger HMR) and assert that NEW chunks arrive within 8 s.
const logsWs = new WebSocket(`${WS_BASE}/s/${sid}/api/logs/${vitePid}`);
let backlogSeen = false;
let chunksSeen = 0;
let postBacklogChunks = [];
let logsClosed = false;
logsWs.on('open', () => {});
logsWs.on('close', () => { logsClosed = true; });
logsWs.on('error', (e) => { console.log('  logs WS error:', e?.message); });
logsWs.on('message', (data) => {
  let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
  if (m.type === 'backlog') backlogSeen = true;
  else if (m.type === 'chunk') {
    chunksSeen++;
    if (backlogSeen) postBacklogChunks.push(m);
  }
});

// Wait for connection + backlog
{
  const t0 = Date.now();
  while (!backlogSeen && Date.now() - t0 < 10_000 && !logsClosed) await sleep(50);
}
check('Process-tab WS receives backlog frame', backlogSeen, `closed=${logsClosed}`);

// Quiesce — no more chunks expected without activity.
const chunksBefore = chunksSeen;
await sleep(800);

// ── Trigger dev-server work ──
//   1. Hit /preview/  → serves index.html
//   2. Hit /preview/src/main.js → serves transformed module
//   3. Append a byte to src/main.js to trigger an HMR full-reload
{
  const url0 = `${BASE}/s/${sid}/preview/`;
  const resp0 = await fetch(url0, { redirect: 'manual' });
  await resp0.text().catch(() => '');
  const url1 = `${BASE}/s/${sid}/preview/src/main.js`;
  const resp1 = await fetch(url1, { redirect: 'manual' });
  await resp1.text().catch(() => '');
  console.log(`  triggered: GET / → ${resp0.status}, GET /src/main.js → ${resp1.status}`);
}

// Wait up to 8 s for at least ONE post-backlog chunk.
{
  const t0 = Date.now();
  while (postBacklogChunks.length === 0 && Date.now() - t0 < 8_000 && !logsClosed) {
    await sleep(100);
  }
}
check('post-banner chunk arrives within 8 s of dev-server activity',
  postBacklogChunks.length > 0,
  `postBacklogChunks=${postBacklogChunks.length}; chunksBefore=${chunksBefore}; chunksSeen=${chunksSeen}`);

if (postBacklogChunks.length > 0) {
  const sample = postBacklogChunks.slice(0, 3).map(c =>
    `[${c.stream}] ${JSON.stringify((c.data || '').slice(0, 80))}`).join(' | ');
  console.log(`  sample post-banner chunks: ${sample}`);
}

// ── teardown ──
try { logsWs.close(); } catch {}
try { ws.close(); } catch {}
await sleep(200);

console.log(`\n  ──── [process-logs-stream] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
