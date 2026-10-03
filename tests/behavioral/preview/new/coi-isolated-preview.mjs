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
// shell, which keeps no COOP/COEP, learns the app's COEP from the session's
// stats and offers the isolated shell. The switch guards unsaved editor
// changes, hands the terminal over and reloads within 10 s; it lands on the
// same tab, and the app then reports crossOriginIsolated and a completed
// round trip from inside the pane. The ↗ button opens it top-level, where its
// own headers isolate it. At a 390 px window the offer and ↗ stay on screen.
//
// Chrome runs with web security on: the rules under test are the browser's.
// NIMBUS_PROBE_SCREENSHOTS=<dir> saves the offer, desktop and 390 px.

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
// Chrome runs without its back/forward cache: a shell-mode switch changes
// browsing context group, the page it leaves can stay frozen in that cache,
// and puppeteer then routed evaluations to the frozen document (measured: 2
// of 5 runs hung with it on, 6 of 6 passed with it off). The shell itself
// gives the terminal back on pagehide either way.
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true, args: ['--disable-features=BackForwardCache'] });

/** The app's own report from inside a frame or page, once it has one. */
async function appResult(target) {
  const handle = await target.waitForFunction(
    () => document.body?.dataset.result,
    { timeout: 30_000 },
  );
  return JSON.parse(await handle.jsonValue());
}

/**
 * The offer's own readiness: the strip is showing `offer` for `tabId`. Every
 * click on the offer waits for this first, so it never lands while the pane
 * shows another tab (a markdown tab hides the strip).
 */
function offerReady(page, tabId, offer) {
  return page.waitForFunction((tabId, offer) => {
    const notice = document.getElementById('previewIsolation');
    return notice.dataset.tab === tabId && notice.dataset.offer === offer && !notice.hidden
      && document.getElementById('btnPreviewIsolationAction').getBoundingClientRect().width > 0;
  }, { timeout: 30_000 }, tabId, offer);
}

