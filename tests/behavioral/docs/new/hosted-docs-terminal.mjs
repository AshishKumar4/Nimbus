#!/usr/bin/env bun
// docs/new/hosted-docs-terminal — the docs' live terminal gets a session from
// the demo it is served by. The docs are built once and served by every
// hosted demo (staging and production get the same bytes), so the terminal's
// endpoint is the path /api/demo/anon-session, resolved against the page: on
// each origin the terminal must reach that origin's endpoint, attach to a
// session there, and go live.
//
// Hosted-demo only (the probe target serves no docs): _probe-target-skips.mjs
// skips it there, and release.mjs and promote.mjs run it against the demo.

import { makeAsserter } from '../../_driver.mjs';
import { launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'docs/new/hosted-docs-terminal';
const a = makeAsserter(label);
const BASE = process.env.BASE.replace(/\/$/, '');
const origin = new URL(BASE).origin;
console.log(`${label} — BASE=${BASE}`);

const browser = await launchBrowser({ timeout: 60_000 });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const attaches = [];
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/demo/anon-session') {
      attaches.push({ url: response.url(), status: response.status() });
    }
  });
  const sockets = [];
  page.on('request', (request) => { if (/^wss?:/.test(request.url())) sockets.push(request.url()); });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => sockets.push(url));

  const docs = await page.goto(`${BASE}/docs/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  a.check('the docs answer 200', docs?.status() === 200, `status=${docs?.status()}`);
  const sandbox = await page.waitForSelector('[data-nimbus-sandbox]', { timeout: 30_000 }).catch(() => null);
  a.check('the docs carry the live terminal', sandbox !== null, 'no [data-nimbus-sandbox] on /docs/');
  if (sandbox) {
    const attachUrl = await sandbox.evaluate((el) => el.getAttribute('data-attach-url'));
    a.check('its endpoint is a path on the page\'s own origin', attachUrl === '/api/demo/anon-session', `data-attach-url=${attachUrl}`);
    // It connects when it scrolls into view.
    await sandbox.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const state = await page.waitForFunction(
      () => {
        const badge = document.querySelector('[data-nimbus-sandbox] [data-role="badge"]');
        return ['running', 'live', 'error', 'ended'].includes(badge?.dataset.state ?? '') ? badge.dataset.state : false;
      },
      { timeout: 90_000, polling: 250 },
    ).then((handle) => handle.jsonValue()).catch(() => 'never settled');
    a.check('the terminal goes live', state === 'running' || state === 'live', `state=${state}`);
    a.check('it asked this origin\'s endpoint for its session', attaches.length > 0 && attaches.every((attach) => new URL(attach.url).origin === origin && attach.status === 200),
      JSON.stringify(attaches));
    const ws = sockets.find((url) => new URL(url).pathname.startsWith('/s/'));
    a.check('it attached to a session on this origin', ws !== undefined && new URL(ws).host === new URL(origin).host, `sockets=${JSON.stringify(sockets.map((url) => url.replace(/\?.*$/, '?…')))}`);
  }
  a.check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
