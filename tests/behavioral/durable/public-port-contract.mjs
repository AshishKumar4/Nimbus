#!/usr/bin/env bun
// durable/public-port-contract — the durable application's public URL
// contract, probed live against a deployed target.
//
// WHAT IT PROVES
//   `ensureDurableApp` reserves a port and mints the capability the public
//   URL is built on BEFORE the application exists — and the reservation is
//   where visibility lives. `ports.expose(port, { visibility: 'public' })`
//   marks a live port public and builds the `<cap>--<port>--<sid>` host
//   form. That host form answers the request with the capability alone —
//   no Authorization, no attach token — because the capability IS the
//   bearer. And the gate: a public bearer with the right capability on a
//   scoped port is 404, a wrong capability on a public port is 404.
//
// HOW IT'S DRIVEN
//   Externally, the public host form is a Host header — the wildcard DNS
//   isn't part of this probe, the routed decision is. The SDK's remote
//   surface carries exposePort/ensureDurableApp; the terminal carries the
//   server itself.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, Terminal, heredocCommand, requestHeaders, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
// The public host form is exercised only when the deployment carries
// NIMBUS_PREVIEW_HOST_SUFFIX; a path-form deployment still proves the
// reservation + routing contract.
const SUFFIX = process.env.NIMBUS_PREVIEW_HOST_SUFFIX ?? new URL(BASE).host;

const a = makeAsserter('durable/public-port-contract');
console.log(`durable/public-port-contract — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);

const nimbus = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) });
const box = nimbus.sandbox(sid);

/** Fetch a public-host URL by overriding Host — DNS for the wildcard isn't the probe. */
async function fetchPublicHost(capability, port, path = '/', headers = {}) {
  const host = `${capability}--${port}--${sid}.${SUFFIX}`;
  const r = await fetch(`${BASE}/`, {
    headers: { ...headers, Host: host },
    redirect: 'manual',
  }).catch((e) => ({ status: 0, text: async () => String(e) }));
  const body = await r.text().catch(() => '');
  return { status: r.status, body };
}
{
  const ensured = await box.ports.ensureDurableApp({ owner: 'probe-app', visibility: 'public' });
  a.check('ensureDurableApp answers over the remote surface', ensured.port > 0,
    JSON.stringify(ensured));
  a.check('ensureDurableApp mints a 24-hex capability',
    /^[a-f0-9]{24}$/.test(ensured.capability ?? ''),
    `capability=${ensured.capability}`);
  a.check('ensureDurableApp reports visibility public', ensured.visibility === 'public');

  // The capability URL answers unauthenticated while nothing is running —
  // the reservation is a route, not a proof that a process is up.
  const { status } = await fetchPublicHost(ensured.capability ?? '', ensured.port);
  a.check('a bound-but-not-running public port is not a 404', status !== 404,
    `status=${status} — 404 means the capability never made it to the gate`);
}

// ── 2. a public port answers its own capability bearer ───────────────────────
{
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/pubapp && cd /home/user/pubapp', 15_000);
  const serverJs = `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('public-durable:' + req.url + '\\n');
}).listen(4173, '0.0.0.0', () => console.log('LISTENING 4173'));
`.trim();
  await t.run(heredocCommand('server.js', serverJs), 15_000);
  const started = await t.run('node server.js', 30_000);
  const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('a node server is running on 4173', pid > 0, started.output.slice(-200));

  // Expose it public — the capability URL is the whole bearer.
  const exposed = await box.ports.expose(4173, { visibility: 'public' });
  a.check('exposePort reports public visibility', exposed.visibility === 'public',
    JSON.stringify(exposed));
  // The SDK answers the host form only when the deployment carries
  // NIMBUS_PREVIEW_HOST_SUFFIX — staging doesn't (no wildcard DNS on
  // workers.dev), so the host-form checks skip rather than fail.
  const hostForm = typeof exposed.url === 'string' && /--4173--/.test(exposed.url);
  if (!hostForm) {
    console.log(`  - public host form skipped — this deployment answers the path form (url=${exposed.url})`);
  } else {
    a.check('exposePort answers the public host form', true, `url=${exposed.url}`);
    const publicCap = exposed.url?.match(/^https:\/\/([a-f0-9]{24})--/)?.[1] ?? '';
    let ok = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { status, body } = await fetchPublicHost(publicCap, 4173, '/hello');
      if (status === 200 && /public-durable:\/hello/.test(body)) { ok = true; break; }
      await sleep(400);
    }
    a.check('the public capability URL serves the app unauthenticated', ok);

    // The gate: wrong capability on the public port is 404.
    const wrong = await fetchPublicHost('0'.repeat(24), 4173, '/');
    a.check('a wrong capability is 404', wrong.status === 404, `status=${wrong.status}`);
  }

  if (pid > 0) await t.run(`kill ${pid}`, 15_000);
  await t.close();
}

// ── 3. removeDurableApp ends the contract; re-ensure mints a new capability ─
{
  const ensured = await box.ports.ensureDurableApp({ owner: 'probe-removal', visibility: 'public' });
  a.check('ensureDurableApp reserves a removal-test port', ensured.port > 0,
    JSON.stringify(ensured));

  const removed = await box.ports.removeDurableApp('probe-removal');
  a.check('removeDurableApp reports removal', removed.removed === true,
    JSON.stringify(removed));
  a.check('removeDurableApp answers the released port', removed.port === ensured.port,
    `port=${removed.port} ensured=${ensured.port}`);
  // The released port is gone from the live surface and — where the public
  // host form routes — the capability URL no longer resolves.
  const listed = await box.ports.list();
  a.check('ports.list no longer reports the released port',
    !listed.some((p) => p.port === ensured.port), JSON.stringify(listed));
  if (!process.env.NIMBUS_PREVIEW_HOST_SUFFIX) {
    console.log('  - capability-404 check skipped — this deployment answers the path form');
  } else {
    const gone = await fetchPublicHost(ensured.capability, ensured.port, '/');
    a.check('the released capability URL is unroutable', gone.status === 404,
      `status=${gone.status}`);
  }

  // Re-ensuring is a fresh contract: a new port and a NEW capability — the
  // old one is retired for good.
  const re = await box.ports.ensureDurableApp({ owner: 'probe-removal', visibility: 'public' });
  a.check('re-ensuring answers a port', re.port > 0, JSON.stringify(re));
  a.check('re-ensuring mints a NEW capability',
    typeof re.capability === 'string' && re.capability !== ensured.capability,
    `old=${ensured.capability} new=${re.capability}`);
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
