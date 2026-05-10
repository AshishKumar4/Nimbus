#!/usr/bin/env bun
// frameworks/sveltekit-real — runtime-behavioral probe of a real
// SvelteKit scaffold via `npm create svelte@latest`.
//
// Category: R (runtime-behavioral)
//
// User scenario: `npx sv@latest create mvp --template minimal --types
// ts --no-add-ons` scaffolds a SvelteKit skeleton, then
// `npm install && npm run dev` starts the dev server. Real Chrome
// asserts the home renders without runtime errors.
//
// Note: the older `npm create svelte@latest` flow is deprecated by
// upstream (create-svelte 6.x prints "has been replaced with `npx
// sv create`" and exits 0). We use the new `sv` tool.
//
// Acceptable RED: surfaces SvelteKit gaps for cirrus-real S3+.

import { Terminal, mintSession, sleep, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[sveltekit-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/sk-probe && cd /home/user/sk-probe', 10_000);
console.log('[sveltekit-real] npx sv@latest create...');

// `npx sv create` is the new tool (replaces `npm create svelte`).
// Use --template minimal --types ts --no-add-ons for the simplest
// non-interactive scaffold.
const createR = await t.run(
  'npx --yes sv@latest create mvp --template minimal --types ts --no-add-ons --no-install',
  360_000,
);
const createTail = stripAnsi(createR.output).split(/\r?\n/).slice(-12).join('\n');
console.log('[sveltekit-real] create tail:', createTail.slice(-500));

const pkgCheck = await t.run(
  `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));console.log('PKG_OK='+(p.devDependencies?.['@sveltejs/kit']?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
  20_000,
);
const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
console.log('[sveltekit-real] createSucceeded=', createSucceeded);

let viteReady = false;
let installTail = '';
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];
let consoleSummary = [];

if (createSucceeded) {
  await t.run('cd /home/user/sk-probe/mvp', 10_000);

  const installR = await t.run('npm install', 600_000);
  installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-12).join('\n');

  t.reset();
  t.cmd('npm run dev');
  try {
    await t.waitFor(
      (b) => /VITE v|SvelteKit|ready in|localhost:5173|Local:|started \(long-running\)/i.test(b),
      300_000,
      'sveltekit-dev-ready',
    );
    viteReady = true;
  } catch (e) {
    console.log('[sveltekit-real] dev not ready:', e?.message);
  }
  await sleep(3_000);
}

if (viteReady) {
  console.log('[sveltekit-real] launching headless Chrome...');
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
  probe: 'sveltekit-real',
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
  ['npm create svelte produced a package.json with @sveltejs/kit', createSucceeded],
  ['vite/sveltekit dev server ready', viteReady],
  ['SvelteKit home page rendered (non-empty body)', homeRendered],
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
console.log(`\n[sveltekit-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
