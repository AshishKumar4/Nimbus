#!/usr/bin/env bun
// frameworks/cloudflare-pages-real — runtime-behavioral probe of a
// `create-cloudflare` (c3) hello-world Worker scaffold.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create cloudflare@latest mvp -- --type=hello-world --no-deploy
//     --no-git --no-open --no-ts --yes
//   cd mvp
//   npm run dev   (runs `wrangler dev`)
//
// The c3 hello-world template is a single-file Worker that returns
// "Hello World!" as plain text on every request. Real Chrome navigates
// to /preview/ and asserts body.innerText is exactly "Hello World!".
//
// Replaces the deleted `frameworks/cloudflare-pages.mjs` which used
// the forbidden HTML-shell-marker anti-pattern (substring-on-body
// without verifying the worker actually responded with the correct
// text). The new probe verifies the literal user-visible response.
//
// Acceptable RED: surfaces gaps in Nimbus's `wrangler dev` Worker
// support; RED feeds the wrangler-dev workstream.

import { Terminal, mintSession, sleep, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[cloudflare-pages-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

// ── Phase 1: npm create cloudflare ────────────────────────────────────
await t.run('mkdir -p /home/user/c3-probe && cd /home/user/c3-probe', 10_000);
console.log('[cloudflare-pages-real] npm create cloudflare@latest...');

const createR = await t.run(
  'npm create cloudflare@latest mvp -- --type=hello-world --no-deploy --no-git --no-open --no-ts --yes',
  360_000,
);
const createTail = stripAnsi(createR.output).split(/\r?\n/).slice(-12).join('\n');
console.log('[cloudflare-pages-real] create tail:', createTail.slice(-500));

// c3 hello-world scaffolds + installs wrangler. Verify package.json
// has wrangler as a dep.
const pkgCheck = await t.run(
  `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));var hasWrangler=!!(p.dependencies?.wrangler||p.devDependencies?.wrangler);console.log('PKG_OK='+(hasWrangler?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
  20_000,
);
const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
console.log('[cloudflare-pages-real] createSucceeded=', createSucceeded);

let viteReady = false;
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];
let consoleSummary = [];

if (createSucceeded) {
  await t.run('cd /home/user/c3-probe/mvp', 10_000);

  // ── Phase 2: npm run dev (wrangler dev) ────────────────────────────
  console.log('[cloudflare-pages-real] npm run dev...');
  t.reset();
  t.cmd('npm run dev');
  try {
    await t.waitFor(
      (b) => /Ready on|Listening on|localhost:8787|http:\/\/localhost|wrangler|Local:|started \(long-running\)/i.test(b),
      240_000,
      'wrangler-dev-ready',
    );
    viteReady = true;
  } catch (e) {
    console.log('[cloudflare-pages-real] dev not ready:', e?.message);
  }
  await sleep(3_000);
}

// ── Phase 3: real Chrome drive ───────────────────────────────────────
if (viteReady) {
  console.log('[cloudflare-pages-real] launching headless Chrome...');
  const browser = await launchBrowser();
  try {
    const ctx = await openPage(browser, sid, { waitUntil: 'load' });
    await ctx.navigatePreview('');

    // The c3 hello-world template returns plain text "Hello World!"
    // from its Worker `fetch` handler. Chrome renders plain-text
    // responses as a <pre> wrapping the body, so innerText IS the
    // string "Hello World!" (modulo whitespace).
    try {
      homeText = await ctx.waitForBodyText(
        (text) => /Hello\s+World/i.test(text) && !/Preview crashed/.test(text),
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
  probe: 'cloudflare-pages-real',
  category: 'R',
  sid, base: BASE,
  createSucceeded,
  createTail: createTail.slice(-500),
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
  ['npm create cloudflare produced a package.json with wrangler dep', createSucceeded],
  ['wrangler dev server ready', viteReady],
  ['Worker responded with "Hello World!" text', homeRendered,
    homeRendered ? '' : `body: ${homeText.slice(0, 360)}`],
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
console.log(`\n[cloudflare-pages-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
