#!/usr/bin/env bun
// frameworks/nuxt-real — honest-boundary probe for `nuxi init`.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npx nuxi@latest init mvp --no-install --packageManager=npm
//
// Boundary (documented, not faked): nuxi@3.36 added an explicit
// non-interactive mode. Nimbus has no native TTY, so nuxi now requires every
// prompt-backed argument and rejects this invocation because it omits
// `--gitInit`. In June, nuxi@3.35 instead reached the interactive template
// picker. Nimbus' thrown process.exit(2) sentinel is caught by citty's
// runMain and printed as a Consola error trace after the useful diagnostic.
//
// What this probe PROVES (the real, useful capability): nuxi runs under
// Nimbus, loads its template registry over the network ("Templates
// loaded"), and reaches its current argument validation — exercising
// outbound fetch plus the startup-drain timer tracking that keeps the facet
// alive across the registry fetch (without it the facet exited at "Loading
// available templates" before the fetch settled). nuxi's exact
// missing-argument diagnostic is the current honest boundary.

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

  // Since nuxi 3.36, a terminal without a native TTY is handled as explicitly
  // non-interactive instead of entering the template picker.
  let reachedNonInteractiveBoundary = false;
  try {
    await t.waitFor(
      (b) => /Non-interactive terminal detected[\s\S]*Missing required argument:\s*--gitInit/i.test(b),
      30_000,
      'nuxi-missing-git-init',
    );
    reachedNonInteractiveBoundary = true;
  } catch (e) {
    console.log('[nuxt-real] non-interactive boundary not reached:', e?.message);
  }
  a.check('nuxi reports --gitInit as required in Nimbus non-interactive mode (current honest boundary)',
    reachedNonInteractiveBoundary, JSON.stringify(stripAnsi(t.buf).slice(-800)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
