// W6 functional: WASM_SWAPS / REJECT_INSTALL shape contract.
//
// Asserts:
//   - exports exist
//   - every entry has required fields
//   - WASM_SWAPS.from and REJECT_INSTALL.from sets are disjoint
//   - swap.compat is one of the allowed literals
//   - reject.transitive is 'fail' | 'warn'

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/functional/registry-shape');
}

const { WASM_SWAPS, REJECT_INSTALL } = mod;

group('module exports', () => {
  ok('WASM_SWAPS exported', Array.isArray(WASM_SWAPS));
  ok('REJECT_INSTALL exported', Array.isArray(REJECT_INSTALL));
  ok('WASM_SWAPS non-empty', WASM_SWAPS.length >= 1);
  ok('REJECT_INSTALL non-empty', REJECT_INSTALL.length >= 5);
});

group('WASM_SWAPS entry shape', () => {
  for (const e of WASM_SWAPS) {
    ok(`swap.from is non-empty string (${e.from})`, typeof e.from === 'string' && e.from.length > 0);
    ok(`swap.to is non-empty string (${e.from} → ${e.to})`, typeof e.to === 'string' && e.to.length > 0);
    ok(`swap.reason present (${e.from})`, typeof e.reason === 'string' && e.reason.length > 0);
    ok(`swap.compat is allowed literal (${e.from})`, e.compat === 'drop-in' || e.compat === 'shim' || e.compat === 'manual');
    ok(`swap from!=to (${e.from})`, e.from !== e.to);
  }
});

group('REJECT_INSTALL entry shape', () => {
  for (const e of REJECT_INSTALL) {
    ok(`reject.from is non-empty string (${e.from})`, typeof e.from === 'string' && e.from.length > 0);
    ok(`reject.reason present (${e.from})`, typeof e.reason === 'string' && e.reason.length > 0);
    ok(`reject.transitive is 'fail' | 'warn' (${e.from})`, e.transitive === 'fail' || e.transitive === 'warn');
    if (e.suggest !== undefined) {
      ok(`reject.suggest is string when present (${e.from})`, typeof e.suggest === 'string' && e.suggest.length > 0);
    }
  }
});

group('disjoint sets', () => {
  const swapFroms = new Set(WASM_SWAPS.map(e => e.from));
  const rejectFroms = new Set(REJECT_INSTALL.map(e => e.from));
  const overlap = [...swapFroms].filter(f => rejectFroms.has(f));
  eq('WASM_SWAPS.from ∩ REJECT_INSTALL.from is empty', overlap, []);
});

group('uniqueness within each list', () => {
  const swapFroms = WASM_SWAPS.map(e => e.from);
  const swapDupes = swapFroms.filter((f, i) => swapFroms.indexOf(f) !== i);
  eq('no duplicate WASM_SWAPS.from', swapDupes, []);
  const rejectFroms = REJECT_INSTALL.map(e => e.from);
  const rejectDupes = rejectFroms.filter((f, i) => rejectFroms.indexOf(f) !== i);
  eq('no duplicate REJECT_INSTALL.from', rejectDupes, []);
});

group('expected entries present (sanity)', () => {
  const swapFroms = new Set(WASM_SWAPS.map(e => e.from));
  ok('esbuild is in WASM_SWAPS', swapFroms.has('esbuild'));
  const rejectFroms = new Set(REJECT_INSTALL.map(e => e.from));
  // The plan-level minimum reject set
  for (const must of ['sharp', 'sqlite3', 'better-sqlite3', 'fsevents', 'prisma', '@prisma/client', 'puppeteer', 'playwright', 'bcrypt', 'argon2']) {
    ok(`${must} is in REJECT_INSTALL`, rejectFroms.has(must));
  }
});

summary('w6/functional/registry-shape');
