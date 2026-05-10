#!/usr/bin/env bun
// frameworks/markflow-real — runtime-behavioral probe of the REAL
// Markflow repo on prod.
//
// Category: R (runtime-behavioral)
//
// Why this exists
// ───────────────
// The synthetic `markflow-clickthrough.mjs` probe (also R-category)
// scaffolds a Markflow-SHAPED minimal SPA: it pulls in react-router-
// dom + react-textarea-autosize and exercises a click → `/write`
// flow. But the user-reported bug fires against the REAL Markflow
// bundle, which has ~80 transitive deps — framer-motion, radix-ui's
// 25+ packages, @tanstack/react-query, react-markdown, mermaid,
// react-resizable-panels, etc. — each contributing CJS interop edge
// cases the minimal repro doesn't cover.
//
// This probe clones the real repo via `git clone` (Nimbus's
// isomorphic-git layer handles public HTTPS), installs the full dep
// tree, starts the dev server, and drives the LITERAL user flow:
//
//   1. Mint session.
//   2. `git clone https://github.com/AshishKumar4/Markflow Markflow`
//   3. `cd Markflow && bun install` (the repo's pinned package
//      manager per bun.lock).
//   4. `bun run dev` — vite on port 3000 per the repo's package.json.
//   5. Wait for vite-ready marker.
//   6. Real Chrome via puppeteer-core navigates to
//      `BASE/s/<sid>/preview/`.
//   7. Wait for the Home component to render (body.innerText: 
//      "MarkFlow" + "Start Writing" + "View Directory").
//   8. Click "Start Writing" → routes to `/new` (the EditorPage,
//      which mounts react-textarea-autosize — the bug-trigger).
//   9. Wait for /new to render with the editor present in the DOM.
//  10. Assert ZERO pageerror / console.error matching runtime-error
//      markers (TypeError, "is not a function",
//      _objectWithoutPropertiesLoose2, etc.).
//  11. Assert body.innerText DOES NOT contain "Preview crashed".
//
// Pass/fail signal: real Chrome's runtime behavior against the real
// Markflow bundle. The probe goes RED iff a real user attempting
// this flow on prod would see the bug.
//
// Baseline at probe creation: documented in
//   /workspace/.seal-internal/2026-05-10-markflow-real-probe/baseline.md
//
// RED on prod 3bd8e28 → cirrus-real S2 is urgent.
// GREEN on prod 3bd8e28 → framework-validation P3 (CJS-interop fix)
//   covered the gap; cirrus-real S2 is preventative.

