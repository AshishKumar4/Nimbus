#!/usr/bin/env bun
// frameworks/cjs-esm-interop — CJS↔ESM interop probe for @babel/runtime/helpers/*.
//
// User-reported bug on prod (Markflow /write route):
//   Uncaught TypeError: _objectWithoutPropertiesLoose2 is not a function
//   @ /s/<sid>/preview/@modules/react-textarea-autosize:407
//
// Root cause: the pre-bundle resolver picks the ESM helper file
// (./helpers/esm/objectWithoutPropertiesLoose.js) for CJS `require()`
// calls. The ESM file only `export { fn as default }`s. esbuild's
// __toCommonJS wrap surfaces `{ default: fn }` to the CJS caller,
// whose downstream code calls `_objectWithoutPropertiesLoose2(...)`
// — the namespace as a function — and runtime-crashes.
//
// Fix shape (this commit): pass `conditions` per-resolution. esbuild's
// `args.kind` is 'require-call' for `require()`, 'import-statement' for
// ESM imports. CJS callers get ['require','node','browser','default'],
// ESM callers keep ['import','module','browser','default']. The CJS
// helper file `@babel/runtime/helpers/X.js` uses the dual-export trick
// `module.exports = fn; module.exports.default = fn` so `__toCommonJS`
// preserves callability.
//
// Probe shape:
//   1. Install react-textarea-autosize (uses @babel/runtime/helpers).
//   2. Start vite dev.
//   3. Fetch /preview/@modules/react-textarea-autosize.
//   4. Assert the bundled output's call to `_objectWithoutPropertiesLoose`
//      references the FUNCTION, not a `{ default: fn }` namespace.
//   5. Also fetch /preview/@modules/@babel/runtime/helpers/objectWithoutPropertiesLoose
//      and assert it exports the function in a CJS-shaped way (or that
//      it's served via the dual-export CJS file).

import { mintSession, Terminal, sleep, stripAnsi, fetchPreview, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[cjs-esm-interop] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const writeFile = (path, content) => {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return `node -e "require('fs').writeFileSync('${path}', Buffer.from('${b64}','base64').toString('utf8'))"`;
};

await t.run('mkdir -p /home/user/cjs-probe/src', 10_000);
await t.run('cd /home/user/cjs-probe', 10_000);

const pkg = JSON.stringify({
  name: 'cjs-probe', version: '0.0.0', type: 'module',
  scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    'react-textarea-autosize': '^8.5.3',
  },
}, null, 2);

const indexHtml = `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;

const mainTsx = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import TextareaAutosize from 'react-textarea-autosize';
function App() { return React.createElement(TextareaAutosize, { minRows: 2 }); }
createRoot(document.getElementById('root')).render(React.createElement(App));
`;

await t.run(writeFile('/home/user/cjs-probe/package.json', pkg), 15_000);
await t.run(writeFile('/home/user/cjs-probe/index.html', indexHtml), 15_000);
await t.run(writeFile('/home/user/cjs-probe/src/main.tsx', mainTsx), 15_000);

console.log('[cjs-esm-interop] npm install...');
const installR = await t.run('npm install', 600_000);
const installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-6).join('\n');

console.log('[cjs-esm-interop] npm run dev (long-running)...');
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
  console.log('[cjs-esm-interop] vite not ready:', e?.message);
}
await sleep(3_000);

// Fetch the bundled react-textarea-autosize module from /preview/@modules/
const r = await fetchPreview(sid, { path: '@modules/react-textarea-autosize' });
const txt = r.html;

// Find the _objectWithoutPropertiesLoose binding in the served bundle.
// The bug shape (RED): `var _objectWithoutPropertiesLoose2 = (init_X(), __toCommonJS(X_exports));`
// The fix shape (GREEN): no `__toCommonJS` wrap because the require resolved
// to the CJS file that returns the function directly. Either:
//   (a) the bundle inlines the CJS helper and uses the function directly, OR
//   (b) the bundle still references the helper as a CJS module but the
//       __toCommonJS receives `{ default: fn, __esModule: true }` where
//       module.exports IS the function and the namespace properties carry
//       __esModule + default that point back to fn — esbuild then exposes
//       fn as the default at the call site.
const hasToCommonJSPattern =
  /var\s+_?objectWithoutPropertiesLoose\w*\s*=\s*\([^)]*init_[^)]*\([^)]*\)\s*,\s*__toCommonJS\([^)]*objectWithoutPropertiesLoose[^)]*\)/.test(txt);

// The downstream callsite. If GREEN, this line still says
// `_objectWithoutPropertiesLoose2(_ref, _excluded)` but the binding
// it references is the function, not the namespace. We assert presence
// of a call AND absence of the broken namespace pattern.
const hasCallSite = /_?objectWithoutPropertiesLoose\w*\(_ref/.test(txt);

// Stronger signal: when GREEN, the helper file resolved should be the
// CJS one — the bundled comment trail typically shows the file path.
const referencesCjsHelper =
  /helpers\/objectWithoutPropertiesLoose\.js/.test(txt);
const referencesEsmHelper =
  /helpers\/esm\/objectWithoutPropertiesLoose\.js/.test(txt);

await t.close();

const findings = {
  probe: 'cjs-esm-interop',
  sid, base: BASE,
  installTail,
  viteReady,
  preview: {
    status: r.status,
    htmlLen: txt.length,
    hasToCommonJSPattern,
    hasCallSite,
    referencesCjsHelper,
    referencesEsmHelper,
    snippet: (txt.match(/var\s+_?objectWithoutPropertiesLoose\w*[^;]{0,400}/) || [''])[0],
  },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['vite ready', viteReady],
  ['module served 200', r.status === 200],
  ['has objectWithoutPropertiesLoose callsite', hasCallSite],
  ['NO broken __toCommonJS(namespace) wrap around objectWithoutPropertiesLoose',
   !hasToCommonJSPattern],
  ['references CJS helper file (the fix)', referencesCjsHelper],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`\n[cjs-esm-interop] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
