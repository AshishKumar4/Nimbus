#!/usr/bin/env bun
// preview/new/coi-host-preview-live — an app that asks for cross-origin
// isolation runs isolated in a host-form preview (`<port>--<sid>.<suffix>`),
// the form production serves previews in. The path-form pane is covered by
// coi-isolated-preview; the host form needs a zone route with
// NIMBUS_PREVIEW_HOST_SUFFIX, which only production has, so this probe runs
// against production (the promotion runs it) and is skipped for probe
// targets (_probe-target-skips.mjs).
//
// The app sends COEP require-corp with CORP cross-origin, as an app that
// wants to be framed by another origin must. The isolated shell frames it
// from its own origin, through the preview door's token exchange (a 302 that
// must itself carry CORP, or the frame is blocked). In the pane and in its
// own tab the app reports crossOriginIsolated and completes a
// SharedArrayBuffer + Worker + Atomics round trip.

import { AUTH_TOKEN, deleteSession, heredocCommand, makeAsserter, mintSession, Terminal } from '../../_driver.mjs';
import {
  applyProbeCookies,
  exchangeAttachCookie,
  launchBrowser,
  waitForSessionTerminalText,
} from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'preview/new/coi-host-preview-live';
const a = makeAsserter(label);
const BASE = process.env.BASE;
console.log(`${label} — BASE=${BASE}`);

const PORT = 3000;
const serverJs = `
const http = require('http');
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
const page = \`<!doctype html><meta charset="utf-8"><title>coi-host-app</title><body>starting<script>
(async () => {
  const result = { coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer };
  try {
    const cell = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker('worker.js');
    worker.postMessage(cell.buffer);
    Atomics.store(cell, 0, 1);
    Atomics.notify(cell, 0);
    const deadline = Date.now() + 10000;
    while (Atomics.load(cell, 1) !== 42 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    result.value = Atomics.load(cell, 1);
  } catch (error) {
    result.error = String(error);
  }
  document.body.dataset.result = JSON.stringify(result);
  document.body.textContent = 'COI-RESULT ' + JSON.stringify(result);
})();
</script>\`;
const worker = 'onmessage = (e) => { const cell = new Int32Array(e.data); Atomics.wait(cell, 0, 0); Atomics.store(cell, 1, 42); Atomics.notify(cell, 1); };';
http.createServer((req, res) => {
  const js = new URL(req.url, 'http://app').pathname.endsWith('/worker.js');
  res.writeHead(200, { ...isolation, 'Content-Type': js ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(js ? worker : page);
}).listen(${PORT}, () => console.log('COI HOST APP ${PORT}'));
`.trim();

const sid = await mintSession();
const t = new Terminal(sid);
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true, args: ['--disable-features=BackForwardCache'] });

/** A URL on the app's host-form preview origin. */
const onHostPreview = (url) => {
  try { return new URL(url).hostname.startsWith(`${PORT}--${sid}.`); } catch { return false; }
};

/** The app's own report from inside a frame or page, once it has one. */
async function appResult(target) {
  const handle = await target.waitForFunction(() => document.body?.dataset.result, { timeout: 30_000 });
  return JSON.parse(await handle.jsonValue());
}

try {
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/coi-host-app && cd /home/user/coi-host-app', 15_000);
  await t.run(heredocCommand('server.js', serverJs), 15_000);
  await t.run('node server.js', 60_000);
  // A session has one browser terminal: hand it to the shell under test.
  await t.close();

  const page = await browser.newPage();
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message || String(error)));

  const shell = await page.goto(`${BASE}/s/${sid}/?isolated=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  a.check(
    'the isolated shell is served with COOP same-origin + COEP credentialless',
    shell?.headers()['cross-origin-opener-policy'] === 'same-origin'
      && shell?.headers()['cross-origin-embedder-policy'] === 'credentialless',
    JSON.stringify(shell?.headers()),
  );
  a.check('the shell itself is cross-origin isolated', await page.evaluate(() => self.crossOriginIsolated) === true);
  await waitForSessionTerminalText(page, /user@nimbus:/, 30_000);

  const until = Date.now() + 60_000;
  let pane = null;
  while (Date.now() < until && pane === null) {
    pane = page.frames().find((frame) => onHostPreview(frame.url())) ?? null;
    if (pane === null) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  a.check(
    `the pane frames the app on its host-form origin (${PORT}--${sid}.…)`,
    pane !== null,
    page.frames().map((frame) => frame.url()).join(' | '),
  );
  if (pane !== null) {
    const inPane = await appResult(pane);
    a.check(
      'in the pane: crossOriginIsolated, and SharedArrayBuffer + Worker + Atomics round-trip',
      inPane.coi === true && inPane.sab === 'function' && inPane.value === 42 && !inPane.error,
      JSON.stringify(inPane),
    );

    const opened = browser.waitForTarget((target) => onHostPreview(target.url()) && target.type() === 'page', { timeout: 30_000 });
    await page.click('#btnOpenPreview');
    const ownTab = await (await opened).page();
    const inTab = await appResult(ownTab);
    a.check(
      'in its own tab: crossOriginIsolated, and SharedArrayBuffer + Worker + Atomics round-trip',
      inTab.coi === true && inTab.sab === 'function' && inTab.value === 42 && !inTab.error,
      JSON.stringify(inTab),
    );
    await ownTab.close();
  }
  a.check('no page errors in the shell', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close().catch(() => {});
  await t.close();
  await deleteSession(sid);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
