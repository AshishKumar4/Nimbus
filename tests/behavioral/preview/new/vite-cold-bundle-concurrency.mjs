#!/usr/bin/env bun
// behavioral/preview/new/vite-cold-bundle-concurrency —
// the on-demand /@modules/ cold-bundle path must serve MANY distinct
// packages requested CONCURRENTLY (as a fresh app's first load does)
// without erroring and without crashing the supervisor (CF 1101).
//
// O1 replaced the single-slot serialization with a byte-budget gate:
// small slices' facet RPC round-trips now overlap, so a flurry of cold
// /@modules/ requests completes faster than strict serialization, while
// peak supervisor slice memory stays bounded at one slice cap (the gate
// invariant is unit-tested in tests/unit/on-demand-bundle-gate.mjs; this
// probe proves the deployed path serves them all correctly under load).
//
// Public surface: GET /s/<sid>/preview/@modules/<pkg>. Strictly
// black-box. The packages are small, pure-ESM/CJS libs that bundle
// cleanly through the on-demand path.
//
// failing if regressed: a cold-bundle that 500s, returns non-JS, or a
// supervisor reset (502/1101) under concurrent first-load.

import WebSocket from 'ws';
import { mintSession, wsHeaders, requestHeaders, deleteSession, sleep, stripAnsi }
  from '../../_driver.mjs';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const WS_BASE = BASE.replace(/^http/, 'ws');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
};

// Small, well-behaved packages that bundle through the on-demand path.
const PKGS = ['clsx', 'nanoid', 'mitt', 'just-debounce-it', 'dequal'];

const sid = await mintSession();
console.log(`behavioral/preview/new/vite-cold-bundle-concurrency — BASE=${BASE} sid=${sid}`);

const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`, wsHeaders());
let buf = '';
let tConn = false, tClosed = false;
ws.on('open', () => { tConn = true; });
ws.on('close', () => { tClosed = true; });
ws.on('error', () => {});
ws.on('message', (data) => {
  try { const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'output' && typeof m.data === 'string') buf += m.data; } catch {}
});

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate(stripAnsi(buf))) return Date.now() - t0;
    if (tClosed) throw new Error(`terminal closed waiting for ${label}`);
    await sleep(50);
  }
  throw new Error(`waitFor(${label}) timeout ${timeoutMs}ms; tail=${JSON.stringify(stripAnsi(buf).slice(-300))}`);
}
const cmd = (line) => ws.send(JSON.stringify({ type: 'input', data: line + '\r' }));
async function run(line, timeoutMs = 120_000) {
  const before = buf.length;
  cmd(line);
  await waitFor((b) => buf.length > before && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    timeoutMs, `prompt after ${line}`);
}
const writeFile = (path, content) => {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`;
};

try {
  {
    const t0 = Date.now();
    while (!tConn && Date.now() - t0 < 15_000) await sleep(50);
    if (!tConn) throw new Error('terminal connect timeout');
  }
  await waitFor((b) => /[$#>]\s*$/.test(b.trimEnd().slice(-3)), 10_000, 'initial prompt');

  const dir = '/home/user/cold-concurrency';
  await run('cd /home/user', 5000);
  await run(`mkdir -p ${dir}/src`, 5000);
  await run(writeFile(`${dir}/package.json`,
    JSON.stringify({
      name: 'cold-concurrency', type: 'module',
      scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
      dependencies: Object.fromEntries(PKGS.map((p) => [p, '*'])),
    })), 10_000);
  // An entry that imports every package so they're resolvable under node_modules.
  await run(writeFile(`${dir}/index.html`,
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>'), 10_000);
  await run(writeFile(`${dir}/src/main.js`,
    PKGS.map((p, i) => `import * as m${i} from '${p}';`).join('\n') + '\nconsole.log(' + PKGS.map((_, i) => `m${i}`).join(',') + ');\n'), 10_000);

  await run(`cd ${dir}`, 5000);
  await run('npm install', 180_000);

  buf = '';
  cmd('npm run dev');
  await waitFor((b) => /Nimbus Vite Dev Server/i.test(b), 30_000, 'vite banner');

  // Fire all /@modules/ requests CONCURRENTLY — this is the fresh-load
  // flurry the gate must handle. Measure wall time for the whole batch.
  const t0 = Date.now();
  const results = await Promise.all(PKGS.map(async (p) => {
    const url = `${BASE}/s/${sid}/preview/@modules/${p}`;
    const r = await fetch(url, { redirect: 'manual', headers: requestHeaders() });
    const body = await r.text().catch(() => '');
    return { p, status: r.status, body };
  }));
  const elapsed = Date.now() - t0;
  console.log(`  concurrent /@modules/ batch (${PKGS.length} pkgs) took ${elapsed}ms`);

  for (const { p, status, body } of results) {
    check(`@modules/${p} served 200`, status === 200, `status=${status}`);
    // A real bundle is non-trivial JS — not an error stub / empty body.
    check(`@modules/${p} is non-empty JS module`,
      status === 200 && body.length > 0 &&
      (body.includes('export') || body.includes('import') || body.length > 40),
      `len=${body.length}`);
    check(`@modules/${p} is not an error stub`,
      !/throw __err|Bundle failed|cannot bundle|Transform Error/i.test(body),
      `tail=${JSON.stringify(body.slice(-120))}`);
  }

  // Bounded wall-time: even fully serialized these 5 small bundles
  // should finish well under a minute; a supervisor reset / hang would
  // blow this. (Not a tight perf assertion — overlap is proven by the
  // gate unit test; this guards against a deployed regression hanging.)
  check('concurrent cold-bundle batch completes under 60s', elapsed < 60_000, `elapsed=${elapsed}ms`);
} catch (e) {
  console.error('FATAL:', e?.message || e);
  fail++;
} finally {
  try { ws.close(); } catch {}
  await deleteSession(sid).catch(() => {});
}

console.log(`\n  ──── [vite-cold-bundle-concurrency] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
