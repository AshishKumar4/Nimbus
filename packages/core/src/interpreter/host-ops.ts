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

/** A function as the interpreter holds one it made: callable with any receiver and arguments. */
export type NativeFunction = (this: unknown, ...args: unknown[]) => unknown;

/** The interpreter-side callbacks the function factories call. */
export interface FunctionRuntime<F, E, R> {
  /** Run a plain function, method, getter or setter body. */
  call(fi: F, scope: E, fn: Function, thisArg: unknown, args: IArguments, newTarget: Function | undefined, home: object | undefined): unknown;
  /** Run an arrow function body. */
  arrow(fi: F, scope: E, args: unknown[]): unknown;
  /** Bind a call's environment: the function's frame with its parameters bound. */
  enter(fi: F, scope: E, fn: Function | undefined, thisArg: unknown, args: ArrayLike<unknown>, newTarget: Function | undefined, home: object | undefined): E;
  /** A body's completion as the function's return value. */
  finish(fi: F, result: unknown): unknown;
  /** Run a base class constructor: fields, then the body. */
  construct(fi: F, scope: E, ctor: Function, record: R, thisArg: object, args: IArguments, newTarget: Function): unknown;
  /** Run a derived class constructor, whose `this` comes from super(). */
  constructDerived(fi: F, scope: E, ctor: Function, record: R, args: IArguments, newTarget: Function): unknown;
  /** The operand of the await, yield or yield* an async generator body just signalled. */
  operand(): unknown;
  readonly AWAIT: object;
  readonly YIELD: object;
  readonly DELEGATE: object;
  /** The value an async generator body is returned with when the consumer calls return(). */
  readonly MARK: object;
}

/** What an interpreted function's body is, as the factories read it. */
export interface FactoryFunctionInfo {
  /** The body when it never suspends. */
  readonly body: ((env: never) => unknown) | null;
  /** The body as a generator when it awaits or yields. */
  readonly gen: ((env: never) => Generator<unknown, unknown, unknown>) | null;
}

/** Native functions of each kind whose bodies run interpreted code. */
export interface FunctionFactories<F extends FactoryFunctionInfo, E, R> {
  plain(fi: F, scope: E): NativeFunction;
  method(fi: F, scope: E, home: object | undefined): NativeFunction;
  arrow(fi: F, scope: E): NativeFunction;
  generator(fi: F, scope: E, home: object | undefined): NativeFunction;
  async(fi: F, scope: E, home: object | undefined): NativeFunction;
  asyncArrow(fi: F, scope: E): NativeFunction;
  asyncGenerator(fi: F, scope: E, home: object | undefined): NativeFunction;
  classBase(fi: F, scope: E, record: R): NativeFunction;
  classDerived(fi: F, scope: E, parent: unknown, record: R): NativeFunction;
}

/** The operators of the language over arbitrary values (strict mode unless named sloppy). */
export interface HostOperators {
  add(a: unknown, b: unknown): unknown;
  sub(a: unknown, b: unknown): unknown;
  mul(a: unknown, b: unknown): unknown;
  div(a: unknown, b: unknown): unknown;
  mod(a: unknown, b: unknown): unknown;
  exp(a: unknown, b: unknown): unknown;
  shl(a: unknown, b: unknown): unknown;
  shr(a: unknown, b: unknown): unknown;
  ushr(a: unknown, b: unknown): unknown;
  and(a: unknown, b: unknown): unknown;
  or(a: unknown, b: unknown): unknown;
  xor(a: unknown, b: unknown): unknown;
  lt(a: unknown, b: unknown): boolean;
  gt(a: unknown, b: unknown): boolean;
  le(a: unknown, b: unknown): boolean;
  ge(a: unknown, b: unknown): boolean;
  /** `key in target` */
  has(key: unknown, target: unknown): boolean;
  instanceOf(value: unknown, target: unknown): boolean;
  /** Unary minus. */
  neg(a: unknown): unknown;
  /** Unary plus (ToNumber). */
  plus(a: unknown): unknown;
  /** Bitwise not. */
  bitNot(a: unknown): unknown;
  /** ToNumeric: what `x++` returns. */
  numeric(v: unknown): unknown;
  /** A numeric value plus one, minus one. */
  increment(n: unknown): unknown;
  decrement(n: unknown): unknown;
  /** ToPropertyKey of an object (its ToPrimitive with hint string). */
  propertyKey(value: object): PropertyKey;
  get(target: unknown, key: unknown): unknown;
  /**
   * A reader of the global `name`, for the well-known globals: a named load
   * of its own, which V8 caches per site, where a keyed load on the global
   * object is a slow lookup every time. Undefined for other names.
   */
  globalReader(name: string): (() => unknown) | undefined;
  set(target: unknown, key: unknown, value: unknown): void;
  setSloppy(target: unknown, key: unknown, value: unknown): void;
  remove(target: unknown, key: unknown): boolean;
  removeSloppy(target: unknown, key: unknown): boolean;
}

