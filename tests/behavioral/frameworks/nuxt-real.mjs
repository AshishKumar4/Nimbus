#!/usr/bin/env bun
// frameworks/nuxt-real — runtime-behavioral probe of a real Nuxt
// scaffold via `npx nuxi@latest init`.
//
// Category: R (runtime-behavioral)
//
// User scenario: `npx nuxi@latest init mvp --no-install --no-gitInit
// --packageManager=npm` scaffolds a Nuxt project, then `npm install
// && npm run dev` starts the Vite-based Nuxt dev server. Real Chrome
// asserts the home renders without runtime errors.
//
// Acceptable RED: surfaces Nuxt gaps for cirrus-real S3+.

import { Terminal, mintSession, sleep, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[nuxt-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/nuxt-probe && cd /home/user/nuxt-probe', 10_000);
console.log('[nuxt-real] npx nuxi@latest init...');

const createR = await t.run(
  'npx --yes nuxi@latest init mvp --no-install --no-gitInit --packageManager=npm',
  360_000,
);
const createTail = stripAnsi(createR.output).split(/\r?\n/).slice(-12).join('\n');
console.log('[nuxt-real] create tail:', createTail.slice(-500));

const pkgCheck = await t.run(
  `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));console.log('PKG_OK='+(p.devDependencies?.nuxt||p.dependencies?.nuxt?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
  20_000,
);
const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
console.log('[nuxt-real] createSucceeded=', createSucceeded);

let viteReady = false;
let installTail = '';
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];
let consoleSummary = [];

if (createSucceeded) {
  await t.run('cd /home/user/nuxt-probe/mvp', 10_000);

  const installR = await t.run('npm install', 600_000);
  installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-12).join('\n');

  t.reset();
  t.cmd('npm run dev');
  try {
    await t.waitFor(
      (b) => /Nuxt|ready in|Local:|localhost:3000|Vite|started \(long-running\)/i.test(b),
      300_000,
      'nuxt-dev-ready',
    );
    viteReady = true;
  } catch (e) {
    console.log('[nuxt-real] dev not ready:', e?.message);
  }
  await sleep(3_000);
}

if (viteReady) {
  console.log('[nuxt-real] launching headless Chrome...');
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
  probe: 'nuxt-real',
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
  ['npx nuxi init produced a package.json with nuxt', createSucceeded],
  ['vite/nuxt dev server ready', viteReady],
  ['Nuxt home page rendered (non-empty body)', homeRendered],
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
console.log(`\n[nuxt-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
