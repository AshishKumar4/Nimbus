// @serial — browser probe: launches a real Chrome under the run's shared profile root, which the runner's orphan reaper cannot scope to one probe mid-run
// preview/new/coi-default-shell-third-party-frame — an app that does not ask
// for cross-origin isolation previews exactly as it always has.
//
// The app embeds a third-party iframe (https://example.com/, which sends no
// COEP and no CORP — the shape of a YouTube or Stripe embed). An embedder
// policy anywhere above that frame would block it, so the default shell must
// carry none, nothing may be added to the app's own response, and the pane
// offers nothing. The isolated shell is the counter-check: it blocks the same
// app (it does not ask for isolation), says why, and its "Reload normally"
// brings the default shell back with the app showing again.
//
// Chrome runs with web security on: the rules under test are the browser's.
// NIMBUS_PROBE_SCREENSHOTS=<dir> saves the isolated shell's offer, desktop and 390 px.

import { AUTH_TOKEN, deleteSession, fetchPort, heredocCommand, makeAsserter, mintSession, Terminal } from '../../_driver.mjs';
import { applyProbeCookies, exchangeAttachCookie, launchBrowser, waitForSessionTerminalText } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'preview/new/coi-default-shell-third-party-frame';
const a = makeAsserter(label);
const BASE = process.env.BASE;
console.log(`${label} — BASE=${BASE}`);

const PORT = 3001;
const THIRD_PARTY = 'https://example.com/';
const serverJs = `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'app_session=kept; Path=/; SameSite=Lax' });
  res.end('<!doctype html><title>plain-app</title><body><p id="app">PLAIN-APP</p><iframe id="embed" src="${THIRD_PARTY}"></iframe></body>');
}).listen(${PORT}, () => console.log('PLAIN APP ${PORT}'));
`.trim();

const sid = await mintSession();
const t = new Terminal(sid);
// Chrome runs without its back/forward cache: a shell-mode switch changes
// browsing context group, the page it leaves can stay frozen in that cache,
// and puppeteer then routed evaluations to the frozen document (measured: 2
// of 5 runs hung with it on, 6 of 6 passed with it off). The shell itself
// gives the terminal back on pagehide either way.
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true, args: ['--disable-features=BackForwardCache'] });

