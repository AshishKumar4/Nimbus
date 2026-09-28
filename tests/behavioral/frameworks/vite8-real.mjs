#!/usr/bin/env bun
// frameworks/vite8-real — a `npm create vite@latest` app (Vite 8, rolldown)
// runs its OWN Vite under Nimbus through Vite's JS API: the dev server serves
// the app through the public port route and serves an edit rebuilt, and
// `build()` writes a production bundle.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create vite@latest app -- --template react-ts --no-interactive
//   cd app && npm install
//   node nimbus-vite.mjs          # createServer({ configFile: false, plugins: [react()] })
//   (edit src/App.tsx)
//   node nimbus-vite.mjs build    # build({ configFile: false, plugins: [react()] })
//
// The launcher inlines the template's vite.config (react()) with
// `configFile: false`: Vite's CLI loads vite.config by import()ing a module it
// writes at runtime, which a Worker cannot compile (frameworks/vite8-cli-real
// holds that boundary). Every rolldown call below — dependency optimization,
// oxc transforms, the native resolver, the production bundle — runs in the
// staged single-threaded wasm32-wasip1 build of rolldown's binding
// (scripts/rolldown/), and CSS minification in lightningcss-wasm (the
// package-ABI swap for lightningcss).
//
// What this probe PROVES:
//   1. The scaffold installs Vite 8 with rolldown, with no refusal of either.
//   2. After an edit to src/App.tsx, `build()` writes dist/index.html
//      referencing hashed JS and CSS; the CSS is real minified CSS (not a raw
//      memory view), the JS is a production bundle (no jsxDEV) carrying the
//      edited text.
//   3. The dev server serves the app's index.html through
//      /s/<sid>/port/5173/, with Vite's client injected, and src/main.tsx
//      transformed (JSX → jsxDEV calls, TS syntax gone); a further edit is
//      served rebuilt.

import {
  Terminal, mintSession, stripAnsi, makeAsserter, deleteSession, fetchPort,
  connectProcessTerminal, sleep, BASE, heredocCommand,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('vite8-real');

const PORT = 5173;
const ROOT = '/home/user/vite8-probe';
const APP = `${ROOT}/app`;
const CREATE_BUDGET_MS = 240_000;
const INSTALL_BUDGET_MS = 400_000;
const DEV_BUDGET_MS = 240_000;
const BUILD_BUDGET_MS = 300_000;
const MARKER = `nimbus-edit-${Date.now()}`;

// The template's vite.config, inlined. The static imports of the app's own
// dependencies put them in the process's closure: Vite's dependency optimizer
// reads their entry files synchronously.
const LAUNCHER = `
import 'react';
import 'react-dom/client';
import 'react/jsx-runtime';
import 'react/jsx-dev-runtime';
import { createServer, build } from 'vite';
import react from '@vitejs/plugin-react';
if (process.argv[2] === 'build') {
  build({ configFile: false, plugins: [react()] }).then(() => console.log('BUILD_OK'));
} else {
  createServer({ configFile: false, plugins: [react()], server: { host: '0.0.0.0', port: ${PORT} } })
    .then((server) => server.listen())
    .then((server) => { server.printUrls(); console.log('DEV_READY'); });
}
`.trim();

async function run(t, cmd, timeoutMs) {
  const r = await t.run(`${cmd}; echo "___EXIT=$?___"`, timeoutMs);
  const m = r.output.match(/___EXIT=(\d+)___/);
  return { exit: m ? Number(m[1]) : null, output: stripAnsi(r.output), elapsed: r.elapsed };
}

function tail(text, lines) {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n');
}

/** Poll one port path until `accept` holds or the budget runs out. */
async function pollPort(sid, path, accept, budgetMs, proc) {
  let last = 'no response';
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (proc?.exit) break;
    try {
      const r = await fetchPort(sid, PORT, path);
      last = `status=${r.status} body=${JSON.stringify(r.body.slice(0, 300))}`;
      if (accept(r)) return { ok: true, r, last };
    } catch (e) {
      last = `fetch error: ${e.message}`;
    }
    await sleep(1_000);
  }
  return { ok: false, r: null, last };
}

