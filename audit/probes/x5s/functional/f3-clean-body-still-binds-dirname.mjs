#!/usr/bin/env bun
// X.5-S functional probe #3: invariant guard for plain CJS modules.
//
// The conditional-drop must NOT regress modules that use __dirname /
// __filename without declaring them. This is the single most-likely
// regression vector — most published CJS in node_modules expects
// `__dirname` to be a free variable bound by Node's wrapper.
//
// We exercise a synthetic body (no `const __dirname = …`) and assert
// that the helper still injects the param so the body reads it
// correctly. The probe runs as both pre-fix-relevant (the regex must
// be specific enough not to overmatch) and post-fix-relevant.

import { ok, eq, group, summary } from '../_tap.mjs';
import { loadShimMkCompiledFn } from './_eval-shims.mjs';

const mk = loadShimMkCompiledFn();

if (!mk) {
  group('SKIP: X.5-S helper missing — RED state', () => {
    ok('FIX-NOT-APPLIED: __mkCompiledFn must exist', false);
  });
  summary('f3-clean-body-still-binds-dirname');
}

group('plain CJS — __dirname is the injected param', () => {
  const code = `
exports.x = __dirname;
exports.y = __filename;
`;
  const fn = mk(code);
  const mod = { exports: {} };
  fn(mod.exports, () => ({}), mod, "/abs/file.js", "/abs");
  eq('__dirname injection', mod.exports.x, "/abs");
  eq('__filename injection', mod.exports.y, "/abs/file.js");
});

group('false-positive guard — strings containing "__dirname"', () => {
  // The regex must NOT match "__dirname" inside strings or comments
  // (those don't actually declare the binding).
  const code = `
const note = "this code uses __dirname for path resolution";
const banner = '// const __dirname = "fake"';
exports.dir = __dirname;
exports.note = note;
`;
  const fn = mk(code);
  const mod = { exports: {} };
  fn(mod.exports, () => ({}), mod, "/abs/file.js", "/abs/dir");
  eq('__dirname still injected (regex did not over-match)',
    mod.exports.dir, "/abs/dir");
});

group('positive — top-level `const __dirname = …` triggers drop', () => {
  const code = `
const __dirname = "/special";
exports.x = __dirname;
`;
  const fn = mk(code);
  const mod = { exports: {} };
  fn(mod.exports, () => ({}), mod, "/abs/file.js", "/abs");
  eq('body declaration wins', mod.exports.x, "/special");
});

group('positive — top-level `let __dirname = …` triggers drop', () => {
  const code = `
let __dirname = "/letdir";
exports.x = __dirname;
`;
  const fn = mk(code);
  const mod = { exports: {} };
  fn(mod.exports, () => ({}), mod, "/abs/file.js", "/abs");
  eq('let-declaration wins', mod.exports.x, "/letdir");
});

group('positive — top-level `var __dirname = …` triggers drop', () => {
  const code = `
var __dirname = "/vardir";
exports.x = __dirname;
`;
  const fn = mk(code);
  const mod = { exports: {} };
  fn(mod.exports, () => ({}), mod, "/abs/file.js", "/abs");
  eq('var-declaration wins', mod.exports.x, "/vardir");
});

summary('f3-clean-body-still-binds-dirname');
