// The interpreter loads, parses and compiles without reaching a built-in a
// program can replace.
//
// A program shares its realm with the interpreter, which loads on the first
// code the launch did not compile and parses that code with acorn, a parser
// written in JavaScript. A built-in the parse reached would let the program
// see, and change, the code being parsed (tests/unit/interpreter-isolation.mjs
// has a program do that through Array.prototype.push). The bundled parser is
// rewritten to reach only what the launch captured at its start
// (core src/interpreter/parser-realm.ts), and interpreter-primordials.mjs
// checks the rewrite's output by its syntax. This checks it by running it:
// after the launch's start, every built-in a program can reach logs its use
// (each property of each built-in prototype, constructor and namespace, every
// lookup that misses a built-in prototype, the names the bundle reads on
// Object.prototype, the globals), and then the interpreter loads and compiles
// a corpus that exercises the whole parser: acorn's own source and the
// interpreter's as modules, every kind of syntax, regular expressions with
// Unicode property escapes, and code it refuses. Nothing may be logged.
//
// Under bun this builds the interpreter and runs itself under node with
// --disallow-code-generation-from-strings, as a Worker refuses string code.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every kind of syntax: compiled, or (`refused`) rejected; a `call` is run, and the function it returns called, which compiles it. */
const SYNTAX = [
  { kind: 'function', text: 'class A extends Object { #p = 1; static #q; static { A.s = 1; } get g() { return this.#p; } set g(v) {} static m() {} *gen() { yield* [1]; } async am() { await 1; } async *ag() { for await (const x of []) yield x; } [`k${1}`]() {} }' },
  { kind: 'function', params: ['a', 'b = a', '{ c, ...d } = {}', '[e, , f = 2, ...g] = []'], text: 'label: for (const x of a) { if (x) continue label; else break label; } return a?.b?.[c]?.(d) ?? e;' },
  { kind: 'async', text: 'const { x = await 1 } = {}; for await (const y of [x]) {} try { throw new Error() } catch { } finally { } return import("m");' },
  { kind: 'asyncGenerator', text: 'yield* (async function* () {})(); return yield await 1;' },
  { kind: 'function', text: 'return [/a(?<n>b)\\k<n>/dgimsuy, /[\\p{Script=Greek}--\\p{Letter}]/v, /\\p{L}\\P{Lu}\\p{Script_Extensions=Latin}\\p{General_Category=Letter}/u, /(?<=a)(?<!b)[^\\d\\W]+?\\u{1F600}/u, /[\\q{abc|d}]/v];' },
  { kind: 'function', text: 'return [1_000_000, 0x1F, 0o17, 0b101, .5e-3, 123n, 1_0n, 0x1Fn, "\\x41\\u0042\\u{43}\\n\\0", \'\\\'\', `a${1}b\\u{41}`, String.raw`\\unicode${1}`, ((t) => t)`\\xinvalid`];' },
  { kind: 'function', text: 'var o = { a, b: 1, [c]: 2, ...d, get e() { return 1 }, set e(v) {}, f() {}, async g() {}, *h() {}, async *i() {}, "j": 1, 2: 3, __proto__: null };' },
  { kind: 'function', text: 'with (o) { x = 1 } if (a) function f() {} switch (x) { case 1: let y; break; default: } do ; while (0) for (var i in o) ; for (;;) break; debugger; void typeof delete o.p; a = b ||= c &&= d ??= e; a **= 2; a >>>= 1; return new.target, this, arguments;' },
  { kind: 'call', text: 'return function outer(p) { "use strict"; return [() => this, function* () { yield p }, async () => await p, class { m() { return super.toString } }]; }' },
  { kind: 'module', path: '/w/m.mjs', text: 'import d, { a as b, "s" as c } from "x"; import * as ns from "y"; export const e = 1; export default class {} export { b as "q" }; export * from "z"; export * as w from "z"; const m = import.meta.url; await 1;' },
  { kind: 'module', path: '/w/c.js', text: '#!/usr/bin/env node\n"use strict"; // comment\u2028/* block */ module.exports = function () { return require("x") }; if (true) return;' },
  { kind: 'expression', text: '"use strict"; (function (exports, require, module) { module.exports = 1 })' },
  { kind: 'expression', text: '"hello"' },
  { kind: 'function', text: 'a\n++b\nc\n(d)\n[e]\nreturn\nf' },
  { kind: 'function', text: 'return x =>\n {}', refused: true },
  { kind: 'function', text: '}', refused: true },
  { kind: 'function', text: 'return /[/', refused: true },
  { kind: 'function', text: 'return `${`', refused: true },
  { kind: 'function', text: '"use strict"; var \\u0061rguments = 08;', refused: true },
  { kind: 'function', text: 'return /\\p{Unknown}/u', refused: true },
  { kind: 'module', path: '/w/bad.mjs', text: 'export { undeclared };', refused: true },
];

