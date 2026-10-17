#!/usr/bin/env bun
// perf-regression/first-paint — time from `npm run dev` to the first
// response the dev server itself serves on /preview/, against the baseline.
//
// User flow timed, per session:
//   1. mint session → connect terminal → wait prompt.
//   2. `cd example-app && npm install` for the seeded React project (untimed).
//   3. Fire-and-forget `npm run dev` (the dev server holds the terminal, so
//      t.cmd() rather than t.run()).
//   4. Poll GET /s/<sid>/preview/ until the DEV SERVER is what answers.
//      Time from cmd-sent to that response.
//
// /preview/ answers 200 with a placeholder page while no dev server is up
// (measured 2026-08-07: 34-167 ms on a session that never ran `npm run dev`),
// so 200 alone proves nothing. The dev server rewrites the project's
// index.html to mount under the preview path and the placeholder carries no
// such mount: that is the marker for "the dev server is serving". The
// placeholder is verified before the start command, so startup lies after
// command-sent time.
//
// Graded paired (_paired.mjs): each round runs the flow on the baseline's
// two Previews and the candidate's, at once, and compares when each first
// saw its dev server. The fixed 1000 ms bound it replaces could not score a
// bracket that straddled it, and failed the same code under load.
//
// Regressions it protects against:
//   - vite plugin chain inflated.
//   - cirrus-real proxy regressed.
//   - Preview route lost the dev-server detection fast path.
// The last two are functional, not timing, so they are asserted directly.

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi, requestHeaders } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/first-paint');
const arms = requirePairedTargets('perf-regression/first-paint');
console.log(`perf-regression/first-paint — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b1.base}, ${arms.b2.base}`);

const ROUNDS = 16;
// Small enough that the round-trip, not this sleep, sets the resolution.
const POLL_INTERVAL_MS = 20;
const POLL_BUDGET_MS = 90_000;

const result = await measurePaired(arms, ROUNDS, async (target) => {
  const sid = await mintSession(target);
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(30_000);
    await t.run('cd example-app && npm install', 300_000);

    const servedByDevServer = new RegExp(`<base href="/s/${sid}/preview/`);
    const preview = (signal) => fetch(`${target.base}/s/${sid}/preview/`, { redirect: 'manual', headers: requestHeaders({}, sid), signal });
    const before = await preview(AbortSignal.timeout(POLL_BUDGET_MS));
    const beforeBody = await before.text();
    if (before.status !== 200 || servedByDevServer.test(beforeBody)) {
      throw new Error(`${sid}: the preview did not serve its placeholder before npm run dev (status=${before.status}), so the timing has no starting point`);
    }

    t.reset();
    const t0 = performance.now();
    t.cmd('npm run dev');
    let firstPaint = null;
    let polls = 0;
    while (firstPaint === null && performance.now() - t0 < POLL_BUDGET_MS) {
      try {
        const r = await preview(AbortSignal.timeout(Math.max(1, Math.ceil(POLL_BUDGET_MS - (performance.now() - t0)))));
        const body = await r.text();
        polls++;
        if (r.status === 200 && servedByDevServer.test(body)) firstPaint = performance.now() - t0;
      } catch { /* A transport failure does not establish whether startup finished. */ }
      if (firstPaint === null) await new Promise((rs) => setTimeout(rs, POLL_INTERVAL_MS));
    }
    if (firstPaint === null) throw new Error(`${sid}: never saw the dev-server mount in /preview/ (polls=${polls}, budget ${POLL_BUDGET_MS} ms)`);

    // The dev server came up and announced a bound port: a 200 alone can be
    // served by something that is not the dev server.
    try {
      await t.waitFor((b) => /Nimbus Vite Dev Server/.test(b) && /Port:\s*\d+/.test(b), 30_000, 'dev-server banner');
    } catch (error) {
      throw new Error(`${sid}: the dev server did not announce its port (${error.message}); terminal tail=${JSON.stringify(stripAnsi(t.buf).slice(-400))}`);
    }
    return { 'first paint': firstPaint };
  } finally {
    await t.close();
    await deleteSession(sid);
  }
});

assertCandidateRounds(a, 'its session serves its dev server on /preview/ and announces its port', result);
const graded = assertPaired(a, 'first paint', result);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : graded ? 0 : 2);