/** Save a screenshot for review when NIMBUS_PROBE_SCREENSHOTS names a directory. */
async function screenshot(page, name) {
  const dir = process.env.NIMBUS_PROBE_SCREENSHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function showsApp(page) {
  try {
    await page.waitForFunction((port) => {
      const active = document.querySelector('#previewTabs .preview-tab.active');
      const frame = document.getElementById('preview-frame');
      return active?.textContent?.includes(':' + port)
        && frame?.contentDocument?.getElementById('app')?.textContent === 'PLAIN-APP';
    }, { timeout: 30_000, polling: 250 }, PORT);
  } catch (error) {
    const pane = await page.evaluate(() => {
      const frame = document.getElementById('preview-frame');
      return JSON.stringify({
        url: location.href,
        active: document.querySelector('#previewTabs .preview-tab.active')?.textContent,
        src: frame.getAttribute('src'),
        shown: frame.contentDocument?.body?.innerText?.slice(0, 120) ?? null,
      });
    }).catch((reason) => `unreadable: ${reason.message}`);
    throw new Error(`the pane never showed the app: ${pane}`, { cause: error });
  }
}

try {
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/plain-app && cd /home/user/plain-app', 15_000);
  await t.run(heredocCommand('server.js', serverJs), 15_000);
  await t.run('node --watch server.js', 60_000);

  let direct = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    direct = await fetchPort(sid, PORT, '');
    if (direct.status === 200 && direct.body.includes('PLAIN-APP')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  a.check('the app answers on its port', direct?.status === 200, `status=${direct?.status}`);
  a.check(
    'no isolation policy is added to the app’s response',
    ['cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy']
      .every((name) => direct?.headers.get(name) === null),
    direct ? JSON.stringify(Object.fromEntries(direct.headers)) : 'no response',
  );
  a.check('the app’s own cookie is passed through', direct?.headers.get('set-cookie')?.startsWith('app_session=kept') === true);

  // A session has one browser terminal: hand it to the shell under test.
  // The session's DELETE below ends the app with everything else.
  await t.close();
  const page = await browser.newPage();
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);

  // ── default shell ──
  const shellResponse = await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  a.check(
    'the default shell sends no COEP and no COOP',
    shellResponse?.headers()['cross-origin-embedder-policy'] === undefined
      && shellResponse?.headers()['cross-origin-opener-policy'] === undefined,
    JSON.stringify(shellResponse?.headers()),
  );
  await showsApp(page);
  a.check('the pane shows the app', true);
  const embed = await (async () => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const frame = page.frames().find((candidate) => candidate.url() === THIRD_PARTY);
      if (frame && await frame.evaluate(() => document.title).catch(() => '') === 'Example Domain') return frame;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  })();
  a.check('the app’s third-party iframe loads inside the pane', embed !== null);
  a.check(
    'the app’s cookie is readable inside the pane',
    await page.evaluate(() => document.getElementById('preview-frame').contentDocument.cookie.includes('app_session=kept')),
  );
  // The offer is decided asynchronously, from the policy the session's stats
  // report for the app: wait for the decision on this tab, then require that
  // it offered nothing.
  await page.waitForFunction((port) => document.getElementById('previewIsolation').dataset.tab === 'port:' + port, { timeout: 30_000 }, PORT);
  a.check(
    'no isolation offer for an app that does not ask',
    await page.evaluate(() => {
      const notice = document.getElementById('previewIsolation');
      return notice.dataset.offer === 'none' && notice.hidden;
    }),
  );

  // ── counter-check: the isolated shell blocks it and offers the way back ──
  const isolatedResponse = await page.goto(`${BASE}/s/${sid}/?isolated=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  a.check(
    'the isolated shell carries COEP credentialless',
    isolatedResponse?.headers()['cross-origin-embedder-policy'] === 'credentialless',
    JSON.stringify(isolatedResponse?.headers()),
  );
  await page.waitForFunction((port) => {
    const active = document.querySelector('#previewTabs .preview-tab.active');
    const notice = document.getElementById('previewIsolation');
    const frame = document.getElementById('preview-frame');
    return active?.textContent?.includes(':' + port)
      && frame.getAttribute('src')?.includes('/port/' + port + '/')
      && frame.contentDocument === null
      && notice && !notice.hidden
      && document.getElementById('btnPreviewIsolationAction')?.textContent === 'Reload normally';
  }, { timeout: 60_000 }, PORT);
  a.check('the isolated shell blocks the app and offers the default shell', true);
  await screenshot(page, 'final-desktop-isolated-offer-reload-normally');
  await page.setViewport({ width: 390, height: 844 });
  await screenshot(page, 'final-mobile-isolated-offer-reload-normally');
  await page.setViewport({ width: 1280, height: 800 });
  const switchStarted = Date.now();
  const [defaultAgain] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 }),
    page.click('#btnPreviewIsolationAction'),
  ]);
  const switchMs = Date.now() - switchStarted;
  a.check(`"Reload normally" reloads within 10 s (${switchMs} ms)`, switchMs < 10_000);
  a.check(
    '"Reload normally" returns to the default shell',
    new URL(page.url()).searchParams.get('isolated') === null
      && defaultAgain?.headers()['cross-origin-embedder-policy'] === undefined,
    page.url(),
  );
  await showsApp(page);
  a.check('the app shows in the pane again', true);
  await waitForSessionTerminalText(page, /user@nimbus:/, 15_000);
  a.check('the terminal reattaches after the switch', true);
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close().catch(() => {});
  await t.close();
  await deleteSession(sid);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