if (process.argv[2] !== '--run') {
  // The methods acorn calls through parser-realm answer as the built-ins do, on what acorn calls them with.
  const realm = await import('../../packages/core/src/interpreter/parser-realm.ts');
  const listOf = (...items) => realm.list(...items);
  const plain = (value) => (Array.isArray(value) ? Array.from(value, plain) : value);
  const same = (label, routed, native) => assert.deepEqual(plain(routed), plain(native), label);
  for (const [text, re, by] of [['1_000_000', /_/g, ''], ['a\r\nb\rc\nd', /\r\n?/g, '\n'], ['break case catch', / /g, '|'], ['x_y', /_/, '-'], ['none', /_/g, '']]) {
    same(`replace ${re}`, realm.replace(text, re, by), text.replace(re, by));
  }
  const lineBreak = /\r\n?|\n|\u2028|\u2029/;
  for (const text of ['', 'a', 'a\nb', 'a\r\nb\u2028c\n', '\n\n']) same(`split ${JSON.stringify(text)}`, realm.split(text, lineBreak), text.split(lineBreak));
  same('split keeps captures', realm.split('a1b2c', /(\d)/), 'a1b2c'.split(/(\d)/));
  same('match', realm.match('0123x', /^[0-7]+/), '0123x'.match(/^[0-7]+/));
  same('test', [realm.test(/^(?:if|for)$/, 'for'), realm.test(/^(?:if|for)$/, 'fo')], [true, false]);
  const text = 'abcabc';
  same('string methods', [realm.slice(text, 1), realm.slice(text, 1, -1), realm.indexOf(text, 'c'), realm.indexOf(text, 'c', 3), realm.lastIndexOf(text, 'a', 2),
    realm.lastIndexOf(text, 'a'), realm.charAt(text, 2), realm.charCodeAt(text, 9), realm.substr(text, 2, 3), realm.index(text, 1), realm.index(text, 6), realm.index(text, 'length')],
  [text.slice(1), text.slice(1, -1), text.indexOf('c'), text.indexOf('c', 3), text.lastIndexOf('a', 2), text.lastIndexOf('a'), text.charAt(2), text.charCodeAt(9), text.substr(2, 3), text[1], text[6], text.length]);
  const list = listOf(1, 2, 3, 2);
  same('list methods', [realm.slice(list, 1), realm.slice(list, -2), realm.indexOf(list, 2), realm.lastIndexOf(list, 2), realm.push(list, 5), realm.pop(list), list],
    [[2, 3, 2], [3, 2], 1, 3, 5, 5, [1, 2, 3, 2]]);
  same('toString', [realm.toString(10n), realm.toString(255, 16)], ['10', 'ff']);
  same('call', realm.call(function (a) { return [this, a]; }, 'self', 1), ['self', 1]);
  const re = /a/giy;
  same('field', [realm.field(re, 'source'), realm.field(re, 'flags'), realm.field({ flags: 3 }, 'flags'), realm.index(listOf(7), 0), realm.index({ k: 1 }, 'k')],
    [re.source, re.flags, 3, 7, 1]);
  assert.throws(() => realm.field(re, 'test'), /read RegExp.prototype.test/, 'a method read off a regexp is refused');
  assert.throws(() => realm.push([], 1), /something other than its own list/, 'a realm array is refused');
  assert.throws(() => realm.charCodeAt({}, 0), /called charCodeAt on a object/);

  const { buildInterpreterFiles } = await import('./lib/interpreter-build.mjs');
  const files = await buildInterpreterFiles();
  let run;
  try {
    // The corpus: acorn's own module, the interpreter's bundle, and the syntax below.
    const acorn = createRequire(fileURLToPath(new URL('../../packages/worker/package.json', import.meta.url))).resolve('acorn');
    writeFileSync(join(files.dir, 'acorn.mjs'), readFileSync(join(acorn, '../acorn.mjs'), 'utf8'));
    run = spawnSync('node', ['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--run', files.dir], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    });
  } finally {
    rmSync(files.dir, { recursive: true, force: true });
  }
  process.stderr.write(run.stderr);
  assert.equal(run.status, 0, 'the run failed');
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.ok(result.compiled > 10, `the corpus compiled (${result.compiled} units)`);
  assert.ok(result.poisoned > 1000, `the realm logs its built-ins (${result.poisoned} properties and lookups)`);
  assert.deepEqual(result.log, [], `the interpreter reached ${result.log.length} built-ins:\n${result.log.slice(0, 40).join('\n')}`);
  console.log(`${result.compiled} units of ${Math.round(result.bytes / 1024)} KiB loaded, parsed and compiled in a realm whose ${result.poisoned} built-in properties and lookups log their use: none reached`);
} else {
  await run(process.argv[3]);
}

