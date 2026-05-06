#!/usr/bin/env bun
// X.5-S functional probe #1: source-text invariant.
//
// The fix introduces a `__mkCompiledFn` helper that conditionally drops
// the `__filename` / `__dirname` params from `new Function` when the body
// declares them. The helper must appear in:
//   - src/node-shims.ts (runtime fallback __loadModule path)
//   - src/facet-manager.ts generateFacetCode template (hot path)
//   - src/facet-manager.ts generateEntrypointCode template (LOADER.load fallback)
//
// Pre-fix (RED): no `X.5-S` marker, no `__mkCompiledFn` symbol → fail.
// Post-fix (GREEN): marker present in shim source AND both facet templates.

import { ok, group, summary } from '../_tap.mjs';
import {
  getShimSource,
  getFacetManagerSource,
  facetTemplatesHaveMkCompiledFn,
} from './_eval-shims.mjs';

const shim = getShimSource();
const fmgr = getFacetManagerSource();

group('X.5-S marker present in shim source', () => {
  ok('node-shims.ts shim source contains "X.5-S" marker',
    shim.includes('X.5-S'));
  ok('node-shims.ts shim source defines `__mkCompiledFn`',
    /function __mkCompiledFn/.test(shim));
  ok('node-shims.ts no longer hard-codes __dirname in __loadModule fallback `new Function(...)`',
    // The runtime fallback at line ~2312 should now use __mkCompiledFn,
    // not the inline `new Function("exports","require","module","__filename","__dirname", code)`.
    // Strip comments first to avoid false-positives from the helper docstring.
    !/new Function\(\s*"exports"\s*,\s*"require"\s*,\s*"module"\s*,\s*"__filename"\s*,\s*"__dirname"\s*,\s*code\s*\)/m.test(
      shim.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'),
    ));
});

group('X.5-S marker present in facet-manager.ts source', () => {
  ok('facet-manager.ts contains "X.5-S" marker', fmgr.includes('X.5-S'));
  // The facet templates emit the helper as part of the generated facet
  // code; presence in both template strings is required.
  const t = facetTemplatesHaveMkCompiledFn();
  ok('generateFacetCode template embeds __mkCompiledFn', t.inFacet);
  ok('generateEntrypointCode template embeds __mkCompiledFn', t.inEntry);
});

group('regex sniff covers both __dirname and __filename', () => {
  // The regex pattern must match `const __dirname = ...`, `let __dirname = ...`,
  // and `var __dirname = ...` at top-level of the body. Same for __filename.
  // Confirm via source-text check that the shim helper references both.
  ok('helper checks __dirname declaration',
    /__dirname/.test(shim.slice(shim.indexOf('function __mkCompiledFn'),
      shim.indexOf('function __mkCompiledFn') + 800)));
  ok('helper checks __filename declaration',
    /__filename/.test(shim.slice(shim.indexOf('function __mkCompiledFn'),
      shim.indexOf('function __mkCompiledFn') + 800)));
});

summary('f1-conditional-param-drop-marker');
