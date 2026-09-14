#!/usr/bin/env bun
// durable/name-host — an application reachable by NAME.
//
// WHAT IT PROVES
//   `apps.expose(port, { name })` stores a DNS-label name on the reservation.
//   The name resolves to the port inside the session: the path door
//   `/s/<sid>/app/<name>/` answers the app on every deployment, and — on a
//   deployment with NIMBUS_PREVIEW_HOST_SUFFIX (wildcard DNS) — the host
//   forms `<name>--<sid>` (scoped) and `<cap>--<name>--<sid>` (public) do
//   too, while a capability under a name it was not bound with is 404. A
//   second app cannot take the same name.
//
// HOW IT'S DRIVEN
//   Terminal for the server; SDK remote surface for expose/list; fetches on
//   the path door always, on the host forms only when a suffix is set
//   (workers.dev has no wildcard suffix, so those arms are skipped there,
//   exactly like the existing public-port probes).

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, requestHeaders, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const SUFFIX = process.env.NIMBUS_PREVIEW_HOST_SUFFIX ?? null;

const a = makeAsserter('durable/name-host');
console.log(`durable/name-host — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);
const PORT = 4500;
const NAME = 'shop';

async function fetchApp(name, path = '') {
  const r = await fetch(`${BASE}/s/${sid}/app/${name}/${path}`, { redirect: 'manual', headers: requestHeaders() });
  return { status: r.status, body: await r.text().catch(() => '') };
}
async function fetchHost(host, path = '/') {
  const r = await fetch(`${BASE}${path}`, { headers: { Host: host }, redirect: 'manual' })
    .catch((e) => ({ status: 0, text: async () => String(e) }));
  return { status: r.status, body: await r.text().catch(() => '') };
}
async function poll(probe, needle, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = { status: 0, body: '' };
  while (Date.now() < deadline) {
    last = await probe();
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
  await t.run('mkdir -p /home/user/nameapp && cd /home/user/nameapp', 15_000);
  await t.run(heredocCommand('server.js', `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('name-app:' + req.url + '\\n');
}).listen(${PORT}, '0.0.0.0', () => console.log('LISTENING ${PORT}'));
`.trim()), 15_000);
  await t.run(heredocCommand('second.js', `
const http = require('http');
http.createServer((req, res) => { res.writeHead(200); res.end('second\\n'); }).listen(${PORT + 1}, '0.0.0.0', () => console.log('LISTENING'));
`.trim()), 15_000);
  const started = await t.run('node server.js', 30_000);
  const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('the app is running', pid > 0, started.output.slice(-200));

  // ── 1. the name door, unauthenticated by capability: 404 until named ──
  const unnamed = await fetchApp(NAME);
  a.check('an unknown name is 404', unnamed.status === 404, `status=${unnamed.status}`);

  const exposed = await box.apps.expose(PORT, { name: NAME });
  a.check('apps.expose stores the name', exposed.name === NAME && exposed.port === PORT, JSON.stringify(exposed));
  a.check('a scoped named exposure has a URL', typeof exposed.url === 'string', `url=${exposed.url}`);
  a.check('the URL names the app', typeof exposed.url === 'string' && (exposed.url.includes(`/app/${NAME}/`) || exposed.url.includes(`${NAME}--${sid}`)),
    `url=${exposed.url}`);

  const viaDoor = await poll(() => fetchApp(NAME, 'hello'), 'name-app:/hello', 20_000);
  a.check('the path door /s/<sid>/app/<name>/ answers the app', viaDoor.ok, `status=${viaDoor.last.status} body=${viaDoor.last.body?.slice(0, 100)}`);

  const listed = (await box.apps.list()).find((app) => app.name === NAME);
  a.check('apps.list reports the name against the port', listed?.port === PORT && listed?.pid === pid, JSON.stringify(listed));

  // ── 2. names are unique per session ───────────────────────────────────
  const second = await t.run('node second.js', 30_000);
  const secondPid = Number(second.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('a second app is running', secondPid > 0, second.output.slice(-200));
  let clash = null;
  try { await box.apps.expose(PORT + 1, { name: NAME }); } catch (e) { clash = e; }
  a.check('a second app cannot take the same name', clash !== null && /already taken/.test(String(clash?.message ?? clash)),
    String(clash?.message ?? clash));
  let badName = null;
  try { await box.apps.expose(PORT + 1, { name: '8080' }); } catch (e) { badName = e; }
  a.check('a numeric name is refused', badName !== null && /not a valid app name/.test(String(badName?.message ?? badName)),
    String(badName?.message ?? badName));

  // ── 3. the host forms — only where wildcard DNS exists ────────────────
  if (!SUFFIX) {
    console.log('  - host-form arms skipped — NIMBUS_PREVIEW_HOST_SUFFIX is not set for this deployment');
  } else {
    const scopedHost = `${NAME}--${sid}.${SUFFIX}`;
    const scoped = await fetchHost(scopedHost, '/');
    a.check('the scoped name host demands session attach (no credential → 401)', scoped.status === 401 || scoped.status === 302,
      `status=${scoped.status}`);
    const pub = await box.apps.expose(NAME, { visibility: 'public' });
    const CAP = pub.capability ?? '';
    a.check('going public mints a capability', /^[a-f0-9]{24}$/.test(CAP), JSON.stringify(pub));
    a.check('the public URL is the name host form', pub.url === `https://${CAP}--${NAME}--${sid}.${SUFFIX}/`, `url=${pub.url}`);
    const publicHost = await poll(() => fetchHost(`${CAP}--${NAME}--${sid}.${SUFFIX}`, '/pub'), 'name-app:/pub', 20_000);
    a.check('the public name host serves the app unauthenticated', publicHost.ok,
      `status=${publicHost.last.status} body=${publicHost.last.body?.slice(0, 100)}`);
    const wrongName = await fetchHost(`${CAP}--web--${sid}.${SUFFIX}`, '/');
    a.check('the capability under a name it was not bound with is 404', wrongName.status === 404, `status=${wrongName.status}`);
    const portForm = await poll(() => fetchHost(`${CAP}--${PORT}--${sid}.${SUFFIX}`, '/port'), 'name-app:/port', 10_000);
    a.check('the port form of the same capability still works', portForm.ok, `status=${portForm.last.status}`);
  }

  await box.apps.remove(NAME).catch(() => {});
} finally {
  if (t) await t.close().catch(() => {});
  await deleteSession(sid, 'durable-name-host');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