async function run(dir) {
  const require = createRequire(import.meta.url);
  const { loadPrimordials } = await import('./lib/interpreter-load.mjs');
  const interpreterFile = join(dir, 'interpreter.js');
  const opsFile = join(dir, 'interpreter-ops.js');
  // Records with every field their own: the harness reads nothing through Object.prototype once the realm logs.
  const corpus = [
    { kind: 'module', path: '/w/acorn.mjs', text: readFileSync(join(dir, 'acorn.mjs'), 'utf8') },
    { kind: 'module', path: '/w/interpreter.js', text: readFileSync(interpreterFile, 'utf8') },
    ...SYNTAX,
  ].map((u) => ({ __proto__: null, kind: u.kind, path: u.path ?? '', text: u.text, params: u.params ?? [], refused: u.refused === true }));
  // Names a lookup that misses an object could ask Object.prototype for: those the bundle reads as
  // properties, and every name in the corpus, whose names acorn keys its own records by.
  const names = new Set(readFileSync(interpreterFile, 'utf8').match(/(?<=\.)[A-Za-z_$][\w$]*/g));
  for (const unit of corpus) for (const name of unit.text.match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(name);
  for (let i = 0; i < 64; i++) names.add(String(i));
  for (const name of ['type', 'start', 'end', 'name', 'value', 'raw', 'regex', 'bigint', 'body', 'kind', 'key', 'computed', 'directive']) names.add(name);

  // The launch's start: the primordials are captured before any program code runs.
  const primordials = loadPrimordials(interpreterFile);
  const { LAUNCH_PRIMORDIALS } = primordials;
  // The interpreter's two modules, compiled now and evaluated once the realm logs: their evaluation is
  // the interpreter loading, and Node's module loader, which is not the interpreter, stays out of it.
  const { compileFunction } = await import('node:vm');
  const wrapper = (file) => compileFunction(readFileSync(file, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
  const interpreterModule = wrapper(interpreterFile);
  const opsModule = wrapper(opsFile);
  const requireBeside = (id) => {
    if (id === './interpreter-primordials.js') return primordials;
    throw new Error(`the interpreter required ${id}`);
  };
  const evaluate = (moduleWrapper, file) => {
    const module = { __proto__: null, exports: { __proto__: null } };
    moduleWrapper(module.exports, requireBeside, module, file, dir);
    return module.exports;
  };
  const write = process.stdout.write.bind(process.stdout);
  const stringify = JSON.stringify;

  // What this harness uses once the realm logs, captured first.
  const O = Object, R = Reflect, P = Proxy, S = Symbol, A = Array;
  const defineProperty = O.defineProperty, getOwn = O.getOwnPropertyDescriptor, ownKeys = R.ownKeys, apply = R.apply;
  const reflectGet = R.get, reflectSet = R.set, reflectHas = R.has;
  const getProto = O.getPrototypeOf, setProto = O.setPrototypeOf, symbolToString = S.prototype.toString;
  const log = O.create(null);
  let logged = 0;
  let logging = false;
  const keyName = (key) => (typeof key === 'symbol' ? apply(symbolToString, key, []) : key);
  const note = (what) => { if (logging) log[logged++] = what; };
  let poisoned = 0;

  /** Each configurable own property of `target` becomes an accessor that logs, then does what the property did. */
  const poison = (target, label) => {
    const keys = ownKeys(target);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const d = getOwn(target, key);
      if (!d.configurable) continue;
      const where = `${label}.${keyName(key)}`;
      if (d.get || d.set) {
        defineProperty(target, key, {
          __proto__: null, configurable: true, enumerable: d.enumerable,
          get: d.get && function () { note(`${where} get`); return apply(d.get, this, []); },
          set: d.set && function (v) { note(`${where} set`); return apply(d.set, this, [v]); },
        });
      } else {
        let value = d.value;
        defineProperty(target, key, {
          __proto__: null, configurable: true, enumerable: d.enumerable,
          get() { note(`${where} get`); return value; },
          set(v) {
            note(`${where} set`);
            if (this === target) value = v;
            else defineProperty(this, key, { __proto__: null, value: v, writable: true, enumerable: true, configurable: true });
          },
        });
      }
      poisoned++;
    }
  };
  /** Every lookup that misses `proto` goes on to a proxy that logs it. */
  const behind = (proto, label) => {
    const next = getProto(proto);
    setProto(proto, new P(next, {
      __proto__: null,
      get(t, key, receiver) { note(`${label} miss get ${keyName(key)}`); return reflectGet(t, key, receiver); },
      set(t, key, value, receiver) { note(`${label} miss set ${keyName(key)}`); return reflectSet(t, key, value, receiver); },
      has(t, key) { note(`${label} miss has ${keyName(key)}`); return reflectHas(t, key); },
    }));
    poisoned++;
  };

  const iterator = getProto(getProto([][S.iterator]()));
  const generator = getProto(function* () {}.prototype);
  const asyncGenerator = getProto(async function* () {}.prototype);
  const prototypes = {
    '%GeneratorPrototype%': generator, '%AsyncGeneratorPrototype%': asyncGenerator, '%AsyncIteratorPrototype%': getProto(asyncGenerator),
    '%GeneratorFunction.prototype%': getProto(function* () {}), '%AsyncFunction.prototype%': getProto(async function () {}),
    '%AsyncGeneratorFunction.prototype%': getProto(async function* () {}), '%RegExpStringIteratorPrototype%': getProto('a'.matchAll(/a/g)),
    'Array.prototype': A.prototype, 'String.prototype': String.prototype, 'Number.prototype': Number.prototype,
    'Boolean.prototype': Boolean.prototype, 'BigInt.prototype': BigInt.prototype, 'Symbol.prototype': S.prototype,
    'RegExp.prototype': RegExp.prototype, 'Function.prototype': Function.prototype, 'Error.prototype': Error.prototype,
    'SyntaxError.prototype': SyntaxError.prototype, 'TypeError.prototype': TypeError.prototype,
    '%IteratorPrototype%': iterator, '%ArrayIteratorPrototype%': getProto([][S.iterator]()),
    '%StringIteratorPrototype%': getProto(''[S.iterator]()), 'Map.prototype': Map.prototype, 'Set.prototype': Set.prototype,
    'WeakMap.prototype': WeakMap.prototype, 'WeakSet.prototype': WeakSet.prototype, 'Promise.prototype': Promise.prototype,
  };
  const statics = {
    Object: O, Array: A, String, Number, Symbol: S, RegExp, Reflect: R, JSON, Math, BigInt, Map, Set, Promise, Function, Error,
    SyntaxError, TypeError,
  };
  const objectPrototypeKeys = new Set(ownKeys(O.prototype));
  const globals = ['Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'RegExp', 'Reflect', 'JSON', 'Math', 'BigInt', 'Error',
    'SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Function',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'escape', 'unescape', 'eval', 'globalThis', 'console'];

  for (const label of O.keys(prototypes)) poison(prototypes[label], label);
  for (const label of O.keys(statics)) poison(statics[label], label);
  poison(O.prototype, 'Object.prototype');
  // Lookups that miss an object reach Object.prototype, whose own prototype cannot be replaced: the names the bundle reads.
  for (const name of names) {
    if (objectPrototypeKeys.has(name)) continue;
    defineProperty(O.prototype, name, {
      __proto__: null, configurable: true, enumerable: false,
      get() { note(`Object.prototype.${name} get (missing)`); return undefined; },
      set(v) { note(`Object.prototype.${name} set (missing)`); defineProperty(this, name, { __proto__: null, value: v, writable: true, enumerable: true, configurable: true }); },
    });
    poisoned++;
  }
  for (const label of O.keys(prototypes)) behind(prototypes[label], label);
  for (const name of globals) {
    const d = getOwn(globalThis, name);
    if (!d || !d.configurable) continue;
    const value = d.value;
    defineProperty(globalThis, name, { __proto__: null, configurable: true, get() { note(`global ${name}`); return value; } });
    poisoned++;
  }

  // The interpreter loads, as in a launch, after the program has had the realm.
  let compiled = 0;
  let bytes = 0;
  logging = true;
  const interpreter = evaluate(interpreterModule, interpreterFile);
  const interp = interpreter.createInterpreter(evaluate(opsModule, opsFile), { __proto__: null, dynamicImport: () => undefined, primordials: LAUNCH_PRIMORDIALS });
  for (let i = 0; i < corpus.length; i++) {
    const unit = corpus[i];
    bytes += unit.text.length;
    try {
      if (unit.kind === 'module') interp.compileModule(unit.path, unit.text);
      else if (unit.kind === 'expression') interp.compileExpression(unit.text);
      else if (unit.kind === 'call') interp.compileFunction('function', [], unit.text)()(1);
      else interp.compileFunction(unit.kind, unit.params, unit.text);
      compiled++;
    } catch (e) {
      // Refused code is part of the corpus: its error path is the parser's too.
      if (!unit.refused) throw e;
      compiled++;
    }
  }
  logging = false;
  const entries = [];
  for (let i = 0; i < logged; i++) entries[entries.length] = log[i];
  write(`${stringify({ compiled, bytes, poisoned, log: entries })}\n`);
}
