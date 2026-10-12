// @tier slow — drives a local workerd; the router's fetched answers (ASSETS
// shell HTML, the session DO's upgrade) arrive with workerd-immutable headers.
// A legacy-cookie migration must answer 200/101 with both Set-Cookie values in
// order, and the upgraded socket must still work after the copy.
import assert from 'node:assert/strict';
import { startLocalProbe } from './lib/workerd-probe.mjs';
// NOTE: the driver reads BASE/NIMBUS_PROBE_TOKEN at import time, so it is
// imported dynamically after startLocalProbe sets them (as localTerminal does).

const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { attachPathFor, deleteSession, mintSession } = await import('../behavioral/_driver.mjs');
try {
  void mintSession; void deleteSession;
  const sid = await mintSession();
  try {
    // Attach without following the redirect: capture the legacy global cookie,
    // exactly as a pre-deploy tab's jar holds it.

    const exchange = await fetch(`${probe.base}${attachPathFor(sid)}`, { redirect: 'manual' });
    assert.equal(exchange.status, 302);
    const perSid = exchange.headers.getSetCookie().map((v) => v.split(';', 1)[0])
      .find((v) => v.startsWith(`__Host-nimbus_token-${sid}=`));
    assert.ok(perSid, 'the exchange sets the route-owned cookie name');
    // A pre-deploy tab's jar: the same verified bytes under the legacy name.
    const jar = `__Host-nimbus_token=${perSid.slice(perSid.indexOf('=') + 1)}`;

    // Shell HTML through the real ASSETS fetch must migrate, not 500.
    const shell = await fetch(`${probe.base}/s/${sid}/`, { headers: { Cookie: jar } });
    assert.equal(shell.status, 200, 'legacy migration on fetched shell HTML');
    const set = shell.headers.getSetCookie();
    assert.ok(set[0]?.startsWith('__Host-nimbus_token=;') && /Max-Age=0/.test(set[0]), 'expiry first');
    assert.ok(set[1]?.startsWith(`__Host-nimbus_token-${sid}=`), 'route name second');

    // A real WS upgrade through the real DO fetch must migrate and stay live.
    const wsUrl = `${probe.base.replace(/^http/, 'ws')}/s/${sid}/ws`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: jar } });
    const opened = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade timed out')), 30_000);
      ws.onopen = () => { clearTimeout(timer); resolve(true); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`upgrade failed: ${e?.message ?? e}`)); };
    });
    assert.equal(opened, true);
    // Bidirectional liveness through the terminal protocol: our input
    // comes back as output. The greeting arrives first and is ignored.
    const echoed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('terminal round-trip timed out')), 30_000);
      let seen = '';
      ws.onmessage = (event) => {
        seen += String(event.data);
        if (seen.includes('cookie-migration-probe')) { clearTimeout(timer); resolve(seen); }
      };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`socket error: ${e?.message ?? e}`)); };
      ws.send(JSON.stringify({ type: 'input', data: 'echo cookie-migration-probe\r' }));
    });
    assert.match(echoed, /cookie-migration-probe/);
    ws.close();
  } finally {
    await deleteSession(sid);
  }
} finally {
  await probe.stop();
}
console.log('session-cookie-immutable-workerd: fetched shell and live upgrade migrate in order');
