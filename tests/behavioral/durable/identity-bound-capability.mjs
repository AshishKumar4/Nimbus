#!/usr/bin/env bun
// durable/identity-bound-capability — a shared link belongs to an identity,
// not to a port.
//
// WHAT IT PROVES
//   `apps.expose(port, { visibility: 'public' })` reserves the port LAZILY
//   for the serving process's derived identity and mints the capability its
//   shared URL is built on. When the app stops and an UNRELATED server binds
//   the same port, that server does not inherit the link: the capability is
//   retired, the shared URL 404s. The original identity — the same
//   `node server.js` from the same directory — is re-exposable afterwards
//   and gets a fresh link that answers.
//
// HOW IT'S DRIVEN
//   Terminal for the servers; the SDK's remote surface for expose/list; the
//   public host form is a Host header when the deployment carries
//   NIMBUS_PREVIEW_HOST_SUFFIX, and the capability-authenticated path form
//   `/s/<sid>/port/<n>/` with the capability header otherwise — both reach
//   the same session gate.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, fetchPort, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const SUFFIX = process.env.NIMBUS_PREVIEW_HOST_SUFFIX ?? null;

const a = makeAsserter('durable/identity-bound-capability');
console.log(`durable/identity-bound-capability — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);
const PORT = 4300;

/** The public bearer request: host form with a suffix, path form + bearer headers without. */
async function fetchPublic(capability, path = '/') {
  if (SUFFIX) {
    const r = await fetch(`${BASE}/`, { headers: { Host: `${capability}--${PORT}--${sid}.${SUFFIX}` }, redirect: 'manual' })
      .catch((e) => ({ status: 0, text: async () => String(e) }));
    return { status: r.status, body: await r.text().catch(() => '') };
  }
  return fetchPort(sid, PORT, path.replace(/^\//, ''), {
    headers: { 'x-nimbus-preview-capability': capability, 'x-nimbus-public-bearer': '1' },
  });
}

async function pollPublic(capability, needle, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = { status: 0, body: '' };
  while (Date.now() < deadline) {
    last = await fetchPublic(capability, '/');
    if (last.status === 200 && last.body.includes(needle)) return { ok: true, last };
    await sleep(400);
  }
  return { ok: false, last };
}

const serverJs = (tag) => `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('${tag}:' + req.url + '\\n');
}).listen(${PORT}, '0.0.0.0', () => console.log('LISTENING ${PORT} ${tag}'));
`.trim();

let t = null;
try {
  t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/boundapp && cd /home/user/boundapp', 15_000);
  await t.run(heredocCommand('server.js', serverJs('the-app')), 15_000);
  await t.run(heredocCommand('other.js', serverJs('unrelated')), 15_000);

  // ── 1. the app, exposed public: a lazy reservation under its identity ──
  const started = await t.run('node server.js', 30_000);
  const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('the app is running', pid > 0, started.output.slice(-200));
  const warm = await (async () => {
    const deadline = Date.now() + 20_000;
    let last;
    while (Date.now() < deadline) {
      last = await fetchPort(sid, PORT, '');
      if (last.status === 200 && last.body.includes('the-app:')) return true;
      await sleep(400);
    }
    return false;
  })();
  a.check('the app answers its scoped URL', warm);

  const before = await box.apps.list();
  a.check('nothing is reserved before expose', !before.some((app) => app.port === PORT && app.capability !== null),
    JSON.stringify(before));

  const listedPort = (await box.ports.list()).find((entry) => entry.port === PORT);
  const exposed = await box.apps.expose(PORT, { visibility: 'public', name: 'bound-app' });
  a.check('listPorts then expose adopts the unowned exposure without changing its capability',
    listedPort?.capability === exposed.capability, JSON.stringify({ listed: listedPort?.capability, exposed: exposed.capability }));
  a.check('apps.expose answers the derived owner', /^auto:[a-f0-9]{24}$/.test(exposed.owner), JSON.stringify(exposed));
  a.check('apps.expose mints a 24-hex capability', /^[a-f0-9]{24}$/.test(exposed.capability ?? ''), JSON.stringify(exposed));
  a.check('apps.expose reports public', exposed.visibility === 'public');
  a.check('apps.expose reports the serving pid', exposed.pid === pid, `pid=${exposed.pid} expected ${pid}`);
  const OWNER = exposed.owner;
  const CAP1 = exposed.capability ?? '';

  const publicWarm = await pollPublic(CAP1, 'the-app:', 20_000);
  a.check('the shared link answers the app', publicWarm.ok, `status=${publicWarm.last.status} body=${publicWarm.last.body?.slice(0, 100)}`);

  // ── 2. stop the app; an unrelated server takes the port ───────────────
  await t.run(`kill ${pid}`, 15_000);
  const other = await t.run('node other.js', 30_000);
  const otherPid = Number(other.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('an unrelated server is running on the same port', otherPid > 0 && otherPid !== pid, other.output.slice(-200));
  {
    const deadline = Date.now() + 20_000;
    let ok = false, last;
    while (Date.now() < deadline) {
      last = await fetchPort(sid, PORT, '');
      if (last.status === 200 && last.body.includes('unrelated:')) { ok = true; break; }
      await sleep(400);
    }
    a.check('the unrelated server answers the scoped URL', ok, `status=${last?.status} body=${last?.body?.slice(0, 100)}`);
  }
  const hijacked = await fetchPublic(CAP1, '/');
  a.check('the shared link 404s for the unrelated server', hijacked.status === 404,
    `status=${hijacked.status} body=${hijacked.body?.slice(0, 100)}`);
  const during = await box.apps.list();
  const held = during.find((app) => app.owner === OWNER);
  a.check('the reservation stays with the original identity', held !== undefined && held.port === PORT, JSON.stringify(during));
  a.check('the original identity is stopped, its capability retired', held?.status === 'stopped' && held?.capability === null, JSON.stringify(held));
  const unrelated = during.find((app) => app.pid === otherPid);
  a.check('the unrelated server keeps its own identity', unrelated !== undefined && unrelated.owner !== OWNER, JSON.stringify(unrelated));
  let conflict = null;
  try { await box.apps.expose(PORT, { visibility: 'public' }); } catch (e) { conflict = e; }
  a.check('the unrelated server cannot expose over the identity\'s reservation',
    conflict !== null && /held by another owner|already holds/.test(String(conflict?.message ?? conflict)),
    String(conflict?.message ?? conflict));

  for (const target of [{ name: 'bound-app' }, { owner: OWNER }]) {
    for (const [verb, act] of [
      ['expose', () => box.apps.expose(target, { visibility: 'public' })],
      ['rotate', () => box.apps.rotateLink(target)],
    ]) {
      let refused = null;
      try { await act(); } catch (error) { refused = error; }
      a.check(`${verb} ${JSON.stringify(target)} refuses the foreign listener`,
        String(refused?.message ?? refused).includes(`port ${PORT} is served by a different process (owner ${unrelated?.owner})`),
        String(refused?.message ?? refused));
      const after = (await box.apps.list()).find((app) => app.owner === OWNER);
      a.check('refusal never mints a capability onto the foreign listener', after?.capability === null, JSON.stringify(after));
      const stillDead = await fetchPublic(CAP1);
      a.check('the original shared link stays dead after refusal', stillDead.status === 404, `status=${stillDead.status}`);
    }
  }

  // ── 3. the original identity is re-exposable ──────────────────────────
  await t.run(`kill ${otherPid}`, 15_000);
  const again = await t.run('node server.js', 30_000);
  const againPid = Number(again.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('the app is running again', againPid > 0, again.output.slice(-200));
  const reExposed = await box.apps.expose({ owner: OWNER }, { visibility: 'public' });
  a.check('re-expose answers the same identity', reExposed.owner === OWNER, JSON.stringify(reExposed));
  a.check('re-expose mints a fresh capability', /^[a-f0-9]{24}$/.test(reExposed.capability ?? '') && reExposed.capability !== CAP1,
    `old=${CAP1} new=${reExposed.capability}`);
  const CAP2 = reExposed.capability ?? '';
  const publicAgain = await pollPublic(CAP2, 'the-app:', 20_000);
  a.check('the new shared link answers the app', publicAgain.ok, `status=${publicAgain.last.status} body=${publicAgain.last.body?.slice(0, 100)}`);
  const stale = await fetchPublic(CAP1, '/');
  a.check('the retired link stays dead', stale.status === 404, `status=${stale.status}`);

  await box.apps.remove({ owner: OWNER }).catch(() => {});
} finally {
  if (t) await t.close().catch(() => {});
  await deleteSession(sid, 'durable-identity-bound-capability');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
