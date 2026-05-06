#!/usr/bin/env bun
// X5G functional: classifyInstallError distinguishes recoverable
// optional-dep failures from real failures.
//
// Used by the resolver to NOT propagate a fetch-fail for an
// `optionalDependencies` entry as a hard install fail.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

group('helper exists', () => {
  ok('exports classifyInstallError', typeof reg.classifyInstallError === 'function');
});

if (typeof reg.classifyInstallError !== 'function') {
  console.log('# X5G classifyInstallError not implemented yet — TDD red phase');
  summary('error-classification (RED)');
}

const fn = reg.classifyInstallError;

group('optional-dep skip is recoverable', () => {
  eq('platform mismatch (os) → optional-dep-skip',
    fn(new Error('platform mismatch'), { isOptional: true }),
    'optional-dep-skip');
  eq('optional 404 → optional-dep-skip',
    fn(new Error('not found'), { isOptional: true }),
    'optional-dep-skip');
});

group('non-optional fetch-fail is real', () => {
  eq('fetch fail on required dep → real-resolve-fail',
    fn(new Error('fetch failed'), { isOptional: false }),
    'real-resolve-fail');
});

group('registry reject is loud-reject', () => {
  const e = new Error('rejected');
  e.__w6_reject = true;
  eq('registry-reject error → registry-reject',
    fn(e, { isOptional: false }),
    'registry-reject');
});

group('default optional-flag absent', () => {
  eq('no isOptional → real-resolve-fail (conservative)',
    fn(new Error('something'), {}),
    'real-resolve-fail');
});

summary('error-classification');
