#!/usr/bin/env bun
// behavioral/end-to-end-workflow — fresh session → cd app → npm install →
// npm run dev → /preview/?id=<sid> returns the dev page (200) within 60s.
//
// Black-box surfaces only. NO _diag.

import { mintSession, Terminal, makeAsserter, sleep, fetchPreview } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('end-to-end-workflow');
console.log(`behavioral/end-to-end-workflow — npm install + dev + preview\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_500);

// Step 1: cd app (the seeded starter ships with package.json + a Vite app).
{
  const r = await t.run('cd /home/user/app && pwd', 10_000);
  a.check('cd /home/user/app succeeds', /\/home\/user\/app/.test(r.output), r.output.slice(-200));
}

// Step 2: npm install. Up to 120 s.
{
  t.reset();
  t.cmd('npm install');
  const elapsed = await t.waitFor(
    (b) => /added \d+ packages|installed \d+ packages|Done!\s+\d+ packages|npm ERR!/i.test(b),
    180_000,
    'npm install completion',
  );
  const installed = /added \d+ packages|installed \d+ packages|Done!/i.test(t.buf);
  a.check(`npm install completed (added/installed marker; ${(elapsed/1000).toFixed(1)}s)`,
    installed, t.buf.slice(-300));
  await t.waitForNewPrompt(15_000).catch(() => { /* prompt may already be there */ });
}

// Step 3: npm run dev — long-running. Forks to a long-running facet.
//    The shell should return promptly (≤5s) with a "[started…]" marker
//    OR start vite inline; in either case the next step (preview fetch)
//    is the real assertion.
{
  t.reset();
  t.cmd('npm run dev');
  // Wait for ANY of the dev-server start markers. The Nimbus vite
  // facet emits its own banner (`Preview:`, `Root:`, `Port:`); upstream
  // vite emits "ready in", "Local:", "VITE v…"; long-running fork
  // emits "[started (long-running)…]".
  try {
    const elapsed = await t.waitFor(
      (b) => /ready in|Local:|started \(long-running\)|VITE\s+v|server running|hostname|Preview:\s+|Run\s+vite stop/i.test(b),
      60_000,
      'dev server marker',
    );
    a.check(`dev server emitted ready/started marker (${(elapsed/1000).toFixed(1)}s)`,
      true);
  } catch (e) {
    a.check('dev server emitted ready/started marker', false, t.buf.slice(-400));
  }
}

// Step 4: GET /s/<sid>/preview/ returns 200 with HTML body containing the
// expected app shell. Vite serves an index.html with a <div id="root"> mount.
{
  let ok = false;
  let lastStatus = null;
  let lastBody = '';
  // Poll for up to 60s — vite may need a moment to bind after the
  // started marker.
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const r = await fetchPreview(sid, { path: '' });
    lastStatus = r.status;
    lastBody = r.html;
    if (r.status === 200 && /<div id="root"|<!doctype html>|<html/i.test(r.html)) {
      ok = true;
      break;
    }
    await sleep(1_500);
  }
  a.check('GET /s/<sid>/preview/ returns 200 with dev-server HTML',
    ok, `status=${lastStatus} body[0..160]=${lastBody.slice(0, 160)}`);
}

await t.close();
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
