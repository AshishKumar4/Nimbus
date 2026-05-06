// X.5-S functional probe helper. Loads the generated facet templates AND
// the shim source so probes can do source-text + targeted IIFE-extraction
// assertions on the conditional-param-drop helper.
//
// Mirrors audit/probes/x5m3/functional/_eval-shims.mjs in spirit.

import { generateShimsCode } from '../../../../src/node-shims.ts';
import * as facetMod from '../../../../src/facet-manager.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACET_SRC = path.resolve(HERE, '../../../../src/facet-manager.ts');

export function getShimSource() {
  return generateShimsCode();
}

export function getFacetManagerSource() {
  return fs.readFileSync(FACET_SRC, 'utf8');
}

/**
 * Locate the X.5-S conditional-param-drop helper in the shim source and
 * evaluate it directly. Returns the wrapper fn or null if marker absent
 * (RED state).
 *
 * Marker convention (set by Phase D fix): the helper is named
 * `__mkCompiledFn` and bears an `// X.5-S` block comment within or
 * directly above its body so the probe can locate it.
 */
export function loadShimMkCompiledFn() {
  const src = getShimSource();
  const marker = 'X.5-S';
  if (!src.includes(marker)) return null;
  // Helper body is small + self-contained; evaluate the entire shim
  // module body would be heavyweight (it pulls in the full SHIMS bundle
  // with VFS hooks). Instead, extract by named-function pattern.
  const fnIdx = src.indexOf('function __mkCompiledFn');
  if (fnIdx < 0) return null;
  // Find matching closing brace.
  let depth = 0;
  let i = src.indexOf('{', fnIdx);
  if (i < 0) return null;
  const start = fnIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const fnSrc = src.slice(start, i);
  // Eval into a fresh closure. The helper depends only on `new Function`
  // and a regex; nothing external.
  const factory = new Function(`${fnSrc}; return __mkCompiledFn;`);
  return factory();
}

/**
 * Locate the same helper in the facet-manager.ts generated facet code
 * template strings. Both `generateFacetCode` and `generateEntrypointCode`
 * must contain the helper; this probe asserts that.
 */
export function facetTemplatesHaveMkCompiledFn() {
  const src = getFacetManagerSource();
  const inFacet = /generateFacetCode[\s\S]*?function __mkCompiledFn[\s\S]*?generateEntrypointCode/m.test(src);
  const inEntry = /generateEntrypointCode[\s\S]*?function __mkCompiledFn/m.test(src);
  return { inFacet, inEntry };
}