export interface HostOps {
  readonly ops: HostOperators;
  bind<F extends FactoryFunctionInfo, E, R>(rt: FunctionRuntime<F, E, R>): {
    readonly strict: FunctionFactories<F, E, R>;
    readonly sloppy: FunctionFactories<F, E, R>;
  };
}

/**
 * The factories' text, instantiated twice: once sloppy, once strict. Each
 * wrapper is created inside a comma expression so it starts anonymous (its
 * name is defined by the interpreter). Generators and async generators bind
 * their environment in a parameter default (the rest element's absent key),
 * which runs when the function is called, before the generator object
 * exists, as parameter binding does natively.
 */
const FACTORIES = String.raw`
const { call, arrow: callArrow, enter, finish, construct, constructDerived, operand, AWAIT, YIELD, MARK } = rt;
const KEY = Symbol("nimbus.interpreter.environment");
// Drives an async generator body from a state the consumer's return()
// request left suspended (a finally block that awaits or yields). Returns
// the body's final completion: MARK when it let the return proceed.
async function* drain(it, r) {
  for (;;) {
    if (r.done) return r.value;
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
          if (result !== MARK) return result;
        }
      }
    }
    r = ok ? it.next(value) : it.throw(value);
  }
}
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
    const f = (0, function* (...{ [KEY]: env = enter(fi, scope, f, this, arguments, undefined, home) }) {
      return finish(fi, fi.body ? fi.body(env) : yield* fi.gen(env));
    });
    return f;
  },
  async(fi, scope, home) {
    const f = (0, async function () {
      const env = enter(fi, scope, f, this, arguments, undefined, home);
      if (fi.body) return finish(fi, fi.body(env));
      const it = fi.gen(env);
      let r = it.next();
      while (!r.done) {
        let value, ok = true;
        try { value = await r.value; } catch (e) { ok = false; value = e; }
        r = ok ? it.next(value) : it.throw(value);
      }
      return finish(fi, r.value);
    });
    return f;
  },
  asyncArrow(fi, scope) {
    return async (...args) => {
      const env = enter(fi, scope, undefined, undefined, args, undefined, undefined);
      if (fi.body) return finish(fi, fi.body(env));
      const it = fi.gen(env);
      let r = it.next();
      while (!r.done) {
        let value, ok = true;
        try { value = await r.value; } catch (e) { ok = false; value = e; }
        r = ok ? it.next(value) : it.throw(value);
      }
      return finish(fi, r.value);
    };
  },
  // The body yields AWAIT, YIELD or DELEGATE with its operand beside it. A
  // return() request at a yield is a return completion this frame cannot
  // read the value of, so the body is returned with MARK: if its finally
  // blocks leave MARK alone, the native return proceeds with its own value.
  asyncGenerator(fi, scope, home) {
    const f = (0, async function* (...{ [KEY]: env = enter(fi, scope, f, this, arguments, undefined, home) }) {
      if (fi.body) return finish(fi, fi.body(env));
      const it = fi.gen(env);
      let r = it.next();
      for (;;) {
        if (r.done) return finish(fi, r.value);
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
              if (result !== MARK) return finish(fi, result);
            }
          }
        }
        r = ok ? it.next(value) : it.throw(value);
      }
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
] as const;

/** The module's source: `module.exports` is a HostOps. */
export const HOST_OPS_SOURCE = String.raw`
const ops = (function () {
  "use strict";
  return {
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
    propertyKey: (v) => Reflect.ownKeys({ [v]: 0 })[0],
    get: (o, k) => o[k],
    set: (o, k, v) => { o[k] = v; },
    remove: (o, k) => delete o[k],
  };
})();
const globals = { ${WELL_KNOWN_GLOBALS.map((name) => `${JSON.stringify(name)}: () => globalThis.${name}`).join(', ')} };
ops.globalReader = (name) => (Object.hasOwn(globals, name) ? globals[name] : undefined);
ops.setSloppy = function (o, k, v) { o[k] = v; };
ops.removeSloppy = function (o, k) { return delete o[k]; };
function sloppy(rt) {${FACTORIES}}
const strict = (function () {
  "use strict";
  return function (rt) {${FACTORIES}};
})();
module.exports = { ops, bind: (rt) => ({ strict: strict(rt), sloppy: sloppy(rt) }) };
`;
