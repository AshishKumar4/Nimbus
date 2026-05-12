#!/usr/bin/env bun
// behavioral/end-to-end-workflow — fresh session → cd app → npm install →
// npm run dev → real Chrome navigates to /preview/?id=<sid> and asserts
// the seeded Nimbus Starter React app actually mounts.
//
// Category: R (runtime-behavioral)
//
// Replaces the earlier HTML-shell-marker version which only asserted
// `r.status === 200 && /<div id="root"|<!doctype html>|<html/i.test(r.html)`
// — that test passes against a static HTML shell even when the React
// bundle fails to load (the 2026-05-10 false-GREEN incident class).
//
// The seeded /home/user/app starter is a Vite + React + TypeScript +
// Tailwind + React Router project whose Home component renders the
// heading "A dev environment that lives at the edge." We wait for
// that exact rendered text via real Chrome — if React fails to
// hydrate, body.innerText stays empty and the probe goes RED.
//
// Black-box surfaces only. NO _diag.

import { mintSession, Terminal, makeAsserter, sleep, BASE } from './_driver.mjs';
import {
  launchBrowser, openPage,
  RUNTIME_ERROR_MARKERS, bodyTextHasErrorMarker,
} from './_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('end-to-end-workflow');
console.log(`behavioral/end-to-end-workflow — npm install + dev + preview (real Chrome)\nBASE=${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_500);
await t.waitForPrompt(60_000);

// Step 1: cd into the seeded app.
{
  const r = await t.run('cd /home/user/app && pwd', 10_000);
  a.check('cd /home/user/app succeeds', /\/home\/user\/app/.test(r.output), r.output.slice(-200));
}

// Step 2: npm install.
{
  t.reset();
  t.cmd('npm install');
  const elapsed = await t.waitFor(
    (b) => /added \d+ packages|installed \d+ packages|Done!\s+\d+ packages|npm ERR!/i.test(b),
    180_000,
    'npm install completion',
  );
  const installed = /added \d+ packages|installed \d+ packages|Done!/i.test(t.buf);
  a.check(`npm install completed (added/installed marker; ${(elapsed/1000).toFixed(1)}s)`,
    installed, t.buf.slice(-300));
  await t.waitForNewPrompt(15_000).catch(() => { /* prompt may already be there */ });
}

// Step 3: npm run dev — long-running.
let viteReady = false;
{
  t.reset();
  t.cmd('npm run dev');
  try {
    const elapsed = await t.waitFor(
      (b) => /ready in|Local:|started \(long-running\)|VITE\s+v|server running|hostname|Preview:\s+|Run\s+vite stop/i.test(b),
      60_000,
      'dev server marker',
    );
    a.check(`dev server emitted ready/started marker (${(elapsed/1000).toFixed(1)}s)`, true);
    viteReady = true;
  } catch {
    a.check('dev server emitted ready/started marker', false, t.buf.slice(-400));
  }
}

// Step 4: Real Chrome navigates to /s/<sid>/preview/ and waits for the
// seeded React app to mount. The Home() component renders the heading
// "A dev environment that lives at the edge." — that is the literal
// user-visible string we assert on.
let homeRendered = false;
let homeText = '';
let runtimeErrors = [];

if (viteReady) {
  // Bounded settle for port-registry registration (matches pattern
  // used in scaffoldAndStartVite helper).
  await sleep(2_000);

  console.log('[end-to-end-workflow] launching headless Chrome...');
  const browser = await launchBrowser();
  try {
    const ctx = await openPage(browser, sid, { waitUntil: 'load' });
    await ctx.navigatePreview('');

    try {
      // The seeded Home.tsx renders the heading as
      //   "A dev environment<br />that lives at the edge."
      // Real Chrome's body.innerText materialises the `<br />` as a
      // newline, so the literal phrase is split across lines:
      //   "A dev environment\nthat lives at the edge."
      // Pre-fix the regex was /dev environment that lives at the edge/
      // which only matches single-line — it never matched the rendered
      // body and the probe went RED even when the React app mounted
      // correctly. Use \s+ to span the newline. The `Preview crashed`
      // negative still rules out the visible-failure case.
      homeText = await ctx.waitForBodyText(
        (text) =>
          /dev environment\s+that lives at the edge/i.test(text) &&
          !/Preview crashed/.test(text),
        60_000,
      );
      homeRendered = true;
    } catch (e) {
      homeText = (await ctx.getBodyText().catch(() => '')) || `(error: ${e.message})`;
    }

    runtimeErrors = ctx.collectErrors();

    await ctx.close();
  } finally {
    await browser.close();
  }
}

await t.close();

// Step 5: assert on observable browser behaviour.
const errorsText = runtimeErrors.map((e) => e.message || e.text || '').join('\n');
const errorMarker = bodyTextHasErrorMarker(errorsText, RUNTIME_ERROR_MARKERS);
const homeHasErrorMarker = bodyTextHasErrorMarker(homeText, RUNTIME_ERROR_MARKERS);
const homeHasCrashBanner = /Preview crashed/.test(homeText);

a.check(
  'React app mounted: body contains seeded heading "A dev environment that lives at the edge"',
  homeRendered,
  homeRendered ? '' : `body[0..360]=${homeText.slice(0, 360)}`,
);
a.check(
  'NO "Preview crashed" overlay on home',
  !homeHasCrashBanner,
  homeHasCrashBanner ? `body: ${homeText.slice(0, 360)}` : '',
);
a.check(
  'NO error keyword in body.innerText of home',
  homeHasErrorMarker === null,
  homeHasErrorMarker ? `marker="${homeHasErrorMarker}" body: ${homeText.slice(0, 360)}` : '',
);
a.check(
  'NO pageerror or console.error matched runtime-error markers',
  errorMarker === null,
  errorMarker ? `marker="${errorMarker}" first error: ${(runtimeErrors[0]?.message || runtimeErrors[0]?.text || '').slice(0, 360)}` : '',
);

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
