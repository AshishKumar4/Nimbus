// session-lifecycle/new/shell-bfcache-restore — a shell restored from the
// back/forward cache has a working terminal.
//
// The shell gives the session's one terminal back when the page goes away
// (pagehide closes its socket), so the page that replaces it can take the
// terminal. When the user comes back, Chrome restores the old page from its
// back/forward cache without reloading it, and the shell must dial again
// (pageshow with `persisted`). Chrome runs with that cache on, as users have
// it: let the shell finish loading, navigate away, go back, and the same
// page's terminal runs a command.

import { AUTH_TOKEN, BASE, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import {
  applyProbeCookies,
  exchangeAttachCookie,
  launchBrowser,
  waitForSessionTerminalText,
} from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'session-lifecycle/new/shell-bfcache-restore';
const a = makeAsserter(label);
console.log(`${label} — BASE=${BASE}`);

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
try {
  const page = await browser.newPage();
  // Every request the shell has open, from its first: what was still
  // arriving when the user left, for a page Chrome would not keep.
  const open = new Map();
  page.on('request', (request) => open.set(request, `${request.resourceType()} ${request.url().replace(/[?#].*$/, '')}`));
  page.on('requestfinished', (request) => open.delete(request));
  page.on('requestfailed', (request) => open.delete(request));
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForSessionTerminalText(page, /user@nimbus:/, 30_000);
  // The user leaves a page that has loaded: the prompt can paint before the
  // document's own load (under load it did, 26 of 80 runs with 8 Chromes to a
  // container), and Chrome evicts a page whose responses keep arriving after
  // it is cached (NetworkExceedsBufferLimit). The marks below also need the
  // document's first pageshow behind them.
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60_000 });
  // A mark only this document carries: a reload would lose it.
  await page.evaluate(() => {
    window.__probeDocument = true;
    window.__probeRestored = null;
    addEventListener('pageshow', (event) => { window.__probeRestored = event.persisted; });
  });

  // Why Chrome did not restore the page, when it does not: its own
  // explanation (DevTools' backForwardCacheNotUsed), so a failure names its
  // cause, the page's or the browser's (memory pressure, a cache limit).
  const cdp = await page.createCDPSession();
  await cdp.send('Page.enable');
  let notUsed = null;
  cdp.on('Page.backForwardCacheNotUsed', (event) => {
    notUsed = (event.notRestoredExplanations ?? []).map((explanation) => `${explanation.type}:${explanation.reason}`);
  });

  const leftWithOpen = [...open.values()];
  await page.goto('https://example.com/', { waitUntil: 'load', timeout: 30_000 });
  await page.goBack({ waitUntil: 'load', timeout: 10_000 });
  const restored = await page.evaluate(() => {
    const reasons = performance.getEntriesByType('navigation')[0]?.notRestoredReasons ?? null;
    return { same: window.__probeDocument === true, persisted: window.__probeRestored, notRestoredReasons: reasons && JSON.parse(JSON.stringify(reasons)) };
  });
  a.check('going back restores the same shell page from the back/forward cache', restored.same && restored.persisted === true,
    JSON.stringify({ ...restored, chromeSays: notUsed, openWhenLeft: leftWithOpen }));

  await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN, { timeout: 10_000 });
  await page.evaluate(() => { ws.send(JSON.stringify({ type: 'input', data: 'echo restored-$((6*7))\r' })); });
  await waitForSessionTerminalText(page, /restored-42/, 10_000);
  a.check('the restored shell’s terminal runs a command', true);
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close().catch(() => {});
  await deleteSession(sid);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
