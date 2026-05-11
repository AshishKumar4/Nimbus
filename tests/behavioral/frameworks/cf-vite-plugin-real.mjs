#!/usr/bin/env bun
// frameworks/cf-vite-plugin-real — runtime-behavioral probe of a real
// Vite + React + @cloudflare/vite-plugin scaffold.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create vite@latest mvp -- --template react-ts --yes
//   cd mvp
//   npm install
//   npm install @cloudflare/vite-plugin
//   echo 'import { cloudflare } from "@cloudflare/vite-plugin"; ...' > vite.config.ts
//   npm run dev
//
// Real Chrome navigates to /preview/ and asserts the React SPA mounts.
// The default `react-ts` template renders "Vite + React" heading text
// after hydration — we wait for that exact text to appear in the DOM.
//
// Replaces the deleted `frameworks/cf-vite-plugin.mjs` which used the
// forbidden HTML-shell-marker anti-pattern. The original probe
// asserted on the presence of `<div id="root">` and `<script
// type="module">` in the SSR shell — which is present even when
// the React bundle fails to load. Real Chrome catches that case
// because `root` stays empty.
//
// Acceptable RED: surfaces gaps in Nimbus's CF Vite Plugin support
// (the plugin registers worker-style handlers for /api/* paths which
// we don't exercise here in v1 but the home page must still hydrate).

import { Terminal, mintSession, sleep, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from '../_runtime-behavioral-template.mjs';

const sid = await mintSession();
console.log(`[cf-vite-plugin-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

// ── Phase 1: npm create vite ─────────────────────────────────────────
await t.run('mkdir -p /home/user/cfvite-probe && cd /home/user/cfvite-probe', 10_000);
console.log('[cf-vite-plugin-real] npm create vite@latest...');

const createR = await t.run(
  'npm create vite@latest mvp -- --template react-ts --yes',
  240_000,
);
const createTail = stripAnsi(createR.output).split(/\r?\n/).slice(-12).join('\n');
console.log('[cf-vite-plugin-real] create tail:', createTail.slice(-500));

const pkgCheck = await t.run(
  `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));console.log('PKG_OK='+(p.devDependencies?.vite?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
  20_000,
);
const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
console.log('[cf-vite-plugin-real] createSucceeded=', createSucceeded);

let installSucceeded = false;
let pluginInstalled = false;
let configWritten = false;
let viteReady = false;
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];
let consoleSummary = [];

if (createSucceeded) {
  await t.run('cd /home/user/cfvite-probe/mvp', 10_000);

  // ── Phase 2: npm install ───────────────────────────────────────────
  console.log('[cf-vite-plugin-real] npm install...');
  const installR = await t.run('npm install', 600_000);
  const installTail = stripAnsi(installR.output).split(/\r?\n/).slice(-6).join('\n');
  installSucceeded = /added\s+\d+\s+packages|installed\s+\d+\s+packages|up to date/i.test(installR.output);
  console.log('[cf-vite-plugin-real] install tail:', installTail);

  // ── Phase 3: npm install @cloudflare/vite-plugin ───────────────────
  if (installSucceeded) {
    console.log('[cf-vite-plugin-real] npm install @cloudflare/vite-plugin...');
    const pluginR = await t.run('npm install @cloudflare/vite-plugin', 300_000);
    pluginInstalled = /added\s+\d+\s+packages|installed\s+\d+\s+packages|up to date/i.test(pluginR.output)
      && !/npm ERR!/i.test(pluginR.output);
    console.log('[cf-vite-plugin-real] plugin install tail:',
      stripAnsi(pluginR.output).split(/\r?\n/).slice(-6).join('\n').slice(-500));
  }

  // ── Phase 4: write vite.config.ts including the cloudflare plugin ──
  if (pluginInstalled) {
    const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [react(), cloudflare()],
})
`;
    const b64 = Buffer.from(viteConfig, 'utf8').toString('base64');
    const writeR = await t.run(
      `node -e "require('fs').writeFileSync('vite.config.ts', Buffer.from('${b64}','base64').toString('utf8'))"`,
      15_000,
    );
    configWritten = !/Error/i.test(writeR.output);
    console.log('[cf-vite-plugin-real] configWritten=', configWritten);
  }

  // ── Phase 5: npm run dev ───────────────────────────────────────────
  if (configWritten) {
    console.log('[cf-vite-plugin-real] npm run dev...');
    t.reset();
    t.cmd('npm run dev');
    try {
      await t.waitFor(
        (b) => /Local:|ready in|localhost:5173|Nimbus Vite Dev|VITE\s+v|started \(long-running\)/i.test(b),
        180_000,
        'cfvite-dev-ready',
      );
      viteReady = true;
    } catch (e) {
      console.log('[cf-vite-plugin-real] dev not ready:', e?.message);
    }
    await sleep(3_000);
  }
}

// ── Phase 6: real Chrome drive ───────────────────────────────────────
if (viteReady) {
  console.log('[cf-vite-plugin-real] launching headless Chrome...');
  const browser = await launchBrowser();
  try {
    const ctx = await openPage(browser, sid, { waitUntil: 'load' });
    await ctx.navigatePreview('');

    // The default react-ts template renders <h1>Vite + React</h1>
    // and a counter button after hydration. If `root` stays empty
    // (e.g. plugin breaks the module graph), this wait will time
    // out — exactly the false-GREEN class we replaced.
    try {
      homeText = await ctx.waitForBodyText(
        (text) => /Vite\s*\+\s*React/i.test(text) && !/Preview crashed/.test(text),
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
  probe: 'cf-vite-plugin-real',
  category: 'R',
  sid, base: BASE,
  createSucceeded,
  installSucceeded,
  pluginInstalled,
  configWritten,
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
  ['npm create vite produced a package.json with vite dep', createSucceeded],
  ['npm install completed', installSucceeded],
  ['npm install @cloudflare/vite-plugin completed', pluginInstalled],
  ['vite.config.ts written with cloudflare plugin', configWritten],
  ['vite dev server ready', viteReady],
  ['React app mounted in DOM (body contains "Vite + React")', homeRendered,
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
console.log(`\n[cf-vite-plugin-real] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
