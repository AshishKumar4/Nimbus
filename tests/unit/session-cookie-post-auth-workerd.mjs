// @tier slow — drives a local workerd; the router's fetched answers arrive with
// workerd-immutable headers, and side effects must precede header validation.
// (1) A legacy-cookie write with a full jar must 4xx BEFORE the write commits,
// never 500 after it. (2) An authenticated POST /s/<sid>/ answers through the
// one policy, not around it.
import assert from 'node:assert/strict';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { attachPathFor, deleteSession, mintSession } = await import('../behavioral/_driver.mjs');
try {
  const sid = await mintSession();
  try {
    const exchange = await fetch(`${probe.base}${attachPathFor(sid)}`, { redirect: 'manual' });
    assert.equal(exchange.status, 302);
    const perSid = exchange.headers.getSetCookie().map((v) => v.split(';', 1)[0])
      .find((v) => v.startsWith(`__Host-nimbus_token-${sid}=`));
    assert.ok(perSid);
    // A pre-deploy tab's jar: verified bytes under the legacy name, plus 24
    // small sibling names that fill the jar by count.
    const siblings = Array.from({ length: 24 }, (_, i) => `__Host-nimbus_token-held-${i}=x`).join('; ');
    const jar = `__Host-nimbus_token=${perSid.slice(perSid.indexOf('=') + 1)}; ${siblings}`;
    const write = await fetch(`${probe.base}/s/${sid}/api/write-file`, {
      method: 'POST',
      headers: { Cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'jar-quota-probe.txt', content: 'must never land' }),
    });
    assert.ok(write.status >= 400 && write.status < 500, `quota refusal precedes the committed write (got ${write.status})`);
    assert.match((await write.text()).slice(0, 200), /jar|credential|cookie/i, 'quota refusal names the jar');
    const read = await fetch(`${probe.base}/s/${sid}/api/read-file?path=jar-quota-probe.txt`, {
      headers: { Cookie: jar },
    });
    assert.notEqual(read.status, 200, 'the refused write committed nothing');

    // An authenticated POST to the session root answers through the policy:
    // same envelope as every other authenticated answer (no bypass, no 500).
    const root = await fetch(`${probe.base}/s/${sid}/`, {
      method: 'POST',
      headers: { Cookie: `__Host-nimbus_token-${sid}=${perSid.slice(perSid.indexOf('=') + 1)}` },
    });
    assert.equal(root.status, 405);
    assert.equal(root.headers.get('Allow'), 'GET, HEAD, DELETE');
  } finally {
    await deleteSession(sid);
  }
} finally {
  await probe.stop();
}
console.log('session-cookie-post-auth-workerd: pre-dispatch quota and rooted POST policy passed');
