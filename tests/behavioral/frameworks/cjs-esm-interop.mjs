#!/usr/bin/env bun
// frameworks/cjs-esm-interop — RUNTIME-BEHAVIORAL CJS↔ESM interop probe.
//
// Category: R (runtime-behavioral)
//
// User scenario this probe covers
// ────────────────────────────────
// A user installs a CJS-shipping npm package whose CJS source calls
// `require('@babel/runtime/helpers/X')`. On a buggy build, Nimbus's
// resolver picks the ESM helper for the CJS require; the ESM helper
// only `export { fn as default }`s; esbuild's __toCommonJS wraps it
// as `{ default: fn }`; the downstream CJS callsite invokes the
// namespace as a function and runtime-crashes with:
//
//   Uncaught TypeError: <helper>2 is not a function
//
// Affected packages: thousands. Anything compiled with @babel/preset-
// env's transform-runtime that ships a CJS bundle. The exemplar (and
// the user's reported bug class) is `react-textarea-autosize`.
//
// What this probe drives (the LITERAL user flow)
// ──────────────────────────────────────────────
// 1. Mint a Nimbus session, scaffold a minimal React SPA that
//    renders <TextareaAutosize/> at top-level (NO routing — the
//    component mounts immediately on app boot, so the bug fires
//    during initial render).
// 2. `npm install` + `npm run dev`. Wait for vite-ready marker.
// 3. Open real Chrome at `BASE/s/<sid>/preview/`.
// 4. Wait for the textarea to be in the DOM with its defaultValue
//    propagated. The component mounting under TextareaAutosize is
//    the bug-trigger event.
// 5. Assert ZERO `pageerror` / runtime-error console messages.
//
// REPLACES the prior structural-only probe that asserted on regex
// against /preview/@modules/react-textarea-autosize. That probe was
// confirmed FALSE GREEN on prod eca3dca6 (2026-05-10) — workspace
// agent reproduced the bug via real Puppeteer while it ran 5/5 GREEN.
// See /workspace/.seal-internal/2026-05-10-probe-hardening/audit.md.

import {
  launchBrowser, scaffoldAndStartVite, openPage,
  mintSession, sleep, BASE,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[cjs-esm-interop] sid=${sid} BASE=${BASE}`);

const indexHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
  '<title>CJS-ESM Interop Probe</title></head>' +
  '<body><div id="root"></div>' +
  '<script type="module" src="/src/main.tsx"></script>' +
  '</body></html>';

const mainTsx = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import TextareaAutosize from 'react-textarea-autosize';

function App() {
  return (
    <div>
      <h1>CJS-ESM Interop</h1>
      <TextareaAutosize
        id="editor"
        minRows={2}
        defaultValue="TEXTAREA-OK"
        placeholder="type here"
      />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

const pkg = JSON.stringify({
  name: 'cjs-esm-interop-probe',
  version: '0.0.0',
  type: 'module',
  scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    'react-textarea-autosize': '^8.5.3',
  },
}, null, 2);

console.log('[cjs-esm] scaffold + install + dev...');
const { terminal, viteReady, installTail } = await scaffoldAndStartVite(sid, {
  workdir: 'cjs-esm-probe',
  files: {
    'package.json': pkg,
    'index.html': indexHtml,
    'src/main.tsx': mainTsx,
  },
});
console.log('[cjs-esm] viteReady=', viteReady);
console.log('[cjs-esm] install tail:', installTail.slice(-300));

console.log('[cjs-esm] launching headless Chrome...');
const browser = await launchBrowser();
let appRendered = false;
let editorPresent = null;
let bodyText = '';
let runtimeErrors = [];
let consoleSummary = [];

try {
  const ctx = await openPage(browser, sid, { waitUntil: 'load' });

  console.log('[cjs-esm] navigate to /preview/...');
  await ctx.navigatePreview('');

  // Wait for the App to render (h1 + TextareaAutosize).
  try {
    bodyText = await ctx.waitForBodyText(
      (t) => /CJS-ESM Interop/.test(t),
      45_000,
    );
    appRendered = true;
  } catch (e) {
    bodyText = (await ctx.getBodyText().catch(() => '')) || `(error: ${e.message})`;
  }

  // CRITICAL: confirm TextareaAutosize actually mounted. A pageerror
  // during mount would prevent the textarea from ending up in the DOM.
  if (appRendered) {
    editorPresent = await ctx.page.evaluate(() => {
      const el = document.getElementById('editor');
      return {
        exists: !!el,
        tagName: el?.tagName || null,
        value: el?.value || null,
      };
    });
  }

  runtimeErrors = ctx.collectErrors();
  consoleSummary = ctx.consoleMessages.slice(0, 12).map((m) => ({
    type: m.type,
    text: (m.text || '').slice(0, 280),
  }));

  await ctx.close();
} finally {
  await browser.close();
  await terminal.close();
}

const findings = {
  probe: 'cjs-esm-interop',
  category: 'R',
  sid, base: BASE,
  viteReady,
  appRendered,
  bodyText: bodyText.slice(0, 600),
  editorPresent,
  runtimeErrorCount: runtimeErrors.length,
  runtimeErrors: runtimeErrors.slice(0, 5).map((e) => ({
    kind: e.kind,
    message: (e.message || e.text || '').slice(0, 600),
    location: e.location || null,
  })),
  consoleHead: consoleSummary,
};
console.log(JSON.stringify(findings, null, 2));

const errorsText = runtimeErrors.map((e) => e.message || e.text || '').join('\n');
const errorMarker = bodyTextHasErrorMarker(errorsText, RUNTIME_ERROR_MARKERS);
const bodyHasErrorMarker = bodyTextHasErrorMarker(bodyText, RUNTIME_ERROR_MARKERS);

const checks = [
  ['vite dev server ready', viteReady],
  ['app rendered (CJS-ESM Interop heading visible)', appRendered],
  ['#editor textarea is in the DOM',
    !!editorPresent?.exists && editorPresent.tagName === 'TEXTAREA',
    editorPresent ? `editorPresent=${JSON.stringify(editorPresent)}` : '(not checked — app not rendered)'],
  ['#editor.value === "TEXTAREA-OK" (TextareaAutosize mount succeeded)',
    editorPresent?.value === 'TEXTAREA-OK',
    editorPresent ? `value=${JSON.stringify(editorPresent.value)}` : ''],
  ['NO pageerror or console.error matched runtime-error markers',
    errorMarker === null,
    errorMarker
      ? `marker="${errorMarker}" first error: ${(runtimeErrors[0]?.message || runtimeErrors[0]?.text || '').slice(0, 300)}`
      : ''],
  ['NO error keyword in body.innerText',
    bodyHasErrorMarker === null,
    bodyHasErrorMarker ? `marker="${bodyHasErrorMarker}" body: ${bodyText.slice(0, 300)}` : ''],
];

let pass = 0;
for (const c of checks) {
  const [name, ok, detail] = c;
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? '' : (detail ? ' — ' + detail : '')}`);
  if (ok) pass++;
}

const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`\n[cjs-esm-interop] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
