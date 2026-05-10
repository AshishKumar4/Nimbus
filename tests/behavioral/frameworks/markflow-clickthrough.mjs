#!/usr/bin/env bun
// frameworks/markflow-clickthrough — RUNTIME-BEHAVIORAL Markflow click probe.
//
// Category: R (runtime-behavioral)
//
// User scenario this probe covers
// ────────────────────────────────
// Markflow user lands on the homepage (renders fine, "MarkFlow" h1
// visible). User clicks "Start Writing" → SPA route changes to /write
// → `<Write>` component mounts → `<TextareaAutosize>` renders.
// On a buggy build the click triggers in the iframe:
//   Uncaught TypeError: _objectWithoutPropertiesLoose2 is not a function
//   @ /s/<sid>/preview/@modules/react-textarea-autosize:407
// Verbatim user-reported on prod commit 1b07884 / 8be64fd.
//
// What this probe drives (the LITERAL user flow)
// ──────────────────────────────────────────────
// 1. Mint a Nimbus session, scaffold a minimal Markflow-shaped SPA
//    (BrowserRouter + react-router-dom + react-textarea-autosize).
// 2. `npm install` + `npm run dev`. Wait for vite-ready marker.
// 3. Open a real Chrome (puppeteer-core, system Chrome 148) and
//    navigate to `BASE/s/<sid>/preview/`.
// 4. Wait for the Home component to render (body.innerText contains
//    "MarkFlow" and "Start Writing").
// 5. Click `#start-writing`. The Link routes to `/write`.
// 6. Wait for the Write component to render (body.innerText contains
//    "Write Page" and the textarea is in the DOM).
// 7. Assert that the page captured ZERO `pageerror` events AND no
//    console.error matching the runtime-error keyword family
//    (TypeError, "is not a function", _objectWithoutPropertiesLoose2,
//    etc.).
//
// Pass/fail signal: real Chrome's runtime behaviour. The probe goes
// RED iff a real user would see a broken thing.
//
// REPLACES the prior structural-only probe that asserted on regex
// against /preview/@modules/react-textarea-autosize. That probe was
// confirmed FALSE GREEN on prod eca3dca6 (2026-05-10) — workspace
// agent reproduced the bug via real Puppeteer while this probe ran
// 7/7 GREEN. See /workspace/.seal-internal/2026-05-10-probe-hardening/
// audit.md.

