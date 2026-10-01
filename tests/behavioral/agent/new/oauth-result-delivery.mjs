// agent/new/oauth-result-delivery — the Cloudflare OAuth popup's result
// reaches the agent chat exactly once, in both shell modes.
//
// The callback page tells the chat that started the flow through
// `window.opener` when it has one, else on a BroadcastChannel. In the default
// shell the opener is there, and one result must mean one status read. The
// isolated shell's COOP severs a cross-origin popup, whose `closed` then reads
// true at once: the chat must keep waiting until the callback's result
// arrives, instead of ending the wait while the user is still signing in.
//
// Cloudflare is not contacted. The agent's status is answered as "configured,
// not connected" and the OAuth start with a cross-origin authUrl, which is
// what the chat needs to show Connect and open a popup; the callback page is
// the session's real one (answering an error, as a declined sign-in would).

import { AUTH_TOKEN, BASE, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { applyProbeCookies, exchangeAttachCookie, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'agent/new/oauth-result-delivery';
const a = makeAsserter(label);
console.log(`${label} — BASE=${BASE}`);

const STATUS = {
  ok: true,
  configured: true,
  model: '@cf/probe/model',
  gatewayId: 'default',
  oauth: { configured: true, connected: false, clientId: 'probe', scopes: [], user: null, accounts: [], accountId: null, expiresAt: null },
  ownerToken: { configured: false, accountId: null, disabledByUserOAuthRequired: false },
  connected: false,
  capabilities: [],
};

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true });
const callbackPath = `/s/${sid}/api/agent/oauth/callback?error=access_denied`;

/** A shell page whose agent status and OAuth start are answered here; counts status reads. */
async function openShell(query) {
  const page = await browser.newPage();
  if (AUTH_TOKEN) await exchangeAttachCookie(page, sid);
  else await applyProbeCookies(page);
  const reads = { count: 0 };
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/s/${sid}/api/agent/status`) {
      reads.count++;
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS) });
    } else if (path === `/s/${sid}/api/agent/oauth/start`) {
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, authUrl: 'https://example.com/', expiresAt: Date.now() + 60_000 }) });
    } else {
      await request.continue();
    }
  });
  await page.goto(`${BASE}/s/${sid}/${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#btnAgent', { visible: true, timeout: 30_000 });
  await page.click('#btnAgent');
  await page.waitForSelector('#agentConnect', { visible: true, timeout: 60_000 });
  // The chat's own first reads: let them finish before counting.
  let quietSince = Date.now();
  let last = reads.count;
  while (Date.now() - quietSince < 3_000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (reads.count !== last) { last = reads.count; quietSince = Date.now(); }
  }
  reads.count = 0;
  return { page, reads };
}

const statusText = (page) => page.$eval('#agentStatus', (element) => element.textContent);

try {
  // ── default shell: the opener carries the result, once ──
  {
    const { page, reads } = await openShell('');
    await page.evaluate((path) => { window.open(path, 'nimbus-agent-oauth', 'width=400,height=300'); }, callbackPath);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    a.check('default shell: one OAuth result, one status read', reads.count === 1, `status reads=${reads.count}`);
    await page.close();
  }

  // ── isolated shell: the wait outlives the severed popup ──
  {
    const { page, reads } = await openShell('?isolated=1');
    a.check('the shell is cross-origin isolated', await page.evaluate(() => self.crossOriginIsolated) === true);
    await page.click('#agentConnect');
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const waiting = await statusText(page);
    a.check('isolated shell: still waiting for Cloudflare after the popup is severed', /Waiting for Cloudflare/.test(waiting), `status=${waiting}`);
    a.check('isolated shell: no result, no status read yet', reads.count === 0, `status reads=${reads.count}`);

    // The popup comes back to the session's callback, with no opener to use.
    const callback = await browser.newPage();
    await callback.goto(`${BASE}${callbackPath}`, { waitUntil: 'load', timeout: 30_000 });
    const deadline = Date.now() + 10_000;
    while (/Waiting for Cloudflare/.test(await statusText(page)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const after = await statusText(page);
    a.check('isolated shell: the callback’s result ends the wait', !/Waiting for Cloudflare/.test(after), `status=${after}`);
    a.check('isolated shell: one OAuth result, one status read', reads.count === 1, `status reads=${reads.count}`);
    await callback.close().catch(() => {});
    await page.close();
  }
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close().catch(() => {});
  await deleteSession(sid);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