import {
  launchBrowser, cloneAndStartVite, openPage,
  mintSession, sleep, BASE,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[markflow-real] sid=${sid} BASE=${BASE}`);

// ── Phase 1: clone + install + dev ────────────────────────────────────
console.log('[markflow-real] git clone + bun install + bun run dev (15 min budget)...');
const {
  terminal, viteReady, installTail, cloneOk, cloneTail,
} = await cloneAndStartVite(sid, {
  repoUrl: 'https://github.com/AshishKumar4/Markflow',
  workdir: 'Markflow',
  // Markflow's README uses bun, but Nimbus's `bun install` shim
  // delegates to npm install under the hood (no bun-native install
  // path yet). Using `npm install` directly is the canonical Nimbus
  // path for this repo today — same install graph, same Nimbus
  // dispatch chain that handles longRunning for the dev script.
  installCmd: 'npm install',
  installTimeoutMs: 900_000, // 15 min — real install can take long
  // Run via `npm run dev`. The package.json#scripts['dev'] is
  // `vite --host 0.0.0.0 --port ${PORT:-3000}`. Nimbus's npm run
  // dispatch marks dev/start/serve/watch as longRunning (init.ts:
  // 2153) so the spawn doesn't block the shell waiting for vite to
  // exit.
  devCmd: 'npm run dev',
  devReadyTimeoutMs: 300_000,
  cloneTimeoutMs: 240_000,
  // Vite emits "Local: ... :3000" and "ready in Xms" on success.
  devReadyMarkers: [
    'ready in', 'Local:', 'Nimbus Vite Dev', 'VITE v',
    'localhost:3000',
    'started (long-running)', // Nimbus's banner for forked vite
  ],
});

console.log('[markflow-real] cloneOk=', cloneOk);
console.log('[markflow-real] clone tail:', cloneTail.slice(-300));
console.log('[markflow-real] viteReady=', viteReady);
console.log('[markflow-real] install tail:', installTail.slice(-300));

// If clone or install failed, document the state but proceed to
// browser drive (so the probe captures a deterministic failure
// signal at the right phase, not a hang).
let homeRendered = false;
let homeText = '';
let clickSucceeded = false;
let editorRendered = false;
let editorText = '';
let editorPresent = null;
let urlAfterClick = '';
let runtimeErrors = [];
let consoleSummary = [];

if (viteReady) {
  console.log('[markflow-real] launching headless Chrome...');
  const browser = await launchBrowser();

  try {
    const ctx = await openPage(browser, sid, { waitUntil: 'load' });

    console.log('[markflow-real] navigate to /preview/...');
    const homeNav = await ctx.navigatePreview('');
    console.log('[markflow-real] home nav status:', homeNav.status);

    // Phase 2a: wait for Markflow Home to render. The H1 splits
    // "Mark" + "Flow" into two spans; body.innerText concatenates,
    // so "MarkFlow" is the single token to look for. Then assert
    // both CTAs are present.
    try {
      homeText = await ctx.waitForBodyText(
        (t) => /MarkFlow/.test(t) && /Start Writing/.test(t) && /View Directory/.test(t),
        60_000,
      );
      homeRendered = true;
    } catch (e) {
      homeText = (await ctx.getBodyText().catch(() => '')) || `(error: ${e.message})`;
    }

    // Phase 2b: click "Start Writing". Markflow's HomePage uses
    // `<Link to="/new">Start Writing</Link>` so the click triggers
    // a client-side route change to /new (EditorPage). The editor
    // mounts react-textarea-autosize — the bug-trigger component.
    if (homeRendered) {
      try {
        // The CTA is a Button wrapping a Link. Click the Link's
        // text content (XPath-style via Puppeteer's locator API
        // is brittle; use evaluate to click the right anchor).
        const clicked = await ctx.page.evaluate(() => {
          // Find all links whose textContent contains "Start Writing".
          const links = Array.from(document.querySelectorAll('a'));
          const target = links.find((a) =>
            /Start Writing/i.test(a.textContent || ''));
          if (target) {
            target.click();
            return true;
          }
          return false;
        });
        clickSucceeded = !!clicked;
      } catch (e) {
        consoleSummary.push(`click eval failed: ${e.message}`);
      }
    }

    // Phase 2c: wait for the EditorPage to render. We look for the
    // textarea by tag (react-textarea-autosize emits an actual
    // <textarea>). The CTA navigates to /new which routes to the
    // EditorPage; on a buggy build the page errors during
    // TextareaAutosize hydration.
    if (clickSucceeded) {
      // Bounded settle for client-side route change.
      await sleep(2_500);

      // Re-read body and DOM state.
      editorText = await ctx.getBodyText().catch(() => '');
      try {
        editorPresent = await ctx.page.evaluate(() => {
          // EditorPage has a textarea-autosize as its main editor.
          const ta = document.querySelector('textarea');
          return {
            present: !!ta,
            tagName: ta?.tagName || null,
            // The editor may have placeholder/aria text we can sample.
            placeholder: ta?.placeholder || '',
            ariaLabel: ta?.getAttribute('aria-label') || '',
            classList: ta ? Array.from(ta.classList).slice(0, 6).join(' ') : '',
          };
        });
        editorRendered =
          !!editorPresent &&
          editorPresent.present &&
          editorPresent.tagName === 'TEXTAREA';
      } catch (e) {
        consoleSummary.push(`editor check failed: ${e.message}`);
      }
    }

    urlAfterClick = await ctx.currentUrl();
    runtimeErrors = ctx.collectErrors();
    consoleSummary = consoleSummary.concat(
      ctx.consoleMessages.slice(0, 40).map((m) => ({
        type: m.type,
        text: (m.text || '').slice(0, 280),
      })),
    );

    await ctx.close();
  } finally {
    await browser.close();
  }
}

await terminal.close();

// ── Verdict + structured findings dump ───────────────────────────────
const findings = {
  probe: 'markflow-real',
  category: 'R',
  sid, base: BASE,
  cloneOk,
  cloneTail: cloneTail.slice(-600),
  installTail: installTail.slice(-600),
  viteReady,
  homeRendered,
  homeText: homeText.slice(0, 600),
  clickSucceeded,
  editorRendered,
  editorPresent,
  editorText: editorText.slice(0, 600),
  urlAfterClick,
  runtimeErrorCount: runtimeErrors.length,
  runtimeErrors: runtimeErrors.slice(0, 8).map((e) => ({
    kind: e.kind,
    message: (e.message || e.text || '').slice(0, 600),
    location: e.location || null,
  })),
  consoleHead: consoleSummary.slice(0, 20),
};
console.log(JSON.stringify(findings, null, 2));

// ── Asserts ──────────────────────────────────────────────────────────
// The negative assertions are the canonical pass signal: ZERO runtime
// errors matching the marker family. Gating preconditions (clone,
// install, dev, home rendered, click) must succeed for the runtime
// assertions to be meaningful.

const errorsText = runtimeErrors.map((e) => e.message || e.text || '').join('\n');
const errorMarker = bodyTextHasErrorMarker(errorsText, RUNTIME_ERROR_MARKERS);
const homeBodyHasErrorMarker = bodyTextHasErrorMarker(homeText, RUNTIME_ERROR_MARKERS);
const homeBodyHasCrashBanner = /Preview crashed/.test(homeText);
const editorBodyHasErrorMarker = bodyTextHasErrorMarker(editorText, RUNTIME_ERROR_MARKERS);
const editorBodyHasCrashBanner = /Preview crashed/.test(editorText);

const checks = [
  ['git clone succeeded',                     cloneOk],
  ['vite dev server ready',                   viteReady],
  ['Markflow home rendered (MarkFlow + Start Writing + View Directory)',
                                              homeRendered],
  ['NO "Preview crashed" overlay on home',
                                              !homeBodyHasCrashBanner,
                                              homeBodyHasCrashBanner ? `body: ${homeText.slice(0, 360)}` : ''],
  ['NO error keyword in body.innerText of home',
                                              homeBodyHasErrorMarker === null,
                                              homeBodyHasErrorMarker
                                                ? `marker="${homeBodyHasErrorMarker}" body: ${homeText.slice(0, 360)}`
                                                : ''],
  ['click on "Start Writing" Link succeeded', clickSucceeded],
  ['EditorPage (/new) rendered with <textarea> in DOM',
                                              editorRendered,
                                              editorPresent ? `editor=${JSON.stringify(editorPresent)}` : `(not checked — click didn't succeed)`],
  ['NO pageerror or console.error matched runtime-error markers',
                                              errorMarker === null,
                                              errorMarker
                                                ? `marker="${errorMarker}" first error: ${(runtimeErrors[0]?.message || runtimeErrors[0]?.text || '').slice(0, 360)}`
                                                : ''],
  ['NO error keyword in body.innerText of /new',
                                              editorBodyHasErrorMarker === null,
                                              editorBodyHasErrorMarker
                                                ? `marker="${editorBodyHasErrorMarker}" body: ${editorText.slice(0, 360)}`
                                                : ''],
  ['NO "Preview crashed" overlay on /new',
                                              !editorBodyHasCrashBanner,
                                              editorBodyHasCrashBanner ? `body: ${editorText.slice(0, 360)}` : ''],
];

let pass = 0;
for (const c of checks) {
  const [name, ok, detail] = c;
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? '' : (detail ? ' — ' + detail : '')}`);
  if (ok) pass++;
}

const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`\n[markflow-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
