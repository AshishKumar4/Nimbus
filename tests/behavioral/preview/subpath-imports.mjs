#!/usr/bin/env bun
// behavioral/preview/subpath-imports — `package.json#imports` (subpath
// imports, `#X`) MUST be resolved by the dev-server's bare-import
// rewriter so the browser never sees a literal `#X` specifier.
//
// User repro (Markflow on prod 0a488bab):
//   npm i markflow → vfile/unified/remark/mdx all use `#minpath`,
//   `#minurl`, etc. internally. Preview crashes with
//   `Uncaught TypeError: Failed to resolve module specifier "#minpath"`.
//
// What we test: serve a tiny package with a `package.json#imports`
// entry through /preview/@modules/<pkg>. The rewritten module body
// must NOT contain a literal `"#X"` import — it must be rewritten to
// either a /@modules/ URL OR a relative path that the browser can
// resolve.
//
// RED before fix: rewriteAllImports' SPECIFIER_WITH_QUERY regex
// requires the first char to be [A-Za-z0-9_@] — `#` is rejected — so
// `import x from "#minpath"` survives untouched in the served bundle.
//
// Black-box. ONLY public surfaces: POST /new, WS terminal, GET
// /preview/. Per-bug evidence saved by the parent task.

import WebSocket from 'ws';

const BASE = process.env.BASE;
if (!BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const WS_BASE = BASE.replace(/^http/, 'ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, '');

// ── minimal asserter (kept in-file so this probe is hermetic) ──
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failures.push(`${name}: ${detail}`); fail++; }
}

// ── mint a session ──
const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
const loc = r.headers.get('location');
const sid = loc.match(/\/s\/([^/]+)/)[1];
console.log(`behavioral/preview/subpath-imports — BASE=${BASE} sid=${sid}`);

// ── connect a terminal ──
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
let buf = '';
let connected = false, closed = false;
ws.on('open', () => { connected = true; });
ws.on('close', () => { closed = true; });
ws.on('error', () => {});
ws.on('message', (data) => {
  try {
    const m = JSON.parse(data.toString('utf8'));
    if (m.type === 'output' && typeof m.data === 'string') buf += m.data;
  } catch {}
});
{
  const t0 = Date.now();
  while (!connected && Date.now() - t0 < 15_000) await sleep(50);
  if (!connected) { console.error('WS connect timeout'); process.exit(2); }
}

