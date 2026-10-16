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
//     receiver and arguments, and the results compared (an awaitable by
//     what it settles to);
//   - a generator or async generator: the program gets the native generator
//     function and its objects, and each next, return and throw it makes on
//     one is made on the interpreted copy (a value the native one handed
//     out, sent back, reaches the copy as the copy's own), and the steps
//     compared.
// The arguments to a constructor are converted to strings once, for both
// (constructor-hooks.mjs). A comparison still waiting for an awaitable when
// the run ends is reported (`awaiting`).
//
// THE CONTRACT: the interpreted copy runs on the same inputs as the native
// run, after it. It is not isolated from it. So a function that changes what
// it is given (its arguments, its receiver, state it reaches) changes it
// twice, and the copy starts from what the native run left: `s => ++s.n` on
// { n: 0 } is reported as a mismatch, `result: number 1 vs number 2`, and
// the program then sees n === 2. That mismatch is this harness's limit, not
// the interpreter's; it can only fail loudly, never pass silently. The
// program gets the native return itself (a native Promise is the same
// Promise), and observing it for the comparison marks it handled, so a
// shadow run reports no unhandled rejection of a returned Promise: the
// native and interpreted runs grade that.
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

/** What running `run` came to: what it returned (an awaitable as it is) or what it threw. */
function outcome(run) {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    return { ok: false, value: e };
  }
}

const isThenable = (value) => value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
const awaits = (o) => o.ok && isThenable(o.value);

/** What an outcome comes to once an awaitable it returned settles. */
const settled = (o) => (awaits(o) ? Promise.resolve(o.value).then((value) => ({ ok: true, value }), (value) => ({ ok: false, value })) : o);

/** Give the program what the native run came to, itself. */
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
 * Compare two outcomes now, or, when they returned awaitables, once both
 * settle; `link(native, interpreted)` sees the settled pair first. A
 * comparison still waiting is counted (`awaiting`), so one the run ends
 * before is reported, not lost.
 */
function compareOutcomes(label, key, real, copy, exportsPair = null, link = null) {
  if (awaits(real) !== awaits(copy)) {
    record({ compared: 1, mismatches: [{ label, key, difference: `result: native ${awaits(real) ? 'returned' : 'did not return'} an awaitable, interpreted ${awaits(copy) ? 'did' : 'did not'}` }] });
  } else if (awaits(real)) {
    record({ awaiting: 1 });
    Promise.all([settled(real), settled(copy)]).then(([r, c]) => {
      link?.(r, c);
      compare(label, key, r, c, exportsPair);
      record({ awaiting: -1 });
    });
  } else {
    link?.(real, copy);
    compare(label, key, real, copy, exportsPair);
  }
}

/** Each native generator object the program got from a shadowed generator, with its interpreted copy. */
const mirrors = new WeakMap();

const isObject = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');

/** What the copy is sent for `value`: the copy's own counterpart of a value the native generator handed out, or the value. */
const counterpartOf = (mirror, value) => (mirror.counterparts.has(value) ? mirror.counterparts.get(value) : value);

/** After a step, remember the copy's counterpart of what the native generator handed out. */
function linkStep(mirror, real, copy) {
  const handed = real.ok && isObject(real.value) ? real.value.value : undefined;
  if (isObject(handed) && copy.ok && isObject(copy.value)) mirror.counterparts.set(handed, copy.value.value);
}

// Every generator's and async generator's next, return and throw: on a
// mirrored one, the same step is taken on the interpreted copy and
// compared. The program's own receiver and arguments reach the native
// method as they are, and its step is never delayed. An async generator's
// copy takes its steps in order, each once the step before it has settled
// on both sides, so a value handed out by one is the copy's own when sent
// back in the next.
for (const prototype of [Object.getPrototypeOf(function* () {}).prototype, Object.getPrototypeOf(async function* () {}).prototype]) {
  for (const method of ['next', 'return', 'throw']) {
    const native = prototype[method];
    const mirrored = {
      [method](...args) {
        const mirror = mirrors.get(this);
        const real = outcome(() => Reflect.apply(native, this, args));
        if (mirror === undefined) return forward(real);
        const label = `${mirror.kind} ${method}`;
        const step = () => outcome(() => Reflect.apply(mirror.copy[method], mirror.copy, args.map((arg) => counterpartOf(mirror, arg))));
        if (mirror.kind === 'generator') {
          compareOutcomes(label, mirror.key, real, step(), null, (r, c) => linkStep(mirror, r, c));
        } else {
          record({ awaiting: 1 });
          const realSettled = settled(real);
          mirror.steps = mirror.steps.then(async () => {
            const copy = await settled(step());
            const r = await realSettled;
            linkStep(mirror, r, copy);
            compare(label, mirror.key, r, copy, null);
            record({ awaiting: -1 });
          });
        }
        return forward(real);
      },
    }[method];
    Object.defineProperty(mirrored, 'length', { value: native.length });
    Object.defineProperty(prototype, method, { value: mirrored, writable: true, configurable: true, enumerable: false });
  }
}

/**
 * The generator function the program gets: the native one behind a Proxy
 * that only intercepts calls, so its name, length, prototype (live, if the
 * program replaces it), [[Prototype]] and refusal to construct are the
 * native function's own, and its objects are native ones, each mirrored.
 */
function shadowedGenerator(kind, key, native, interpreted) {
  return new Proxy(native, {
    apply(target, receiver, args) {
      const real = outcome(() => Reflect.apply(target, receiver, args));
      const copy = outcome(() => Reflect.apply(interpreted, receiver, args));
      if (real.ok && copy.ok) mirrors.set(real.value, { kind, key, copy: copy.value, counterparts: new WeakMap(), steps: kind === 'asyncGenerator' ? Promise.resolve() : null });
      else compare(kind, key, real, copy, null);
      return forward(real);
    },
  });
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
      compare('async', key, real, await settled(outcome(() => Reflect.apply(interpreted, this, args))), null);
      return forward(real);
    };
  }
  if (kind === 'generator' || kind === 'asyncGenerator') return shadowedGenerator(kind, key, native, interpreted);
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
