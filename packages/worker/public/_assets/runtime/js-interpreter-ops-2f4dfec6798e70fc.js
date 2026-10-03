
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
  const globals = { __proto__: null, "Object": () => g.Object, "Function": () => g.Function, "Array": () => g.Array, "Number": () => g.Number, "String": () => g.String, "Boolean": () => g.Boolean, "Symbol": () => g.Symbol, "BigInt": () => g.BigInt, "Math": () => g.Math, "JSON": () => g.JSON, "Date": () => g.Date, "RegExp": () => g.RegExp, "Error": () => g.Error, "TypeError": () => g.TypeError, "RangeError": () => g.RangeError, "SyntaxError": () => g.SyntaxError, "ReferenceError": () => g.ReferenceError, "EvalError": () => g.EvalError, "URIError": () => g.URIError, "AggregateError": () => g.AggregateError, "Promise": () => g.Promise, "Proxy": () => g.Proxy, "Reflect": () => g.Reflect, "Map": () => g.Map, "Set": () => g.Set, "WeakMap": () => g.WeakMap, "WeakSet": () => g.WeakSet, "WeakRef": () => g.WeakRef, "FinalizationRegistry": () => g.FinalizationRegistry, "ArrayBuffer": () => g.ArrayBuffer, "SharedArrayBuffer": () => g.SharedArrayBuffer, "DataView": () => g.DataView, "Uint8Array": () => g.Uint8Array, "Int8Array": () => g.Int8Array, "Uint16Array": () => g.Uint16Array, "Int16Array": () => g.Int16Array, "Uint32Array": () => g.Uint32Array, "Int32Array": () => g.Int32Array, "Float32Array": () => g.Float32Array, "Float64Array": () => g.Float64Array, "BigInt64Array": () => g.BigInt64Array, "BigUint64Array": () => g.BigUint64Array, "Uint8ClampedArray": () => g.Uint8ClampedArray, "Intl": () => g.Intl, "Atomics": () => g.Atomics, "globalThis": () => g.globalThis, "undefined": () => g.undefined, "NaN": () => g.NaN, "Infinity": () => g.Infinity, "isNaN": () => g.isNaN, "isFinite": () => g.isFinite, "parseInt": () => g.parseInt, "parseFloat": () => g.parseFloat, "encodeURIComponent": () => g.encodeURIComponent, "decodeURIComponent": () => g.decodeURIComponent, "encodeURI": () => g.encodeURI, "decodeURI": () => g.decodeURI, "escape": () => g.escape, "unescape": () => g.unescape, "console": () => g.console, "process": () => g.process, "Buffer": () => g.Buffer, "setTimeout": () => g.setTimeout, "clearTimeout": () => g.clearTimeout, "setInterval": () => g.setInterval, "clearInterval": () => g.clearInterval, "setImmediate": () => g.setImmediate, "clearImmediate": () => g.clearImmediate, "queueMicrotask": () => g.queueMicrotask, "structuredClone": () => g.structuredClone, "fetch": () => g.fetch, "Request": () => g.Request, "Response": () => g.Response, "Headers": () => g.Headers, "URL": () => g.URL, "URLSearchParams": () => g.URLSearchParams, "TextEncoder": () => g.TextEncoder, "TextDecoder": () => g.TextDecoder, "AbortController": () => g.AbortController, "AbortSignal": () => g.AbortSignal, "Event": () => g.Event, "EventTarget": () => g.EventTarget, "crypto": () => g.crypto, "performance": () => g.performance, "atob": () => g.atob, "btoa": () => g.btoa, "Blob": () => g.Blob, "FormData": () => g.FormData, "ReadableStream": () => g.ReadableStream, "WritableStream": () => g.WritableStream, "TransformStream": () => g.TransformStream, "WebAssembly": () => g.WebAssembly, "navigator": () => g.navigator, "require": () => g.require, "module": () => g.module, "exports": () => g.exports, "__filename": () => g.__filename, "__dirname": () => g.__dirname };
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
function sloppy(rt) {
const { call, arrow: callArrow, enter, enterGenerator, takeFrame, finish, construct, constructDerived, operand, AWAIT, YIELD, MARK } = rt;
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
    const f = (0, async function* (...{ [enterGenerator(fi, scope, f, this, arguments, home)]: length }) {
      const env = takeFrame(arguments);
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
const { call, arrow: callArrow, enter, enterGenerator, takeFrame, finish, construct, constructDerived, operand, AWAIT, YIELD, MARK } = rt;
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
    const f = (0, async function* (...{ [enterGenerator(fi, scope, f, this, arguments, home)]: length }) {
      const env = takeFrame(arguments);
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
module.exports = { bind: (rt) => ({ ops: hostOperators(rt), strict: strict(rt), sloppy: sloppy(rt) }) };
