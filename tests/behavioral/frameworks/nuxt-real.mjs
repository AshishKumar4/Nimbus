#!/usr/bin/env bun
// frameworks/nuxt-real — honest-boundary probe for `nuxi init`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx nuxi@latest init mvp --no-install --packageManager=npm
//
// Boundary (documented, not faked): nuxi@3.35's `init` ALWAYS presents
// an interactive @clack/prompts template picker ("Which template would
// you like to use?") and ignores `-t/--template` for skipping it — every
// `-t <name>` and even `-t github:nuxt/starter/v3` still drops into the
// picker. There is no flag combination that scaffolds non-interactively,
// so a fully-automated scaffold is genuinely out of reach for this tool.
//
// What this probe PROVES (the real, useful capability): nuxi runs under
// Nimbus, loads its template registry over the network ("Templates
// loaded"), and reaches the picker — exercising outbound fetch plus the
// startup-drain timer tracking that keeps the facet alive across the
// registry fetch (without it the facet exited at "Loading available
// templates" before the fetch settled). The interactive picker itself is
// the honest boundary.

import { Terminal, mintSession, sleep, stripAnsi, makeAsserter, deleteSession, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('nuxt-real');

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
  t.cmd('npx --yes nuxi@latest init mvp -t minimal --no-install --packageManager=npm 2>&1');

  // The registry fetch must complete (network + drain). Without the
  // startup-drain timer tracking the facet exited at "Loading available
  // templates" before the fetch resolved.
  let templatesLoaded = false;
  try {
    await t.waitFor((b) => /Templates loaded/i.test(b), 120_000, 'nuxi-templates-loaded');
    templatesLoaded = true;
  } catch (e) {
    console.log('[nuxt-real] templates not loaded:', e?.message);
  }
  a.check('nuxi loaded its template registry over the network ("Templates loaded")',
    templatesLoaded, JSON.stringify(stripAnsi(t.buf).slice(-500)));

  // nuxi then drops into the interactive template picker — the honest
  // boundary. Assert we reach it (proving nuxi ran end-to-end up to the
  // point where only interactive input remains).
  let reachedPicker = false;
  try {
    await t.waitFor((b) => /Which template would you like to use/i.test(b), 30_000, 'nuxi-picker');
    reachedPicker = true;
  } catch (e) {
    console.log('[nuxt-real] picker not reached:', e?.message);
  }
  a.check('nuxi reaches the interactive template picker (honest non-interactive boundary)',
    reachedPicker, JSON.stringify(stripAnsi(t.buf).slice(-500)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
