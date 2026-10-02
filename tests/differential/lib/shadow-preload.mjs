// Shadow execution for the interpreter differential (tests/differential/
// interpreter-frameworks.mjs), loaded with `node --import` into a real
// framework run where V8 may compile strings.
//
// Each Function-constructor call builds the native function AND the
// interpreted one. The program gets a function of the same kind that runs
// the native one, for real, and then the interpreted one on shadow outputs:
//   - a Vite SSR module (the module runner's AsyncFunction): the interpreted
//     body runs against a shadow exports object, with the runner's own import
//     functions (they return its cached modules, so nothing is evaluated
//     twice), and the two exports objects are compared;
//   - any other function: called with the same receiver and arguments, and
//     the results compared.
// vm.runInThisContext (jiti's, for Nuxt's config) is routed as node-shims
// routes it in a Worker (vm-route.mjs): the native value goes to the
// program, the interpreted one is compared; a CommonJS wrapper expression
// (jiti's) is compared by what each run of it puts in module.exports, the
// interpreted one on a shadow module object.
// Every module file the program loads from a Vite temp directory (the
// bundled config) is captured, to be compared after the run.
// Mismatches, refusals and counts go to the report file named by
// NIMBUS_DIFF_REPORT as they happen (report.mjs).

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';

import { loadInterpreter } from '../../unit/lib/interpreter-load.mjs';
import { recordPart } from './report.mjs';
import { same } from './same.mjs';
import { routeRunInThisContext } from './vm-route.mjs';

const require = createRequire(import.meta.url);
const interp = loadInterpreter(process.env.NIMBUS_INTERPRETER, process.env.NIMBUS_INTERPRETER_OPS, (parent, specifier) => (
  import(parent && /^\.\.?\//.test(String(specifier)) ? new URL(String(specifier), parent).href : String(specifier))
));
const corpus = process.env.NIMBUS_DIFF_CORPUS;
mkdirSync(corpus, { recursive: true });
const record = (part) => recordPart(process.env.NIMBUS_DIFF_REPORT, part);

function settle(run) {
  try {
    const value = run();
    if (value && typeof value.then === 'function') return value.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, value: e }));
    return { ok: true, value };
  } catch (e) {
    return { ok: false, value: e };
  }
}

function compare(label, key, native, interpreted, exportsPair) {
  let difference = null;
  if (native.ok !== interpreted.ok) {
    difference = `outcome: native ${native.ok ? 'returned' : `threw ${native.value && native.value.message}`}, interpreted ${interpreted.ok ? 'returned' : `threw ${interpreted.value && interpreted.value.message}`}`;
  } else if (!native.ok) {
    if (String(native.value && native.value.message) !== String(interpreted.value && interpreted.value.message)) difference = `errors: ${native.value && native.value.message} vs ${interpreted.value && interpreted.value.message}`;
  } else if (exportsPair) {
    difference = same(exportsPair[0], exportsPair[1], 'exports', 3, new Set());
  } else {
    difference = same(native.value, interpreted.value, 'result', 3, new Set());
  }
  record(difference ? { compared: 1, mismatches: [{ label, key, difference }] } : { compared: 1, equal: 1 });
}

const SSR_KEYS = ['__vite_ssr_exports__', '__vite_ssr_import_meta__', '__vite_ssr_import__', '__vite_ssr_dynamic_import__', '__vite_ssr_exportAll__', '__vite_ssr_exportName__'];

function shadowed(kind, native, interpreted, params, key) {
  const ssr = kind === 'async' && SSR_KEYS.every((k) => params.includes(k));
  if (ssr) {
    record({ ssrModules: 1 });
    const at = Object.fromEntries(SSR_KEYS.map((k) => [k, params.indexOf(k)]));
    return async function (...args) {
      // The shadow exports object is made as the runner made the real one (its prototype and Symbol.toStringTag).
      const realExports = args[at.__vite_ssr_exports__];
      const shadowExports = Object.create(Object.getPrototypeOf(realExports));
      for (const symbol of Object.getOwnPropertySymbols(realExports)) Object.defineProperty(shadowExports, symbol, Object.getOwnPropertyDescriptor(realExports, symbol));
      const real = await settle(() => Reflect.apply(native, this, args));
      const shadow = args.slice();
      shadow[at.__vite_ssr_exports__] = shadowExports;
      shadow[at.__vite_ssr_exportName__] = (name, getter) => Object.defineProperty(shadowExports, name, { enumerable: true, configurable: true, get: getter });
      shadow[at.__vite_ssr_exportAll__] = (source) => {
        for (const k in source) if (k !== 'default' && k !== '__esModule' && !(k in shadowExports)) Object.defineProperty(shadowExports, k, { enumerable: true, configurable: true, get: () => source[k] });
      };
      const copy = await settle(() => Reflect.apply(interpreted, this, shadow));
      compare('vite-ssr-module', key, real, copy, [args[at.__vite_ssr_exports__], shadowExports]);
      if (!real.ok) throw real.value;
      return real.value;
    };
  }
  if (kind === 'function') {
    return function (...args) {
      if (new.target) return Reflect.construct(native, args, new.target);
      const real = settle(() => Reflect.apply(native, this, args));
      const copy = settle(() => Reflect.apply(interpreted, this, args));
      compare('function', key, real, copy, null);
      if (!real.ok) throw real.value;
      return real.value;
    };
  }
  if (kind === 'async') {
    return async function (...args) {
      const real = await settle(() => Reflect.apply(native, this, args));
      const copy = await settle(() => Reflect.apply(interpreted, this, args));
      compare('async', key, real, copy, null);
      if (!real.ok) throw real.value;
      return real.value;
    };
  }
  // Generators are compared by what one iteration of each yields to the end.
  return native;
}

