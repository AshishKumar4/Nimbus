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
//   - any other function: called, or constructed with `new`, with the same
//     receiver and arguments, and the results compared (a Promise by what
//     it settles to);
//   - a generator or async generator: each next, return and throw the
//     program makes on the native iterator is made on the interpreted one,
//     and the steps compared.
// The arguments to a constructor are converted to strings once, for both
// (constructor-hooks.mjs).
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
import { registerHooks } from 'node:module';
import { join } from 'node:path';

import { loadInterpreter } from '../../unit/lib/interpreter-load.mjs';
import { hookFunctionConstructors } from './constructor-hooks.mjs';
import { recordPart } from './report.mjs';
import { same } from './same.mjs';
import { routeRunInThisContext } from './vm-route.mjs';

const interp = loadInterpreter(process.env.NIMBUS_INTERPRETER, process.env.NIMBUS_INTERPRETER_OPS, (parent, specifier) => (
  import(parent && /^\.\.?\//.test(String(specifier)) ? new URL(String(specifier), parent).href : String(specifier))
));
const corpus = process.env.NIMBUS_DIFF_CORPUS;
mkdirSync(corpus, { recursive: true });
const record = (part) => recordPart(process.env.NIMBUS_DIFF_REPORT, part);

/** What running `run` came to: what it returned (a Promise as it is) or what it threw. */
function outcome(run) {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    return { ok: false, value: e };
  }
}

const isPromise = (o) => o.ok && o.value instanceof Promise;

/** What an outcome comes to once a Promise it returned settles. */
const settled = (o) => (isPromise(o) ? o.value.then((value) => ({ ok: true, value }), (value) => ({ ok: false, value })) : o);

/** Give the program what the native run came to. */
function forward(real) {
  if (!real.ok) throw real.value;
  return real.value;
}

/** Record whether two outcomes of the same run are the same; `exportsPair()` names what to compare instead of the results. */
function compare(label, key, native, interpreted, exportsPair) {
  let difference = null;
  if (native.ok !== interpreted.ok) {
    difference = `outcome: native ${native.ok ? 'returned' : `threw ${native.value && native.value.message}`}, interpreted ${interpreted.ok ? 'returned' : `threw ${interpreted.value && interpreted.value.message}`}`;
  } else if (!native.ok) {
    if (String(native.value && native.value.message) !== String(interpreted.value && interpreted.value.message)) difference = `errors: ${native.value && native.value.message} vs ${interpreted.value && interpreted.value.message}`;
  } else if (exportsPair) {
    const [a, b] = exportsPair();
    difference = same(a, b, 'exports', 3);
  } else {
    difference = same(native.value, interpreted.value, 'result', 3);
  }
  record(difference ? { compared: 1, mismatches: [{ label, key, difference }] } : { compared: 1, equal: 1 });
}

/**
 * Compare two outcomes now, or, when one returned a Promise, once both
 * settle. Observing a native Promise marks it handled.
 */
function compareOutcomes(label, key, real, copy, exportsPair = null) {
  if (isPromise(real) !== isPromise(copy)) {
    record({ compared: 1, mismatches: [{ label, key, difference: `result: native ${isPromise(real) ? 'returned' : 'did not return'} a Promise, interpreted ${isPromise(copy) ? 'did' : 'did not'}` }] });
  } else if (isPromise(real)) {
    Promise.all([settled(real), settled(copy)]).then(([r, c]) => compare(label, key, r, c, exportsPair));
  } else {
    compare(label, key, real, copy, exportsPair);
  }
}

/**
 * The iterator the program gets for a generator call: an object of the
 * native iterator's prototype whose next, return and throw drive the native
 * iterator for the program and the interpreted one beside it, comparing
 * each step's outcome.
 */
function mirroredIterator(label, key, real, copy) {
  const step = (method) => ({
    value(argument) {
      const r = outcome(() => real[method](argument));
      compareOutcomes(`${label} ${method}`, key, r, outcome(() => copy[method](argument)));
      return forward(r);
    },
    writable: true,
    configurable: true,
  });
  return Object.create(Object.getPrototypeOf(real), { next: step('next'), return: step('return'), throw: step('throw') });
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
      const real = await settled(outcome(() => Reflect.apply(native, this, args)));
      const shadow = args.slice();
      shadow[at.__vite_ssr_exports__] = shadowExports;
      shadow[at.__vite_ssr_exportName__] = (name, getter) => Object.defineProperty(shadowExports, name, { enumerable: true, configurable: true, get: getter });
      shadow[at.__vite_ssr_exportAll__] = (source) => {
        for (const k in source) if (k !== 'default' && k !== '__esModule' && !(k in shadowExports)) Object.defineProperty(shadowExports, k, { enumerable: true, configurable: true, get: () => source[k] });
      };
      const copy = await settled(outcome(() => Reflect.apply(interpreted, this, shadow)));
      compare('vite-ssr-module', key, real, copy, () => [realExports, shadowExports]);
      return forward(real);
    };
  }
  if (kind === 'async') {
    return async function (...args) {
      const real = await settled(outcome(() => Reflect.apply(native, this, args)));
      const copy = await settled(outcome(() => Reflect.apply(interpreted, this, args)));
      compare('async', key, real, copy, null);
      return forward(real);
    };
  }
  if (kind === 'generator' || kind === 'asyncGenerator') {
    return function (...args) {
      const real = outcome(() => (new.target === undefined ? Reflect.apply(native, this, args) : Reflect.construct(native, args, new.target)));
      const copy = outcome(() => Reflect.apply(interpreted, this, args));
      if (!real.ok || !copy.ok) {
        compare(kind, key, real, copy, null);
        return forward(real);
      }
      return mirroredIterator(kind, key, real.value, copy.value);
    };
  }
  // An ordinary function: called, or constructed with `new`, both ways.
  return function (...args) {
    const run = (fn) => outcome(() => (new.target === undefined ? Reflect.apply(fn, this, args) : Reflect.construct(fn, args, new.target)));
    const real = run(native);
    compareOutcomes(new.target === undefined ? 'function' : 'construct', key, real, run(interpreted));
    return forward(real);
  };
}

hookFunctionConstructors(({ kind, params, body, native }) => {
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
});

// What node-shims captures as the launch starts, to call a script's function with.
const apply = Reflect.apply;
const scriptThis = globalThis;

routeRunInThisContext((code, native) => {
  const value = native();
  record({ vmExpressions: 1 });
  const key = createHash('sha256').update(JSON.stringify(['vm', code])).digest('hex').slice(0, 16);
  writeFileSync(join(corpus, `${key}.json`), JSON.stringify({ kind: 'expression', code }));
  let interpreted;
  try {
    // Called as node-shims calls it: with the global object as `this`, a script's own.
    interpreted = apply(interp.compileExpression(code), scriptThis, []);
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
    const real = outcome(() => Reflect.apply(value, this, args));
    compareOutcomes('vm-module', key, real, outcome(() => Reflect.apply(interpreted, this, shadow)), commonJs ? () => [module.exports, shadowModule.exports] : null);
    return forward(real);
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
