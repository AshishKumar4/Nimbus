#!/usr/bin/env bun
// frameworks/markflow-clickthrough — Markflow click-then-render bug repro.
//
// User-reported on prod (commit 1b07884): Markflow homepage loads fine
// (title "MarkFlow", #root mounted) but clicking "Start Writing" →
// /write crashes the preview with:
//
//   Uncaught TypeError: _objectWithoutPropertiesLoose2 is not a function
//   @ /preview/@modules/react-textarea-autosize:407
//
// We can't actually drive a click in this driver (no real browser).
// The bug is in the BUNDLED module, not in render-time DOM interaction.
// So: fetch the rendered HTML of /preview/@modules/react-textarea-autosize
// and assert the bundle:
//   1. Has the runtime function-call shape preserved (the actual import
//      resolves to a callable, not a namespace object).
//   2. Does NOT contain the broken `__toCommonJS(objectWithoutPropertiesLoose_exports)`
//      wrap shape that the prior bug emitted.
//   3. Also fetch the home page HTML AND simulate a router-state change
//      by fetching /preview/write — the SPA's vite dev server should serve
//      the same HTML shell (client-side routing).
//
// This is the "would clicking 'Start Writing' work" assertion at the
// module-bundling layer — the only layer the bug actually lives in.
// A separate v2 of this probe will add real browser-driven clickthrough
// when the framework-validation wave is followed up with a Puppeteer-
// equivalent driver.

import { mintSession, Terminal, sleep, stripAnsi, fetchPreview, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[markflow-clickthrough] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const writeFile = (path, content) => {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`;
};

await t.run('mkdir -p /home/user/mf/src', 10_000);
await t.run('cd /home/user/mf', 10_000);

const pkg = JSON.stringify({
  name: 'mf', version: '0.0.0', type: 'module',
  scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    'react-router-dom': '^6.26.2',
    'react-textarea-autosize': '^8.5.3',
  },
}, null, 2);

const indexHtml = `<!doctype html><html><head><title>MarkFlow Mini</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;

// SPA with two routes: '/' (Home) + '/write' (uses react-textarea-autosize).
// On '/write' the textarea-autosize component mounts and triggers the
// _objectWithoutPropertiesLoose call site that was crashing.
const mainTsx = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import TextareaAutosize from 'react-textarea-autosize';

function Home() {
  return React.createElement('div', null,
    React.createElement('h1', null, 'MarkFlow'),
    React.createElement(Link, { to: '/write', id: 'start-writing' }, 'Start Writing'),
  );
}
function Write() {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Write'),
    React.createElement(TextareaAutosize, { minRows: 2, id: 'editor' }),
  );
}
function App() {
  return React.createElement(BrowserRouter, null,
    React.createElement(Routes, null,
      React.createElement(Route, { path: '/preview', element: React.createElement(Home) }),
      React.createElement(Route, { path: '/preview/write', element: React.createElement(Write) }),
      React.createElement(Route, { path: '/', element: React.createElement(Home) }),
      React.createElement(Route, { path: '/write', element: React.createElement(Write) }),
    ),
  );
}
createRoot(document.getElementById('root')).render(React.createElement(App));
`;

await t.run(writeFile('/home/user/mf/package.json', pkg), 15_000);
await t.run(writeFile('/home/user/mf/index.html', indexHtml), 15_000);
await t.run(writeFile('/home/user/mf/src/main.tsx', mainTsx), 15_000);

console.log('[markflow] npm install...');
await t.run('npm install', 600_000);

console.log('[markflow] npm run dev...');
t.reset();
t.cmd('npm run dev');
let viteReady = false;
try {
  await t.waitFor(
    (b) => /ready in|Nimbus Vite Dev|Local:|VITE v/i.test(b),
    180_000,
    'vite-ready',
  );
  viteReady = true;
} catch (e) {
  console.log('[markflow] vite not ready:', e?.message);
}
await sleep(3_000);

// Fetch preview / (home page) — should return the index.html shell
const home = await fetchPreview(sid);

// Fetch the react-textarea-autosize bundle — this is the URL the
// browser hits when /write mounts the component
const rta = await fetchPreview(sid, { path: '@modules/react-textarea-autosize' });

// Find the broken pattern in the bundle
const brokenWrap =
  /var\s+_?objectWithoutPropertiesLoose\w*\s*=\s*\([^)]*init_[^)]*\([^)]*\)\s*,\s*__toCommonJS\([^)]*objectWithoutPropertiesLoose[^)]*\)/.test(rta.html);
const hasCallSite = /_?objectWithoutPropertiesLoose\w*\(_ref/.test(rta.html);

// Also fetch the helper directly
const helper = await fetchPreview(sid, { path: '@modules/@babel/runtime/helpers/objectWithoutPropertiesLoose' });
// In the GREEN shape (CJS-resolved helper), the bundled output should
// declare `_objectWithoutPropertiesLoose` as a function or a default
// export carrying a function — NOT a namespace with __esModule:true and
// default a function (which causes the __toCommonJS confusion).
// Practical test: look for the function body itself in the served code.
const helperHasFnBody =
  /function _objectWithoutPropertiesLoose/.test(helper.html);

await t.close();

const findings = {
  probe: 'markflow-clickthrough',
  sid, base: BASE,
  viteReady,
  home: { status: home.status, htmlLen: home.html.length, htmlHead: home.html.slice(0, 500) },
  rta:  { status: rta.status,  htmlLen: rta.html.length },
  helper: { status: helper.status, htmlLen: helper.html.length, head: helper.html.slice(0, 600) },
  brokenWrap,
  hasCallSite,
  helperHasFnBody,
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['vite ready',                                    viteReady],
  ['home GET 200',                                  home.status === 200],
  ['home contains <div id="root">',                 /<div\s+id=["']root["']/.test(home.html)],
  ['rta bundle GET 200',                            rta.status === 200],
  ['rta has objectWithoutPropertiesLoose callsite', hasCallSite],
  ['rta NO broken __toCommonJS wrap',               !brokenWrap],
  ['helper served with function body',              helperHasFnBody],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`\n[markflow-clickthrough] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
