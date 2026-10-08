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
  ['a parenthesized callee', String.raw`function load(id) { try { return require(id); } catch {} }
export const d = (load)('./private.cjs');`, ['./private.cjs']],
  ['an optional call', String.raw`function load(id) { try { return require(id); } catch {} }
export const d = load?.('./optional.cjs');`, ['./optional.cjs']],
  ['a function expression in parentheses', String.raw`const load = (function (id) { return require(id); });
export const d = load('dep');`, ['dep']],
  ['an arrow in parentheses', String.raw`const load = ((id) => require(id));
export const d = load('paren-arrow-dep');`, ['paren-arrow-dep']],
  // Not String.raw: Bun hands a raw template's non-ASCII back as \u escapes.
  ['a Unicode name', `function λ(id) { return require(id); }
export const d = λ('dep');`, ['dep']],
  ['a Unicode parameter', `function load(ñame) { return require(ñame); }
export const d = load('unicode-param-dep');`, ['unicode-param-dep']],
  ['an async arrow', String.raw`const load = async (id) => require(id);
export const d = load('async-dep');`, ['async-dep']],
  ['a generator', String.raw`function* load(id) { yield require(id); }
export const d = load('generator-dep');`, ['generator-dep']],
  ['a parenthesized require', String.raw`function load(id) { return (require)(id); }
export const d = load('paren-require-dep');`, ['paren-require-dep']],
  ['an optionally called require', String.raw`function load(id) { return require?.(id); }
export const d = load('optional-require-dep');`, ['optional-require-dep']],
  ['a parenthesized argument', String.raw`function load(id) { return require((id)); }
export const d = load('paren-arg-dep');`, ['paren-arg-dep']],
  ['a createRequire after another declarator', String.raw`import { createRequire } from 'node:module';
const base = import.meta.url, req = createRequire(base);
function load(id) { return req(id); }
export const d = load('second-declarator-dep');`, ['second-declarator-dep']],
  ['a createRequire on a namespace', String.raw`import module from 'node:module';
const req = module.createRequire(import.meta.url);
const load = (id) => req.resolve(id);
export const d = load('namespace-dep');`, ['namespace-dep']],
  ['no wrapper', String.raw`function label(id) { return "[" + id + "]"; }
function second(options, id) { return require(id); }
export const a = label('not-a-module'), b = second('not-either', 'x');`, []],
  ['a method, an unnamed callback and a member require are no wrappers', String.raw`const o = { load(id) { return require(id); } };
export const a = o.load('method-dep'), b = [1].map((id) => require(id)), c = ((id) => require(id))('iife-dep');
function viaMember(id) { return host.require(id); }
export const d = viaMember('member-dep');`, []],
];

for (const [name, code, expected] of cases) {
  const runtime = [...new Set(moduleRequests('pkg/index.js', code).filter((r) => r.kind === 'require').map((r) => r.specifier))].sort();
  const walk = [...requireWrapperCalls(code, stripCommentsForImports(code))].sort();
  assert.deepEqual(runtime, expected, `${name}: the import() prefetch reads ${JSON.stringify(runtime)}`);
  assert.deepEqual(walk, expected, `${name}: the supervisor's walk reads ${JSON.stringify(walk)}`);
}

console.log('require-wrapper-parity: ok');
