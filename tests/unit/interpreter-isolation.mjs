// A program cannot reach the interpreter's own objects through built-ins it
// replaces.
//
// The interpreter runs in the realm of the program it interprets. Natively, a
// program that replaces a built-in (a polyfill, a test harness, a hostile
// dependency) sees only what other code hands that built-in; it can never
// reach a closure's bindings or an object's private fields. The interpreter
// keeps those in its own objects (environments, private names), so if it
// called a replaced built-in with them, or let a lookup on them reach a
// replaced prototype, the program would see what native code never shows.
//
// Each case replaces built-ins the way a program can, before the interpreter
// loads (it loads late, on the first code a launch did not stage, after the
// launch's start captured the primordials) or after, and then runs the same
// program in fresh processes: compiled by V8, and interpreted. The
// replacements log every call and lookup that reaches them. The two logs and
// results must be equal (the interpreter goes through nothing native code
// would not), and no replacement may receive anything that leads to the
// program's secret, an object it keeps only in closure bindings and a private
// field. tests/unit/interpreter-primordials.mjs checks the same property
// statically; this checks it as a program would find it.
//
// The program runs once before the logged run: the interpreter compiles a
// function on its first call, and compiling parses with acorn, which runs
// on the realm's built-ins (as any parser written in JavaScript would) and
// is not what is compared. The logged run compiles nothing.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The program: the secret lives in closure bindings (a per-iteration loop's,
 * a generator's, an async function's, a class's) and a private field, and
 * the program uses the language broadly over them. It hands no built-in the
 * secret itself.
 */
const PROGRAM = `
const secret = { secret: true };
globalThis.registerSecret(secret);
const out = [];
class Box {
  #value = secret;
  static #count = 0;
  constructor(n) { this.n = n; Box.#count++; }
  get holds() { return this.#value === secret; }
  static get count() { return Box.#count; }
  *items() { yield this.n; yield this.#value === secret; }
}
const boxes = [];
for (let i = 0; i < 3; i++) boxes.push(new Box(i));
const readers = [];
for (let i = 0; i < 3; i++) readers.push(() => i + (secret ? 10 : 0));
out.push(readers.map((r) => r()), boxes.map((b) => b.holds), Box.count);
const [first, , third = 7, ...rest] = [1, 2, undefined, 4, 5];
const { a, b: { c = 3 } = {}, ...others } = { a: 1, d: 4, e: 5 };
out.push(first, third, rest, a, c, Object.keys(others));
out.push([...boxes[1].items()], [0, ...rest, ...new Set([9])]);
function* counter(n) { const keep = secret; for (let i = 0; i < n; i++) yield i + (keep ? 1 : 0); }
out.push([...counter(3)]);
const sum = (...xs) => xs.reduce((s, x) => s + x, 0);
out.push(sum(...[1, 2, 3], 4));
// Fewer arguments than parameters: native binding reads none past the last argument.
function pair(a, b, c = a, { d } = { d: 4 }, [e] = [5], ...f) { return [a, b, c, d, e, f]; }
const twice = (x, y) => [x, y];
const arrowPair = (x, y = x, [z] = [3]) => [x, y, z];
out.push(pair(1), pair(1, 2, 3), twice(7), arrowPair(6), Reflect.construct(function (p, q) { this.v = [p, q]; }, [8]).v);
label: for (const x of [1, 2, 3]) { for (const y of [1, 2]) { if (y === 2) continue label; if (x === 3) break label; out.push(x * 10 + y); } }
const tagged = (s, ...v) => s.raw.join('|') + v.join(',');
out.push(tagged\`x\${1}y\${secret ? 2 : 0}\`, \`t\${out.length}\`);
const o = { [\`k\${1}\`]: 1, m() { return super.toString === Object.prototype.toString; }, get g() { return 2; } };
out.push(o.k1, o.m(), o.g, o?.missing?.deep, typeof o.m);
try { null.x; } catch (e) { out.push(e instanceof TypeError); }
try { undefinedName; } catch (e) { out.push(e instanceof ReferenceError); }
let swapped = [1, 2];
[swapped[0], swapped[1]] = [swapped[1], swapped[0]];
out.push(swapped);
async function later(x) { const keep = secret; await null; for await (const y of [x, Promise.resolve(x + 1)]) out.push(y + (keep ? 0 : 1)); return x; }
async function* stream() { const keep = secret; yield keep ? 1 : 0; await null; yield 2; }
return (async () => {
  out.push(await later(5));
  for await (const v of stream()) out.push(v);
  const it = stream();
  await it.next();
  out.push(await it.return(9));
  out.push(String(function shown(x) { return x; }));
  return out;
})();
`;

