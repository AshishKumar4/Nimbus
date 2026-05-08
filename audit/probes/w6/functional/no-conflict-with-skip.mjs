// W6 functional: no overlap between WASM_SWAPS / REJECT_INSTALL(fail) and
// SKIP_PACKAGES, except for an explicit allowlist (transitive='warn'
// rejects that intentionally double up so SKIP-prunes them transitively
// while top-level rejects loudly).
//
// Plan §4.0 + §10 risk row.

import { ok, eq, group, summary } from '../_tap.mjs';

let registry;
try {
  registry = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/functional/no-conflict-with-skip');
}

let resolverMod;
try {
  resolverMod = await import('../../../../src/npm/resolver.ts');
} catch (e) {
  ok('npm-resolver module exists', false, e.message);
  summary('w6/functional/no-conflict-with-skip');
}

const { WASM_SWAPS, REJECT_INSTALL } = registry;
const { shouldSkipPackage } = resolverMod;

// Names allowed to be in BOTH SKIP_PACKAGES (silent prune for transitives)
// AND REJECT_INSTALL (loud at top level). All must be transitive='warn'.
const INTENTIONAL_OVERLAP = new Set(['node-gyp', 'node-pre-gyp']);

group('WASM_SWAPS.from disjoint from SKIP_PACKAGES', () => {
  for (const e of WASM_SWAPS) {
    ok(`${e.from} NOT skipped (would mask the swap)`, !shouldSkipPackage(e.from));
  }
});

group('REJECT_INSTALL(fail).from disjoint from SKIP_PACKAGES', () => {
  for (const e of REJECT_INSTALL) {
    if (e.transitive === 'fail') {
      ok(`${e.from} NOT skipped (would mask the reject)`, !shouldSkipPackage(e.from));
    }
  }
});

group('REJECT_INSTALL(warn).from overlap with SKIP_PACKAGES is allowlisted', () => {
  for (const e of REJECT_INSTALL) {
    if (e.transitive === 'warn' && shouldSkipPackage(e.from)) {
      ok(
        `${e.from} overlap is intentional (in INTENTIONAL_OVERLAP allowlist)`,
        INTENTIONAL_OVERLAP.has(e.from),
        `${e.from} is both in SKIP_PACKAGES and REJECT_INSTALL(warn) but not in the documented allowlist`
      );
    }
  }
});

group('esbuild and fsevents specifically NOT skipped', () => {
  // These were moved out of SKIP_PACKAGES per plan §4.0
  ok('esbuild NOT in SKIP_PACKAGES anymore', !shouldSkipPackage('esbuild'));
  ok('fsevents NOT in SKIP_PACKAGES anymore', !shouldSkipPackage('fsevents'));
});

summary('w6/functional/no-conflict-with-skip');
