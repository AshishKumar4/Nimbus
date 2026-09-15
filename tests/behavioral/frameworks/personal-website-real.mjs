#!/usr/bin/env bun
// frameworks/personal-website-real — runtime-behavioral HTTP smoke of the
// REAL personal-website repo (no browser).
//
// Category: R (runtime-behavioral)
//
// What it checks, honestly: clone → `npm install` exit 0 with npm's
// `added N packages` line → `npm run dev` (the repo's own script,
// `vite --host 0.0.0.0 --port ${PORT:-3000}`) binds 3000 → the scoped
// port URL serves HTML → the dev banner shows no ✘ line. When the repo's
// declared devDependencies include a policy refusal (today:
// @cloudflare/vite-plugin — a Workers-only tool with no reason to run
// inside a sandbox that already IS Workers), the install exits 1 and
// this probe reports that honestly instead of laundering it.
//
// Run: BASE=... NIMBUS_PROBE_TOKEN=... bun tests/behavioral/frameworks/personal-website-real.mjs

import {
  mintSession, deleteSession, Terminal, stripAnsi, fetchPort, sleep,
  BASE, AUTH_TOKEN, makeAsserter,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE required'); process.exit(2); }

const a = makeAsserter('frameworks/personal-website-real');
const PORT = 3000;

// Terminal.run() waits for the prompt to return; appending an exit
// sentinel keeps the exit code inside the returned output.
async function run(t, cmd, timeoutMs) {
  const r = await t.run(`${cmd}; echo __EXIT__$?`, timeoutMs);
  const m = r.output.match(/__EXIT__(\d+)/);
  return { exit: m ? Number(m[1]) : null, output: r.output };
}

const sid = await mintSession();
console.log(`[personal-website-real] sid=${sid} BASE=${BASE}`);

let t = null;
try {
  const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
  const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(sid);

  t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);

  // ── 1. clone ────────────────────────────────────────────────────────
  const cl = await run(t, 'cd /home/user && git clone https://github.com/AshishKumar4/personal-website site', 300_000);
  console.log('[clone] exit=' + cl.exit);
  a.check('git clone exits 0', cl.exit === 0, cl.output.slice(-400));
  if (cl.exit !== 0) throw new Error('clone failed; nothing to install or serve');

  // ── 2. install — report, do not hide, a required refusal ────────────
  const ins = await run(t, 'cd /home/user/site && npm install', 900_000);
  console.log('[install] exit=' + ins.exit);
  console.log(ins.output.split('\n').filter(l => l.trim()).slice(-15).join('\n'));
  a.check('npm install exits 0', ins.exit === 0, ins.output.slice(-800));
  a.check('npm install prints the added-packages summary', /added \d+ packages?/.test(ins.output), ins.output.slice(-400));
  // A failed install still leaves whatever resolved; keep going — the dev
  // probe below is more signal with partial node_modules than none.

  // ── 3. dev server banner ────────────────────────────────────────────
  t.reset();
  t.cmd('cd /home/user/site && npm run dev');
  let devOut = '';
  try {
    await t.waitFor(b => /Preview:|pid=\d+|Local:|localhost:\d+|port \d+/i.test(stripAnsi(b)), 120_000, 'dev server banner');
    devOut = stripAnsi(t.buf);
  } catch (e) {
    devOut = stripAnsi(t.buf);
    a.check('npm run dev prints a dev-server banner', false, `${e.message}\n${devOut.slice(-600)}`);
  }
  if (devOut) {
    a.check('dev-server banner has no ✘ line', !/✘/.test(devOut), devOut.slice(-600));
  }

  // ── 4. port 3000 reports live ───────────────────────────────────────
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
  let lastStatus = 'no response';
  for (let i = 0; i < 30 && !served; i++) {
    try {
      const pr = await fetchPort(sid, PORT);
      lastStatus = `status=${pr?.status ?? 'n/a'}`;
      if (pr && pr.status === 200 && /<html/i.test(pr.body || '')) served = pr;
      else await sleep(1_000);
    } catch (e) {
      lastStatus = `fetch error: ${e.message}`;
      await sleep(1_000);
    }
  }
  a.check(
    `GET /s/<sid>/port/${PORT}/ returns 200 + <html`,
    served !== null,
    served ? `status=${served.status}` : lastStatus,
  );
} finally {
  if (t) await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
  // Prove the session is gone rather than assuming it.
  try {
    const res = await fetch(`${BASE}/s/${sid}/api/ports`, { headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {} });
    a.check('session is deleted after the probe', res.status === 404 || res.status === 410, `ports endpoint answered ${res.status}`);
  } catch { /* an unreachable endpoint after teardown is also a pass */ }
}

const { pass, fail } = a.summary();
process.exit(fail === 0 && pass > 0 ? 0 : 1);
