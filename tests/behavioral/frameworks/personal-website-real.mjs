#!/usr/bin/env bun
// frameworks/personal-website-real — runtime-behavioral probe of the
// REAL personal-website repo, HTTP-only (no browser).
//
// Category: R (runtime-behavioral)
//
// Why this exists
// ───────────────
// The real repo declares ~90 root dependencies — radix-ui, tiptap,
// react-markdown, rehype/remark chains, @cloudflare/vite-plugin — a dep
// tree no synthetic fixture reproduces. `npm install` must exit 0 on a
// tree this wide (transitive native/optional refusals under a dev-only
// root must stay non-fatal), and `npm run dev` (its script is
// `vite --host 0.0.0.0 --port ${PORT:-3000}`) must serve the site on the
// scoped port URL.
//
// Flow:
//   1. Mint session.
//   2. `git clone https://github.com/AshishKumar4/personal-website site`
//   3. `cd site && npm install` — exit 0 and npm's `added N packages`
//      summary line.
//   4. `npm run dev` — wait for the dev banner, then for port 3000 to
//      appear in the session's port list.
//   5. GET `/s/<sid>/port/3000/` → 200 with an `<html` body.
//   6. The dev-server banner shows no `✘` line.
//
// Run: BASE=... NIMBUS_PROBE_TOKEN=... bun tests/behavioral/frameworks/personal-website-real.mjs

import {
  mintSession, deleteSession, Terminal, stripAnsi, fetchPort, sleep,
  BASE, AUTH_TOKEN, makeAsserter,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE required'); process.exit(2); }

const a = makeAsserter('frameworks/personal-website-real');
const PORT = 3000;

async function exec(t, cmd, timeoutMs) {
  t.reset();
  t.cmd(`${cmd}; echo __EXIT__$?`);
  try {
    await t.waitFor(b => /__EXIT__\d+/.test(b), timeoutMs, `${cmd.slice(0, 60)} exit`);
    await sleep(200);
  } catch {
    t.send('');
    return { exit: null, timedOut: true, output: stripAnsi(t.buf) };
  }
  const output = stripAnsi(t.buf);
  const m = output.match(/__EXIT__(\d+)/);
  return { exit: m ? Number(m[1]) : null, timedOut: false, output };
}

const sid = await mintSession();
console.log(`[personal-website-real] sid=${sid} BASE=${BASE}`);

try {
  const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
  const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);

  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);

  // ── 1. clone ────────────────────────────────────────────────────────
  let r = await exec(t, 'cd /home/user && git clone https://github.com/AshishKumar4/personal-website site', 300_000);
  console.log('[clone] exit=' + r.exit);
  a.check('git clone exits 0', r.exit === 0, r.output.slice(-400));
  if (r.exit !== 0) throw new Error('clone failed; aborting before install');

  // ── 2. install ──────────────────────────────────────────────────────
  r = await exec(t, 'cd /home/user/site && npm install', 900_000);
  console.log('[install] exit=' + r.exit);
  console.log(r.output.split('\n').filter(l => l.trim()).slice(-15).join('\n'));
  a.check('npm install exits 0', r.exit === 0, r.output.slice(-800));
  a.check('npm install prints the added-packages summary', /added \d+ packages?/.test(r.output), r.output.slice(-400));
  if (r.exit !== 0) throw new Error('npm install failed; aborting before dev');

  // ── 3. dev server ───────────────────────────────────────────────────
  t.reset();
  t.cmd('cd /home/user/site && npm run dev');
  let devOut = '';
  try {
    await t.waitFor(b => /Preview:|pid=\d+|Local:|localhost:\d+|port \d+/i.test(stripAnsi(b)), 120_000, 'dev server banner');
    devOut = stripAnsi(t.buf);
  } catch (e) {
    devOut = stripAnsi(t.buf);
    a.check('npm run dev prints a dev-server banner', false, `${e.message}`);
  }
  if (devOut) {
    a.check('dev-server banner has no ✘ line', !/✘/.test(devOut), devOut.slice(-600));
  }

  // ── 4. port appears in the session's port list ──────────────────────
  let bound = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !bound) {
    const ports = await box.ports.list().catch(() => []);
    bound = ports.find((p) => p.port === PORT) || null;
    if (!bound) await sleep(1_000);
  }
  a.check('ports.list reports 3000 live', bound !== null, JSON.stringify(bound));

  // ── 5. the scoped port URL serves HTML ──────────────────────────────
  let served = null;
  for (let i = 0; i < 30 && !served; i++) {
    const pr = await fetchPort(sid, PORT).catch(() => null);
    if (pr && pr.status === 200 && /<html/i.test(pr.body || '')) served = pr;
    else await sleep(1_000);
  }
  a.check(
    `GET /s/<sid>/port/${PORT}/ returns 200 + <html`,
    served !== null,
    served ? `status=${served.status}` : 'never served',
  );

  await t.close().catch(() => {});
} finally {
  await deleteSession(sid).catch(() => {});
}

const { pass, fail } = a.summary();
process.exit(fail === 0 && pass > 0 ? 0 : 1);
