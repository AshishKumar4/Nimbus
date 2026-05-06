#!/usr/bin/env bun
// X.5-S functional probe #2: behavioural invariant.
//
// Extract __mkCompiledFn from the shim source and evaluate it directly
// against esbuild-shaped CJS output. The helper must:
//   - parse without "Identifier '__dirname' has already been declared"
//   - return a function that, when invoked, sees the body's
//     `const __dirname = ...` (not the param shadow)
//   - work symmetrically for __filename
//
// Pre-fix (RED): __mkCompiledFn does not exist → loadShimMkCompiledFn
// returns null → fail.
// Post-fix (GREEN): assertions all pass.

import { ok, eq, group, summary } from '../_tap.mjs';
import { loadShimMkCompiledFn } from './_eval-shims.mjs';

const mk = loadShimMkCompiledFn();

if (!mk) {
  group('SKIP: X.5-S helper missing — RED state', () => {
    ok('FIX-NOT-APPLIED: __mkCompiledFn must exist in node-shims.ts shim source',
      false);
  });
  summary('f2-eval-no-collision');
}

const ESBUILD_LIKE_OUTPUT = `
"use strict";
const __dirname = "/foo/bar";
exports.dir = __dirname;
exports.fn = "/foo/bar/file.js";
`;

group('esbuild-shaped body with const __dirname does NOT collide', () => {
  let fn, threw = null;
  try { fn = mk(ESBUILD_LIKE_OUTPUT); } catch (e) { threw = e; }
  ok('helper parsed body without SyntaxError',
    threw === null,
    threw && threw.message);
  if (fn) {
    const mod = { exports: {} };
    let exportsObj = mod.exports;
    let runErr = null;
    try {
      // Caller still passes 5 positional args; helper drops the trailing
      // ones it didn't declare as params.
      fn(exportsObj, () => ({}), mod, "/wrong-fn", "/wrong-dn");
    } catch (e) { runErr = e; }
    ok('body executed without runtime error', runErr === null,
      runErr && runErr.message);
    eq('body __dirname binding wins (not the dropped param)',
      mod.exports.dir, "/foo/bar");
  }
});

group('body declaring __filename also drops the param', () => {
  const code = `
"use strict";
const __filename = "/x.js";
const __dirname = "/x";
exports.fn = __filename;
exports.dn = __dirname;
`;
  let fn, threw = null;
  try { fn = mk(code); } catch (e) { threw = e; }
  ok('helper parsed body declaring both __filename and __dirname',
    threw === null,
    threw && threw.message);
  if (fn) {
    const mod = { exports: {} };
    fn(mod.exports, () => ({}), mod, "/wrong", "/wrong");
    eq('body __filename wins', mod.exports.fn, "/x.js");
    eq('body __dirname wins',  mod.exports.dn, "/x");
  }
});

group('control: body without __dirname keeps the param injection', () => {
  // Plain CJS that uses __dirname without declaring it must still work
  // — the helper preserves the param when no shadowing declaration exists.
  const code = `
"use strict";
exports.dir = __dirname;
exports.fn  = __filename;
`;
  let fn, threw = null;
  try { fn = mk(code); } catch (e) { threw = e; }
  ok('helper parsed plain CJS body', threw === null, threw && threw.message);
  if (fn) {
    const mod = { exports: {} };
    fn(mod.exports, () => ({}), mod, "/x.js", "/x");
    eq('plain body sees injected __dirname', mod.exports.dir, "/x");
    eq('plain body sees injected __filename', mod.exports.fn, "/x.js");
  }
});

summary('f2-eval-no-collision');
