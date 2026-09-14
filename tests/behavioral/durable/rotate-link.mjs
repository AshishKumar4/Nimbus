#!/usr/bin/env bun
// durable/rotate-link — rotating an application's shared link invalidates
// the old one at once and the new one answers at once.
//
// WHAT IT PROVES
//   `apps.rotateLink(target)` mints a fresh capability on the reservation,
//   rebinds the directory, and re-adopts it into the live registration: the
//   URL handed out before is a 404 from the next request on, the new URL
//   serves the same process (same pid, same boot nonce). The reservation —
//   owner, port, name, visibility — is untouched by the rotation.
//
// HOW IT'S DRIVEN
//   Terminal for the server; SDK remote surface for expose/rotate/list; the
//   public bearer form as a Host header with a suffix, or the capability
//   headers on the path form without one.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, fetchPort, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const SUFFIX = process.env.NIMBUS_PREVIEW_HOST_SUFFIX ?? null;

const a = makeAsserter('durable/rotate-link');
console.log(`durable/rotate-link — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);
const PORT = 4400;

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

let t = null;
try {
  t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/rotapp && cd /home/user/rotapp', 15_000);
  await t.run(heredocCommand('server.js', `
const http = require('http');
const BOOT = process.pid + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('rot-app:' + req.url + '|boot=' + BOOT + '\\n');
}).listen(${PORT}, '0.0.0.0', () => console.log('LISTENING ${PORT}'));
`.trim()), 15_000);
  const started = await t.run('node server.js', 30_000);
  const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('the app is running', pid > 0, started.output.slice(-200));

  const exposed = await box.apps.expose(PORT, { visibility: 'public', name: 'rot' });
  a.check('exposed public with a name', exposed.visibility === 'public' && exposed.name === 'rot', JSON.stringify(exposed));
  const CAP1 = exposed.capability ?? '';
  a.check('a capability was minted', /^[a-f0-9]{24}$/.test(CAP1));
  const first = await pollPublic(CAP1, 'rot-app:', 20_000);
  a.check('the shared link answers', first.ok, `status=${first.last.status} body=${first.last.body?.slice(0, 100)}`);
  const bootBefore = first.last.body?.match(/boot=([^\s|]+)/)?.[1] ?? '';

  const rotated = await box.apps.rotateLink('rot');
  a.check('rotateLink answers a fresh capability', /^[a-f0-9]{24}$/.test(rotated.capability ?? '') && rotated.capability !== CAP1,
    `old=${CAP1} new=${rotated.capability}`);
  a.check('rotateLink keeps owner, name, port and visibility',
    rotated.owner === exposed.owner && rotated.name === 'rot' && rotated.port === PORT && rotated.visibility === 'public',
    JSON.stringify(rotated));
  if (SUFFIX) {
    a.check('rotateLink answers a host URL built on the new capability',
      typeof rotated.url === 'string' && rotated.url.includes(rotated.capability ?? '\u0000'), `url=${rotated.url}`);
  } else {
    a.check('rotation keeps the scoped path URL, which never carries a capability',
      rotated.url === exposed.url && rotated.url === `${BASE}/s/${sid}/app/rot/`
        && !rotated.url.includes(rotated.capability), `url=${rotated.url}`);
  }
  const CAP2 = rotated.capability ?? '';

  const old = await fetchPublic(CAP1, '/');
  a.check('the old link 404s immediately', old.status === 404, `status=${old.status} body=${old.body?.slice(0, 100)}`);
  const fresh = await pollPublic(CAP2, 'rot-app:', 10_000);
  a.check('the new link answers immediately', fresh.ok, `status=${fresh.last.status} body=${fresh.last.body?.slice(0, 100)}`);
  const bootAfter = fresh.last.body?.match(/boot=([^\s|]+)/)?.[1] ?? '';
  a.check('the same process serves the new link', bootAfter !== '' && bootAfter === bootBefore, `before=${bootBefore} after=${bootAfter}`);

  const listed = (await box.apps.list()).find((app) => app.name === 'rot');
  a.check('apps.list reports the rotated capability', listed?.capability === CAP2 && listed?.pid === pid, JSON.stringify(listed));

  await box.apps.remove('rot').catch(() => {});
} finally {
  if (t) await t.close().catch(() => {});
  await deleteSession(sid, 'durable-rotate-link');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
