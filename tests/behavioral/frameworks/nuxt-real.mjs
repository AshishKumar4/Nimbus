#!/usr/bin/env bun
// frameworks/nuxt-real — honest-boundary probe for `nuxi init` under Nimbus.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx nuxi@latest init mvp --no-install --packageManager=npm
//
// THE INVARIANT (not a pinned upstream string): a non-interactive
// `nuxi init` under Nimbus must FAIL FAST and CLEANLY — reach nuxi's own
// non-interactive handling and exit non-zero within a bounded time —
// rather than (a) wedging on an interactive prompt that never returns,
// (b) crashing inside a Nimbus shim, or (c) silently "succeeding".
//
// Why an invariant and not an exact message: nuxi's non-interactive
// diagnostic has drifted repeatedly and broke this probe three times —
// 3.35 reached an interactive template picker; 3.36 printed
// "Missing required argument: --gitInit"; current nuxi prints
// "Non-interactive terminal detected. Missing required arguments:
// --template, --packageManager, --gitInit". Pinning the exact wording
// guarantees a periodic false failure on the next drift. The invariant
// below still catches a REAL regression: if nuxi wedges (no exit within
// the budget) or Nimbus mishandles the non-TTY case (a shim crash, or a
// silent exit 0), the asserts fail.
//
// What this still PROVES about Nimbus (the real capability): nuxi runs
// under Nimbus, loads its template registry over the network, and reaches
// its argument validation — exercising outbound fetch plus the
// startup-drain timer that keeps the facet alive across the registry
// fetch (without it the facet exited before the fetch settled). The
// "no Nimbus shim crash" assert specifically guards the regression where
// node:util.formatWithOptions was missing and consola crashed nuxi at its
// first diagnostic line before it could report anything useful.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('nuxt-real');

// Bounded budget: nuxi reaches its non-interactive exit in a few seconds.
// A wedge on an interactive prompt would blow past this — that is the
// no-hang signal we want to catch.
const BUDGET_MS = 90_000;

const sid = await mintSession();
console.log(`[nuxt-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/nuxt-probe && cd /home/user/nuxt-probe', 10_000);
  console.log('[nuxt-real] npx nuxi@latest init...');

  t.reset();
  // Append an exit sentinel so we can read nuxi's real exit code and
  // confirm the command actually returned to a shell prompt (no hang).
  t.cmd('npx --yes nuxi@latest init mvp -t minimal --no-install --packageManager=npm 2>&1; echo "___NUXI_EXIT=$?___"');

  let terminated = false;
  let elapsed = -1;
  const t0 = Date.now();
  try {
    await t.waitFor((b) => /___NUXI_EXIT=\d+___/.test(b), BUDGET_MS, 'nuxi-exit-sentinel');
    terminated = true;
    elapsed = Date.now() - t0;
  } catch (e) {
    console.log('[nuxt-real] did not terminate within budget:', e?.message);
  }

  const out = stripAnsi(t.buf);
  const exitMatch = out.match(/___NUXI_EXIT=(\d+)___/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  console.log(`[nuxt-real] terminated=${terminated} elapsed=${elapsed}ms exitCode=${exitCode}`);

  // 1. No hang: the command returned to a prompt within the budget.
  a.check('nuxi init terminates within the bounded budget (does not hang on an interactive prompt)',
    terminated, JSON.stringify(out.slice(-500)));

  // 2. No silent success: a non-interactive init must exit non-zero.
  a.check('nuxi init exits non-zero (does not silently succeed under non-TTY)',
    exitCode !== null && exitCode !== 0, `exitCode=${exitCode}`);

  // 3. Reached nuxi's own non-interactive handling — proves Nimbus surfaces
  //    the non-TTY condition to the tool rather than faking a terminal.
  a.check('nuxi detects the non-interactive terminal (Nimbus non-TTY handled correctly)',
    /non-interactive/i.test(out), JSON.stringify(out.slice(-600)));

  // 4. Network + startup-drain: nuxi loaded its template registry over the
  //    network before validating arguments (the facet stayed alive across
  //    the outbound fetch).
  a.check('nuxi loaded its template registry over the network',
    /Available templates|Templates loaded/i.test(out), JSON.stringify(out.slice(-600)));

  // 5. The failure is nuxi's own bounded validation — NOT a Nimbus shim
  //    crash. Guards the regression where node:util.formatWithOptions was
  //    missing and consola crashed nuxi at its first log line.
  a.check('nuxi fails on its own validation, not a Nimbus shim crash',
    !/is not a function|Unhandled promise rejection:\s*TypeError/i.test(out),
    JSON.stringify(out.slice(-600)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
