// The runtime-code interpreter (packages/core/src/interpreter) runs code the
// way V8 would have compiled it: functions of each kind, classes, modules,
// with the semantics a program can observe, in a process that refuses string
// code generation as a Worker does at request time.
//
// Under bun this builds the interpreter from source and runs itself under
// `node --disallow-code-generation-from-strings`, where the cases run: each
// interpreted function is made by the routed Function constructors, as in a
// guest. Regressions found while bringing the interpreter up have a case each.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--cases') {
  const { buildInterpreterFiles } = await import('./lib/interpreter-build.mjs');
  const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
  let run;
  try {
    run = spawnSync('node', ['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url), '--cases', interpreterFile, opsFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  assert.equal(run.status, 0, 'the interpreter cases failed under node');
  assert.match(run.stdout, /\bcases passed\b/);
} else {
  await runCases(process.argv[3], process.argv[4]);
}

async function runCases(interpreterFile, opsFile) {
  const require = createRequire(import.meta.url);
  const { createInterpreter, INTERPRETER_UNSUPPORTED } = require(interpreterFile);
  const { ROUTE_FUNCTION_CONSTRUCTORS } = await import('./lib/interpreter-build.mjs');
  const imports = [];
  const interp = createInterpreter(require(opsFile), {
    dynamicImport: (parent, specifier) => {
      imports.push([parent, specifier]);
      return Promise.resolve({ specifier });
    },
  });
  assert.throws(() => Function('return 1'), EvalError, 'the process refuses string code generation');
  // A program's own Function, as node-shims installs it: routed to the interpreter.
  const route = interp.compileFunction('function', [], `return ${ROUTE_FUNCTION_CONSTRUCTORS};`)();
  route(interp);

  const F = (body, ...params) => new Function(...params, body);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
  const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
  let count = 0;
  const check = (label, actual, expected) => {
    assert.deepEqual(actual, expected, label);
    count++;
  };

  // ── Functions, closures, control flow ──
  check('parameters', F('return a + b', 'a', 'b')(2, 3), 5);
  check('closure', F('let n = 0; return () => ++n')()(), 1);
  check('recursion', F('function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) } return fib(20)')(), 6765);
  check('labels', F('const out = []; outer: for (const i of [1, 2, 3]) { for (const j of [1, 2, 3]) { if (j === 2) continue outer; if (i === 3) break outer; out.push(i * 10 + j) } } return out')(), [11, 21]);
  check('finally', F('const out = []; function f() { try { return 1 } finally { out.push("f") } } return [f(), out]')(), [1, ['f']]);
  check('break in finally overrides return', F('function f() { for (;;) { try { return 1 } finally { break } } return 2 } return f()')(), 2);
  check('switch fallthrough', F('const r = []; for (const x of [1, 2, 5]) { switch (x) { case 1: r.push("one"); case 2: r.push("two"); break; default: r.push("d") } } return r')(), ['one', 'two', 'two', 'd']);
  check('per-iteration let', F('const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); return fs.map((f) => f())')(), [0, 1, 2]);
  check('destructuring', F('const { a, b: [x, ...r], c = 9 } = { a: 1, b: [2, 3, 4] }; return [a, x, r, c]')(), [1, 2, [3, 4], 9]);
  check('defaults and rest', F('function f(a, b = a + 1, ...r) { return [a, b, r] } return f(1)')(), [1, 2, []]);
  check('template and tag', F('const t = (s, ...v) => s.raw.join("|") + v.join(","); return [`x${1}y${2}`, t`a${1}b${2}c`]')(), ['x1y2', 'a|b|c1,2']);
  check('optional chains', F('const o = { a: { b: () => 5 } }; return [o?.a?.b(), o.x?.y.z, o.a.c?.()]')(), [5, undefined, undefined]);
  check('with', F('const o = { a: 1 }; with (o) { a = 2; var b = a + 1 } return [o.a, b]')(), [2, 3]);
  check('bigint and regexp', F('return [String(2n ** 64n), /a(b+)/.exec("xabbb")[1]]')(), ['18446744073709551616', 'bbb']);
  check('names', F('const f = function g() {}; const h = () => {}; const o = { [Symbol("q")]() {}, k: () => 1 }; return [f.name, h.name, Object.values(o)[0].name, Object.getOwnPropertySymbols(o).map((s) => o[s].name)[0]]')(), ['g', 'h', 'k', '[q]']);
  check('a parenthesized target does not name', F('let f; (f) = function () {}; return f.name')(), '');

  // ── Sloppy and strict ──
  check('sloppy this is the global object', F('function f() { return this === globalThis } return f()')(), true);
  check('strict this is undefined', F('"use strict"; function f() { return this } return f()')(), undefined);
  check('arguments.callee', F('function f() { return arguments.callee === f } return f()')(), true);
  check('var arguments keeps the arguments object', F('function f() { return typeof arguments; var arguments = 1 } return f(1)')(), 'object');
  check('sloppy write to frozen is ignored', F('const o = Object.freeze({ a: 1 }); o.a = 2; return o.a')(), 1);
  check('strict write to frozen throws', F('"use strict"; try { Object.freeze({ a: 1 }).a = 2 } catch (e) { return e instanceof TypeError }')(), true);
  check('class heritage is strict code', F('const D = class extends function () { return arguments.callee } {}; try { new D(); return "no" } catch (e) { return e instanceof TypeError }')(), true);

  // ── TDZ ──
  check('let before declaration', F('try { x; let x = 1 } catch (e) { return e instanceof ReferenceError }')(), true);
  check('parameter read before its binding', F('function f(a = b, b) {} try { f() } catch (e) { return e instanceof ReferenceError }')(), true);
  check('for-of head sees its own names in TDZ', F('try { for (const x of [x]) {} } catch (e) { return e instanceof ReferenceError }')(), true);
  check('const assignment', F('const x = 1; try { x = 2 } catch (e) { return e.message }')(), 'Assignment to constant variable.');

  // ── Classes ──
  check('class features', F(`
    class A { #x = 1; static s = 2; get x() { return this.#x } inc() { this.#x += 1; return this } static has(o) { return #x in o } static { A.t = 3 } }
    class B extends A { constructor() { super(); this.y = 5 } m() { return super.inc() } }
    const b = new B().m();
    return [b.x, b.y, A.s, A.t, b instanceof A, B.name, A.has(b), A.has({})]`)(), [2, 5, 2, 3, true, 'B', true, false]);
  check('private names in computed keys', F('let r; class C { #f = 1; [(r = (() => { try { return ({}).#f } catch (e) { return e.constructor.name } })(), "k")]() {} } return r')(), 'TypeError');
  check('derived constructor returning an object', F('let o; class C extends null { constructor() { return o = {} } } return new C() === o')(), true);
  check('fields run after super binds this', F('class A {} class B extends A { f = this; constructor() { super(); } } const b = new B(); return b.f === b')(), true);
  check('subclassing Function', F('class G extends Function {} return new G("return 7") instanceof G')(), true);
  check('class toString', String(F('return class K { m() {} }')()), 'class K { m() {} }');

  // ── Same realm, and a realm the program has changed ──
  check('identity', F('return [new Map() instanceof Map, [] instanceof Array, Object.getPrototypeOf({}) === Object.prototype]')(), [true, true, true]);
  {
    const make = F('return () => { const [x, y, z] = [1, 2, 3]; class C { #p = 1; get p() { return this.#p } } return [x, y, z, new C().p] }')();
    const saved = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = function* () { yield 'patched'; };
    try {
      check('internal arrays ignore a replaced array iterator', make(), ['patched', undefined, undefined, 1]);
    } finally {
      Array.prototype[Symbol.iterator] = saved;
    }
  }

  // ── A program that replaced built-ins ──
  {
    // The interpreter compiles and runs without the built-ins a program can
    // replace: test262 replaces the array iterator, a polyfill a method. acorn,
    // which parses, still uses Array.prototype.push/pop/indexOf/slice and
    // String.prototype.charCodeAt/slice/indexOf, so those stay.
    const boom = () => { throw new Error('a replaced built-in was called'); };
    const patches = [
      [Array.prototype, Symbol.iterator, function* () { yield 'patched'; }],
      ...['every', 'some', 'filter', 'find', 'findIndex', 'forEach', 'includes', 'join', 'flatMap', 'reduce', 'entries', 'keys', 'values'].map((k) => [Array.prototype, k, boom]),
      ...['get', 'set', 'has', 'delete', 'forEach'].map((k) => [Map.prototype, k, boom]),
      ...['add', 'has', 'delete', 'forEach'].map((k) => [Set.prototype, k, boom]),
      ...['get', 'set', 'has'].map((k) => [WeakMap.prototype, k, boom]),
      ...['add', 'has'].map((k) => [WeakSet.prototype, k, boom]),
      [Symbol.prototype, 'toString', boom],
      ...['entries', 'values', 'freeze', 'getPrototypeOf', 'setPrototypeOf', 'defineProperty', 'getOwnPropertyNames'].map((k) => [Object, k, boom]),
      ...['get', 'set', 'has', 'apply', 'construct', 'ownKeys', 'defineProperty', 'getOwnPropertyDescriptor'].map((k) => [Reflect, k, boom]),
    ];
    const saved = patches.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
    // Patched or restored, nothing here may iterate an array or call what it replaces.
    const define = Object.defineProperty;
    let result;
    let asyncResult;
    try {
      for (let i = 0; i < patches.length; i++) define(patches[i][0], patches[i][1], { value: patches[i][2], writable: true, configurable: true });
      const body = `
        label: for (let i = 0; i < 3; i++) { switch (i) { case 1: continue label; default: } }
        class A { #x = 1; static s = 2; static { this.t = 3; } get x() { return this.#x; } }
        class B extends A { constructor(...a) { super(); this.n = a.length; } }
        const { p = 4, ...rest } = { q: 5 };
        function* g() { yield 1; yield* [7]; }
        let caught;
        try { null.x; } catch (e) { caught = e instanceof TypeError; }
        const b = new B(1, 2);
        return [b.x, b.n, A.s, A.t, p, rest.q, [...g()], \`t\${p}\`, caught, [...[1, 2]]];`;
      // The interpreter itself, not the routed constructors: those are this test's own code.
      result = interp.compileFunction('function', [], body)();
      // What runs before the first await runs here, with the built-ins replaced.
      asyncResult = interp.compileFunction('async', [], 'const w = [...[1]]; const v = await Promise.resolve(9); return { v, w };')();
    } finally {
      for (let i = 0; i < patches.length; i++) {
        if (saved[i]) define(patches[i][0], patches[i][1], saved[i]);
        else delete patches[i][0][patches[i][1]];
      }
    }
    // Spreading an array runs the program's iterator, as V8 does; nothing else does.
    check('compiles and runs with built-ins replaced', result, [1, 2, 2, 3, 4, 5, [1, 'patched'], 't4', true, ['patched']]);
    check('async code with built-ins replaced', await asyncResult, { v: 9, w: ['patched'] });
  }

  // ── Calls ──
  check('a parenthesized optional chain keeps its receiver', F('const a = { b() { return this._b }, _b: 42 }; return [(a?.b)(), (a.b)?.()]')(), [42, 42]);
  check('not a function names the callee', F('const o = {}; try { o.m() } catch (e) { return e.message }')(), 'o.m is not a function');
  check('not a constructor names the callee', F('const f = () => 1; try { new f() } catch (e) { return e.message }')(), 'f is not a constructor');
  check('base checked before the key converts', F('const k = { toString() { throw new Error("key") } }; try { null[k]++ } catch (e) { return e.constructor.name }')(), 'TypeError');
  check('compound assignment to a private field', F('class C { #n = 1; inc() { this.#n += 2; return this.#n } } return new C().inc()')(), 3);

  // ── Generators ──
  check('generator', F('function* g() { const x = yield 1; yield x * 2 } const it = g(); return [it.next().value, it.next(21).value, it.next().done]')(), [1, 42, true]);
  check('generator constructor', new GeneratorFunction('a', 'yield a; yield a + 1')(5).next().value, 5);
  check('return() closes an iterator mid-destructuring', F(`
    let closed = 0;
    const iterable = { [Symbol.iterator]() { return { next: () => ({ done: false }), return() { closed++; return {} } } } };
    function* g() { let x; [x = yield] = iterable; }
    const it = g(); it.next(); it.return();
    return closed`)(), 1);
  check('yield inside a destructuring target', F('function* g() { const o = {}; [o[yield "k"]] = [7]; return o } const it = g(); it.next(); return it.next("key").value')(), { key: 7 });

  // ── Async ──
  check('await', await new AsyncFunction('const a = await Promise.resolve(1); return a + await 2')(), 3);
  check('await rejection', await new AsyncFunction('try { await Promise.reject(new Error("x")) } catch (e) { return e.message }')(), 'x');
  check('optional chain over await', await new AsyncFunction('return [(await Promise.resolve({ a: 1 }))?.a, (await null)?.a]')(), [1, undefined]);
  check('class keys that await', await new AsyncFunction('class C { [await Promise.resolve("m")]() { return 1 } } return new C().m()')(), 1);
  check('for await', await new AsyncFunction('async function* g() { yield 1; await null; yield 2 } const r = []; for await (const x of g()) r.push(x); return r')(), [1, 2]);
  check('async generator return runs finally', await new AsyncGeneratorFunction('log', 'try { yield 1; yield 2 } finally { log.push("fin") }')([]).return(7), { value: 7, done: true });
  {
    const log = [];
    const gen = new AsyncGeneratorFunction('log', 'try { yield 1 } finally { log.push("fin") }')(log);
    await gen.next();
    check('async generator return() after a yield', [await gen.return(9), log], [{ value: 9, done: true }, ['fin']]);
  }
  check('microtask order', await new AsyncFunction('const log = []; const p = (async () => { log.push(1); await null; log.push(3) })(); log.push(2); await p; return log')(), [1, 2, 3]);
  {
    const native = [];
    const nativeRun = (async () => { native.push('a'); await null; native.push('c'); await null; native.push('e'); })();
    Promise.resolve().then(() => native.push('b')).then(() => native.push('d'));
    await nativeRun;
    const interpreted = [];
    const run = new AsyncFunction('log', 'log.push("a"); await null; log.push("c"); await null; log.push("e")')(interpreted);
    Promise.resolve().then(() => interpreted.push('b')).then(() => interpreted.push('d'));
    await run;
    check('await interleaves with other promises as natively', interpreted, native);
  }

  // ── Function source ──
  const fn = F('return 1', 'a');
  check('Function.prototype.toString', String(fn), 'function anonymous(a\n) {\nreturn 1\n}');
  check('toString of an inner function', String(F('return function inner(x) { return x }')()), 'function inner(x) { return x }');
  check('toString of methods', F('const o = { validate(input) { return 1 }, get g() { return 1 }, async *ag() {}, ["c" + 1]() {} }; class A { static m(a) {} static get s() { return 1 } #p() {} q() { return this.#p } } return [o.validate, Object.getOwnPropertyDescriptor(o, "g").get, o.ag, o.c1, A.m, Object.getOwnPropertyDescriptor(A, "s").get, new A().q()].map(String)')(),
    ['validate(input) { return 1 }', 'get g() { return 1 }', 'async *ag() {}', '["c" + 1]() {}', 'm(a) {}', 'get s() { return 1 }', '#p() {}']);
  check('toString keeps a trailing source map', String(F('return 2\n//# sourceMappingURL=data:application/json;base64,e30=\n')), 'function anonymous(\n) {\nreturn 2\n//# sourceMappingURL=data:application/json;base64,e30=\n\n}');
  check('a trailing comment that is not one', F('return `\n//# x`')(), '\n//# x');
  check('native functions still answer natively', Function.prototype.toString.call(Math.max), 'function max() { [native code] }');

  // ── Compiled on first call ──
  // A function's body compiles the first time it runs, parsed again from its unit's text.
  check('a constructor\'s function does not bind `anonymous`', F('return typeof anonymous')(), 'undefined');
  check('a sloppy generator declaration named yield', F('function* yield() { yield 3; } return yield().next().value')(), 3);
  check('an async function declaration named await', F('async function await() { return 4; } return typeof await')(), 'function');
  check('an arrow using super, new.target and super() in a derived constructor',
    F('class A { m() { return 1 } } class B extends A { constructor() { const f = () => super(); f(); this.t = (() => new.target)(); } m() { return (() => super.m() + 1)() } } const b = new B(); return [b.m(), b.t === B]')(), [2, true]);
  check('a sloppy method arrow using super', F('const o = { __proto__: { v: 5 }, m() { return () => super.v } }; return o.m()()')(), 5);
  check('getters, setters and generator methods', F('const o = { get g() { return 1 }, set s(v) { this.v = v }, *gen() { yield 2 }, async am() { return 3 } }; o.s = 4; return [o.g, o.v, o.gen().next().value]')(), [1, 4, 2]);
  {
    // Defined on Object.prototype before the inner function first runs, where the compile builds its AST.
    const defined = Object.defineProperty(Object.prototype, 'callee', { get() { throw new Error('read Object.prototype.callee'); }, configurable: true });
    try {
      check('Object.prototype accessors do not reach the compile', F('return () => f(1); function f(x) { return x + 1 }')()(), 2);
    } finally {
      delete defined.callee;
    }
  }

  // ── Refusals ──
  assert.throws(() => F('}'), SyntaxError);
  assert.throws(() => F('}, globalThis.__broke = 1, function () {'), SyntaxError);
  check('a body cannot break out of its function', globalThis.__broke, undefined);
  assert.throws(() => interp.compileFunction('function', [], '{ using x = null; }'), (e) => e.code === INTERPRETER_UNSUPPORTED);
  assert.throws(() => interp.compileModule('/w/m.ts', 'export const x: number = 1;'), (e) => e.code === INTERPRETER_UNSUPPORTED);

  // ── Module cells ──
  {
    const cell = interp.compileModule('/w/m.mjs', [
      'import { join } from "node:path";',
      'import d from "./esm.js";',
      'import cjs from "./cjs.js";',
      'import * as ns from "./cjs.js";',
      'export * from "./star.js";',
      'export { v as renamed } from "./star.js";',
      'export const x = join("a", "b");',
      'export let n = 1;',
      'export function inc() { n++; }',
      'export default class {}',
      'export const meta = import.meta.url;',
      'export const load = () => import("./later.js");',
      'export const seen = [d, cjs.k, ns.default.k, ns.k];',
    ].join('\n'));
    const modules = {
      'node:path': require('node:path'),
      './esm.js': { __esModule: true, default: 'D' },
      './cjs.js': { k: 'K' },
      './star.js': { v: 'V', w: 'W', default: 'not re-exported' },
    };
    const mod = { exports: {}, __nimbusImportMeta: { url: 'file:///w/m.mjs' } };
    cell(mod.exports, (id) => modules[id], mod, '/w/m.mjs', '/w');
    const e = mod.exports;
    check('esm exports', [e.x, e.n, e.seen, e.v, e.w, e.renamed, 'default' in e && typeof e.default, e.meta, e.__esModule], ['a/b', 1, ['D', 'K', 'K', 'K'], 'V', 'W', 'V', 'function', 'file:///w/m.mjs', true]);
    e.inc();
    check('esm export bindings are live', e.n, 2);
    check('esm default class is named default', e.default.name, 'default');
    await e.load();
    check('dynamic import from the module url', imports.at(-1), ['file:///w/m.mjs', './later.js']);
  }
  {
    const cjs = interp.compileModule('/w/c.js', 'exports.a = 1; module.exports.b = typeof require; if (true) return; exports.c = 1');
    const mod = { exports: {} };
    cjs(mod.exports, require, mod, '/w/c.js', '/w');
    check('commonjs cell', mod.exports, { a: 1, b: 'function' });
    const tla = interp.compileModule('/w/t.mjs', 'export const v = await Promise.resolve(42);');
    const m = { exports: {} };
    await tla(m.exports, require, m, '', '');
    check('top-level await', m.exports.v, 42);
  }

  console.log(`${count} cases passed`);
}
