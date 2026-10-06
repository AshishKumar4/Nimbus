/**
 * host-ops.ts — the part of the interpreter that has to be JavaScript source
 * of its own, loaded as a separate CommonJS module beside the interpreter.
 *
 * Two things live here. First, the language's operators over arbitrary
 * values (`a + b`, `a < b`, `o[k]`, `delete o[k]`, ...), which TypeScript
 * cannot type over `unknown`. Second, the native functions an interpreted
 * function IS. Every interpreted function is a real function of its kind
 * (a plain function, a method, an arrow, a generator, an async function, an
 * async generator, a class), created here from a native literal of that kind
 * whose body calls back into the interpreter. So `instanceof`, prototypes,
 * `new`, `new.target`, `this` coercion, `arguments` and generator and promise
 * machinery are V8's own; the interpreter supplies only the body.
 *
 * Why a module of its own: sloppy-mode code differs observably from strict
 * (a plain function's `this` is the global object when called bare, its
 * `arguments.callee` is the function, an assignment to a read-only property
 * is silently ignored). A native function gets those semantics only from
 * source text in sloppy mode, and the interpreter bundle is strict. This
 * module is sloppy at its top level; the operators and the strict copy of
 * the factories are inside "use strict" functions.
 */
/**
 * An async function's body, after `env` is bound: a body that never awaits
 * runs as is; one that does is a generator yielding what it awaits, driven
 * here: each yielded value is awaited and the outcome resumes it. Written
 * once, spliced into `async` and `asyncArrow`, so each awaits in its own
 * frame (a shared async helper would add ticks to every call).
 */
const ASYNC_BODY = String.raw `
      if (fi.body) return finish(fi, fi.body(env));
      const it = fi.gen(env);
      let r = it.next();
      while (!r.done) {
        let value, ok = true;
        try { value = await r.value; } catch (e) { ok = false; value = e; }
        r = ok ? it.next(value) : it.throw(value);
      }
      return finish(fi, r.value);`;
/**
 * An async generator body's driving loop over `it` from the step `r`: the
 * body yields AWAIT, YIELD or DELEGATE with its operand beside it (see
 * asyncGenerator below). Spliced into `drain` and `asyncGenerator`, each
 * completing through `complete` (as is, or through finish), at `indent`.
 */
function asyncGeneratorSteps(complete, indent) {
    return String.raw `
for (;;) {
  if (r.done) return ${complete('r.value')};
  const mark = r.value, x = operand();
  let value, ok = true;
  if (mark === AWAIT) {
    try { value = await x; } catch (e) { ok = false; value = e; }
  } else {
    let resumed = false;
    try { value = mark === YIELD ? yield x : yield* x; resumed = true; }
    catch (e) { ok = false; value = e; resumed = true; }
    finally {
      if (!resumed) {
        const end = it.return(MARK);
        const result = end.done ? end.value : yield* drain(it, end);
        if (result !== MARK) return ${complete('result')};
      }
    }
  }
  r = ok ? it.next(value) : it.throw(value);
}`.replace(/\n/g, '\n' + indent);
}
/**
 * The factories' text, instantiated twice: once sloppy, once strict. Each
 * wrapper is created inside a comma expression so it starts anonymous (its
 * name is defined by the interpreter). Generators and async generators bind
 * their environment while their parameters bind, when the function is
 * called and before the generator object exists, as parameter binding does
 * natively: in the computed key of the rest element's pattern, which then
 * reads the rest array's own `length` (a read of any other key could reach
 * Array.prototype, where a program may answer it). The body takes the
 * environment by the call's arguments object.
 */
