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
// Every module file the program loads from a Vite temp directory (the
// bundled config) is captured, to be compared after the run.
// Mismatches, refusals and counts go to the report file named by
// NIMBUS_DIFF_REPORT, written when the process exits.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';

import { same } from './same.mjs';

const require = createRequire(import.meta.url);
const { createInterpreter } = require(process.env.NIMBUS_INTERPRETER);
const interp = createInterpreter(require(process.env.NIMBUS_INTERPRETER_OPS), {
  dynamicImport: (parent, specifier) => import(parent && /^\.\.?\//.test(String(specifier)) ? new URL(String(specifier), parent).href : String(specifier)),
});
const corpus = process.env.NIMBUS_DIFF_CORPUS;
mkdirSync(corpus, { recursive: true });
const report = { functions: 0, ssrModules: 0, compared: 0, equal: 0, mismatches: [], refused: [], modules: [] };

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
  report.compared++;
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
  if (difference) report.mismatches.push({ label, key, difference });
  else report.equal++;
}

const SSR_KEYS = ['__vite_ssr_exports__', '__vite_ssr_import_meta__', '__vite_ssr_import__', '__vite_ssr_dynamic_import__', '__vite_ssr_exportAll__', '__vite_ssr_exportName__'];

function shadowed(kind, native, interpreted, params, key) {
  const ssr = kind === 'async' && SSR_KEYS.every((k) => params.includes(k));
  if (ssr) {
    report.ssrModules++;
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
    report.functions++;
    const key = createHash('sha256').update(JSON.stringify([kind, params, body])).digest('hex').slice(0, 16);
    writeFileSync(join(corpus, `${key}.json`), JSON.stringify({ kind, params, body }));
    let interpreted;
    try {
      interpreted = interp.compileFunction(kind, params, body);
    } catch (e) {
      report.refused.push({ key, kind, error: `${e && e.code} ${e && e.message}` });
      return native;
    }
    return shadowed(kind, native, interpreted, params, key);
  };
  Object.defineProperty(routed, 'prototype', { value: Native.prototype });
  Object.defineProperty(Native.prototype, 'constructor', { value: routed, writable: true, configurable: true });
  if (kind === 'function') globalThis.Function = routed;
}

// Module files written to a Vite temp directory (the bundled config): captured as loaded.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (/\/\.vite-temp\/|\.timestamp-/.test(url) && result.source) {
      const text = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      report.modules.push({ url, text });
    }
    return result;
  },
});

process.on('exit', () => {
  writeFileSync(process.env.NIMBUS_DIFF_REPORT, JSON.stringify(report));
});
