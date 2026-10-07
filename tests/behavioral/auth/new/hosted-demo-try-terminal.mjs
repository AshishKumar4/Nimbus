#!/usr/bin/env bun
// auth/new/hosted-demo-try-terminal — a visitor who takes the landing page's
// no-sign-in path gets a working terminal, in a real browser: /try lands on a
// session's shell, `node -e` runs in it and prints its answer, the session's
// attach credential does not stay in the address bar, and the page throws
// nothing. hosted-demo-anon-launch walks the same chain over HTTP; this is
// what a person sees.
//
// Hosted-demo only (/try is the demo's route): _probe-target-skips.mjs skips
// it on the probe target, and release.mjs and promote.mjs run it against the
// demo. The session is anonymous and TTL-bound; it is deleted when the
// demo lets an anonymous visitor delete it, and otherwise left to its TTL.

import { makeAsserter } from '../../_driver.mjs';
import { launchBrowser, sessionTerminalText, waitForSessionTerminalText } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'auth/new/hosted-demo-try-terminal';
const a = makeAsserter(label);
const BASE = process.env.BASE.replace(/\/$/, '');
console.log(`${label} — BASE=${BASE}`);

const browser = await launchBrowser({ timeout: 60_000 });
let sid = null;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const shell = await page.goto(`${BASE}/try`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  a.check('/try answers 200', shell?.status() === 200, `status=${shell?.status()}`);
  sid = new URL(page.url()).pathname.match(/^\/s\/([^/]+)\/$/)?.[1] ?? null;
  a.check('the anonymous launch reaches a session', sid !== null, page.url());
  if (sid) {
    const prompt = await waitForSessionTerminalText(page, /user@nimbus:/, 60_000).then(() => true, () => false);
    a.check('the shell prompts', prompt, (await sessionTerminalText(page)).slice(-300));
    await page.click('#terminal-container .xterm-helper-textarea');
    await page.keyboard.type('node -e "console.log(6*7)"');
    await page.keyboard.press('Enter');
    const answered = await waitForSessionTerminalText(page, /(?:^|\n)42\s*(?:\n|$)/, 60_000).then(() => true, () => false);
    a.check('node -e prints its answer', answered, (await sessionTerminalText(page)).slice(-300));
    a.check('the attach credential left the address bar', !new URL(page.url()).searchParams.has('nimbus_token'), page.url().replace(/nimbus_token=[^&]+/, 'nimbus_token=…'));
    const cleanup = await page.evaluate(async (session) => {
      const response = await fetch(`/s/${encodeURIComponent(session)}/`, { method: 'DELETE', headers: { 'X-Nimbus-Cleanup-Reason': 'probe-exit' } });
      return { status: response.status, json: (response.headers.get('content-type') ?? '').includes('application/json') };
    }, sid);
    a.check('the session is deleted, or left to its TTL as an anonymous one', cleanup.status === 401 || (cleanup.status === 200 && cleanup.json), JSON.stringify(cleanup));
  }
  a.check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
