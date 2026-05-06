// X.5-NPQO functional probe helper. Mirrors x5m/functional/_eval-shims.mjs.
//
// The generated shim source is a heavy template referencing many runner-side
// globals (__supervisor, __ws, etc.) so we can't directly eval the whole
// thing. Functional probes therefore work primarily by:
//   (a) source-text presence/structure assertions (regex over generated source)
//   (b) targeted IIFE / object-literal extraction where feasible

import { generateShimsCode } from '../../../../src/node-shims.ts';

export function getShimSource() {
  return generateShimsCode();
}

/**
 * Locate the `types: { ... }` object literal inside the __utilMod object,
 * extract it, and return the source slice of the literal (including
 * surrounding braces). Returns null if not found.
 *
 * Used by Q functional probe to assert the polyfill expansion landed.
 */
export function extractUtilTypesLiteral(source) {
  // Anchor: look for the line `types: {` preceded by the util module
  // surrounding context. The util module is __utilMod and contains the
  // `types:` key in its object literal. We grep for `types: {` (which
  // occurs only once in the file) and walk forward until the matching
  // closing `}`.
  const idx = source.indexOf('types: {');
  if (idx < 0) return null;
  let depth = 0;
  let i = idx + 'types: '.length;
  let firstBrace = -1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') {
      if (firstBrace < 0) firstBrace = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return source.slice(firstBrace, i);
}

/**
 * Locate and extract the body source of `function __resolveFrom(id, fromDir)`.
 * Returns the function source including signature + body.
 *
 * Used by P functional probe to assert the literal `.`/`..` normalization
 * landed at the right place.
 */
export function extractResolveFromFn(source) {
  const sig = 'function __resolveFrom(id, fromDir)';
  const idx = source.indexOf(sig);
  if (idx < 0) return null;
  // Walk to the first `{`, then match braces.
  let i = source.indexOf('{', idx);
  if (i < 0) return null;
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

/**
 * Locate and extract the body source of the fs `_resolve` helper inside the
 * __fsMod IIFE. The __fsMod IIFE contains a single `function _resolve(p)`.
 * Return the function source.
 *
 * Used by O functional probe to assert the file:// stripping landed.
 */
export function extractFsResolveFn(source) {
  const sig = 'function _resolve(p)';
  const idx = source.indexOf(sig);
  if (idx < 0) return null;
  let i = source.indexOf('{', idx);
  if (i < 0) return null;
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}
