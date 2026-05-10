#!/usr/bin/env bun
// runtime-pkg/strict-mode-bin — G2 probe.
//
// Cowsay's CLI uses dynamic require + a top-level `if (require.main
// === module)` guard plus various strict-mode patterns. On prod
// 8791a51a, `npx cowsay -- hi` installs the package, starts the
// facet, but produces NO OUTPUT — cowsay's main() never runs.
//
// Hypothesis: `require.main === module` is false in our facet runtime
// because we don't set `require.main`. The cowsay CLI bails silently
// when that check fails (treats the module as imported, not invoked).
//
// Fix shape (queue spec): esbuild pre-transform for .js when shape
// suggests strict-mode pragmas / unusual regex. ALTERNATIVE: set
// require.main === module correctly in the bin entry path. This
// probe asserts the OBSERVABLE outcome (cowsay produces ascii art),
// not the implementation.
//
// Test bins:
//   1. cowsay — classic CLI with require.main check
//   2. A custom local "self-aware" bin that explicitly checks
//      require.main; asserts our shim sets it correctly. This
//      isolates the require.main fix from cowsay's other quirks.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[G2] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

await t.run('mkdir -p /home/user/g2-probe', 5_000);
await t.run('cd /home/user/g2-probe', 5_000);
await t.run('node -e "require(\'fs\').writeFileSync(\'package.json\', JSON.stringify({name:\'p\',version:\'1.0.0\'}))"', 10_000);

// ── Test 1: custom self-aware bin — explicitly checks require.main ──
//
// We control this bin; if require.main is correctly set when the bin
// is invoked, it prints "MAIN-OK"; otherwise prints "MAIN-FAIL" and
// exits 1.
await t.run('mkdir -p node_modules/.bin', 5_000);
const selfAware =
  '#!/usr/bin/env node\n' +
  '"use strict";\n' +
  'if (require.main === module) {\n' +
  '  console.log("MAIN-OK");\n' +
  '  process.exit(0);\n' +
  '}\n' +
  'console.log("MAIN-FAIL");\n' +
  'process.exit(1);\n';
const selfAwareB64 = Buffer.from(selfAware, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('node_modules/.bin/selfaware', Buffer.from('${selfAwareB64}','base64').toString('utf8'))"`,
  10_000,
);
const r1 = await t.run('selfaware', 30_000);
const r1Out = stripAnsi(r1.output);
const t1RequireMainOk = /MAIN-OK/.test(r1Out) && !/MAIN-FAIL/.test(r1Out);

// ── Test 2: cowsay (real-world) ──
const r2 = await t.run('npx cowsay -- hi-from-g2', 240_000);
const r2Out = stripAnsi(r2.output);
// cowsay prints ASCII-art:
//
//    _____________
//   < hi-from-g2 >
//    -------------
//          \   ^__^
//           \  (oo)\_______
//   ...
//
// We look for the bubble border (-----) or the cow body (^__^).
const t2HasArt = /-{3,}|\^__\^|hi-from-g2/.test(r2Out) &&
                 // Make sure it's not just the user's command echo:
                 (r2Out.match(/hi-from-g2/g) || []).length >= 2;

// ── Test 3: another small CLI with strict-mode pragma + class field ──
//
// Verifies our pre-transform handles modern syntax. Uses
// "use strict"; class with private field; arrow fn.
const modernSyntax =
  '#!/usr/bin/env node\n' +
  '"use strict";\n' +
  'class Foo {\n' +
  '  #x = 42;\n' +
  '  greet() { return `MOD-${this.#x}`; }\n' +
  '}\n' +
  'const f = new Foo();\n' +
  'console.log(f.greet());\n' +
  'process.exit(0);\n';
const modernB64 = Buffer.from(modernSyntax, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('node_modules/.bin/modern', Buffer.from('${modernB64}','base64').toString('utf8'))"`,
  10_000,
);
const r3 = await t.run('modern', 30_000);
const r3Out = stripAnsi(r3.output);
const t3ModernOk = /MOD-42/.test(r3Out);

await t.close();

const findings = {
  gap: 'G2',
  sid,
  base: BASE,
  tests: {
    requireMainBin: { ok: t1RequireMainOk, head: r1Out.slice(-300) },
    cowsay: { ok: t2HasArt, head: r2Out.slice(-500) },
    modernSyntaxBin: { ok: t3ModernOk, head: r3Out.slice(-300) },
  },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['bin self-aware: require.main === module ⇒ MAIN-OK', t1RequireMainOk],
  ['cowsay produces ASCII-art (or > 1 occurrence of arg)',  t2HasArt],
  ['strict-mode + class private field bin runs',            t3ModernOk],
];
let pass = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[G2] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