import {
  launchBrowser, scaffoldAndStartVite, openPage,
  mintSession, sleep, BASE,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[markflow-clickthrough] sid=${sid} BASE=${BASE}`);

// ── Project files ────────────────────────────────────────────────────
// JSX form for both `<BrowserRouter>` and routes — Nimbus's
// router-basename auto-injector recognises JSX (and factory call)
// patterns; the prior probe used `React.createElement(BrowserRouter,
// null, ...)` which is neither, so basename was never injected and
// `No routes matched location "/s/<sid>/preview/"` fired before the
// click could even reach the textarea-autosize component. JSX is
// what real apps use.

const indexHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
  '<title>Markflow Clickthrough Probe</title></head>' +
  '<body><div id="root"></div>' +
  '<script type="module" src="/src/main.tsx"></script>' +
  '</body></html>';

const mainTsx = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import TextareaAutosize from 'react-textarea-autosize';

function Home() {
  return (
    <div>
      <h1>MarkFlow</h1>
      <Link id="start-writing" to="/write">Start Writing</Link>
    </div>
  );
}

function Write() {
  return (
    <div>
      <h1>Write Page</h1>
      <TextareaAutosize id="editor" minRows={2} defaultValue="TEXTAREA-OK" />
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/write" element={<Write />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

const pkg = JSON.stringify({
  name: 'markflow-clickthrough-probe',
  version: '0.0.0',
  type: 'module',
  scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    'react-router-dom': '^6.26.2',
    'react-textarea-autosize': '^8.5.3',
  },
}, null, 2);

// ── Phase 1: scaffold + npm install + vite dev ───────────────────────
console.log('[markflow] scaffold + install + dev...');
const { terminal, viteReady, installTail } = await scaffoldAndStartVite(sid, {
  workdir: 'mf-probe',
  files: {
    'package.json': pkg,
    'index.html': indexHtml,
    'src/main.tsx': mainTsx,
  },
});
console.log('[markflow] viteReady=', viteReady);
console.log('[markflow] install tail:', installTail.slice(-300));

// ── Phase 2: real Chrome + iframe drive ──────────────────────────────
console.log('[markflow] launching headless Chrome...');
const browser = await launchBrowser();
let findings;
let homeText = '';
let writeText = '';
let runtimeErrors = [];
let consoleSummary = [];
let homeRendered = false;
let clickSucceeded = false;
let writeRendered = false;
let urlAfterClick = '';

try {
  const ctx = await openPage(browser, sid, { waitUntil: 'load' });

  console.log('[markflow] navigate to /preview/...');
  const homeNav = await ctx.navigatePreview('');
  console.log('[markflow] home nav status:', homeNav.status);

  // Phase 2a: wait until the Home component has rendered. The
  // injected basename means router routes against the /preview/...
  // path; "MarkFlow" text appears once <Home /> mounts.
  try {
    homeText = await ctx.waitForBodyText(
      (t) => /MarkFlow/.test(t) && /Start Writing/.test(t),
      45_000,
    );
    homeRendered = true;
  } catch (e) {
    homeText = (await ctx.getBodyText().catch(() => '')) || `(error: ${e.message})`;
  }

  // Phase 2b: click "Start Writing" — this is the bug-trigger event.
  // On a buggy build, the click immediately renders <Write /> which
  // mounts <TextareaAutosize />, and TextareaAutosize's hydration
  // path crashes.
  if (homeRendered) {
    try {
      await ctx.clickSelector('#start-writing', { timeoutMs: 10_000 });
      clickSucceeded = true;
    } catch (e) {
      consoleSummary.push(`click failed: ${e.message}`);
    }
  }

  // Phase 2c: wait for Write to render (or for runtime errors to
  // accumulate). Bounded; success = "Write Page" + textarea visible
  // AND no runtime errors. We require BOTH the heading AND the
  // textarea element with its defaultValue in the DOM — the bug
  // fires DURING TextareaAutosize's mount, so the textarea would
  // be missing from the DOM if the bug fires.
  if (clickSucceeded) {
    try {
      writeText = await ctx.waitForBodyText(
        (t) => /Write Page/.test(t),
        30_000,
      );
      // Confirm the textarea is actually in the DOM and the user-supplied
      // defaultValue made it through TextareaAutosize. This is the
      // actual contract: the COMPONENT mounted, not just a heading.
      const editorPresent = await ctx.page.evaluate(() => {
        const el = document.getElementById('editor');
        return {
          exists: !!el,
          tagName: el?.tagName || null,
          value: el?.value || null,
          defaultValue: el?.defaultValue || null,
        };
      });
      writeRendered =
        /Write Page/.test(writeText) &&
        editorPresent.exists &&
        editorPresent.tagName === 'TEXTAREA' &&
        editorPresent.value === 'TEXTAREA-OK';
      // Stash the editor inspection in writeText so the JSON dump
      // documents what we observed.
      writeText = writeText + '\n[editor: ' + JSON.stringify(editorPresent) + ']';
    } catch (e) {
      writeText = (await ctx.getBodyText().catch(() => '')) || `(error: ${e.message})`;
    }
  }

  urlAfterClick = await ctx.currentUrl();
  runtimeErrors = ctx.collectErrors();
  consoleSummary = consoleSummary.concat(ctx.consoleMessages.slice(0, 30).map((m) => ({
    type: m.type,
    text: (m.text || '').slice(0, 280),
  })));

  await ctx.close();
} finally {
  await browser.close();
  await terminal.close();
}

// ── Verdict ──────────────────────────────────────────────────────────
findings = {
  probe: 'markflow-clickthrough',
  category: 'R',
  sid, base: BASE,
  viteReady,
  homeRendered,
  homeText: homeText.slice(0, 600),
  clickSucceeded,
  writeRendered,
  writeText: writeText.slice(0, 600),
  urlAfterClick,
  runtimeErrorCount: runtimeErrors.length,
  runtimeErrors: runtimeErrors.slice(0, 5).map((e) => ({
    kind: e.kind,
    message: (e.message || e.text || '').slice(0, 600),
    location: e.location || null,
  })),
  consoleHead: consoleSummary.slice(0, 12),
};
console.log(JSON.stringify(findings, null, 2));

// ── Asserts ──────────────────────────────────────────────────────────
//
// The bug fires DURING the /write render. Test specifically rejects:
//   1. pageerror events captured (Uncaught TypeError etc.)
//   2. console.error containing a runtime-error keyword
//   3. "Preview crashed" text in body innerText
//   4. body innerText with TypeError fragments
//
// The pre-render assertions (vite ready, home rendered, click
// succeeded) are gating preconditions — the runtime assertions
// only matter if the user could have reached the click.

const errorsText = runtimeErrors.map((e) => e.message || e.text || '').join('\n');
const errorMarker = bodyTextHasErrorMarker(errorsText, RUNTIME_ERROR_MARKERS);
const writeBodyHasErrorMarker = bodyTextHasErrorMarker(writeText, RUNTIME_ERROR_MARKERS);

const checks = [
  ['vite dev server ready', viteReady],
  ['home page rendered (MarkFlow + Start Writing)', homeRendered],
  ['click on #start-writing succeeded', clickSucceeded],
  ['/write page rendered (heading + #editor textarea + defaultValue propagated)',
    writeRendered,
    writeRendered ? '' : `writeText=${writeText.slice(0, 400)}`],
  ['NO pageerror or console.error matched runtime-error markers',
    errorMarker === null,
    errorMarker ? `marker="${errorMarker}" first error: ${(runtimeErrors[0]?.message || runtimeErrors[0]?.text || '').slice(0, 300)}` : ''],
  ['NO error keyword in body.innerText',
    writeBodyHasErrorMarker === null,
    writeBodyHasErrorMarker ? `marker="${writeBodyHasErrorMarker}" body: ${writeText.slice(0, 300)}` : ''],
];

let pass = 0;
for (const c of checks) {
  const [name, ok, detail] = c;
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? '' : (detail ? ' — ' + detail : '')}`);
  if (ok) pass++;
}

const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`\n[markflow-clickthrough] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