const kinds = [
  ['function', Function],
  ['async', Object.getPrototypeOf(async function () {}).constructor],
  ['generator', Object.getPrototypeOf(function* () {}).constructor],
  ['asyncGenerator', Object.getPrototypeOf(async function* () {}).constructor],
];
for (const [kind, Native] of kinds) {
  const routed = function (...args) {
    const native = new.target ? Reflect.construct(Native, args, new.target) : Reflect.apply(Native, undefined, args);
    const params = args.slice(0, -1).map(String);
    const body = args.length ? String(args[args.length - 1]) : '';
    record({ functions: 1 });
    const key = createHash('sha256').update(JSON.stringify([kind, params, body])).digest('hex').slice(0, 16);
    writeFileSync(join(corpus, `${key}.json`), JSON.stringify({ kind, params, body }));
    let interpreted;
    try {
      interpreted = interp.compileFunction(kind, params, body);
    } catch (e) {
      record({ refused: [{ key, kind, error: `${e && e.code} ${e && e.message}` }] });
      return native;
    }
    return shadowed(kind, native, interpreted, params, key);
  };
  Object.defineProperty(routed, 'prototype', { value: Native.prototype });
  Object.defineProperty(Native.prototype, 'constructor', { value: routed, writable: true, configurable: true });
  if (kind === 'function') globalThis.Function = routed;
}

routeRunInThisContext((code, native) => {
  const value = native();
  record({ vmExpressions: 1 });
  const key = createHash('sha256').update(JSON.stringify(['vm', code])).digest('hex').slice(0, 16);
  writeFileSync(join(corpus, `${key}.json`), JSON.stringify({ kind: 'expression', code }));
  let interpreted;
  try {
    // Called as node-shims calls it: with the global object as `this`, a script's own.
    interpreted = Reflect.apply(interp.compileExpression(code), globalThis, []);
  } catch (e) {
    record({ refused: [{ key, kind: 'vm', error: `${e && e.code} ${e && e.message}` }] });
    return value;
  }
  if (typeof value !== 'function' || typeof interpreted !== 'function') {
    compare('vm', key, { ok: true, value }, { ok: true, value: interpreted }, null);
    return value;
  }
  // A CommonJS wrapper, (exports, require, module, ...): run for real, then
  // interpreted on a shadow module object, with the same require (its
  // modules are cached, so nothing is evaluated twice).
  return function (...args) {
    const module = args[2];
    const commonJs = module !== null && typeof module === 'object' && module.exports === args[0];
    const shadowModule = { exports: {} };
    const shadow = args.slice();
    if (commonJs) { shadow[0] = shadowModule.exports; shadow[2] = shadowModule; }
    const finish = (real, copy) => {
      compare('vm-module', key, real, copy, commonJs && real.ok && copy.ok ? [module.exports, shadowModule.exports] : null);
      if (!real.ok) throw real.value;
      return real.value;
    };
    const real = settle(() => Reflect.apply(value, this, args));
    const copy = settle(() => Reflect.apply(interpreted, this, shadow));
    if (real instanceof Promise || copy instanceof Promise) return Promise.all([real, copy]).then(([r, c]) => finish(r, c));
    return finish(real, copy);
  };
});

// Module files written to a Vite temp directory (the bundled config): captured as loaded.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (/\/\.vite-temp\/|\.timestamp-/.test(url) && result.source) {
      const text = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      record({ modules: [{ url, text }] });
    }
    return result;
  },
});
