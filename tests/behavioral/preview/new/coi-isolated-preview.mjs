// @serial — browser probe: launches a real Chrome under the run's shared profile root, which the runner's orphan reaper cannot scope to one probe mid-run
// preview/new/coi-isolated-preview — an app that asks for cross-origin
// isolation gets it, in the preview pane and in a tab of its own.
//
// The app is served the way an Emscripten `-pthread` build is (halo-web):
// every response carries COOP same-origin, COEP require-corp and CORP
// same-origin, and the page runs a SharedArrayBuffer + Worker + Atomics round
// trip (the worker blocks in Atomics.wait until the page signals it).
//
// A nested document is isolated only when every document above it is, so the
// pane cannot give the app isolation inside the default shell. The default
// shell, which keeps no COOP/COEP, notices the app's COEP and offers the
// isolated shell; the reload lands on the same tab, and the app then reports
// crossOriginIsolated and a completed round trip from inside the pane. The
// ↗ button opens it top-level, where its own headers isolate it.
//
// Chrome runs with web security on: the rules under test are the browser's.

import { AUTH_TOKEN, deleteSession, fetchPort, heredocCommand, makeAsserter, mintSession, Terminal } from '../../_driver.mjs';
import {
  applyProbeCookies,
  exchangeAttachCookie,
  launchBrowser,
  waitForSessionTerminalText,
} from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'preview/new/coi-isolated-preview';
const a = makeAsserter(label);
const BASE = process.env.BASE;
console.log(`${label} — BASE=${BASE}`);

const PORT = 3000;
const serverJs = `
const http = require('http');
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const page = \`<!doctype html><meta charset="utf-8"><title>coi-app</title><body>starting<script>
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
}).listen(${PORT}, () => console.log('COI APP ${PORT}'));
`.trim();

const sid = await mintSession();
const t = new Terminal(sid);
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true });

/** The app's own report from inside a frame or page, once it has one. */
async function appResult(target) {
  const handle = await target.waitForFunction(
    () => document.body?.dataset.result,
    { timeout: 30_000 },
  );
  return JSON.parse(await handle.jsonValue());
}

/** The pane's frame once it has navigated to the app. */
async function paneFrame(page) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const frame = page.frames().find((candidate) => candidate.url().includes(`/s/${sid}/port/${PORT}/`));
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the pane never navigated to the app');
}

try {
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/coi-app && cd /home/user/coi-app', 15_000);
  await t.run(heredocCommand('server.js', serverJs), 15_000);
  await t.run('node --watch server.js', 60_000);

  let direct = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    direct = await fetchPort(sid, PORT, '');
    if (direct.status === 200 && direct.body.includes('coi-app')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  a.check('the app answers on its port', direct?.status === 200, `status=${direct?.status}`);
  a.check(
    "the app's own isolation headers reach the browser untouched",
    direct?.headers.get('cross-origin-embedder-policy') === 'require-corp'
      && direct?.headers.get('cross-origin-opener-policy') === 'same-origin'
      && direct?.headers.get('cross-origin-resource-policy') === 'same-origin',
    direct ? JSON.stringify(Object.fromEntries(direct.headers)) : 'no response',
  );

  // A session has one browser terminal: hand it to the shell under test.
  // The session's DELETE below ends the app with everything else.
  await t.close();
  const page = await browser.newPage();
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message || String(error)));

  // ── the default shell: no policy of its own, and an offer ──
  const shellResponse = await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  a.check(
    'the default shell is served without COOP/COEP',
    shellResponse?.headers()['cross-origin-embedder-policy'] === undefined
      && shellResponse?.headers()['cross-origin-opener-policy'] === undefined,
    JSON.stringify(shellResponse?.headers()),
  );
  await page.waitForFunction((port) => {
    const active = document.querySelector('#previewTabs .preview-tab.active');
    const notice = document.getElementById('previewIsolation');
    return active?.textContent?.includes(':' + port)
      && notice && !notice.hidden
      && document.getElementById('btnPreviewIsolationAction')?.textContent === 'Reload isolated';
  }, { timeout: 60_000 }, PORT);
  a.check('the default shell offers the isolated shell for the app', true);
  const before = await appResult(await paneFrame(page));
  a.check(
    'inside the default shell the pane is not isolated',
    before.coi === false && before.sab === 'undefined',
    JSON.stringify(before),
  );

  // ── the isolated shell ──
  const [isolatedResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90_000 }),
    page.click('#btnPreviewIsolationAction'),
  ]);
  a.check(
    'the isolated shell is served with COOP same-origin + COEP credentialless',
    isolatedResponse?.headers()['cross-origin-opener-policy'] === 'same-origin'
      && isolatedResponse?.headers()['cross-origin-embedder-policy'] === 'credentialless'
      && new URL(page.url()).searchParams.get('isolated') === '1',
    `${page.url()} ${JSON.stringify(isolatedResponse?.headers())}`,
  );
  a.check('the shell itself is cross-origin isolated', await page.evaluate(() => self.crossOriginIsolated) === true);
  await waitForSessionTerminalText(page, /user@nimbus:/, 60_000);
  a.check('the terminal still renders under COEP credentialless (CDN scripts load)', true);
  await page.waitForFunction((port) => {
    const active = document.querySelector('#previewTabs .preview-tab.active');
    return active?.textContent?.includes(':' + port);
  }, { timeout: 60_000 }, PORT);
  a.check('the reload lands on the tab it was made for', true);
  const inPane = await appResult(await paneFrame(page));
  a.check(
    'in the pane: crossOriginIsolated, and SharedArrayBuffer + Worker + Atomics round-trip',
    inPane.coi === true && inPane.sab === 'function' && inPane.value === 42 && !inPane.error,
    JSON.stringify(inPane),
  );
  a.check(
    'no offer is left once the pane shows the app as it asked',
    await page.evaluate(() => document.getElementById('previewIsolation').hidden) === true,
  );

  // ── the app's own tab ──
  const opened = browser.waitForTarget((target) => target.url().includes(`/s/${sid}/port/${PORT}/`) && target.type() === 'page', { timeout: 30_000 });
  await page.click('#btnOpenPreview');
  const ownTab = await (await opened).page();
  const inTab = await appResult(ownTab);
  a.check(
    'in its own tab: crossOriginIsolated, and SharedArrayBuffer + Worker + Atomics round-trip',
    inTab.coi === true && inTab.sab === 'function' && inTab.value === 42 && !inTab.error,
    JSON.stringify(inTab),
  );
  await ownTab.close();

  // ── the agent's OAuth result still reaches an isolated shell ──
  // COOP severs the popup's opener, so the callback page's word comes over a
  // BroadcastChannel. The callback answers an error without a signed state,
  // which is enough: the chat refreshes its status on any result.
  await page.click('#btnAgent');
  await page.waitForSelector('.agent-chat', { timeout: 60_000 });
  let statusReads = 0;
  page.on('request', (request) => {
    if (request.url().endsWith(`/s/${sid}/api/agent/status`)) statusReads++;
  });
  await page.evaluate((path) => { window.open(path, 'nimbus-agent-oauth', 'width=400,height=300'); }, `/s/${sid}/api/agent/oauth/callback?error=access_denied`);
  const oauthDeadline = Date.now() + 20_000;
  while (statusReads === 0 && Date.now() < oauthDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  a.check('an OAuth result reaches the agent chat of an isolated shell', statusReads > 0, `status reads=${statusReads}`);

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