const sid = await mintSession();
console.log(`[vite8-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let proc = null;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await run(t, `mkdir -p ${ROOT} && cd ${ROOT}`, 10_000);

  // ── 1. scaffold + install ──────────────────────────────────────────
  const create = await run(t, 'npm create vite@latest app -- --template react-ts --no-interactive 2>&1', CREATE_BUDGET_MS);
  a.check('npm create vite@latest (react-ts) exits 0', create.exit === 0, tail(create.output, 15));
  if (create.exit !== 0) throw new Error('create-vite failed');

  const ins = await run(t, `cd ${APP} && npm install 2>&1`, INSTALL_BUDGET_MS);
  console.log(`[vite8-real] install exit=${ins.exit} elapsed=${ins.elapsed}ms\n${tail(ins.output, 6)}`);
  a.check('npm install exits 0', ins.exit === 0, tail(ins.output, 20));
  if (ins.exit !== 0) throw new Error('npm install failed');
  a.check('npm install refuses neither rolldown nor its wasm binding',
    !/note:\s*(rolldown|@rolldown\/binding-wasm32-wasi) has no Workers-compatible build/.test(ins.output), tail(ins.output, 20));
  const versions = await run(t, `cd ${APP} && grep -h '"version"' node_modules/vite/package.json node_modules/rolldown/package.json`, 30_000);
  const [viteVersion, rolldownVersion] = [...versions.output.matchAll(/"version":\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log(`[vite8-real] vite@${viteVersion} rolldown@${rolldownVersion}`);
  a.check('the scaffold installed Vite 8 and rolldown', /^8\./.test(viteVersion ?? '') && !!rolldownVersion, tail(versions.output, 6));
  // A heredoc's terminator must stand alone on its line: no exit sentinel.
  await t.run(heredocCommand(`${APP}/nimbus-vite.mjs`, LAUNCHER), 15_000);

  // ── 2. an edit, then build ─────────────────────────────────────────
  const edit = await run(t,
    `cd ${APP} && node -e "const fs=require('fs');const p='src/App.tsx';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('Get started','${MARKER}'))"`,
    30_000);
  a.check('src/App.tsx edited', edit.exit === 0, tail(edit.output, 5));
  const buildRun = await run(t, `cd ${APP} && node nimbus-vite.mjs build 2>&1`, BUILD_BUDGET_MS);
  console.log(`[vite8-real] build exit=${buildRun.exit} elapsed=${buildRun.elapsed}ms\n${tail(buildRun.output, 12)}`);
  a.check('build() reports BUILD_OK', /BUILD_OK/.test(buildRun.output), tail(buildRun.output, 30));
  const report = await run(t,
    `cd ${APP} && node -e "const fs=require('fs');const d='dist/assets/';const html=fs.readFileSync('dist/index.html','utf8');`
    + `for(const f of fs.readdirSync(d)){if(!/\\.(css|js)$/.test(f))continue;const t=fs.readFileSync(d+f,'latin1');`
    + `console.log('ASSET '+f+' bytes='+t.length+' html='+html.includes('/assets/'+f)+' nul='+t.includes(String.fromCharCode(0))`
    + `+' jsxDEV='+t.includes('jsxDEV')+' marker='+t.includes('${MARKER}')+' root='+t.startsWith(':root'))}"`,
    30_000);
  const assets = [...report.output.matchAll(/ASSET (\S+) bytes=(\d+) html=(\w+) nul=(\w+) jsxDEV=(\w+) marker=(\w+) root=(\w+)/g)]
    .map(([, name, bytes, html, nul, jsxDEV, marker, root]) => ({ name, bytes: Number(bytes), html, nul, jsxDEV, marker, root }));
  const js = assets.find((x) => x.name.endsWith('.js'));
  const css = assets.find((x) => x.name.endsWith('.css'));
  a.check('dist/index.html references the hashed JS and CSS', !!js && !!css && js.html === 'true' && css.html === 'true', tail(report.output, 10));
  a.check('the CSS is minified stylesheet text (lightningcss-wasm), not a raw memory view',
    !!css && css.nul === 'false' && css.root === 'true' && css.bytes < 20_000, JSON.stringify(css));
  a.check('the JS is a production bundle carrying the edit', !!js && js.jsxDEV === 'false' && js.marker === 'true', JSON.stringify(js));

  // ── 3. dev server ──────────────────────────────────────────────────
  const launch = await t.run(`cd ${APP} && node nimbus-vite.mjs`, DEV_BUDGET_MS);
  const launchOut = stripAnsi(launch.output);
  const pid = Number((launchOut.match(/pid=(\d+)/) || [])[1] || 0);
  a.check('the dev server starts as a long-running process', pid > 0, JSON.stringify(launchOut.slice(-600)));
  if (!(pid > 0)) throw new Error('the dev server did not start');
  proc = await connectProcessTerminal(sid, pid);

  const page = await pollPort(sid, '', (r) => r.status === 200 && /<div id="root">/.test(r.body), DEV_BUDGET_MS, proc);
  console.log(`[vite8-real] process log tail:\n${tail(proc.output, 20)}`);
  a.check(`GET /s/<sid>/port/${PORT}/ serves the app's index.html`, page.ok,
    `${proc.exit ? `exited ${JSON.stringify(proc.exit)}; ` : ''}last ${page.last}\n${tail(proc.output, 40)}`);
  if (!page.ok) throw new Error('dev server never served');
  a.check('the served page carries Vite\'s client', /\/@vite\/client/.test(page.r.body), page.r.body.slice(0, 600));

  // The template's main.tsx is `createRoot(document.getElementById('root')!)
  // .render(<StrictMode><App /></StrictMode>)`: served, the non-null
  // assertion is gone and the JSX is jsxDEV calls.
  const main = await pollPort(sid, 'src/main.tsx', (r) => r.status === 200, 120_000, proc);
  const mainJs = main.r?.body ?? '';
  a.check('src/main.tsx is served as JavaScript (TSX transformed by rolldown\'s oxc)',
    main.ok && /jsxDEV\(/.test(mainJs) && !/<StrictMode>/.test(mainJs) && !/getElementById\(["']root["']\)!/.test(mainJs),
    `last ${main.last}`);
  // An edit while the server runs is served rebuilt.
  const MARKER2 = `${MARKER}-live`;
  await run(t,
    `cd ${APP} && node -e "const fs=require('fs');const p='src/App.tsx';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('${MARKER}','${MARKER2}'))"`,
    30_000);
  const rebuilt = await pollPort(sid, 'src/App.tsx', (r) => r.status === 200 && r.body.includes(MARKER2), 120_000, proc);
  a.check('an edit is served rebuilt with the new text', rebuilt.ok, `last ${rebuilt.last}`);
} finally {
  if (proc) { try { proc.ws.close(); } catch { /* probe teardown */ } }
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
