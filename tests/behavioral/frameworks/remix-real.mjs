#!/usr/bin/env bun
// frameworks/remix-real — runtime-behavioral probe of a real Remix
// scaffold via `npx create-remix@latest`.
//
// Category: R (runtime-behavioral)
//
// User scenario: `npx create-remix@latest mvp --template remix-run/remix/templates/remix
// --no-git-init --no-install --yes` scaffolds a Remix project,
// then `npm install && npm run dev` starts the Vite-based Remix dev
// server. Real Chrome asserts the home renders without runtime errors.
//
// Acceptable RED: surfaces Remix gaps for cirrus-real S3+.

import { Terminal, mintSession, sleep, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[remix-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/remix-probe && cd /home/user/remix-probe', 10_000);
console.log('[remix-real] npx create-remix@latest...');

const createR = await t.run(
  'npx --yes create-remix@latest mvp --template remix-run/remix/templates/remix --no-git-init --no-install --yes',
  360_000,
);
const createTail = stripAnsi(createR.output).split(/\r?\n/).slice(-12).join('\n');
console.log('[remix-real] create tail:', createTail.slice(-500));

const pkgCheck = await t.run(
  `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));var hasRemix=!!(p.dependencies?.['@remix-run/react']||p.devDependencies?.['@remix-run/dev']);console.log('PKG_OK='+(hasRemix?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
  20_000,
);
const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
console.log('[remix-real] createSucceeded=', createSucceeded);

let viteReady = false;
let installTail = '';
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];
let consoleSummary = [];

if (createSucceeded) {
  await t.run('cd /home/user/remix-probe/mvp', 10_000);

  const installR = await t.run('npm install', 600_000);
  installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-12).join('\n');

  t.reset();
  t.cmd('npm run dev');
  try {
    await t.waitFor(
      (b) => /Remix|ready in|VITE v|localhost:|Local:|started \(long-running\)/i.test(b),
      300_000,
      'remix-dev-ready',
    );
    viteReady = true;
  } catch (e) {
    console.log('[remix-real] dev not ready:', e?.message);
  }
  await sleep(3_000);
}

if (viteReady) {
  console.log('[remix-real] launching headless Chrome...');
  const browser = await launchBrowser();
  try {
    const ctx = await openPage(browser, sid, { waitUntil: 'load' });
    await ctx.navigatePreview('');

    try {
      homeText = await ctx.waitForBodyText(
        (text) => text.length > 5 && !/Preview crashed/.test(text),
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

const errorsText = runtimeErrors.map((e) => e.message || e.text || '').join('\n');
const errorMarker = bodyTextHasErrorMarker(errorsText, RUNTIME_ERROR_MARKERS);
const homeHasErrorMarker = bodyTextHasErrorMarker(homeText, RUNTIME_ERROR_MARKERS);
const homeHasCrashBanner = /Preview crashed/.test(homeText);

const findings = {
  probe: 'remix-real',
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
  ['npx create-remix produced a package.json with @remix-run', createSucceeded],
  ['vite/remix dev server ready', viteReady],
  ['Remix home page rendered (non-empty body)', homeRendered],
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
console.log(`\n[remix-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
