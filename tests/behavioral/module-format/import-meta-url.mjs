#!/usr/bin/env bun
// module-format/import-meta-url — sub-bundle .mjs with `import.meta.url`
// is transformed correctly. Both single-pass and two-pass esbuild paths.
//
// Root cause (audit 2026-05-11-nuxt-import-meta):
//
//   `transformEsmInBundle` in src/facets/manager.ts:1370 calls
//   `esbuild.transform(src, { loader, format, target })` WITHOUT a
//   `define: { 'import.meta.url': ... }` option. Two failure modes:
//
//   A. SINGLE-PASS (file has top-level export but no TLA):
//      esbuild emits a CJS file with `const import_meta = {};` and
//      `import_meta.url` references reduce to `undefined`. Silent wrong
//      behaviour — `fileURLToPath(undefined)` later throws or returns
//      a meaningless path.
//
//   B. TWO-PASS (file has TLA + ESM imports — typical npm-published .mjs):
//      EsbuildService.transform routes through esbuild's `format: 'esm'`
//      pass-1, which PRESERVES `import.meta.url` literally, then wraps
//      the body in an async IIFE. `import.meta` in a function body is
//      a SyntaxError at parse time → "Cannot use 'import.meta' outside
//      a module" at facet pre-compile. This is sveltekit-real's
//      next-layer error from sk-mjs-fix's verdict.
//
// Fix: pass `define: { 'import.meta.url': JSON.stringify(file:/// URL) }`
// per file in `transformEsmInBundle`'s loop. Matches the sibling fix at
// `runtime-registry.ts:386-389` (framework-gaps-fix P5).
//
// Probe asserts:
//   1. synthetic-sibling (single-pass): a .mjs with `export const X =
//      import.meta.url;` required from a consumer.js, X resolves to a
//      `file:///...sib.mjs` URL — NOT undefined.
//   2. synthetic-sibling-tla (two-pass): same file but with top-level
//      await and an imported binding, forcing the TWO-PASS code path.
//      X still resolves to a file:/// URL.
//   3. wild-sv: `npx --yes sv@latest create ...` advances past the
//      import.meta gate (next-layer errors out of scope).

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[module-format/import-meta-url] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('module-format/import-meta-url');

// ── Check 1: synthetic-sibling (single-pass esbuild path) ──────────
//
// `export const X = import.meta.url;` has top-level export → looksLikeEsm
// true. No TLA + no imports → routed to single-pass esbuild
// format:'cjs' transform.
//
// Pre-fix: esbuild emits `const import_meta = {}; const X = import_meta.url;`
//   → X is undefined → consumer prints RESULT=undefined.
// Post-fix: define injects file:///<path> literal → consumer prints
//   RESULT=file:///home/user/imeta/sib.mjs.

await t.run('rm -rf /home/user/imeta && mkdir -p /home/user/imeta', 5_000);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/imeta/sib.mjs', 'export const URL_SENTINEL = import.meta.url;')"`,
  10_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/imeta/consumer.js', 'const m = require(\\'./sib.mjs\\'); console.log(\\'RESULT=\\' + m.URL_SENTINEL);')"`,
  10_000,
);
const siblingResult = await t.run('cd /home/user/imeta && node consumer.js', 30_000);
const sibOut = siblingResult.output;
A.check(
  'synthetic-sibling (single-pass): RESULT is a file:/// URL containing sib.mjs',
  /RESULT=file:\/\/\/[^\s]*sib\.mjs/.test(sibOut),
  `tail: ${sibOut.slice(-500)}`,
);

// ── Check 2: synthetic-sibling-tla (two-pass esbuild path) ─────────
//
// Force the TWO-PASS path: add top-level await + a real top-level import.
// The same .mjs uses import.meta.url. Pre-fix: pass-1 (format:esm)
// preserves `import.meta.url` literally; body wrapped in async IIFE
// → SyntaxError "import.meta outside module" at pre-compile.
// Post-fix: define passed through to pass-1 → URL literal substituted
// before the IIFE wrap.

await t.run('rm -rf /home/user/imeta-tla && mkdir -p /home/user/imeta-tla', 5_000);
const tlaSrc = `
import { join } from 'node:path';
const _x = await Promise.resolve(1);
export const URL_SENTINEL_TLA = import.meta.url;
export const JOIN_TYPE = typeof join;
export const TLA_VAL = _x;
`;
await t.run(`cat > /home/user/imeta-tla/sib.mjs << 'NIMBUS_HEREDOC_EOF'\n${tlaSrc}\nNIMBUS_HEREDOC_EOF`, 10_000);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/imeta-tla/consumer.js', 'const m = require(\\'./sib.mjs\\'); setTimeout(() => console.log(\\'RESULT=\\' + m.URL_SENTINEL_TLA + \\' join=\\' + m.JOIN_TYPE + \\' tla=\\' + m.TLA_VAL), 100);')"`,
  10_000,
);
const tlaResult = await t.run('cd /home/user/imeta-tla && node consumer.js', 30_000);
const tlaOut = tlaResult.output;
A.check(
  'synthetic-sibling-tla (two-pass): NO "Cannot use \'import.meta\' outside a module"',
  !/Cannot use 'import\.meta' outside a module/.test(tlaOut),
  `tail: ${tlaOut.slice(-500)}`,
);
A.check(
  'synthetic-sibling-tla (two-pass): RESULT is a file:/// URL containing sib.mjs (with join + tla intact)',
  /RESULT=file:\/\/\/[^\s]*sib\.mjs/.test(tlaOut) && /join=function/.test(tlaOut) && /tla=1/.test(tlaOut),
  `tail: ${tlaOut.slice(-500)}`,
);

// ── Check 3: wild-sv ────────────────────────────────────────────────
//
// sv@0.15.3 engine.mjs hit the two-pass + import.meta crash post sk-mjs-fix.
// We verify the import.meta gate is gone. Next-layer scaffold success
// is OUT OF SCOPE for this wave.

await t.run('rm -rf /home/user/sv-probe && mkdir -p /home/user/sv-probe && cd /home/user/sv-probe', 5_000);
const svRun = await t.run(
  'npx --yes sv@latest create mvp --template minimal --types ts --no-add-ons --no-install',
  360_000,
);
const svOut = svRun.output;

A.check(
  'wild-sv: NO "Cannot use \'import.meta\' outside a module" in sv invocation',
  !/Cannot use 'import\.meta' outside a module/.test(svOut),
  `tail: ${svOut.slice(-700)}`,
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
