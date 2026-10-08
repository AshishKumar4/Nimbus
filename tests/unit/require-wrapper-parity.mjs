#!/usr/bin/env bun
// A require wrapper's string calls, read by both walks alike: the import()
// prefetch (core/interpreter moduleRequests, over the interpreter's parser)
// and the supervisor's walk (require-resolver.ts requireWrapperCalls: a
// literal-anchored prefilter, then the same analysis over acorn,
// core/interpreter/module-requests.ts). The prefilter may admit more than
// the analysis does, never less: what a string holds (a `$`, the other
// quote, an escape) and how a parameter's default is spelled are the
// parse's to read.

import assert from 'node:assert/strict';
import { moduleRequests } from '../../packages/core/src/interpreter/index.ts';
import { requireWrapperCalls } from '../../packages/core/src/runtime/require-resolver.ts';
import { stripCommentsForImports } from '../../packages/core/src/runtime/comment-strip.ts';

const cases = [
  ['a $ in the string', String.raw`function load(id) { try { return require(id); } catch {} }
export const d = load('./driver$impl.js');`, ['./driver$impl.js']],
  ['the other quote in the string', String.raw`function load(id) { return require(id); }
export const d = load("it's-a-pkg");`, ["it's-a-pkg"]],
  ['an escaped quote', String.raw`function load(id) { return require(id); }
export const d = load('a\'b');`, ["a'b"]],
  ['a template with no substitutions', 'function load(id) { return require(id); }\nexport const d = load(`templated`);', ['templated']],
  ['a default that calls', String.raw`const load = (id = defaultName()) => { try { return require(id); } catch {} };
export const d = load('dep');`, ['dep']],
  ['a single-parameter arrow', String.raw`const load = id => require(id);
export const d = load('arrow-dep');`, ['arrow-dep']],
  ['an assigned function expression', String.raw`let load;
load = function (id, fallback) { try { return require.resolve(id); } catch { return fallback; } };
export const d = load('resolved-dep', null);`, ['resolved-dep']],
  ['plugin-vue', String.raw`import { createRequire } from "node:module";
function tryResolveCompiler(root) {
  const vueMeta = tryRequire("vue/package.json", root);
  if (vueMeta && vueMeta.version.split(".")[0] >= 3) return tryRequire("vue/compiler-sfc", root);
}
const _require = createRequire(import.meta.url);
function tryRequire(id, from) {
  try { return from ? _require(_require.resolve(id, { paths: [from] })) : _require(id); } catch (e) {}
}`, ['vue/compiler-sfc', 'vue/package.json']],
  ['no wrapper', String.raw`function label(id) { return "[" + id + "]"; }
function second(options, id) { return require(id); }
export const a = label('not-a-module'), b = second('not-either', 'x');`, []],
];

for (const [name, code, expected] of cases) {
  const runtime = [...new Set(moduleRequests('pkg/index.js', code).filter((r) => r.kind === 'require').map((r) => r.specifier))].sort();
  const walk = [...requireWrapperCalls(code, stripCommentsForImports(code))].sort();
  assert.deepEqual(runtime, expected, `${name}: the import() prefetch reads ${JSON.stringify(runtime)}`);
  assert.deepEqual(walk, expected, `${name}: the supervisor's walk reads ${JSON.stringify(walk)}`);
}

console.log('require-wrapper-parity: ok');