/** Save a screenshot for review when NIMBUS_PROBE_SCREENSHOTS names a directory. */
async function screenshot(page, name) {
  const dir = process.env.NIMBUS_PROBE_SCREENSHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
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
  await t.run(heredocCommand('/home/user/notes.js', '// notes'), 15_000);
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
  const shellResponse = await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
      && document.getElementById('btnPreviewIsolationAction')?.getAttribute('aria-label')?.startsWith('Reload isolated:');
  }, { timeout: 60_000 }, PORT);
  a.check('the default shell offers the isolated shell for the app', true);
  const before = await appResult(await paneFrame(page));
  a.check(
    'inside the default shell the pane is not isolated',
    before.coi === false && before.sab === 'undefined',
    JSON.stringify(before),
  );
  await screenshot(page, 'final-desktop-offer-reload-isolated');

  // ── a phone-width window keeps the offer and ↗ on screen, words whole ──
  // The pane is ~80 px wide there: the offer collapses to one button with a
  // one-word label, named in full by its aria-label and tooltip, and no word
  // is broken to fit.
  await page.setViewport({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => {
    const onScreen = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 0.5;
    };
    const action = document.getElementById('btnPreviewIsolationAction');
    const shown = (element) => getComputedStyle(element).display !== 'none';
    const text = document.getElementById('previewIsolationText');
    return {
      open: onScreen(document.getElementById('btnOpenPreview')),
      action: onScreen(action) && action.scrollWidth <= action.clientWidth + 1,
      words: [text, action.querySelector('.preview-isolation-label'), action.querySelector('.preview-isolation-short')]
        .filter(shown).map((element) => element.textContent),
      oneLine: action.getClientRects().length === 1 && action.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(action).fontSize) + 8,
      name: action.getAttribute('aria-label'),
      tooltip: action.title,
    };
  });
  a.check('at 390 px the ↗ button is on screen', narrow.open, JSON.stringify(narrow));
  a.check(
    'at 390 px the offer is one whole button reading "Isolate" on one line, named "Reload isolated" by label and tooltip',
    narrow.action && narrow.oneLine && JSON.stringify(narrow.words) === '["Isolate"]'
      && narrow.name?.startsWith('Reload isolated:') && narrow.tooltip === narrow.name,
    JSON.stringify(narrow),
  );
  await screenshot(page, 'final-mobile-offer-reload-isolated');
  await page.setViewport({ width: 1280, height: 800 });

  // ── unsaved editor changes are not discarded without asking ──
  // The file tree lists notes.js once its listing arrives; click it then, in
  // the same task that finds it: a later listing redraws the tree, and a node
  // found in one task can be detached by the next.
  await page.waitForFunction((name) => {
    const node = [...document.querySelectorAll('.tree-node')].find((candidate) => candidate.querySelector('.tree-label')?.textContent === name);
    node?.click();
    return node !== undefined;
  }, { timeout: 30_000 }, 'notes.js');
  await page.waitForFunction(() => document.getElementById('editorTab')?.textContent?.includes('notes.js'), { timeout: 30_000 });
  await page.click('.monaco-editor .view-lines');
  await page.keyboard.type('// unsaved\n');
  await page.waitForFunction(() => document.getElementById('editorTab')?.classList.contains('dirty'), { timeout: 10_000 });
  await page.evaluate((port) => {
    [...document.querySelectorAll('#previewTabs .preview-tab')].find((tab) => tab.textContent.includes(':' + port))?.click();
  }, PORT);
  await offerReady(page, 'port:' + PORT, 'isolate-shell');
  const declined = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    page.once('dialog', async (dialog) => {
      clearTimeout(timer);
      const message = dialog.message();
      await dialog.dismiss();
      resolve(message);
    });
    page.click('#btnPreviewIsolationAction');
  });
  a.check('the switch asks before discarding unsaved changes', typeof declined === 'string' && declined.includes('notes.js'), `dialog=${declined}`);
  // A switch that went ahead would have taken the terminal socket in the
  // same task the dialog returned to, before this runs.
  a.check(
    'declining keeps the default shell, its terminal and the edit',
    new URL(page.url()).searchParams.get('isolated') === null
      && await page.evaluate(() => document.getElementById('editorTab')?.classList.contains('dirty')
        && typeof ws !== 'undefined' && ws?.readyState === WebSocket.OPEN),
    page.url(),
  );

  // ── the isolated shell, within 10 s ──
  await offerReady(page, 'port:' + PORT, 'isolate-shell');
  page.once('dialog', (dialog) => { void dialog.accept(); });
  const switchStarted = Date.now();
  const [isolatedResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 }),
    page.click('#btnPreviewIsolationAction'),
  ]);
  const switchMs = Date.now() - switchStarted;
  a.check(`the switch reloads within 10 s (${switchMs} ms)`, switchMs < 10_000);
  a.check(
    'the isolated shell is served with COOP same-origin + COEP credentialless',
    isolatedResponse?.headers()['cross-origin-opener-policy'] === 'same-origin'
      && isolatedResponse?.headers()['cross-origin-embedder-policy'] === 'credentialless'
      && new URL(page.url()).searchParams.get('isolated') === '1',
    `${page.url()} ${JSON.stringify(isolatedResponse?.headers())}`,
  );
  a.check('the shell itself is cross-origin isolated', await page.evaluate(() => self.crossOriginIsolated) === true);
  await waitForSessionTerminalText(page, /user@nimbus:/, 15_000);
  a.check('the terminal reattaches under COEP credentialless (CDN scripts load)', true);
  await page.waitForFunction((port) => {
    const active = document.querySelector('#previewTabs .preview-tab.active');
    return active?.textContent?.includes(':' + port);
  }, { timeout: 30_000 }, PORT);
  a.check('the reload lands on the tab it was made for', true);
  const inPane = await appResult(await paneFrame(page));
  a.check(
    'in the pane: crossOriginIsolated, and SharedArrayBuffer + Worker + Atomics round-trip',
    inPane.coi === true && inPane.sab === 'function' && inPane.value === 42 && !inPane.error,
    JSON.stringify(inPane),
  );
  await page.waitForFunction((port) => document.getElementById('previewIsolation').dataset.tab === 'port:' + port, { timeout: 30_000 }, PORT);
  a.check(
    'no offer is left once the pane shows the app as it asked',
    await page.evaluate(() => document.getElementById('previewIsolation').hidden) === true,
  );
  await screenshot(page, 'final-desktop-isolated-app-in-pane');
  await page.setViewport({ width: 390, height: 844 });
  await screenshot(page, 'final-mobile-isolated-app-in-pane');
  await page.setViewport({ width: 1280, height: 800 });

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
