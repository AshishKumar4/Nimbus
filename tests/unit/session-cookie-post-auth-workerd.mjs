// @tier slow — drives a local workerd; the router's fetched answers arrive with
// workerd-immutable headers, and header validation must precede side effects.
// (1) A legacy-cookie write with a full jar must 4xx BEFORE the write commits,
// never 500 after it. (2) An authenticated POST /s/<sid>/ answers through the
// one policy, not around it.
import assert from 'node:assert/strict';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { attachPathFor, deleteSession, mintSession } = await import('../behavioral/_driver.mjs');
try {
  const sid = await mintSession();
  try {
    // Observe the same filesystem independently of the denied cookie jar.
    const box = Nimbus.connect({ endpoint: probe.base, token: probe.token }).sandbox(sid);
    const deniedPath = '/home/user/jar-quota-probe.txt';
    assert.equal(await box.files.stat(deniedPath), null, 'the denied-write target starts absent');
    const exchange = await fetch(`${probe.base}${attachPathFor(sid)}`, { redirect: 'manual' });
    assert.equal(exchange.status, 302);
    const perSid = exchange.headers.getSetCookie().map((v) => v.split(';', 1)[0])
      .find((v) => v.startsWith(`__Host-nimbus_token-${sid}=`));
    assert.ok(perSid);
    // A pre-deploy tab's jar: verified bytes under the legacy name, plus 24
    // small sibling names that fill the jar by count.
    const siblings = Array.from({ length: 24 }, (_, i) => `__Host-nimbus_token-held-${i}=x`).join('; ');
    const legacy = `__Host-nimbus_token=${perSid.slice(perSid.indexOf('=') + 1)}`;
    const jar = `${legacy}; ${siblings}`;
    const write = await fetch(`${probe.base}/s/${sid}/api/write-file`, {
      method: 'POST',
      headers: { Cookie: jar, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: deniedPath, content: 'must never land' }),
    });
    assert.ok(write.status >= 400 && write.status < 500, `quota refusal precedes the committed write (got ${write.status})`);
    assert.match((await write.text()).slice(0, 200), /jar|credential|cookie/i, 'quota refusal names the jar');
    assert.equal(await box.files.stat(deniedPath), null, 'the refused write committed nothing');
    // Positive control: these credentials can write and stat that exact path.
    const allowedContent = 'unblocked SDK write';
    await box.files.write(deniedPath, allowedContent);
    assert.equal((await box.files.stat(deniedPath))?.size, allowedContent.length,
      'the independent observer sees an authorized write');

    // An authenticated POST to the session root answers through the policy:
    // same envelope as every other authenticated answer (no bypass, no 500).
    const root = await fetch(`${probe.base}/s/${sid}/`, {
      method: 'POST',
      headers: { Cookie: perSid },
    });
    assert.equal(root.status, 405);
    assert.equal(root.headers.get('Allow'), 'GET, HEAD, DELETE');
    assert.deepEqual(root.headers.getSetCookie(), [], 'a route-owned cookie needs no migration');

    const legacyRoot = await fetch(`${probe.base}/s/${sid}/`, {
      method: 'POST',
      headers: { Cookie: legacy },
    });
    assert.equal(legacyRoot.status, 405, 'a legacy-authenticated root POST is still method-refused');
    assert.equal(legacyRoot.headers.get('Allow'), 'GET, HEAD, DELETE');
    const migration = legacyRoot.headers.getSetCookie();
    assert.equal(migration.length, 2, 'the 405 participates in the authenticated response policy');
    assert.ok(migration[0].startsWith('__Host-nimbus_token=;') && /Max-Age=0(?:;|$)/.test(migration[0]),
      'legacy expiry precedes replacement issuance on the 405');
    assert.ok(migration[1].split(';', 1)[0] === perSid,
      'the 405 reissues the verified credential under its route-owned name');
  } finally {
    await deleteSession(sid);
  }
} finally {
  await probe.stop();
}
console.log('session-cookie-post-auth-workerd: pre-dispatch quota and rooted POST policy passed');