const cmd = (line) => ws.send(JSON.stringify({ type: 'input', data: line + '\r' }));
async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate(stripAnsi(buf))) return Date.now() - t0;
    if (closed) throw new Error(`terminal closed waiting for ${label}`);
    await sleep(50);
  }
  throw new Error(`waitFor(${label}) timeout ${timeoutMs}ms; tail=${JSON.stringify(stripAnsi(buf).slice(-300))}`);
}
async function run(line, timeoutMs = 60_000) {
  const before = buf.length;
  cmd(line);
  // Wait for a NEW prompt past the cmd echo.
  await waitFor((b) => buf.length > before && /[$#>]\s*$/.test(b.trimEnd().slice(-3)),
    timeoutMs, `prompt after ${line}`);
}

await sleep(1500);
await waitFor((b) => /[$#>]\s*$/.test(b.trimEnd().slice(-3)), 10_000, 'initial prompt');

// ── scaffold project ──
const writeFileViaShell = (path, content) => {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`;
};
const mkdirP = (path) => `mkdir -p ${path}`;

await run('cd /home/user', 5000);
await run(mkdirP('/home/user/imp-test/src'), 5000);
await run(mkdirP('/home/user/imp-test/node_modules/vfile-mini/lib'), 5000);

// vfile-mini package: declares #minpath and uses it in lib/index.js.
const vfileMiniPkg = JSON.stringify({
  name: 'vfile-mini',
  version: '1.0.0',
  type: 'module',
  main: 'lib/index.js',
  imports: {
    // Browser condition wins for ESM dev-server resolution.
    '#minpath': {
      browser: './lib/minpath.browser.js',
      default: './lib/minpath.node.js',
    },
  },
}, null, 2);
const vfileMiniIndex = `
import { sep } from '#minpath';
export const VFILE_SEP = sep;
export default { sep };
`;
const vfileMiniBrowser = `export const sep = '/';\nexport default { sep };\n`;
const vfileMiniNode = `import { sep } from 'path';\nexport { sep };\nexport default { sep };\n`;

await run(writeFileViaShell('/home/user/imp-test/node_modules/vfile-mini/package.json', vfileMiniPkg), 8000);
await run(writeFileViaShell('/home/user/imp-test/node_modules/vfile-mini/lib/index.js', vfileMiniIndex), 8000);
await run(writeFileViaShell('/home/user/imp-test/node_modules/vfile-mini/lib/minpath.browser.js', vfileMiniBrowser), 8000);
await run(writeFileViaShell('/home/user/imp-test/node_modules/vfile-mini/lib/minpath.node.js', vfileMiniNode), 8000);

// User project entry that imports the package.
const indexHtml = `<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>`;
const mainJs = `import vf from 'vfile-mini';\ndocument.body.textContent = 'sep=' + vf.sep;\n`;
const pkgJson = JSON.stringify({
  name: 'imp-test',
  version: '0.0.0',
  type: 'module',
  scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
}, null, 2);

await run(writeFileViaShell('/home/user/imp-test/index.html', indexHtml), 8000);
await run(writeFileViaShell('/home/user/imp-test/src/main.js', mainJs), 8000);
await run(writeFileViaShell('/home/user/imp-test/package.json', pkgJson), 8000);

// ── start dev server ──
await run('cd /home/user/imp-test', 5000);
buf = '';
cmd('npm run dev');
// Wait for the Nimbus banner that confirms vite is up.
await waitFor((b) => /Nimbus Vite Dev Server|Local:|Preview:/i.test(b),
  30_000, 'vite banner');

// ── assert: GET /preview/@modules/vfile-mini does NOT contain `"#minpath"` ──
{
  const url = `${BASE}/s/${sid}/preview/@modules/vfile-mini`;
  const resp = await fetch(url, { redirect: 'manual' });
  const code = await resp.text().catch(() => '');
  check('vfile-mini bundle 200',
    resp.status === 200, `status=${resp.status} url=${url}`);
  // Stronger check: no literal `"#minpath"` or `'#minpath'` import in the served body.
  const hasLiteralHash = /from\s+["']#[a-zA-Z]/.test(code) || /import\s*\(\s*["']#/.test(code) || /import\s+["']#[a-zA-Z]/.test(code);
  check('served bundle has NO literal "#X" subpath-import specifier',
    !hasLiteralHash,
    hasLiteralHash
      ? `bundle still contains literal #X: ${(code.match(/["']#[a-zA-Z][a-zA-Z0-9_/-]*["']/g) || []).slice(0,3).join(', ')}`
      : '');
  // Sanity: bundle should reference the resolved file or its content.
  const referencesResolved = code.includes("sep = '/'") || code.includes("sep=\"/\"") || code.includes('VFILE_SEP') || code.includes('minpath.browser');
  check('served bundle references resolved minpath target',
    referencesResolved,
    referencesResolved ? '' : `code head=${code.slice(0, 300)}`);
}

// ── assert: GET /preview/@modules/vfile-mini/lib/index.js (the importer) ──
//    The bundle path through serveModule may bundle index.js into a
//    single module, so this might be the same response. We accept either
//    the inlined-resolved form or a 200 that doesn't expose `#X`.
{
  const url = `${BASE}/s/${sid}/preview/@modules/vfile-mini`;
  const resp = await fetch(url, { redirect: 'manual' });
  const code = await resp.text();
  // Must not contain a bare `#minpath` reachable to the browser as a literal.
  const lit = (code.match(/["']#minpath["']/g) || []).length;
  check('zero literal "#minpath" tokens in served bundle', lit === 0,
    `count=${lit}`);
}

// ── teardown ──
try { ws.close(); } catch {}
await sleep(200);

console.log(`\n  ──── [subpath-imports] ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
