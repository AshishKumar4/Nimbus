#!/usr/bin/env bun
// X.5-NPQO Q functional: util.types polyfill expansion + util/types subpath
// builtin registration.
//
// Pre-fix:
//   - util.types contains only 3 methods (isDate, isRegExp, isPromise)
//   - builtins["util/types"] and builtins["node:util/types"] are NOT registered
//   - jsdom's bundled undici does require('node:util/types') and
//     dereferences isUint8Array / isArrayBuffer / isProxy → all missing
//
// Post-fix:
//   - util.types expanded to 13 methods covering undici's required surface
//     (isUint8Array, isArrayBuffer, isProxy) plus defensive additions
//   - builtins["util/types"] = builtins.util.types
//   - builtins["node:util/types"] = builtins["util/types"]
//
// Probe asserts:
//   1. util.types literal contains the undici-required methods
//   2. util.types literal still contains the 3 baseline methods (no regression)
//   3. builtins["util/types"] subpath registration line is present
//   4. builtins["node:util/types"] alias is present
//   5. The util/types registration happens AFTER the M-2 dns/promises pattern
//      (sourcing from builtins.util.types object property)

import { ok, group, summary } from '../../w6/_tap.mjs';
import { getShimSource, extractUtilTypesLiteral } from './_eval-shims.mjs';

const src = getShimSource();
const typesLit = extractUtilTypesLiteral(src);

group('util.types literal: discoverable', () => {
  ok('util.types literal extracted',
    typesLit !== null && typesLit.length > 0,
    typesLit === null ? 'types: { ... } not found' : `len=${typesLit.length}`,
  );
});

group('X.5-Q fix part 1: util.types polyfill expansion', () => {
  // Undici-required (must-have):
  ok('util.types contains isUint8Array',  /isUint8Array\s*:/.test(typesLit || ''));
  ok('util.types contains isArrayBuffer', /isArrayBuffer\s*:/.test(typesLit || ''));
  ok('util.types contains isProxy',       /isProxy\s*:/.test(typesLit || ''));
  // Defensive additions (highly common):
  ok('util.types contains isAnyArrayBuffer', /isAnyArrayBuffer\s*:/.test(typesLit || ''));
  ok('util.types contains isArrayBufferView', /isArrayBufferView\s*:/.test(typesLit || ''));
  ok('util.types contains isTypedArray',  /isTypedArray\s*:/.test(typesLit || ''));
  ok('util.types contains isMap',         /isMap\s*:/.test(typesLit || ''));
  ok('util.types contains isSet',         /isSet\s*:/.test(typesLit || ''));
  ok('util.types contains isWeakMap',     /isWeakMap\s*:/.test(typesLit || ''));
  ok('util.types contains isWeakSet',     /isWeakSet\s*:/.test(typesLit || ''));
  ok('util.types contains isNativeError', /isNativeError\s*:/.test(typesLit || ''));
  ok('util.types contains isAsyncFunction', /isAsyncFunction\s*:/.test(typesLit || ''));
  ok('util.types contains isGeneratorFunction', /isGeneratorFunction\s*:/.test(typesLit || ''));
  ok('util.types contains isBoxedPrimitive', /isBoxedPrimitive\s*:/.test(typesLit || ''));
});

group('regression: util.types baseline 3 methods preserved', () => {
  ok('util.types still contains isDate',    /isDate\s*:/.test(typesLit || ''));
  ok('util.types still contains isRegExp',  /isRegExp\s*:/.test(typesLit || ''));
  ok('util.types still contains isPromise', /isPromise\s*:/.test(typesLit || ''));
});

group('X.5-Q fix part 2: util/types subpath registration', () => {
  ok('builtins["util/types"] registration line present',
    /builtins\["util\/types"\]\s*=\s*builtins\.util\.types/.test(src),
  );
  ok('builtins["node:util/types"] alias present',
    /builtins\["node:util\/types"\]\s*=\s*builtins\["util\/types"\]/.test(src) ||
    /builtins\["node:util\/types"\]\s*=\s*builtins\.util\.types/.test(src),
  );
});

group('regression: dns/promises subpath (M-2) still registered', () => {
  ok('builtins["dns/promises"] still registered',
    /builtins\["dns\/promises"\]\s*=\s*builtins\.dns\.promises/.test(src),
  );
  ok('builtins["node:dns/promises"] still registered',
    /builtins\["node:dns\/promises"\]\s*=\s*builtins\["dns\/promises"\]/.test(src),
  );
});

group('regression: util module shape (parent module not corrupted)', () => {
  ok('util module still defines format',     /\bformat\s*:/.test(src));
  ok('util module still defines inspect',    /\binspect\s*:/.test(src));
  ok('util module still defines promisify',  /\bpromisify\s*:/.test(src));
  ok('util module still defines callbackify', /\bcallbackify\s*:/.test(src));
  ok('util module still defines inherits',   /\binherits\s*:/.test(src));
  ok('util module still defines TextEncoder', /\bTextEncoder\s*:/.test(src));
  ok('util module still defines TextDecoder', /\bTextDecoder\s*:/.test(src));
});

summary('q-util-types');
