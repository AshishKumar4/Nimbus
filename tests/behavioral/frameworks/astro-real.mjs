#!/usr/bin/env bun
// frameworks/astro-real — runtime-behavioral probe of a real Astro
// scaffold via `npm create astro@latest`.
//
// Category: R (runtime-behavioral)
//
// User scenario: `npm create astro@latest mvp -- --template minimal --no-install
// --no-git --skip-houston --yes` scaffolds a real Astro project,
// then `npm install && npm run dev` starts the Astro dev server.
// Real Chrome navigates to /preview/ and asserts:
//   - Astro home renders without "Preview crashed"
//   - The DOM contains an `<astro-island>` custom element OR the page's
//     hydration script (Astro emits one or the other depending on
//     template). For the `minimal` template, we look for `astro:` in
//     a script tag URL OR the `<!doctype html>` + a recognisable text.
//   - No pageerror / runtime-error markers fired.
//
// Acceptable RED: this probe surfaces gaps in Nimbus's Astro support
// (the support-matrix had Astro as ❓ before this wave). RED feeds
// cirrus-real S3+ planning.

import { Terminal, mintSession, sleep, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[astro-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

// ── Phase 1: npm create astro ────────────────────────────────────────
await t.run('mkdir -p /home/user/astro-probe && cd /home/user/astro-probe', 10_000);
console.log('[astro-real] npm create astro@latest...');

// Astro's create flow accepts CLI flags for non-interactive scaffold:
//   --template <name>  template directory name (minimal, basics, blog)
//   --no-install       don't auto-run npm install (we run it ourselves)
//   --no-git           don't init git
//   --skip-houston     skip the welcome banner
//   --yes              accept all defaults
const createR = await t.run(
  'npm create astro@latest mvp -- --template minimal --no-install --no-git --skip-houston --yes',
  360_000,
);
const createTail = stripAnsi(createR.output).split(/\r?\n/).slice(-12).join('\n');
console.log('[astro-real] create tail:', createTail.slice(-500));

// Check whether scaffolding produced a package.json.
const pkgCheck = await t.run(
  `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));console.log('PKG_OK='+(p.dependencies?.astro?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
  20_000,
);
const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
console.log('[astro-real] createSucceeded=', createSucceeded);

let viteReady = false;
let installTail = '';
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];
let consoleSummary = [];

if (createSucceeded) {
  await t.run('cd /home/user/astro-probe/mvp', 10_000);

  // ── Phase 2: npm install ───────────────────────────────────────────
  console.log('[astro-real] npm install...');
  const installR = await t.run('npm install', 600_000);
  installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-12).join('\n');
  console.log('[astro-real] install tail:', installTail.slice(-500));

  // ── Phase 3: npm run dev ───────────────────────────────────────────
  console.log('[astro-real] npm run dev...');
  t.reset();
  t.cmd('npm run dev');
  try {
    await t.waitFor(
      (b) => /astro|localhost:|Local:|ready in|started \(long-running\)/i.test(b),
      300_000,
      'astro-dev-ready',
    );
    viteReady = true;
  } catch (e) {
    console.log('[astro-real] dev not ready:', e?.message);
  }
  await sleep(3_000);
}

// ── Phase 4: real Chrome drive ───────────────────────────────────────
if (viteReady) {
  console.log('[astro-real] launching headless Chrome...');
  const browser = await launchBrowser();
  try {
    const ctx = await openPage(browser, sid, { waitUntil: 'load' });
    await ctx.navigatePreview('');

    // Astro 'minimal' template renders a minimal page with text and
    // (because it's SSR) the rendered HTML is in body.innerText
    // directly. Astro's dev server also emits <astro-island> or a
    // hydration script when client directives are used; minimal
    // doesn't necessarily have islands, so we assert "page rendered
    // with non-empty text" plus the absence of error markers.
    try {
      homeText = await ctx.waitForBodyText(
        (text) => text.length > 10 && !/Preview crashed/.test(text),
        60_000,
      );
      homeRendered = true;
    } catch (e) {
      homeText = (await ctx.getBodyText().catch(() => '')) || `(error: ${e.message})`;
    }

    runtimeErrors = ctx.collectErrors();
    consoleSummary = ctx.consoleMessages.slice(0, 20).map((m) => ({
      type: m.type,
      text: (m.text || '').slice(0, 280),
    }));

    await ctx.close();
  } finally {
    await browser.close();
  }
}

await t.close();

// ── Verdict ──────────────────────────────────────────────────────────
const errorsText = runtimeErrors.map((e) => e.message || e.text || '').join('\n');
const errorMarker = bodyTextHasErrorMarker(errorsText, RUNTIME_ERROR_MARKERS);
const homeHasErrorMarker = bodyTextHasErrorMarker(homeText, RUNTIME_ERROR_MARKERS);
const homeHasCrashBanner = /Preview crashed/.test(homeText);

const findings = {
  probe: 'astro-real',
  category: 'R',
  sid, base: BASE,
  createSucceeded,
  createTail: createTail.slice(-500),
  installTail: installTail.slice(-500),
  viteReady,
  homeRendered,
  homeText: homeText.slice(0, 600),
  runtimeErrorCount: runtimeErrors.length,
  runtimeErrors: runtimeErrors.slice(0, 6).map((e) => ({
    kind: e.kind,
    message: (e.message || e.text || '').slice(0, 360),
    location: e.location || null,
  })),
  consoleHead: consoleSummary.slice(0, 12),
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['npm create astro produced a package.json with astro dep', createSucceeded],
  ['vite/astro dev server ready', viteReady],
  ['Astro home page rendered (non-empty body)', homeRendered],
  ['NO "Preview crashed" overlay on home',
    !homeHasCrashBanner,
    homeHasCrashBanner ? `body: ${homeText.slice(0, 360)}` : ''],
  ['NO error keyword in body.innerText of home',
    homeHasErrorMarker === null,
    homeHasErrorMarker ? `marker="${homeHasErrorMarker}" body: ${homeText.slice(0, 360)}` : ''],
  ['NO pageerror or console.error matched runtime-error markers',
    errorMarker === null,
    errorMarker ? `marker="${errorMarker}" first error: ${(runtimeErrors[0]?.message || runtimeErrors[0]?.text || '').slice(0, 360)}` : ''],
];

let pass = 0;
for (const c of checks) {
  const [name, ok, detail] = c;
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? '' : (detail ? ' — ' + detail : '')}`);
  if (ok) pass++;
}

const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`\n[astro-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