/** Names of properties the interpreter's own records and descriptors could look up. */
const NAMES = [
  'get', 'set', 'value', 'writable', 'enumerable', 'configurable', 'done', 'next', 'return', 'throw', 'then',
  'kind', 'static', 'computed', 'private', 'block', 'field', 'key', 'el', 's', 'g', 'fi', 'bind', 'member', 'dflt',
  'rest', 'spread', 'code', 'f', 'global', 'slot', 'namespace', 'proto', 'named', 'isStatic', 'accessor', 'body',
  'gen', 'frame', 'lazy', 'params', 'iterator', 'raw', 'reference', 'assign', 'initialize', 'home', 'values', 'brand',
  ...Array.from({ length: 16 }, (_, i) => String(i)),
];

/**
 * Each case's replacements, installed by `install(hook)` either `before`
 * the interpreter loads (and after the launch's start captured the
 * primordials) or `after`. Methods acorn (the parser, bundled with the
 * interpreter) calls are left alone: it parses with the realm's built-ins,
 * on the program's own source text.
 */
const CASES = {
  // Array copies made with the receiver's species: a constructor that keeps what it is given.
  species: { when: 'after', install: (h) => h.species() },
  // Writes past an array's own elements reach accessors on Array.prototype and Object.prototype.
  'array-index-accessors': { when: 'after', install: (h) => h.indexAccessors() },
  // Every lookup an array does not answer itself reaches a proxy behind Array.prototype.
  'array-prototype-proxy': { when: 'after', install: (h) => h.arrayPrototypeProxy() },
  // Lookups of names an internal record or descriptor might not have reach Object.prototype.
  'object-prototype-accessors': { when: 'after', install: (h) => h.objectPrototypeAccessors(NAMES) },
  // Built-ins replaced before the interpreter loads: the globals, constructed or called.
  'globals-before-load': { when: 'before', install: (h) => h.globals() },
  // Prototype methods replaced before the interpreter loads (WeakMap.prototype.set holds private fields).
  'methods-before-load': { when: 'before', install: (h) => h.methods() },
  // Iteration and generator machinery replaced before the interpreter loads.
  'iteration-before-load': { when: 'before', install: (h) => h.iteration() },
  // Function.prototype.toString wrapped before the interpreter loads, as a program would wrap the native one.
  'tostring-before-load': { when: 'before', install: (h) => h.toString() },
};

