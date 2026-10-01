// session-lifecycle/new/shell-bfcache-restore — a shell restored from the
// back/forward cache has a working terminal.
//
// The shell gives the session's one terminal back when the page goes away
// (pagehide closes its socket), so the page that replaces it can take the
// terminal. When the user comes back, Chrome restores the old page from its
// back/forward cache without reloading it, and the shell must dial again
// (pageshow with `persisted`). Chrome runs with that cache on, as users have
// it: navigate away, go back, and the same page's terminal runs a command.

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
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForSessionTerminalText(page, /user@nimbus:/, 30_000);
  // A mark only this document carries: a reload would lose it.
  await page.evaluate(() => {
    window.__probeDocument = true;
    window.__probeRestored = null;
    addEventListener('pageshow', (event) => { window.__probeRestored = event.persisted; });
  });

  await page.goto('https://example.com/', { waitUntil: 'load', timeout: 30_000 });
  await page.goBack({ waitUntil: 'load', timeout: 10_000 });
  const restored = await page.evaluate(() => ({ same: window.__probeDocument === true, persisted: window.__probeRestored }));
  a.check('going back restores the same shell page from the back/forward cache', restored.same && restored.persisted === true, JSON.stringify(restored));

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
