#!/usr/bin/env bun
// embed/new/react-embed-ready-event — the session shell posts nimbus:ready
// to its embedding parent window, with the shape and origin that
// @nimbus-sh/react's useNimbusSession/<NimbusTerminal> consume
// (ev.origin === endpoint origin, data.type === 'nimbus:ready',
// data.sessionId === the embedded session id). This drives a real parent
// page with an <iframe src="/s/<id>/"> exactly like an embedder does.

import { BASE, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { applyProbeCookies, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('embed/new/react-embed-ready-event');
console.log(`embed/new/react-embed-ready-event — BASE=${BASE}`);

const sid = await mintSession();
const browser = await launchBrowser();
let page = null;

try {
  page = await browser.newPage();
  await applyProbeCookies(page);

  // Parent page on the Nimbus origin so probe auth cookies flow to the
  // iframe. The shell posts with targetOrigin '*', so reception is the
  // same for a cross-origin embedder parent.
  const response = await page.goto(`${BASE}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  a.check('parent page loads', response?.status() === 200, `status=${response?.status()}`);

  await page.evaluate((attachPath) => {
    window.__nimbusMessages = [];
    window.addEventListener('message', (ev) => {
      window.__nimbusMessages.push({
        origin: ev.origin,
        data: (ev.data !== null && typeof ev.data === 'object') ? ev.data : { value: String(ev.data) },
      });
    });
    const frame = document.createElement('iframe');
    frame.src = attachPath;
    frame.style.cssText = 'width:1024px;height:640px;border:0;';
    document.body.appendChild(frame);
  }, `${BASE}/s/${sid}/`);

  // Bounded poll: the shell posts nimbus:ready on its first WebSocket
  // ready message, so this also covers shell boot + WS attach.
  await page.waitForFunction(
    () => (window.__nimbusMessages || []).some((m) => m.data && m.data.type === 'nimbus:ready'),
    { timeout: 90_000, polling: 250 },
  );

  const messages = await page.evaluate(() => window.__nimbusMessages);
  const ready = messages.find((m) => m.data && m.data.type === 'nimbus:ready');
  const expectedOrigin = new URL(BASE).origin;

  a.check('parent receives nimbus:ready from the embedded shell',
    !!ready, JSON.stringify(messages.slice(0, 10)));
  a.check('nimbus:ready event origin matches the Nimbus endpoint origin (React origin gate)',
    ready?.origin === expectedOrigin,
    `origin=${ready?.origin} expected=${expectedOrigin}`);
  a.check('nimbus:ready carries the embedded session id',
    ready?.data?.sessionId === sid,
    `sessionId=${ready?.data?.sessionId} expected=${sid}`);

  const errors = messages.filter((m) => m.data && m.data.type === 'nimbus:error');
  a.check('no nimbus:error posted while the session is healthy',
    errors.length === 0, JSON.stringify(errors));
} finally {
  if (page) await page.close().catch(() => {});
  await browser.close().catch(() => {});
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