if (process.argv[2] !== '--case') {
  const { buildInterpreterFiles } = await import('./lib/interpreter-build.mjs');
  const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
  const failures = [];
  try {
    for (const name of Object.keys(CASES)) {
      const runs = {};
      for (const mode of ['native', 'interpreted']) {
        const flags = mode === 'interpreted' ? ['--disallow-code-generation-from-strings'] : [];
        const run = spawnSync('node', [...flags, fileURLToPath(import.meta.url), '--case', name, mode, interpreterFile, opsFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        });
        const line = run.stdout.split('\n').find((l) => l.startsWith('{'));
        if (run.status !== 0 || !line) {
          failures.push(`${name} (${mode}): exited ${run.status}\n${run.stderr.slice(-2000)}`);
          break;
        }
        runs[mode] = JSON.parse(line);
      }
      if (!runs.native || !runs.interpreted) continue;
      const { native, interpreted } = runs;
      if (interpreted.secretSeen.length > 0) failures.push(`${name}: a replacement received the secret: ${interpreted.secretSeen.join(', ')}`);
      if (native.secretSeen.length > 0) failures.push(`${name}: natively, a replacement received the secret (the case is wrong): ${native.secretSeen.join(', ')}`);
      try {
        assert.deepEqual(interpreted.result, native.result);
      } catch {
        failures.push(`${name}: results differ\n  native      ${JSON.stringify(native.result)}\n  interpreted ${JSON.stringify(interpreted.result)}`);
      }
      const extra = interpreted.log.filter((entry, i) => entry !== native.log[i]);
      if (interpreted.log.length !== native.log.length || extra.length > 0) {
        const at = interpreted.log.findIndex((entry, i) => entry !== native.log[i]);
        failures.push(`${name}: the replacements saw what native code does not show them, from entry ${at}:\n`
          + `  native      ${JSON.stringify(native.log.slice(at, at + 6))}\n  interpreted ${JSON.stringify(interpreted.log.slice(at, at + 6))}`);
      }
      if (!failures.some((f) => f.startsWith(`${name}:`) || f.startsWith(`${name} (`))) console.log(`${name}: equal (${native.log.length} logged)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], failures.join('\n\n'));
  console.log(`${Object.keys(CASES).length} cases: the replacements see nothing native code does not show them`);
} else {
  await runCase(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
}

async function runCase(name, mode, interpreterFile, opsFile) {
  const { loadPrimordials } = await import('./lib/interpreter-load.mjs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // What this harness uses while built-ins are replaced, captured first.
  const O = Object, defineProperty = O.defineProperty, getOwn = O.getOwnPropertyDescriptor, hasOwn = O.hasOwn;
  const R = { apply: Reflect.apply, construct: Reflect.construct, get: Reflect.get, set: Reflect.set, has: Reflect.has, ownKeys: Reflect.ownKeys };
  const getProto = O.getPrototypeOf, setProto = O.setPrototypeOf, isArray = Array.isArray, OrigProxy = Proxy;
  const G = globalThis, OrigWeakSet = WeakSet;
  const secrets = new WeakSet(), seenAdd = WeakSet.prototype.add, seenHas = WeakSet.prototype.has;
  const log = O.create(null);
  let logged = 0;
  const secretSeen = O.create(null);
  let seenCount = 0;
  let quiet = 0;
  const kindOf = (v) => (v === null ? 'null' : isArray(v) ? 'array' : typeof v);
  const reaches = (value, depth, visited) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    if (R.apply(seenHas, secrets, [value])) return true;
    if (depth > 12 || R.apply(seenHas, visited, [value])) return false;
    R.apply(seenAdd, visited, [value]);
    if (!isArray(value)) return false;
    const n = R.get(getOwn(value, 'length'), 'value');
    for (let i = 0; i < n && i < 4096; i++) {
      const d = getOwn(value, i);
      if (d && hasOwn(d, 'value') && reaches(d.value, depth + 1, visited)) return true;
    }
    return false;
  };
  const record = (label, receiver, args) => {
    if (quiet > 0) return;
    quiet++;
    try {
      log[logged++] = `${label} ${kindOf(receiver)}`;
      const visited = new OrigWeakSet();
      let seen = reaches(receiver, 0, visited);
      for (let i = 0; !seen && args && i < args.length; i++) seen = reaches(args[i], 0, visited);
      if (seen) secretSeen[seenCount++] = label;
    } finally {
      quiet--;
    }
  };
  G.registerSecret = (value) => { R.apply(seenAdd, secrets, [value]); };

  /** Replace `target[key]` (a method) with one that logs, then calls the original. */
  const wrapMethod = (target, key, label) => {
    const original = target[key];
    if (typeof original !== 'function') return;
    defineProperty(target, key, {
      __proto__: null,
      value: { [key](...args) { record(label, this, args); return R.apply(original, this, args); } }[key],
      writable: true, enumerable: false, configurable: true,
    });
  };
  const hooks = {
    species() {
      const Species = function (...args) { record('species', undefined, args); return R.construct(Array, args, new.target ?? Species); };
      Species.prototype = Array.prototype;
      defineProperty(Array, Symbol.species, { __proto__: null, get() { record('Symbol.species', this, []); return Species; }, configurable: true });
    },
    indexAccessors() {
      for (let i = 0; i < 64; i++) {
        defineProperty(Array.prototype, i, {
          __proto__: null,
          get() { record(`Array.prototype[${i}] get`, this, []); return undefined; },
          set(v) { record(`Array.prototype[${i}] set`, this, [v]); defineProperty(this, i, { __proto__: null, value: v, writable: true, enumerable: true, configurable: true }); },
          configurable: true,
        });
      }
    },
    arrayPrototypeProxy() {
      const behind = getProto(Array.prototype);
      setProto(Array.prototype, new OrigProxy(behind, {
        get(target, key, receiver) {
          record(`Array.prototype's prototype get ${typeof key === 'symbol' ? key.toString() : key}`, receiver, []);
          return R.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
          record(`Array.prototype's prototype set ${typeof key === 'symbol' ? key.toString() : key}`, receiver, [value]);
          return R.set(target, key, value, receiver);
        },
        has(target, key) {
          record(`Array.prototype's prototype has ${typeof key === 'symbol' ? key.toString() : key}`, undefined, []);
          return R.has(target, key);
        },
      }));
    },
    objectPrototypeAccessors(names) {
      for (const name of names) {
        defineProperty(Object.prototype, name, {
          __proto__: null,
          get() { record(`Object.prototype.${name} get`, this, []); return undefined; },
          set(v) { record(`Object.prototype.${name} set`, this, [v]); defineProperty(this, name, { __proto__: null, value: v, writable: true, enumerable: true, configurable: true }); },
          configurable: true,
        });
      }
    },
    globals() {
      // Called or constructed: what acorn does not do while it parses.
      for (const name of ['Array', 'Object', 'Symbol', 'Error', 'TypeError', 'ReferenceError', 'RangeError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet']) {
        const original = G[name];
        const replaced = new OrigProxy(original, {
          apply(target, thisArg, args) { record(`${name}()`, thisArg, args); return R.apply(target, thisArg, args); },
          construct(target, args, newTarget) { record(`new ${name}`, undefined, args); return R.construct(target, args, newTarget === replaced ? target : newTarget); },
        });
        G[name] = replaced;
      }
      // Looked up: what acorn does not use.
      for (const name of ['Reflect', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'JSON', 'globalThis']) {
        const original = G[name];
        G[name] = new OrigProxy(original, {
          get(target, key) { record(`${name}.${typeof key === 'symbol' ? key.toString() : key}`, undefined, []); return R.get(target, key, target); },
        });
      }
    },
    methods() {
      for (const key of ['get', 'set', 'has', 'delete']) wrapMethod(WeakMap.prototype, key, `WeakMap.prototype.${key}`);
      for (const key of ['add', 'has', 'delete']) wrapMethod(WeakSet.prototype, key, `WeakSet.prototype.${key}`);
      for (const key of ['get', 'set', 'has', 'delete', 'forEach']) wrapMethod(Map.prototype, key, `Map.prototype.${key}`);
      for (const key of ['add', 'has', 'delete', 'forEach']) wrapMethod(Set.prototype, key, `Set.prototype.${key}`);
      for (const key of ['with', 'toSpliced', 'concat', 'filter', 'forEach', 'every', 'some', 'find', 'findIndex', 'includes', 'join', 'reduce', 'flat', 'flatMap', 'fill', 'splice', 'shift', 'unshift', 'reverse', 'lastIndexOf']) {
        wrapMethod(Array.prototype, key, `Array.prototype.${key}`);
      }
      for (const key of ['apply', 'bind']) wrapMethod(Function.prototype, key, `Function.prototype.${key}`);
      for (const key of ['then', 'catch', 'finally']) wrapMethod(Promise.prototype, key, `Promise.prototype.${key}`);
      for (const key of ['resolve', 'reject', 'all']) wrapMethod(Promise, key, `Promise.${key}`);
      for (const key of ['freeze', 'defineProperty', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyNames', 'assign', 'entries', 'values']) {
        wrapMethod(Object, key, `Object.${key}`);
      }
      for (const key of R.ownKeys(Reflect)) if (typeof key === 'string') wrapMethod(Reflect, key, `Reflect.${key}`);
      wrapMethod(Symbol.prototype, 'toString', 'Symbol.prototype.toString');
      const description = getOwn(Symbol.prototype, 'description');
      defineProperty(Symbol.prototype, 'description', { __proto__: null, get() { record('Symbol.prototype.description', this, []); return R.apply(description.get, this, []); }, configurable: true });
      for (const key of ['stringify', 'parse']) wrapMethod(JSON, key, `JSON.${key}`);
    },
    iteration() {
      const arrayIterator = getProto([][Symbol.iterator]());
      const generator = getProto(function* () {}.prototype);
      const asyncGenerator = getProto(async function* () {}.prototype);
      wrapMethod(Array.prototype, Symbol.iterator, 'Array.prototype[Symbol.iterator]');
      wrapMethod(arrayIterator, 'next', '%ArrayIteratorPrototype%.next');
      for (const key of ['next', 'return', 'throw']) wrapMethod(generator, key, `%GeneratorPrototype%.${key}`);
      for (const key of ['next', 'return', 'throw']) wrapMethod(asyncGenerator, key, `%AsyncGeneratorPrototype%.${key}`);
      wrapMethod(getProto(generator), Symbol.iterator, '%IteratorPrototype%[Symbol.iterator]');
      wrapMethod(getProto(asyncGenerator), Symbol.asyncIterator, '%AsyncIteratorPrototype%[Symbol.asyncIterator]');
    },
    toString() {
      const native = Function.prototype.toString;
      const wrapper = { toString() { record('Function.prototype.toString', this, []); return `guest:${R.apply(native, this, [])}`; } }.toString;
      G.guestToString = wrapper;
      defineProperty(Function.prototype, 'toString', { __proto__: null, value: wrapper, writable: true, enumerable: false, configurable: true });
    },
  };

  const testCase = CASES[name];
  let interp = null;
  // The launch's start: the primordials are captured before anything replaces a built-in.
  if (mode === 'interpreted') loadPrimordials(interpreterFile);
  if (testCase.when === 'before') testCase.install(hooks);
  if (mode === 'interpreted') {
    const { LAUNCH_PRIMORDIALS } = loadPrimordials(interpreterFile);
    const { createInterpreter } = require(interpreterFile);
    interp = createInterpreter(require(opsFile), { dynamicImport: () => Promise.reject(new Error('no imports')), primordials: LAUNCH_PRIMORDIALS });
  }
  const program = mode === 'interpreted' ? interp.compileFunction('function', [], PROGRAM) : new Function(PROGRAM);
  await program();
  if (testCase.when === 'after') testCase.install(hooks);
  logged = 0;
  const result = await program();
  quiet++;
  const entries = [];
  for (let i = 0; i < logged; i++) entries[entries.length] = log[i];
  const seen = [];
  for (let i = 0; i < seenCount; i++) seen[seen.length] = secretSeen[i];
  if (name === 'tostring-before-load') result.push(Function.prototype.toString === G.guestToString);
  process.stdout.write(`${JSON.stringify({ result, log: entries, secretSeen: seen })}\n`);
}
