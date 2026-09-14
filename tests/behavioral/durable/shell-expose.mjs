#!/usr/bin/env bun
// durable/shell-expose — `nimbus expose` from the terminal prints a URL
// that answers, and `nimbus app` sees, rotates and removes it.
//
// WHAT IT PROVES
//   The shell verbs are the session's own app methods, reached from inside
//   the session: `nimbus expose <port> --public --name <n>` prints the app's
//   URL on its first line; the printed URL serves the app; `nimbus app
//   list` shows the same identity the SDK's `apps.list` reports; `nimbus
//   app rotate` prints a new URL and the old one goes dead; `nimbus app
//   remove` ends it. On a deployment without a preview suffix the URL is
//   the path form on the session's origin — which the session learned from
//   the requests that reached it.
//
// HOW IT'S DRIVEN
//   Terminal for everything the user would type; the SDK only to cross-check
//   `apps.list`; plain fetches on the printed URLs with the probe token
//   (a scoped path URL needs the session credential; a public host form does
//   not, and is exercised only when a suffix is set).

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, requestHeaders, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const SUFFIX = process.env.NIMBUS_PREVIEW_HOST_SUFFIX ?? null;

const a = makeAsserter('durable/shell-expose');
console.log(`durable/shell-expose — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);
const PORT = 4700;

/** Fetch a printed URL: a public host form by Host header, a path form with the session credential. */
async function fetchPrinted(url, path = '') {
  const u = new URL(url);
  const base = new URL(BASE);
  if (u.host !== base.host) {
    const r = await fetch(`${BASE}${u.pathname}${path}`, { headers: { Host: u.host }, redirect: 'manual' })
      .catch((e) => ({ status: 0, text: async () => String(e) }));
    return { status: r.status, body: await r.text().catch(() => '') };
  }
  const r = await fetch(`${url}${path}`, { redirect: 'manual', headers: requestHeaders() });
  return { status: r.status, body: await r.text().catch(() => '') };
}
async function poll(url, needle, budgetMs, path = '') {
  const deadline = Date.now() + budgetMs;
  let last = { status: 0, body: '' };
  while (Date.now() < deadline) {
    last = await fetchPrinted(url, path);
    if (last.status === 200 && last.body.includes(needle)) return { ok: true, last };
    await sleep(400);
  }
  return { ok: false, last };
}
const firstUrl = (output) => output.split('\n').map((l) => l.trim()).find((l) => /^https?:\/\//.test(l)) ?? '';

let t = null;
try {
  t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('mkdir -p /home/user/shellapp && cd /home/user/shellapp', 15_000);
  await t.run(heredocCommand('server.js', `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('shell-app:' + req.url + '\\n');
}).listen(${PORT}, '0.0.0.0', () => console.log('LISTENING ${PORT}'));
`.trim()), 15_000);
  const started = await t.run('node server.js', 30_000);
  const pid = Number(started.output.match(/pid=(\d+)/)?.[1] || 0);
  a.check('the app is running', pid > 0, started.output.slice(-200));

  // ── 1. nimbus expose prints a URL that answers ────────────────────────
  const exposed = await t.run(`nimbus expose ${PORT} --public --name shell`, 30_000);
  const url = firstUrl(exposed.output);
  a.check('nimbus expose prints a URL', url !== '', exposed.output.slice(-300));
  a.check('the printed URL names the app', /\/app\/shell\/$|shell--/.test(url), `url=${url}`);
  a.check('nimbus expose reports the visibility and name', /public · shell · port 4700/.test(exposed.output), exposed.output.slice(-300));
  if (url) {
    const served = await poll(url, 'shell-app:', 20_000, 'hello');
    a.check('the printed URL serves the app', served.ok, `status=${served.last.status} body=${served.last.body?.slice(0, 100)}`);
  }
  if (SUFFIX) {
    a.check('with a suffix the printed URL is the public name host form', new RegExp(`^https://[a-f0-9]{24}--shell--${sid}\\.${SUFFIX.replace(/\\./g, '\\\\.')}/$`).test(url), `url=${url}`);
  } else {
    a.check('without a suffix the printed URL is the path form on the session origin', url.startsWith(`${BASE}/s/${sid}/app/shell/`), `url=${url}`);
  }

  // ── 2. nimbus app list agrees with the SDK ────────────────────────────
  const listed = await t.run('nimbus app list', 15_000);
  a.check('nimbus app list shows the named app on its port', /shell\s+4700\s+\d+\s+running\s+public\s+never\s+\S+/.test(listed.output), listed.output.slice(-400));
  const sdk = (await box.apps.list()).find((app) => app.name === 'shell');
  a.check('the SDK sees the same identity', sdk !== undefined && sdk.port === PORT && sdk.visibility === 'public' && sdk.pid === pid, JSON.stringify(sdk));
  const urlOut = await t.run('nimbus app url shell', 15_000);
  a.check('nimbus app url prints the same URL', firstUrl(urlOut.output) === url, `${firstUrl(urlOut.output)} vs ${url}`);

  // ── 3. rotate: a new URL, the old one dead ────────────────────────────
  const rotated = await t.run('nimbus app rotate shell', 30_000);
  const url2 = firstUrl(rotated.output);
  a.check('nimbus app rotate prints a URL', url2 !== '', rotated.output.slice(-300));
  if (SUFFIX) {
    a.check('the rotated host URL differs (new capability)', url2 !== url, `${url} → ${url2}`);
    const dead = await fetchPrinted(url, '');
    a.check('the old public URL is dead', dead.status === 404, `status=${dead.status}`);
  } else {
    const sdkAfter = (await box.apps.list()).find((app) => app.name === 'shell');
    a.check('the capability rotated', sdkAfter?.capability !== sdk?.capability && /^[a-f0-9]{24}$/.test(sdkAfter?.capability ?? ''),
      `${sdk?.capability} → ${sdkAfter?.capability}`);
  }
  const servedAfter = await poll(url2, 'shell-app:', 20_000, 'after');
  a.check('the rotated URL serves the app', servedAfter.ok, `status=${servedAfter.last.status} body=${servedAfter.last.body?.slice(0, 100)}`);

  // ── 4. remove ends it ─────────────────────────────────────────────────
  const removed = await t.run('nimbus app remove shell', 30_000);
  a.check('nimbus app remove reports the release', /removed auto:[a-f0-9]{24} \(port 4700 released\)/.test(removed.output), removed.output.slice(-300));
  const gone = (await box.apps.list()).find((app) => app.name === 'shell' || app.port === PORT);
  a.check('the app is gone from apps.list', gone === undefined, JSON.stringify(gone));
  const processes = await box.processes.list();
  a.check('the process was killed', !processes.some((p) => p.pid === pid && p.state === 'running'), JSON.stringify(processes.filter((p) => p.pid === pid)));
  const after = await fetchPrinted(url2, '');
  a.check('the removed app no longer answers', after.status !== 200, `status=${after.status} body=${after.body?.slice(0, 100)}`);

  // ── 5. the unknown-verb path still reads as usage ─────────────────────
  const usage = await t.run('nimbus app', 15_000);
  a.check('nimbus app without a subcommand prints usage', /usage: nimbus app list/.test(usage.output), usage.output.slice(-200));
} finally {
  if (t) await t.close().catch(() => {});
  await deleteSession(sid, 'durable-shell-expose');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
