
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
const globals = { "Object": () => globalThis.Object, "Function": () => globalThis.Function, "Array": () => globalThis.Array, "Number": () => globalThis.Number, "String": () => globalThis.String, "Boolean": () => globalThis.Boolean, "Symbol": () => globalThis.Symbol, "BigInt": () => globalThis.BigInt, "Math": () => globalThis.Math, "JSON": () => globalThis.JSON, "Date": () => globalThis.Date, "RegExp": () => globalThis.RegExp, "Error": () => globalThis.Error, "TypeError": () => globalThis.TypeError, "RangeError": () => globalThis.RangeError, "SyntaxError": () => globalThis.SyntaxError, "ReferenceError": () => globalThis.ReferenceError, "EvalError": () => globalThis.EvalError, "URIError": () => globalThis.URIError, "AggregateError": () => globalThis.AggregateError, "Promise": () => globalThis.Promise, "Proxy": () => globalThis.Proxy, "Reflect": () => globalThis.Reflect, "Map": () => globalThis.Map, "Set": () => globalThis.Set, "WeakMap": () => globalThis.WeakMap, "WeakSet": () => globalThis.WeakSet, "WeakRef": () => globalThis.WeakRef, "FinalizationRegistry": () => globalThis.FinalizationRegistry, "ArrayBuffer": () => globalThis.ArrayBuffer, "SharedArrayBuffer": () => globalThis.SharedArrayBuffer, "DataView": () => globalThis.DataView, "Uint8Array": () => globalThis.Uint8Array, "Int8Array": () => globalThis.Int8Array, "Uint16Array": () => globalThis.Uint16Array, "Int16Array": () => globalThis.Int16Array, "Uint32Array": () => globalThis.Uint32Array, "Int32Array": () => globalThis.Int32Array, "Float32Array": () => globalThis.Float32Array, "Float64Array": () => globalThis.Float64Array, "BigInt64Array": () => globalThis.BigInt64Array, "BigUint64Array": () => globalThis.BigUint64Array, "Uint8ClampedArray": () => globalThis.Uint8ClampedArray, "Intl": () => globalThis.Intl, "Atomics": () => globalThis.Atomics, "globalThis": () => globalThis.globalThis, "undefined": () => globalThis.undefined, "NaN": () => globalThis.NaN, "Infinity": () => globalThis.Infinity, "isNaN": () => globalThis.isNaN, "isFinite": () => globalThis.isFinite, "parseInt": () => globalThis.parseInt, "parseFloat": () => globalThis.parseFloat, "encodeURIComponent": () => globalThis.encodeURIComponent, "decodeURIComponent": () => globalThis.decodeURIComponent, "encodeURI": () => globalThis.encodeURI, "decodeURI": () => globalThis.decodeURI, "escape": () => globalThis.escape, "unescape": () => globalThis.unescape, "console": () => globalThis.console, "process": () => globalThis.process, "Buffer": () => globalThis.Buffer, "setTimeout": () => globalThis.setTimeout, "clearTimeout": () => globalThis.clearTimeout, "setInterval": () => globalThis.setInterval, "clearInterval": () => globalThis.clearInterval, "setImmediate": () => globalThis.setImmediate, "clearImmediate": () => globalThis.clearImmediate, "queueMicrotask": () => globalThis.queueMicrotask, "structuredClone": () => globalThis.structuredClone, "fetch": () => globalThis.fetch, "Request": () => globalThis.Request, "Response": () => globalThis.Response, "Headers": () => globalThis.Headers, "URL": () => globalThis.URL, "URLSearchParams": () => globalThis.URLSearchParams, "TextEncoder": () => globalThis.TextEncoder, "TextDecoder": () => globalThis.TextDecoder, "AbortController": () => globalThis.AbortController, "AbortSignal": () => globalThis.AbortSignal, "Event": () => globalThis.Event, "EventTarget": () => globalThis.EventTarget, "crypto": () => globalThis.crypto, "performance": () => globalThis.performance, "atob": () => globalThis.atob, "btoa": () => globalThis.btoa, "Blob": () => globalThis.Blob, "FormData": () => globalThis.FormData, "ReadableStream": () => globalThis.ReadableStream, "WritableStream": () => globalThis.WritableStream, "TransformStream": () => globalThis.TransformStream, "WebAssembly": () => globalThis.WebAssembly, "navigator": () => globalThis.navigator, "require": () => globalThis.require, "module": () => globalThis.module, "exports": () => globalThis.exports, "__filename": () => globalThis.__filename, "__dirname": () => globalThis.__dirname };
ops.globalReader = (name) => (Object.hasOwn(globals, name) ? globals[name] : undefined);
ops.setSloppy = function (o, k, v) { o[k] = v; };
ops.removeSloppy = function (o, k) { return delete o[k]; };
function sloppy(rt) {
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
}
const strict = (function () {
  "use strict";
  return function (rt) {
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
};
})();
module.exports = { ops, bind: (rt) => ({ strict: strict(rt), sloppy: sloppy(rt) }) };
