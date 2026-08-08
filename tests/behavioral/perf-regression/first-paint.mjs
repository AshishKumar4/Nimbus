#!/usr/bin/env bun
// perf-regression/first-paint — time from `npm run dev` to the first 200 on
// /preview/.
//
// User flow timed:
//   1. mint session → connect terminal → wait prompt.
//   2. `cd app && npm install` for the seeded React project (untimed).
//   3. Fire-and-forget `npm run dev` (the dev server holds the terminal, so
//      t.cmd() rather than t.run()).
//   4. Poll GET /s/<sid>/preview/ until the DEV SERVER is what answers.
//      Time from cmd-sent to that response.
//
// Why the signal changed. The probe used to poll for HTTP 200 and stop there.
// Measured 2026-08-07: /preview/ returns 200 in 34-167 ms on a session where
// `npm run dev` has never been run — the route serves a placeholder page when
// no dev server is up. The old probe therefore passed its poll on the first
// request every time (polls=1 in 5 of 5 runs), and would have passed with the
// dev server never started at all. It could not fail for the reason it exists,
// and its "duration" was the round-trip of a request that would have answered
// anyway, which is why its readings scattered 141-1438 ms with no relation to
// startup.
//
// The dev server rewrites the project's index.html to mount under the preview
// path, and the placeholder carries no such mount, so that is the marker for
// "the dev server is serving" as opposed to "the route answered".
//
// The reading is then a bracket: dev-server HTML seen at time T with the last
// placeholder read at time P means startup completed in (P, T]. That decides
// the bound when the bracket sits entirely on one side of it, and decides
// nothing when it straddles — which is refused out loud rather than scored in
// whichever direction the poll phase happened to land. Polling every 20 ms
// keeps the bracket narrow. A run that never witnesses the placeholder never
// started its clock, and is refused for the same reason.
//
// Threshold provenance: see THRESHOLD_MS below.
//
// Threshold protects against vite-startup regression:
//   - vite plugin chain inflated.
//   - cirrus-real proxy regressed.
//   - Preview route lost the dev-server detection fast path.
// The last two are functional, not timing, so they are asserted directly.

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi, BASE, requestHeaders } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('perf-regression/first-paint');
console.log(`perf-regression/first-paint — ${BASE}`);

// Threshold provenance: 1000 ms, unchanged. The original "median=577 ms
// p95=668 ms, N=5 runs vs prod" cited a baselines.md which has never existed
// in this repository, so it could not be re-derived — but re-measuring startup
// with the corrected signal on 2026-08-07 against a throwaway carrying the npm
// fanout branch put it in (359, 731] ms across N=4, which brackets that old
// median and p95 closely. The bound was never the problem here; the signal
// rotted out from under it once /preview/ began answering 200 with a
// placeholder. 1000 ms keeps ~1.4x headroom over the slowest observed run.
const THRESHOLD_MS = 1000;
// Small enough that the round-trip, not this sleep, sets the bracket width.
// Observed bracket 140-200 ms, i.e. one round-trip.
const POLL_INTERVAL_MS = 20;
const POLL_BUDGET_MS = 90_000;

let sid;
try {
  sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(30_000);

  await t.run('cd app && npm install', 300_000);

  t.reset();
  const t0 = performance.now();
  t.cmd('npm run dev');

  // The dev server rewrites the project's index.html to mount under the
  // preview path. The placeholder page carries no such mount, so this is the
  // marker that separates "the dev server is serving" from "the preview route
  // answered".
  const servedByDevServer = new RegExp(`<base href="/s/${sid}/preview/`);

  // upper = when dev-server HTML was first seen. lower = the last observation
  // that was still the placeholder, so first-paint lies in (lower, upper].
  let upperMs = 0;
  let lowerMs = 0;
  let sawPlaceholder = false;
  let polls = 0;
  while (performance.now() - t0 < POLL_BUDGET_MS) {
    try {
      const r = await fetch(`${BASE}/s/${sid}/preview/`, { redirect: 'manual', headers: requestHeaders() });
      const body = await r.text();
      polls++;
      if (r.status === 200 && servedByDevServer.test(body)) {
        upperMs = performance.now() - t0;
        break;
      }
      sawPlaceholder = true;
      lowerMs = performance.now() - t0;
    } catch {
      // The dev server may still be binding its port; a failed request is
      // still evidence it was not serving at this instant.
      lowerMs = performance.now() - t0;
    }
    await new Promise((rs) => setTimeout(rs, POLL_INTERVAL_MS));
  }

  a.check('preview served the dev server within the poll budget', upperMs > 0,
    `polls=${polls} budget=${POLL_BUDGET_MS}ms — never saw the dev-server mount in /preview/`);

  // If the very first observation was already the dev server, the run proves
  // nothing about startup: the placeholder state was never witnessed, so the
  // measurement did not begin before the thing it is timing.
  a.check('observed the pre-startup state, so the timing has a starting point',
    sawPlaceholder,
    'the first /preview/ read was already the dev server — this run did not bracket startup and its duration is not a measurement of it');

  // Direct property: the dev server actually came up and announced a bound
  // port. A 200 alone can be served by something that is not the dev server,
  // so this is what "lost the dev-server detection fast path" looks like.
  // Bounded wait — the banner lands shortly after the port opens.
  let banner = false;
  try {
    await t.waitFor((b) => /Nimbus Vite Dev Server/.test(b) && /Port:\s*\d+/.test(b), 30_000, 'dev-server banner');
    banner = true;
  } catch { /* asserted below with the buffer tail */ }
  const buf = stripAnsi(t.buf);
  await t.close();

  a.check('dev server started and announced its port', banner,
    `terminal tail=${JSON.stringify(buf.slice(-400))}`);

  // The bracket decides the bound only when it does not straddle it.
  const decidable = upperMs > 0 && (upperMs <= THRESHOLD_MS || lowerMs > THRESHOLD_MS);
  a.check(`measurement brackets first-paint tightly enough to score ${THRESHOLD_MS} ms`,
    decidable,
    `first-paint is somewhere in (${lowerMs.toFixed(0)}, ${upperMs.toFixed(0)}] ms, which straddles the ${THRESHOLD_MS} ms bound — this run cannot say which side it is on, so it is not scored`);

  if (decidable) {
    a.check(`first-paint ≤ ${THRESHOLD_MS} ms`,
      upperMs <= THRESHOLD_MS,
      `first-paint in (${lowerMs.toFixed(0)}, ${upperMs.toFixed(0)}] ms threshold=${THRESHOLD_MS}ms polls=${polls}`);
  }

  console.log(`[first-paint] first-paint in (${lowerMs.toFixed(0)}, ${upperMs.toFixed(0)}] ms (threshold=${THRESHOLD_MS}ms, polls=${polls})`);
} finally {
  if (sid) { try { await deleteSession(sid); } catch { /* best-effort cleanup */ } }
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
