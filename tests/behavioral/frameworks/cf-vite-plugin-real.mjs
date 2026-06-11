#!/usr/bin/env bun
// frameworks/cf-vite-plugin-real — honest-boundary probe for
// @cloudflare/vite-plugin.
//
// Category: R (runtime-behavioral)
//
// User scenario:
//   npm create vite@latest mvp -- --template react-ts --yes
//   cd mvp && npm install
//   npm install @cloudflare/vite-plugin
//
// Boundary: @cloudflare/vite-plugin hard-depends on native `sharp`
// (libvips bindings) for its asset pipeline. sharp ships only
// platform-native shards — there is no Workers-executable build — so
// Nimbus correctly REJECTS the install with a precise, actionable ABI
// diagnostic rather than installing a broken plugin that would explode
// at dev-server start.
//
// This is a genuine native boundary (libvips/ABI), the same class as
// agentic-cli/new/opencode-native-bin-diagnostic. Wiring an
// @img/sharp-wasm32 swap is a separate, large capability and the plugin
// does not request the wasm build. The meaningful GREEN here is that the
// boundary is surfaced loudly and correctly: the Vite scaffold + base
// install still work, and the plugin install fails with the named-sharp
// diagnostic instead of silently producing a broken project.

import { Terminal, mintSession, sleep, stripAnsi, deleteSession, makeAsserter, BASE } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('cf-vite-plugin-real');

const sid = await mintSession();
console.log(`[cf-vite-plugin-real] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  // ── Phase 1: npm create vite (react-ts) ────────────────────────────
  await t.run('mkdir -p /home/user/cfvite-probe && cd /home/user/cfvite-probe', 10_000);
  console.log('[cf-vite-plugin-real] npm create vite@latest...');
  await t.run('npm create vite@latest mvp -- --template react-ts --yes', 240_000);

  const pkgCheck = await t.run(
    `node -e "var fs=require('fs');try{var p=JSON.parse(fs.readFileSync('mvp/package.json','utf8'));console.log('PKG_OK='+(p.devDependencies?.vite?'yes':'no'));}catch(e){console.log('PKG_OK=err:'+e.message);}"`,
    20_000,
  );
  const createSucceeded = /PKG_OK=yes/.test(stripAnsi(pkgCheck.output));
  a.check('npm create vite scaffolded a react-ts project with a vite dep', createSucceeded);

  await t.run('cd /home/user/cfvite-probe/mvp', 10_000);

  // ── Phase 2: base npm install ──────────────────────────────────────
  console.log('[cf-vite-plugin-real] npm install...');
  const installR = await t.run('npm install', 600_000);
  const installSucceeded = /added\s+\d+\s+packages|installed\s+\d+\s+packages|up to date/i.test(installR.output)
    && !/npm install failed/i.test(installR.output);
  a.check('base npm install completed (react + vite deps)', installSucceeded,
    stripAnsi(installR.output).split(/\r?\n/).slice(-4).join(' | '));

  // ── Phase 3: install @cloudflare/vite-plugin → native sharp boundary ─
  console.log('[cf-vite-plugin-real] npm install @cloudflare/vite-plugin (expecting sharp boundary)...');
  const pluginR = await t.run('npm install @cloudflare/vite-plugin', 300_000);
  const out = stripAnsi(pluginR.output);

  // Honest boundary: install must FAIL with the named-sharp native ABI
  // diagnostic, NOT silently succeed (which would yield a broken plugin).
  const rejected = /not supported on Nimbus/i.test(out);
  const namesSharp = /sharp\b/.test(out);
  const namesLibvips = /libvips|Native libvips bindings|not portable to Workers/i.test(out);
  const didNotInstall = !/added\s+\d+\s+packages/i.test(out);

  a.check('plugin install is rejected with the Nimbus unsupported-package diagnostic',
    rejected, JSON.stringify(out.slice(-1400)));
  a.check('diagnostic names the native culprit: sharp / libvips',
    namesSharp && namesLibvips, JSON.stringify(out.slice(-1400)));
  a.check('plugin did NOT silently install a broken native dependency',
    didNotInstall, JSON.stringify(out.slice(-600)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
