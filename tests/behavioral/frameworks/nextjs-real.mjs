#!/usr/bin/env bun
// frameworks/nextjs-real — runtime-behavioral probe of a real Next.js
// scaffold via `npx create-next-app@latest`.
//
// Category: R (runtime-behavioral)
//
// User scenario: `npx --yes create-next-app@latest mvp --ts --no-eslint
// --tailwind --app --src-dir --import-alias '@/*' --use-npm --yes`
// scaffolds a real Next.js project (App Router, TS, Tailwind), then
// `npm run dev` starts the Next.js dev server. Real Chrome navigates
// to /preview/ and asserts the home page rendered without runtime
// errors.
//
// Replaces the deleted `frameworks/nextjs.mjs` which used the forbidden
// HTML-shell-marker anti-pattern (substring-on-HTML) — see
// `tests/behavioral/PROBE-QUALITY.md` §"Marker-substring in HTML
// shell" and the 2026-05-10 false-GREEN incident.
//
// Acceptable RED: this probe surfaces gaps in Nimbus's Next.js
// support; RED feeds cirrus-real S3+ planning.

import { Terminal, mintSession, sleep, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[nextjs-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

// ── Phase 1: npx create-next-app ─────────────────────────────────────
await t.run('mkdir -p /home/user/nextjs-probe && cd /home/user/nextjs-probe', 10_000);
console.log('[nextjs-real] npx create-next-app@latest...');

// create-next-app installs as part of create, so no separate npm install.
// --ts: TypeScript, --tailwind: Tailwind, --app: App Router,
// --src-dir: src/ layout, --import-alias '@/*', --use-npm, --yes
// accepts defaults non-interactively.
const createR = await t.run(
  "npx --yes create-next-app@latest mvp --ts --no-eslint --tailwind --app --src-dir --import-alias '@/*' --use-npm --yes",
  360_000,
);
const createTail = stripAnsi(createR.output).split(/\r?\n/).slice(-12).join('\n');
console.log('[nextjs-real] create tail:', createTail.slice(-500));

// Check whether scaffolding produced a package.json with `next` dep.
const pkgCheck = await t.run(
  `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));console.log('PKG_OK='+(p.dependencies?.next?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
  20_000,
);
const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
console.log('[nextjs-real] createSucceeded=', createSucceeded);

let viteReady = false;
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];
let consoleSummary = [];

if (createSucceeded) {
  await t.run('cd /home/user/nextjs-probe/mvp', 10_000);

  // ── Phase 2: npm run dev (create-next-app already installed) ───────
  console.log('[nextjs-real] npm run dev...');
  t.reset();
  t.cmd('npm run dev');
  try {
    await t.waitFor(
      (b) => /Next\.js|Ready in|Local:|localhost:3000|compiled successfully|started \(long-running\)/i.test(b),
      300_000,
      'nextjs-dev-ready',
    );
    viteReady = true;
  } catch (e) {
    console.log('[nextjs-real] dev not ready:', e?.message);
  }
  await sleep(3_000);
}

// ── Phase 3: real Chrome drive ───────────────────────────────────────
if (viteReady) {
  console.log('[nextjs-real] launching headless Chrome...');
  const browser = await launchBrowser();
  try {
    const ctx = await openPage(browser, sid, { waitUntil: 'load' });
    await ctx.navigatePreview('');

    // create-next-app default home page (app router) renders a
    // welcome screen with the Next.js logo and links. Body has
    // non-trivial text content; we assert non-empty + no error
    // markers.
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
  probe: 'nextjs-real',
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
  ['npx create-next-app produced a package.json with next dep', createSucceeded],
  ['Next.js dev server ready', viteReady],
  ['Next.js home page rendered (non-empty body)', homeRendered],
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
console.log(`\n[nextjs-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
