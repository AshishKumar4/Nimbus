#!/usr/bin/env bun
// durable/npx-vite-app — the most common launch is an application too.
//
// WHAT IT PROVES
//   `startProcess('npx vite --host --port 5173')` runs the session's own
//   Vite dev server in process — no facet, no journal row — and registers
//   the port. That server still has an identity: derived from the process
//   table's cwd+argv for the pid that serves the port. So `apps.expose`
//   binds it under a name, `apps.list` reports it running under that
//   identity, `apps.rotateLink` mints a fresh link that answers while the
//   old one dies, and `apps.remove` ends the live server and releases the
//   name. Before this, expose refused with "has no launch record".
//
// HOW IT'S DRIVEN
//   Everything through the SDK's remote surface — the surface the failure
//   was reported on. The path form `/s/<sid>/port/<n>/` with the capability
//   headers stands in for the public host form on a deployment with no
//   preview suffix; both reach the same session gate.

import { BASE, AUTH_TOKEN, makeAsserter, mintSession, deleteSession, fetchPort, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const SUFFIX = process.env.NIMBUS_PREVIEW_HOST_SUFFIX ?? null;

const a = makeAsserter('durable/npx-vite-app');
console.log(`durable/npx-vite-app — BASE=${BASE}`);

const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);
const PORT = 5173;
const CWD = '/home/user/viteapp';

async function fetchPublic(capability, path = '') {
  if (SUFFIX) {
    const r = await fetch(`${BASE}/${path}`, { headers: { Host: `${capability}--web--${sid}.${SUFFIX}` }, redirect: 'manual' })
      .catch((e) => ({ status: 0, text: async () => String(e) }));
    return { status: r.status, body: await r.text().catch(() => '') };
  }
  return fetchPort(sid, PORT, path, {
    headers: { 'x-nimbus-preview-capability': capability, 'x-nimbus-public-bearer': '1' },
  });
}
async function poll(probe, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last.ok) return last;
    await sleep(400);
  }
  return last ?? { ok: false };
}

try {
  await box.ready();
  await box.files.mkdir(CWD).catch(() => {});
  await box.files.write(`${CWD}/index.html`,
    '<!DOCTYPE html><html><head><title>npx vite app</title></head><body><h1 id="app">npx-vite-app</h1></body></html>');
  await box.files.write(`${CWD}/package.json`, JSON.stringify({ name: 'viteapp', private: true }));

  // ── 1. the launch: startProcess runs the in-process dev server ────────
  const started = await box.startProcess('npx vite --host --port 5173', { cwd: CWD });
  a.check('startProcess answers a pid', started.pid > 0, JSON.stringify(started.process));
  const warm = await poll(async () => {
    const r = await fetchPort(sid, PORT, '');
    return { ok: r.status === 200 && r.body.includes('npx-vite-app'), status: r.status, body: r.body };
  }, 30_000);
  a.check('the dev server answers its scoped port URL', warm.ok, `status=${warm.status} body=${warm.body?.slice(0, 120)}`);
  const ports = await box.ports.list();
  const bound = ports.find((p) => p.port === PORT);
  a.check('ports.list reports 5173 live with a pid', bound !== undefined && typeof bound.pid === 'number' && bound.pid > 0, JSON.stringify(ports));

  // ── 2. expose: the identity comes from the process table ──────────────
  const exposed = await box.apps.expose(PORT, { visibility: 'public', name: 'web' });
  a.check('apps.expose answers a derived owner for the un-journalled dev server', /^auto:[a-f0-9]{24}$/.test(exposed.owner), JSON.stringify(exposed));
  a.check('apps.expose names it and mints a capability', exposed.name === 'web' && /^[a-f0-9]{24}$/.test(exposed.capability ?? ''), JSON.stringify(exposed));
  a.check('apps.expose reports the serving pid', exposed.pid === bound?.pid, `pid=${exposed.pid} expected ${bound?.pid}`);
  const OWNER = exposed.owner;
  const CAP1 = exposed.capability ?? '';
  const viaLink = await poll(async () => {
    const r = await fetchPublic(CAP1);
    return { ok: r.status === 200 && r.body.includes('npx-vite-app'), status: r.status, body: r.body };
  }, 20_000);
  a.check('the shared link serves the dev server', viaLink.ok, `status=${viaLink.status} body=${viaLink.body?.slice(0, 120)}`);

  // ── 3. list ───────────────────────────────────────────────────────────
  const listed = (await box.apps.list()).find((app) => app.owner === OWNER);
  a.check('apps.list shows the app running under its identity',
    listed !== undefined && listed.status === 'running' && listed.pid === exposed.pid && listed.port === PORT,
    JSON.stringify(listed));
  a.check('apps.list carries the name, visibility and capability',
    listed?.name === 'web' && listed?.visibility === 'public' && listed?.capability === CAP1, JSON.stringify(listed));
  a.check('apps.list answers a URL for it', typeof listed?.url === 'string' && listed.url.includes(SUFFIX ? `--web--${sid}` : `/app/web/`), `url=${listed?.url}`);

  // ── 4. rotate ─────────────────────────────────────────────────────────
  const rotated = await box.apps.rotateLink('web');
  a.check('rotateLink answers a fresh capability on the same identity',
    /^[a-f0-9]{24}$/.test(rotated.capability ?? '') && rotated.capability !== CAP1 && rotated.owner === OWNER && rotated.pid === exposed.pid,
    JSON.stringify(rotated));
  const CAP2 = rotated.capability ?? '';
  const dead = await fetchPublic(CAP1);
  a.check('the old link is dead', dead.status === 404, `status=${dead.status}`);
  const alive = await poll(async () => {
    const r = await fetchPublic(CAP2);
    return { ok: r.status === 200 && r.body.includes('npx-vite-app'), status: r.status, body: r.body };
  }, 20_000);
  a.check('the new link answers', alive.ok, `status=${alive.status} body=${alive.body?.slice(0, 120)}`);

  // ── 5. remove ends the live server ────────────────────────────────────
  const removed = await box.apps.remove('web');
  a.check('apps.remove reports the release', removed.owner === OWNER && removed.removed === true && removed.port === PORT, JSON.stringify(removed));
  const gone = (await box.apps.list()).find((app) => app.owner === OWNER || app.name === 'web');
  a.check('the app is gone from apps.list', gone === undefined, JSON.stringify(gone));
  const processes = await box.processes.list();
  a.check('the dev server process was ended', !processes.some((p) => p.pid === exposed.pid && p.state === 'running'),
    JSON.stringify(processes.filter((p) => p.pid === exposed.pid)));
  const after = await fetchPort(sid, PORT, '');
  a.check('the port no longer serves the app', after.status !== 200, `status=${after.status} body=${after.body?.slice(0, 100)}`);
} finally {
  await deleteSession(sid, 'durable-npx-vite-app');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