const FACTORIES = String.raw `
const { call, arrow: callArrow, enter, enterGenerator, takeFrame, finish, construct, constructDerived, operand, AWAIT, YIELD, MARK } = rt;
// Drives an async generator body from a state the consumer's return()
// request left suspended (a finally block that awaits or yields). Returns
// the body's final completion: MARK when it let the return proceed.
async function* drain(it, r) {${asyncGeneratorSteps((value) => value, '  ')}
}
drain.prototype = rt.SafeAsyncGeneratorPrototype;
return {
  plain(fi, scope) {
    const f = (0, function () { return call(fi, scope, f, this, arguments, new.target, undefined); });
    return f;
  },
  method(fi, scope, home) {
    const f = { m() { return call(fi, scope, f, this, arguments, undefined, home); } }.m;
    return f;
  },
  arrow(fi, scope) {
    return (...args) => callArrow(fi, scope, args);
  },
  generator(fi, scope, home) {
    const f = (0, function* (...{ [enterGenerator(fi, scope, f, this, arguments, home)]: length }) {
      const env = takeFrame(arguments);
      return finish(fi, fi.body ? fi.body(env) : yield* fi.gen(env));
    });
    return f;
  },
  async(fi, scope, home) {
    const f = (0, async function () {
      const env = enter(fi, scope, f, this, arguments, undefined, home);${ASYNC_BODY}
    });
    return f;
  },
  asyncArrow(fi, scope) {
    return async (...args) => {
      const env = enter(fi, scope, undefined, undefined, args, undefined, undefined);${ASYNC_BODY}
    };
  },
  // The body yields AWAIT, YIELD or DELEGATE with its operand beside it. A
  // return() request at a yield is a return completion this frame cannot
  // read the value of, so the body is returned with MARK: if its finally
  // blocks leave MARK alone, the native return proceeds with its own value.
  asyncGenerator(fi, scope, home) {
    const f = (0, async function* (...{ [enterGenerator(fi, scope, f, this, arguments, home)]: length }) {
      const env = takeFrame(arguments);
      if (fi.body) return finish(fi, fi.body(env));
      const it = fi.gen(env);
      let r = it.next();${asyncGeneratorSteps((value) => `finish(fi, ${value})`, '      ')}
    });
    return f;
  },
  classBase(fi, scope, record) {
    const C = (0, class { constructor() { return construct(fi, scope, C, record, this, arguments, new.target); } });
    return C;
  },
  classDerived(fi, scope, parent, record) {
    const C = (0, class extends parent { constructor() { return constructDerived(fi, scope, C, record, arguments, new.target); } });
    return C;
  },
};
`;
/** Globals code reads constantly: each gets a reader function of its own (HostOperators.globalReader). */
const WELL_KNOWN_GLOBALS = [
    'Object', 'Function', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
    'Promise', 'Proxy', 'Reflect', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
    'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
    'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray',
    'Intl', 'Atomics', 'globalThis', 'undefined', 'NaN', 'Infinity', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
    'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'clearImmediate', 'queueMicrotask', 'structuredClone', 'fetch', 'Request', 'Response', 'Headers', 'URL',
    'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Event', 'EventTarget',
    'crypto', 'performance', 'atob', 'btoa', 'Blob', 'FormData', 'ReadableStream', 'WritableStream', 'TransformStream',
    'WebAssembly', 'navigator', 'require', 'module', 'exports', '__filename', '__dirname',
];
/** Each well-known global's reader, as source: a property read of the global object captured at the start. */
let WELL_KNOWN_GLOBALS_LIST = '';
for (let i = 0; i < WELL_KNOWN_GLOBALS.length; i++) {
    const name = WELL_KNOWN_GLOBALS[i];
    WELL_KNOWN_GLOBALS_LIST += `${i === 0 ? '' : ', '}"${name}": () => g.${name}`;
}
/** The module's source: `module.exports` is a HostOps. */
export const HOST_OPS_SOURCE = String.raw `
const operators = (function () {
  "use strict";
  return (ownKeys) => ({
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    div: (a, b) => a / b,
    mod: (a, b) => a % b,
    exp: (a, b) => a ** b,
    shl: (a, b) => a << b,
    shr: (a, b) => a >> b,
    ushr: (a, b) => a >>> b,
    and: (a, b) => a & b,
    or: (a, b) => a | b,
    xor: (a, b) => a ^ b,
    lt: (a, b) => a < b,
    gt: (a, b) => a > b,
    le: (a, b) => a <= b,
    ge: (a, b) => a >= b,
    has: (k, o) => k in o,
    instanceOf: (v, c) => v instanceof c,
    neg: (a) => -a,
    plus: (a) => +a,
    bitNot: (a) => ~a,
    numeric: (v) => { let x = v; return x++; },
    increment: (n) => { let x = n; return ++x; },
    decrement: (n) => { let x = n; return --x; },
    propertyKey: (v) => ownKeys({ [v]: 0 })[0],
    get: (o, k) => o[k],
    set: (o, k, v) => { o[k] = v; },
    remove: (o, k) => delete o[k],
  });
})();
function hostOperators(rt) {
  const g = rt.global, hasOwn = rt.hasOwn;
  const globals = { __proto__: null, ${WELL_KNOWN_GLOBALS_LIST} };
  const delegate = function* (iterable) { return yield* iterable; };
  delegate.prototype = rt.SafeGeneratorPrototype;
  // Every field in the literal: one set afterwards would run a setter a program put on Object.prototype.
  return {
    ...operators(rt.ownKeys),
    globalReader: (name) => (hasOwn(globals, name) ? globals[name] : undefined),
    setSloppy: function (o, k, v) { o[k] = v; },
    removeSloppy: function (o, k) { return delete o[k]; },
    delegate,
  };
}
function sloppy(rt) {${FACTORIES}}
const strict = (function () {
  "use strict";
  return function (rt) {${FACTORIES}};
})();
module.exports = { bind: (rt) => ({ ops: hostOperators(rt), strict: strict(rt), sloppy: sloppy(rt) }) };
`;
