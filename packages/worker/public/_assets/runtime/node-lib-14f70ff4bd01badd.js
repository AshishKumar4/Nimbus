module.exports = {
  createCaresBinding: (...args) => require("./node-dns.js").createCaresBinding(...args),
  createNodeLib: function createNodeLib(platform) {
  "use strict";
  const platformUtil = platform.util;
  const primordials = platform.primordials;
  const { codes: nodeErrorCodes, hideStackFrames, isErrorStackTraceLimitWritable } = platform.errors;
  const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
  const typedArrayKind = (value) => Reflect.apply(typedArrayTag, value, []);

  // lib/internal/util/types.js: the binding's checks, and the typed arrays' by their tag.
  const types = { ...platformUtil.types, isArrayBufferView: ArrayBuffer.isView, isTypedArray: (value) => typedArrayKind(value) !== undefined };
  for (const kind of ["Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]) {
    types["is" + kind] = (value) => typedArrayKind(value) === kind;
  }

  // lib/internal/errors.js
  let maxStackErrorName;
  let maxStackErrorMessage;
  function isStackOverflowError(err) {
    if (maxStackErrorMessage === undefined) {
      try {
        function overflowStack() { overflowStack(); }
        overflowStack();
      } catch (e) {
        maxStackErrorMessage = e.message;
        maxStackErrorName = e.name;
      }
    }
    return !!err && err.name === maxStackErrorName && err.message === maxStackErrorMessage;
  }
  // lib/internal/assert.js
  function assert(value, message) {
    if (!value) throw new nodeErrorCodes.ERR_INTERNAL_ASSERTION(message);
  }
  assert.fail = (message) => { throw new nodeErrorCodes.ERR_INTERNAL_ASSERTION(message); };

  // lib/internal/util.js
  const colorRegExp = /\u001b\[\d\d?m/g;
  const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");
  const kCustomPromisifyArgsSymbol = platform.customPromisifyArgs;
  // libuv's errors (NODE_UV_ERRORS), by errno: [name, message].
  let uvErrorMap;
  const uvErrors = () => (uvErrorMap ??= new Map(platform.uvErrors.map(([errno, name, message]) => [errno, [name, message]])));
  class DNSException extends Error {
    constructor(code, syscall, hostname) {
      let errno;
      if (typeof code === "number") {
        errno = code;
        code = code === -3007 || code === -3008 ? "ENOTFOUND" : internalUtil.getSystemErrorName(code);
      }
      super(syscall + " " + code + (hostname ? " " + hostname : ""));
      this.errno = errno;
      this.code = code;
      this.syscall = syscall;
      if (hostname) this.hostname = hostname;
    }
    get ["constructor"]() { return Error; }
  }
  const codesWarned = new Set();
  function getDeprecationWarningEmitter(code, msg, deprecated) {
    let warned = false;
    return function () {
      if (warned) return;
      warned = true;
      if (code === "ExperimentalWarning") {
        platform.process.emitWarning(msg, code, deprecated);
      } else if (code !== undefined) {
        if (!codesWarned.has(code)) {
          platform.process.emitWarning(msg, "DeprecationWarning", code, deprecated);
          codesWarned.add(code);
        }
      } else {
        platform.process.emitWarning(msg, "DeprecationWarning", deprecated);
      }
    };
  }
  const internalUtil = {
    customInspectSymbol,
    isError: (e) => types.isNativeError(e) || e instanceof Error,
    join(output, separator) {
      let str = "";
      if (output.length !== 0) {
        const lastIndex = output.length - 1;
        for (let i = 0; i < lastIndex; i++) {
          str += output[i];
          str += separator;
        }
        str += output[lastIndex];
      }
      return str;
    },
    removeColors: (str) => String.prototype.replace.call(str, colorRegExp, ""),
    deprecate(fn, msg, code, useEmitSync, modifyPrototype = true) {
      if (code !== undefined) require("internal/validators").validateString(code, "code");
      const emitDeprecationWarning = getDeprecationWarningEmitter(code, msg, deprecated);
      function deprecated(...args) {
        if (!platform.process.noDeprecation) emitDeprecationWarning();
        if (new.target) return Reflect.construct(fn, args, new.target);
        return Reflect.apply(fn, this, args);
      }
      if (modifyPrototype) {
        Object.setPrototypeOf(deprecated, fn);
        if (fn.prototype) deprecated.prototype = fn.prototype;
        Object.defineProperty(deprecated, "length", { __proto__: null, ...Object.getOwnPropertyDescriptor(fn, "length") });
      }
      return deprecated;
    },
    setOwnProperty: (obj, key, value) => Object.defineProperty(obj, key, { __proto__: null, configurable: true, enumerable: true, value, writable: true }),
    kEmptyObject: Object.freeze({ __proto__: null }),
    customPromisifyArgs: kCustomPromisifyArgsSymbol,
    getLazy(initializer) {
      let value;
      let initialized = false;
      return function () {
        if (initialized === false) {
          value = initializer();
          initialized = true;
        }
        return value;
      };
    },
    // The util binding's defineLazyProperties: each key a data property of
    // the module's, read from it the first time it is.
    defineLazyProperties(target, id, keys, enumerable = true) {
      for (const key of keys) {
        Object.defineProperty(target, key, {
          __proto__: null,
          enumerable,
          configurable: true,
          get() {
            const value = require(id)[key];
            Object.defineProperty(this, key, { __proto__: null, value, writable: true, enumerable, configurable: true });
            return value;
          },
          set(value) {
            Object.defineProperty(this, key, { __proto__: null, value, writable: true, enumerable, configurable: true });
          },
        });
      }
    },
    promisify(original) {
      require("internal/validators").validateFunction(original, "original");
      if (original[kCustomPromisifiedSymbol]) {
        const fn = original[kCustomPromisifiedSymbol];
        require("internal/validators").validateFunction(fn, "util.promisify.custom");
        return Object.defineProperty(fn, kCustomPromisifiedSymbol, { __proto__: null, value: fn, enumerable: false, writable: false, configurable: true });
      }
      // Names to make an object of when the callback is given several values (fs.read's bytesRead and buffer).
      const argumentNames = original[kCustomPromisifyArgsSymbol];
      function fn(...args) {
        return new Promise((resolve, reject) => {
          args.push((err, ...values) => {
            if (err) return reject(err);
            if (argumentNames !== undefined && values.length > 1) {
              const obj = {};
              for (let i = 0; i < argumentNames.length; i++) obj[argumentNames[i]] = values[i];
              resolve(obj);
            } else {
              resolve(values[0]);
            }
          });
          if (types.isPromise(Reflect.apply(original, this, args))) {
            platform.process.emitWarning("Calling promisify on a function that returns a Promise is likely a mistake.", "DeprecationWarning", "DEP0174");
          }
        });
      }
      Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
      Object.defineProperty(fn, kCustomPromisifiedSymbol, { __proto__: null, value: fn, enumerable: false, writable: false, configurable: true });
      const descriptors = Object.getOwnPropertyDescriptors(original);
      for (const descriptor of Object.values(descriptors)) Object.setPrototypeOf(descriptor, null);
      return Object.defineProperties(fn, descriptors);
    },
    getSystemErrorMap: () => new Map([...uvErrors()].map(([errno, entry]) => [errno, [...entry]])),
    getSystemErrorName(err) {
      const entry = uvErrors().get(err);
      return entry ? entry[0] : "Unknown system error " + err;
    },
    getSystemErrorMessage(err) {
      const entry = uvErrors().get(err);
      return entry ? entry[1] : "Unknown system error " + err;
    },
    normalizeEncoding(enc) {
      if (enc == null || enc === "utf8" || enc === "utf-8") return "utf8";
      switch (enc.length) {
        case 4:
          if (enc === "UTF8") return "utf8";
          if (enc === "ucs2" || enc === "UCS2") return "utf16le";
          enc = enc.toLowerCase();
          if (enc === "utf8") return "utf8";
          if (enc === "ucs2") return "utf16le";
          break;
        case 3:
          if (enc === "hex" || enc === "HEX" || enc.toLowerCase() === "hex") return "hex";
          break;
        case 5:
          if (enc === "ascii") return "ascii";
          if (enc === "ucs-2") return "utf16le";
          if (enc === "UTF-8") return "utf8";
          if (enc === "ASCII") return "ascii";
          if (enc === "UCS-2") return "utf16le";
          enc = enc.toLowerCase();
          if (enc === "utf-8") return "utf8";
          if (enc === "ascii") return "ascii";
          if (enc === "ucs-2") return "utf16le";
          break;
        case 6:
          if (enc === "base64") return "base64";
          if (enc === "latin1" || enc === "binary") return "latin1";
          if (enc === "BASE64") return "base64";
          if (enc === "LATIN1" || enc === "BINARY") return "latin1";
          enc = enc.toLowerCase();
          if (enc === "base64") return "base64";
          if (enc === "latin1" || enc === "binary") return "latin1";
          break;
        case 7:
          if (enc === "utf16le" || enc === "UTF16LE" || enc.toLowerCase() === "utf16le") return "utf16le";
          break;
        case 8:
          if (enc === "utf-16le" || enc === "UTF-16LE" || enc.toLowerCase() === "utf-16le") return "utf16le";
          break;
        case 9:
          if (enc === "base64url" || enc === "BASE64URL" || enc.toLowerCase() === "base64url") return "base64url";
          break;
        default:
          if (enc === "") return "utf8";
      }
    },
  };

  // THE BINDING's V8 slots (a promise's state and result, a proxy's target
  // and handler, an iterator's and a weak collection's entries) are
  // platform.slots', after an intrinsic brand check: values, which
  // inspect.js formats itself.
  const slots = platform.slots;

  // V8's names (Object::GetConstructorName) for objects inspect.js finds no named constructor for.
  const builtinNames = [
    ["isMap", "Map"], ["isSet", "Set"], ["isWeakMap", "WeakMap"], ["isWeakSet", "WeakSet"], ["isDate", "Date"],
    ["isRegExp", "RegExp"], ["isPromise", "Promise"], ["isNativeError", "Error"], ["isArrayBuffer", "ArrayBuffer"],
    ["isSharedArrayBuffer", "SharedArrayBuffer"], ["isDataView", "DataView"], ["isNumberObject", "Number"],
    ["isStringObject", "String"], ["isBooleanObject", "Boolean"], ["isBigIntObject", "BigInt"], ["isSymbolObject", "Symbol"],
  ];
  const isArrayIndex = (key) => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
  const utilBinding = {
    constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE: 2, SKIP_SYMBOLS: 16, kPending: 0, kRejected: 2 },
    getOwnNonIndexProperties(object, filter) {
      // An object's own keys list its array indices first, ascending
      // (OrdinaryOwnPropertyKeys, and an array's, a typed array's and a
      // String object's alike): the rest start where they end.
      const all = Reflect.ownKeys(object);
      let low = 0;
      let high = all.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (typeof all[mid] === "string" && isArrayIndex(all[mid])) low = mid + 1;
        else high = mid;
      }
      const keys = [];
      for (let i = low; i < all.length; i++) {
        const key = all[i];
        if ((filter & 2) !== 0 && !Object.prototype.propertyIsEnumerable.call(object, key)) continue;
        if ((filter & 16) !== 0 && typeof key === "symbol") continue;
        keys.push(key);
      }
      return keys;
    },
    getProxyDetails: (value, showProxy) => (types.isProxy(value) ? slots.getProxyDetails(value, showProxy) : undefined),
    getPromiseDetails: (promise) => slots.getPromiseDetails(promise),
    // As inspect.js asks: a weak collection's entries alone, an iterator's with whether they pair.
    previewEntries: (...args) => Reflect.apply(slots.previewEntries, slots, args),
    getConstructorName(value) {
      if (Array.isArray(value)) return "Array";
      if (types.isTypedArray(value)) return String(typedArrayKind(value));
      for (const [test, name] of builtinNames) if (types[test](value)) return name;
      return typeof value === "function" ? "Function" : "Object";
    },
    getExternalValue: () => 0n,
    isInsideNodeModules: () => platform.insideNodeModules(),
  };

  // src/node_i18n.cc GetStringWidth, as Node built with ICU counts columns:
  // an East Asian Wide or Fullwidth character two, a default-emoji-
  // presentation character two, a control, format character, enclosing or
  // nonspacing mark or emoji modifier none (SOFT HYPHEN one), any other one.
  const zeroWidth = /^(?!\u00AD)[\p{Cc}\p{Cf}\p{Me}\p{Mn}\p{Emoji_Modifier}]$/u;
  const emojiPresentation = /^\p{Emoji_Presentation}$/u;
  const icuBinding = {
    getStringWidth(str) {
      let width = 0;
      for (const char of str) {
        if (platform.eastAsianWide(char.codePointAt(0)) || emojiPresentation.test(char)) width += 2;
        else if (!zeroWidth.test(char)) width += 1;
      }
      return width;
    },
  };

  internalUtil.promisify.custom = kCustomPromisifiedSymbol;

  // lib/internal/errors.js ErrnoException and ExceptionWithHostPort: a
  // libuv errno's error, its code the errno's name.
  class ErrnoException extends Error {
    constructor(err, syscall, original) {
      const code = require("util").getSystemErrorName(err);
      super(original ? syscall + " " + code + " " + original : syscall + " " + code);
      this.errno = err;
      this.code = code;
      this.syscall = syscall;
    }
    get ["constructor"]() { return Error; }
  }
  class ExceptionWithHostPort extends Error {
    constructor(err, syscall, address, port, additional) {
      const code = require("util").getSystemErrorName(err);
      let details = "";
      if (port && port > 0) details = " " + address + ":" + port;
      else if (address) details = " " + address;
      if (additional) details += " - Local (" + additional + ")";
      super(syscall + " " + code + details);
      this.errno = err;
      this.code = code;
      this.syscall = syscall;
      this.address = address;
      if (port) this.port = port;
    }
    get ["constructor"]() { return Error; }
  }

  // lib/internal/abort_controller.js's functions util exports, over the platform's AbortSignal.
  // A signal's one follower (AbortSignal.any), whose abort none of the
  // signal's own listeners can stop (Node's kResistStopPropagation), kept as
  // long as the signal is.
  const followers = new WeakMap();
  function followerOf(signal) {
    let follower = followers.get(signal);
    if (follower === undefined) followers.set(signal, (follower = AbortSignal.any([signal])));
    return follower;
  }
  const abortController = {
    async aborted(signal, resource) {
      if (signal === undefined) throw new nodeErrorCodes.ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
      require("internal/validators").validateAbortSignal(signal, "signal");
      require("internal/validators").validateObject(resource, "resource", require("internal/validators").kValidateObjectAllowObjects);
      if (signal.aborted) return Promise.resolve();
      return new Promise((resolve) => followerOf(signal).addEventListener("abort", () => resolve(), { once: true }));
    },
    transferableAbortSignal(signal) {
      if (!(signal instanceof AbortSignal)) throw new nodeErrorCodes.ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
      return signal;
    },
    transferableAbortController: () => new AbortController(),
  };

  // lib/internal/errors.js AbortError.
  class AbortError extends Error {
    constructor(message = "The operation was aborted", options = undefined) {
      if (options !== undefined && typeof options !== "object") throw new nodeErrorCodes.ERR_INVALID_ARG_TYPE("options", "Object", options);
      super(message, options);
      this.code = "ABORT_ERR";
      this.name = "AbortError";
    }
  }

  // lib/timers/promises.js over the platform's timers (platform.timers): its
  // validation, its AbortError and its scheduler; an abort is heard on the
  // signal's follower, as Node hears it past a stopped dispatch.
  function timersPromises() {
    const { validateAbortSignal, validateBoolean, validateObject, validateNumber } = require("internal/validators");
    const { kEmptyObject } = internalUtil;
    const timers = platform.timers;
    const validate = (after, options) => {
      if (after !== undefined) validateNumber(after, "delay");
      validateObject(options, "options");
      if (options?.signal !== undefined) validateAbortSignal(options.signal, "options.signal");
      if (options?.ref !== undefined) validateBoolean(options.ref, "options.ref");
    };
    // The promise of a handle \`start\` makes, settled by it, rejected with an
    // AbortError (and the handle cleared) if \`signal\` aborts first.
    function settle(signal, ref, start, clear) {
      if (signal?.aborted) return Promise.reject(new AbortError(undefined, { cause: signal.reason }));
      const { promise, resolve, reject } = Promise.withResolvers();
      const handle = start(resolve);
      if (!ref) handle?.unref?.();
      if (!signal) return promise;
      const follower = followerOf(signal);
      const cancel = () => {
        clear(handle);
        reject(new AbortError(undefined, { cause: signal.reason }));
      };
      follower.addEventListener("abort", cancel, { once: true });
      return promise.finally(() => follower.removeEventListener("abort", cancel));
    }
    function setTimeout(after, value, options = kEmptyObject) {
      try {
        validate(after, options);
      } catch (err) {
        return Promise.reject(err);
      }
      const { signal, ref = true } = options;
      return settle(signal, ref, (resolve) => timers.setTimeout(resolve, after, value), timers.clearTimeout);
    }
    function setImmediate(value, options = kEmptyObject) {
      try {
        validate(undefined, options);
      } catch (err) {
        return Promise.reject(err);
      }
      const { signal, ref = true } = options;
      return settle(signal, ref, (resolve) => timers.setImmediate(resolve, value), timers.clearImmediate);
    }
    async function* setInterval(after, value, options = kEmptyObject) {
      validate(after, options);
      const { signal, ref = true } = options;
      if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
      let onCancel;
      let interval;
      const follower = signal && followerOf(signal);
      try {
        let notYielded = 0;
        let callback;
        interval = timers.setInterval(() => {
          notYielded++;
          if (callback) {
            callback();
            callback = undefined;
          }
        }, after);
        if (!ref) interval?.unref?.();
        if (follower) {
          onCancel = () => {
            timers.clearInterval(interval);
            if (callback) {
              callback(Promise.reject(new AbortError(undefined, { cause: signal.reason })));
              callback = undefined;
            }
          };
          follower.addEventListener("abort", onCancel, { once: true });
        }
        while (!signal?.aborted) {
          if (notYielded === 0) await new Promise((resolve) => (callback = resolve));
          for (; notYielded > 0; notYielded--) yield value;
        }
        throw new AbortError(undefined, { cause: signal?.reason });
      } finally {
        timers.clearInterval(interval);
        follower?.removeEventListener("abort", onCancel);
      }
    }
    const kScheduler = Symbol("kScheduler");
    class Scheduler {
      constructor() {
        throw new nodeErrorCodes.ERR_ILLEGAL_CONSTRUCTOR();
      }
      yield() {
        if (!this[kScheduler]) throw new nodeErrorCodes.ERR_INVALID_THIS("Scheduler");
        return setImmediate();
      }
      wait(delay, options) {
        if (!this[kScheduler]) throw new nodeErrorCodes.ERR_INVALID_THIS("Scheduler");
        return setTimeout(delay, undefined, options);
      }
    }
    return {
      setTimeout,
      setImmediate,
      setInterval,
      scheduler: Reflect.construct(function () {
        this[kScheduler] = true;
      }, [], Scheduler),
    };
  }

  // lib/timers.js's deprecated item timers (enroll, unenroll, active,
  // _unrefActive): an object's _onTimeout run _idleTimeout ms after it is
  // made active, on a platform timer of its own.
  function legacyTimers() {
    const { validateNumber } = require("internal/validators");
    const TIMEOUT_MAX = 2 ** 31 - 1;
    const handles = new WeakMap();
    function getTimerDuration(msecs, name) {
      validateNumber(msecs, name);
      if (msecs < 0 || !Number.isFinite(msecs)) throw new nodeErrorCodes.ERR_OUT_OF_RANGE(name, "a non-negative finite number", msecs);
      if (msecs > TIMEOUT_MAX) {
        platform.process.emitWarning(msecs + " does not fit into a 32-bit signed integer.\nTimer duration was truncated to " + TIMEOUT_MAX + ".", "TimeoutOverflowWarning");
        return TIMEOUT_MAX;
      }
      return msecs;
    }
    const stop = (item) => {
      const handle = handles.get(item);
      if (handle !== undefined) platform.timers.clearTimeout(handle);
      handles.delete(item);
    };
    function unenroll(item) {
      if (item._destroyed) return;
      item._destroyed = true;
      stop(item);
      item._idleNext = null;
      item._idlePrev = null;
      item._idleTimeout = -1;
    }
    function enroll(item, msecs) {
      msecs = getTimerDuration(msecs, "msecs");
      if (item._idleNext) unenroll(item);
      item._idleNext = item;
      item._idlePrev = item;
      item._idleTimeout = msecs;
    }
    function insertGuarded(item, refed) {
      const msecs = item._idleTimeout;
      if (msecs < 0 || msecs === undefined) return;
      stop(item);
      item._destroyed = false;
      const handle = platform.timers.setTimeout(() => {
        handles.delete(item);
        item._idleNext = null;
        item._idlePrev = null;
        try {
          if (typeof item._onTimeout === "function") item._onTimeout();
        } finally {
          if (!handles.has(item)) item._destroyed = true;
        }
      }, msecs);
      if (!refed) handle?.unref?.();
      handles.set(item, handle);
    }
    const { deprecate } = internalUtil;
    return {
      _unrefActive: deprecate((item) => insertGuarded(item, false), "timers._unrefActive() is deprecated. Please use timeout.refresh() instead.", "DEP0127"),
      active: deprecate((item) => insertGuarded(item, true), "timers.active() is deprecated. Please use timeout.refresh() instead.", "DEP0126"),
      unenroll: deprecate(unenroll, "timers.unenroll() is deprecated. Please use clearTimeout instead.", "DEP0096"),
      enroll: deprecate(enroll, "timers.enroll() is deprecated. Please use setTimeout instead.", "DEP0095"),
    };
  }

  // src/node_dotenv.cc Dotenv::ParseContent, as util.parseEnv and
  // process.loadEnvFile read a .env file: keys in their bytes' order.
  function parseEnv(input) {
    const trim = (text) => text.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
    const store = new Map();
    let content = trim(String(input).replaceAll("\r", ""));
    while (content.length > 0) {
      if (content[0] === "\n" || content[0] === "#") {
        const newline = content.indexOf("\n");
        content = newline === -1 ? "" : content.slice(newline + 1);
        continue;
      }
      const equalOrNewline = content.search(/[=\n]/);
      if (equalOrNewline === -1 || content[equalOrNewline] === "\n") {
        if (equalOrNewline === -1) break;
        content = trim(content.slice(equalOrNewline + 1));
        continue;
      }
      let key = trim(content.slice(0, equalOrNewline));
      content = content.slice(equalOrNewline + 1);
      if (content.length === 0 || content[0] === "\n") {
        store.set(key, "");
        continue;
      }
      content = trim(content);
      if (key.length === 0) continue;
      if (key.startsWith("export ")) key = trim(key.slice(7));
      if (content.length === 0) {
        store.set(key, "");
        break;
      }
      if (content[0] === "\"") {
        const closing = content.indexOf("\"", 1);
        if (closing !== -1) {
          store.set(key, content.slice(1, closing).replaceAll("\\n", "\n"));
          const newline = content.indexOf("\n", closing + 1);
          content = newline === -1 ? "" : content.slice(newline + 1);
          continue;
        }
      }
      if (content[0] === "'" || content[0] === "\"" || content[0] === "\u0060") {
        const closing = content.indexOf(content[0], 1);
        if (closing === -1) {
          const newline = content.indexOf("\n");
          if (newline === -1) {
            store.set(key, content);
            break;
          }
          store.set(key, content.slice(0, newline));
          content = content.slice(newline + 1);
        } else {
          store.set(key, content.slice(1, closing));
          const newline = content.indexOf("\n", closing + 1);
          content = newline === -1 ? "" : content.slice(newline + 1);
          continue;
        }
      } else {
        const newline = content.indexOf("\n");
        let value = newline === -1 ? content : content.slice(0, newline);
        const hash = value.indexOf("#");
        if (hash !== -1) value = value.slice(0, hash);
        store.set(key, trim(value));
        content = newline === -1 ? "" : content.slice(newline + 1);
      }
      content = trim(content);
    }
    // A std::map's order: the keys' UTF-8 bytes, which is their code points'.
    const byCodePoints = (a, b) => {
      const x = [...a];
      const y = [...b];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = x[i].codePointAt(0) - y[i].codePointAt(0);
        if (d !== 0) return d;
      }
      return x.length - y.length;
    };
    const result = {};
    for (const key of [...store.keys()].sort(byCodePoints)) result[key] = store.get(key);
    return result;
  }
  utilBinding.parseEnv = parseEnv;
  // Node's util binding GetCallSites: the frames below util.getCallSites, as
  // V8's StackFrame reads them; a script's id is its own number here.
  const scriptIds = new Map();
  utilBinding.getCallSites = function getCallSites(frameCount) {
    return platform.callSites(frameCount + 1, getCallSites).slice(1).map((site) => {
      const scriptName = site.getScriptNameOrSourceURL?.() ?? site.getFileName() ?? "";
      if (!scriptIds.has(scriptName)) scriptIds.set(scriptName, String(scriptIds.size + 1));
      const column = site.getColumnNumber() ?? 0;
      return {
        functionName: site.getFunctionName() ?? "",
        scriptId: scriptIds.get(scriptName),
        scriptName,
        lineNumber: site.getLineNumber() ?? 0,
        columnNumber: column,
        column,
      };
    });
  };

  // Node's internal modules that are not its own text here, by id.
  const hosted = {
    "internal/util": internalUtil,
    "internal/errors": { codes: nodeErrorCodes, hideStackFrames, isErrorStackTraceLimitWritable, isStackOverflowError, ErrnoException, ExceptionWithHostPort, AbortError, DNSException },
    "internal/v8/startup_snapshot": { namespace: { isBuildingSnapshot: () => false } },
    "internal/perf/observe": { hasObserver: () => false },
    "internal/options": {
      getOptionValue: (name) => platform.optionValue(name),
      // Over the CLI's option table (core node-cli-options.generated.ts), as src/node_options.cc gives it.
      getCLIOptionsInfo() {
        const optionTypes = { noop: 0, v8: 1, boolean: 2, value: 5 };
        return {
          options: new Map(platform.cliOptions.map(([name, kind, env]) => [name, { envVarSettings: env ? 0 : 1, type: optionTypes[kind] }])),
          aliases: new Map(platform.cliAliases.map(([from, expansion]) => [from, [...expansion]])),
        };
      },
    },
    "internal/worker": { isMainThread: true },
    "internal/fs/utils": {
      // lib/internal/fs/utils.js getValidatedPath: a path string or bytes, or a file: URL's path.
      getValidatedPath(fileURLOrPath, propName = "path") {
        const path = fileURLOrPath != null && fileURLOrPath.href && fileURLOrPath.protocol ? platform.url.fileURLToPath(fileURLOrPath) : fileURLOrPath;
        if (typeof path !== "string" && !types.isUint8Array(path)) throw new nodeErrorCodes.ERR_INVALID_ARG_TYPE(propName, ["string", "Buffer", "URL"], path);
        if ((typeof path === "string" ? path : String.fromCharCode(...path)).includes("\u0000")) {
          throw new nodeErrorCodes.ERR_INVALID_ARG_VALUE(propName, path, "must be a string, Uint8Array, or URL without null bytes");
        }
        return path;
      },
      // lib/internal/fs/utils.js validateCpOptions, over its defaultCpOptions and getValidMode's copyFile range.
      validateCpOptions: hideStackFrames((options) => {
        const defaults = { dereference: false, errorOnExist: false, filter: undefined, force: true, preserveTimestamps: false, recursive: false, verbatimSymlinks: false };
        if (options === undefined) return { ...defaults };
        const { validateBoolean, validateFunction, validateInteger, validateObject } = require("internal/validators");
        validateObject(options, "options");
        options = { ...defaults, ...options };
        validateBoolean(options.dereference, "options.dereference");
        validateBoolean(options.errorOnExist, "options.errorOnExist");
        validateBoolean(options.force, "options.force");
        validateBoolean(options.preserveTimestamps, "options.preserveTimestamps");
        validateBoolean(options.recursive, "options.recursive");
        validateBoolean(options.verbatimSymlinks, "options.verbatimSymlinks");
        if (options.mode == null) options.mode = options.mode || 0;
        else validateInteger.withoutStackTrace(options.mode, "mode", 0, 7);
        if (options.dereference === true && options.verbatimSymlinks === true) {
          throw new nodeErrorCodes.ERR_INCOMPATIBLE_OPTION_PAIR.HideStackFramesError("dereference", "verbatimSymlinks");
        }
        if (options.filter !== undefined) validateFunction(options.filter, "options.filter");
        return options;
      }),
    },
    path: platform.path,
    "util/types": types,
    diagnostics_channel: platform.diagnosticsChannel,
    "internal/constants": { CHAR_LOWERCASE_B: 98, CHAR_LOWERCASE_E: 101, CHAR_LOWERCASE_N: 110 },
    "internal/abort_controller": abortController,
    "internal/console/global": platform.console,
    "internal/encoding": { TextDecoder: globalThis.TextDecoder, TextEncoder: globalThis.TextEncoder },
    worker_threads: platform.workerThreads,
    "internal/util/types": types,
    "internal/assert": assert,
    // Node's own modules, whose frames read node:<id> (colored grey).
    "internal/bootstrap/realm": { BuiltinModule: { exists: (id) => id.startsWith("internal/") || platform.builtinModules.includes(id) } },
    "internal/url": { ...platform.url, isURL: (self) => Boolean(self?.href && self.protocol && self.auth === undefined && self.path === undefined) },
    "internal/crypto/util": { kKeyObject: Symbol("kKeyObject") },
    "internal/deps/acorn/acorn/dist/acorn": { Parser: { tokenizer: (code, options) => platform.tokenizer(code, options) } },
    "internal/source_map/source_map_cache": platform.sourceMaps,
    "internal/tty": { getColorDepth: () => platform.colorDepth() },
    buffer: { Buffer: platform.Buffer },
  };
  /**
   * src/node_file.cc's cp bindings, which lib/internal/fs/cp/cp-sync.js
   * calls: CpSyncCheckPaths, CpSyncOverrideFile and CpSyncCopyDir, over the
   * platform's fs, with the C++'s own choices (its status and symlink_status
   * as it calls them under dereference, the modes std::filesystem makes
   * with, a nested link made absolute and canonical) and its errors: Node's
   * coded Errors, libuv's (UVException) and std::error_code's
   * (ErrnoException, its message strerror's).
   */
  function cpBinding() {
    const fs = () => platform.fs();
    const pathMod = platform.path;
    const strerror = {
      EACCES: "Permission denied", EBUSY: "Device or resource busy", EEXIST: "File exists", EINVAL: "Invalid argument",
      EIO: "Input/output error", EISDIR: "Is a directory", ELOOP: "Too many levels of symbolic links",
      ENAMETOOLONG: "File name too long", ENOENT: "No such file or directory", ENOSPC: "No space left on device",
      ENOTDIR: "Not a directory", ENOTEMPTY: "Directory not empty", EPERM: "Operation not permitted",
      EROFS: "Read-only file system", EXDEV: "Invalid cross-device link",
    };
    const coded = (code, message) => Object.assign(new Error(message), { code });
    // src/api/exceptions.cc UVException.
    const uvException = (code, syscall, path, dest) => {
      const errno = -(platform.errno[code] ?? 0);
      let message = code + ": " + (uvErrors().get(errno)?.[1] ?? "unknown error") + ", " + syscall;
      if (path !== undefined) message += " '" + path + "'";
      if (dest !== undefined) message += " -> '" + dest + "'";
      const error = Object.assign(new Error(message), { errno, code, syscall });
      if (path !== undefined) error.path = path;
      if (dest !== undefined) error.dest = dest;
      return error;
    };
    // src/api/exceptions.cc ErrnoException, as Environment::ThrowStdErrException makes it.
    const errnoException = (code, syscall, path) => {
      const errno = platform.errno[code] ?? 0;
      const error = new Error(code + ", " + (strerror[code] ?? "Unknown error " + errno) + " '" + path + "'");
      return Object.assign(error, { errno, code, path, syscall });
    };
    const status = (path, follow) => {
      try {
        const stat = follow ? fs().statSync(path, { throwIfNoEntry: false }) : fs().lstatSync(path, { throwIfNoEntry: false });
        return stat === undefined ? { error: { code: "ENOENT" } } : { stat };
      } catch (error) { return { error }; }
    };
    // std::filesystem::equivalent: one file, by its device and inode where
    // both have one (a file this process made has none yet), else by where
    // each resolves to.
    const equivalent = (a, b) => {
      const one = status(a, true);
      const two = status(b, true);
      if (one.error || two.error) return { error: one.error ?? two.error };
      if (one.stat.ino && two.stat.ino) return { same: one.stat.dev === two.stat.dev && one.stat.ino === two.stat.ino };
      return { same: fs().realpathSync(a) === fs().realpathSync(b) };
    };
    // std::filesystem::path's parent_path and has_parent_path, on a POSIX path string.
    const parentPath = (path) => {
      const trimmed = path.replace(/\/+$/, "");
      if (trimmed === "") return path.startsWith("/") ? "/" : "";
      const at = trimmed.lastIndexOf("/");
      return at < 0 ? "" : at === 0 ? "/" : trimmed.slice(0, at).replace(/\/+$/, "") || "/";
    };
    // A file's copy (std::filesystem::copy_file, libuv's copyfile): its bytes and its mode, as copyFileSync leaves them.
    const copyFile = (src, dest, mode) => fs().copyFileSync(src, dest, mode);
    // CopyUtimes: the source's times, followed, on the copy.
    const copyUtimes = (src, dest) => {
      let stat;
      try { stat = fs().statSync(src); } catch (error) { throw uvException(error.code, "stat", src); }
      try { fs().utimesSync(dest, stat.atime, stat.mtime); } catch (error) { throw uvException(error.code, "utime", dest); }
    };
    // std::filesystem::weakly_canonical: the longest existing prefix resolved, the rest normalised.
    const weaklyCanonical = (path) => {
      const parts = pathMod.normalize(path).split("/").filter(Boolean);
      for (let n = parts.length; n >= 0; n--) {
        const head = "/" + parts.slice(0, n).join("/");
        let real;
        try { real = fs().realpathSync(head); } catch { continue; }
        return pathMod.join(real, ...parts.slice(n));
      }
      return pathMod.normalize(path);
    };
    // isInsideDir: \`dest\` is \`src\` or beneath it, part by part.
    const isInsideDir = (src, dest) => {
      const a = pathMod.resolve(src).split("/").filter(Boolean);
      const b = pathMod.resolve(dest).split("/").filter(Boolean);
      return a.length <= b.length && a.every((part, i) => part === b[i]);
    };
    const isDirectory = (path) => status(path, true).stat?.isDirectory() === true;
    // A path the binding is given as Node's native code takes it: a string, or bytes decoded (BufferValue).
    const pathText = (path) => (typeof path === "string" ? path : path instanceof Uint8Array ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(path) : String(path));
    return {
      cpSyncCheckPaths(src, dest, dereference, recursive) {
        [src, dest] = [pathText(src), pathText(dest)];
        // Upstream's status and symlink_status, as it swaps them under dereference.
        const source = status(src, !dereference);
        if (source.error) throw uvException(source.error.code, dereference ? "stat" : "lstat", src);
        const target = status(dest, dereference);
        const srcIsDir = source.stat.isDirectory() || (dereference && source.stat.isSymbolicLink());
        let srcPathStr = String(src);
        if (!target.error) {
          const same = equivalent(src, dest);
          if (same.same) throw coded("ERR_FS_CP_EINVAL", "src and dest cannot be the same " + dest);
          const destIsDir = target.stat.isDirectory();
          if (srcIsDir && !destIsDir) throw coded("ERR_FS_CP_DIR_TO_NON_DIR", "Cannot overwrite non-directory " + dest + " with directory " + src);
          if (!srcIsDir && destIsDir) throw coded("ERR_FS_CP_NON_DIR_TO_DIR", "Cannot overwrite directory " + dest + " with non-directory " + src);
        }
        if (!srcPathStr.endsWith("/")) srcPathStr += "/";
        if (srcIsDir && String(dest).startsWith(srcPathStr)) {
          throw coded("ERR_FS_CP_EINVAL", "Cannot copy " + srcPathStr + " to a subdirectory of self " + dest);
        }
        // Upstream compares src with dest's parent each time round.
        let destParent = parentPath(dest);
        while (parentPath(src) !== destParent && destParent !== "" && parentPath(destParent) !== destParent) {
          const same = equivalent(src, parentPath(dest));
          if (same.same) throw coded("ERR_FS_CP_EINVAL", "Cannot copy " + srcPathStr + " to a subdirectory of self " + dest);
          if (same.error) break;
          destParent = parentPath(destParent);
        }
        if (srcIsDir && !recursive) throw coded("ERR_FS_EISDIR", "Recursive option not enabled, cannot copy a directory: " + srcPathStr);
        if (source.stat.isSocket()) throw coded("ERR_FS_CP_SOCKET", "Cannot copy a socket file: " + dest);
        if (source.stat.isFIFO()) throw coded("ERR_FS_CP_FIFO_PIPE", "Cannot copy a FIFO pipe: " + dest);
        if (target.error || status(parentPath(dest), true).error) {
          try { fs().mkdirSync(parentPath(dest) || ".", { recursive: true }); } catch {}
        }
      },
      cpSyncOverrideFile(src, dest, mode, preserveTimestamps) {
        [src, dest] = [pathText(src), pathText(dest)];
        try {
          if (status(dest, false).stat?.isDirectory()) fs().rmdirSync(dest);
          else fs().unlinkSync(dest);
        } catch (error) {
          throw errnoException(error.code, "unlink", dest);
        }
        try { copyFile(src, dest, mode); } catch (error) {
          throw mode === 0 ? errnoException(error.code, "cp", dest) : uvException(error.code, "cp", src, dest);
        }
        if (preserveTimestamps) copyUtimes(src, dest);
      },
      cpSyncCopyDir(src, dest, force, dereference, errorOnExist, verbatimSymlinks, preserveTimestamps) {
        [src, dest] = [pathText(src), pathText(dest)];
        try { fs().mkdirSync(dest, { recursive: true }); } catch (error) { throw errnoException(error.code, "cp", dest); }
        // An entry's kind is its dirent's: a link is one, and what is not a
        // link is what it is (upstream's is_directory and is_regular_file follow only links).
        const copyDirContents = (src, dest) => {
          for (const entry of fs().readdirSync(src, { withFileTypes: true })) {
            const entryPath = pathMod.join(src, entry.name);
            const destFilePath = pathMod.join(dest, entry.name);
            if (entry.isSymbolicLink()) {
              let target;
              try { target = fs().readlinkSync(entryPath); } catch (error) { throw errnoException(error.code, "cp", dest); }
              if (verbatimSymlinks) {
                try { fs().symlinkSync(target, destFilePath); } catch (error) { throw errnoException(error.code, "cp", dest); }
                continue;
              }
              if (status(destFilePath, true).stat) {
                if (status(destFilePath, false).stat.isSymbolicLink()) {
                  let current;
                  try { current = fs().readlinkSync(destFilePath); } catch (error) { throw errnoException(error.code, "cp", dest); }
                  if (!dereference && isDirectory(target) && isInsideDir(target, current)) {
                    throw coded("ERR_FS_CP_EINVAL", "Cannot copy " + target + " to a subdirectory of self " + current);
                  }
                  if (isDirectory(destFilePath) && isInsideDir(current, target)) {
                    throw coded("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", "cannot overwrite " + current + " with " + target);
                  }
                  try { fs().unlinkSync(destFilePath); } catch (error) { throw errnoException(error.code, "cp", dest); }
                } else if (status(destFilePath, true).stat.isFile()) {
                  if (!dereference || (!force && errorOnExist)) throw errnoException("EEXIST", "cp", destFilePath);
                }
              }
              try { fs().symlinkSync(weaklyCanonical(pathMod.resolve(src, target)), destFilePath); } catch (error) { throw errnoException(error.code, "cp", dest); }
            } else if (entry.isDirectory()) {
              try { fs().mkdirSync(destFilePath); } catch (error) { if (!isDirectory(destFilePath)) throw errnoException(error.code, "cp", dest); }
              copyDirContents(entryPath, destFilePath);
            } else if (entry.isFile()) {
              if (status(destFilePath, true).stat) {
                if (!force && !errorOnExist) continue;
                if (!force) throw coded("ERR_FS_CP_EEXIST", "[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (" + destFilePath + " already exists)");
              }
              try { copyFile(entryPath, destFilePath, 0); } catch (error) { throw errnoException(error.code, "cp", dest); }
              if (preserveTimestamps) copyUtimes(entryPath, destFilePath);
            }
          }
        };
        copyDirContents(src, dest);
      },
    };
  }
  const bindings = {
    util: utilBinding,
    config: { hasIntl: true },
    icu: icuBinding,
    constants: { os: { signals: platform.signals, errno: platform.errno } },
    buffer: { compare: (a, b) => platform.Buffer.compare(a, b) },
    errors: { getErrorSourcePositions: (error) => platform.errorSourcePositions(error), exitCodes: { kNoFailure: 0, kGenericUserError: 1 } },
    process_methods: platform.processMethods,
    fs: cpBinding(),
    // src/node_options.h's enums, as getCLIOptionsInfo's entries use them.
    options: {
      envSettings: { kAllowedInEnvvar: 0, kDisallowedInEnvvar: 1 },
      types: { kNoOp: 0, kV8Option: 1, kBoolean: 2, kInteger: 3, kUInteger: 4, kString: 5, kHostPort: 6, kStringList: 7 },
    },
    // Node's tracing is off: no category is enabled, and nothing traces.
    trace_events: { getCategoryEnabledBuffer: () => new Uint8Array(1), trace() {} },
  };
  const internalBinding = (name) => name === "cares_wrap"
    ? bindings.cares_wrap ??= platform.createCaresBinding(platform, require("internal/net").isIP)
    : bindings[name];
  // inspect.js reads primordials.globalThis once, for the names it counts as
  // built-in (showHidden shows a prototype's properties when its
  // constructor's name is not one): the capitalised globals there were when
  // Node loaded it, measured (node-lib-source.ts NODE_BUILTIN_OBJECTS).
  const bootGlobal = Object.create(null);
  for (const name of platform.builtinObjects) bootGlobal[name] = globalThis[name];
  const inspectPrimordials = Object.create(null);
  for (const key of Reflect.ownKeys(primordials)) inspectPrimordials[key] = primordials[key];
  inspectPrimordials.globalThis = bootGlobal;

  // Node's own, each run once, its exports cached before it runs (a cycle
  // reads what it has exported so far), as Node's BuiltinModule does.
  const loaded = new Map();
  // Node's modules ported here, each made the first time it is required.
  const ported = {
    "timers/promises": timersPromises,
    "internal/timers/legacy": legacyTimers,
    // The platform's own fs, which Node's modules (lib/internal/fs/cp) copy through.
    fs: () => platform.fs(),
    "fs/promises": () => platform.fs().promises,
  };
  function require(id) {
    if (Object.prototype.hasOwnProperty.call(hosted, id)) return hosted[id];
    if (Object.prototype.hasOwnProperty.call(ported, id)) {
      const made = ported[id]();
      hosted[id] = made;
      return made;
    }
    const cached = loaded.get(id);
    if (cached !== undefined) return cached.exports;
    const source = platform.sources[id];
    if (source === undefined) throw new Error("No such built-in module: " + id);
    const module = { exports: {}, id };
    loaded.set(id, module);
    source(module.exports, require, module, platform.process, internalBinding, id === "internal/util/inspect" ? inspectPrimordials : primordials);
    // As Node's bootstrap does, before any program reads it (pre_execution.js).
    if (id === "internal/util/debuglog") module.exports.initializeDebugEnv(platform.nodeDebug);
    if (id === "internal/dns/utils") module.exports.initializeDns();
    return module.exports;
  }
  return { require };
},
  createWorkerdSlots: function createWorkerdSlots(util) {
  "use strict";
  const kPending = 0;
  const kFulfilled = 1;
  const kRejected = 2;
  const PROXY = "Proxy [Array]";
  const REVOKED = "<Revoked Proxy>";
  const arrayPrototype = Array.prototype;
  const customInspect = Symbol.for("nodejs.util.inspect.custom");
  const isProxy = util.types.isProxy;
  const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "'": "'", "\\": "\\" };
  // The primitive workerd's formatPrimitive handed stylize as 'text', or null for any other mark.
  function primitiveOf(text, style) {
    switch (style) {
      case "number": return /^(?:-?(?:[0-9]|Infinity)|NaN$)/.test(text) ? { primitive: Number(text) } : null;
      case "bigint": return /^-?[0-9]+n$/.test(text) ? { primitive: BigInt(text.slice(0, -1)) } : null;
      case "boolean": return text === "true" || text === "false" ? { primitive: text === "true" } : null;
      case "undefined": return text === "undefined" ? { primitive: undefined } : null;
      case "null": return text === "null" ? { primitive: null } : null;
      case "symbol": return text.startsWith("Symbol(") && text.endsWith(")") ? { primitive: Symbol(text.slice(7, -1)) } : null;
      case "string":
        if (!/^['"\u0060]/.test(text)) return null;
        // strEscape's escapes: the meta table's and a lone surrogate's.
        return { primitive: text.slice(1, -1).replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[btnfr'\\])/g, (all, escape) => (escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escapes[escape])) };
      default: return null;
    }
  }
  // What workerd's inspect of 'value' formats 'level' deep: objects,
  // primitives and marks, in order, and the text, for an iterator's brace.
  // Its 'seen' (the objects being formatted, outermost first) holds 'level'
  // of them then: a prototype's properties showHidden adds are formatted
  // before the value is pushed, and a proxy (showProxy) pushes none.
  // Array.prototype.includes is held only until workerd's first cycle
  // check, which no program code runs before; from then the hook is that
  // call's own 'seen' array's, where no program can reach it. What program
  // code still runs while workerd formats (the value's own toStringTag
  // getter, a proxy in its prototype chain) sees every built-in as it was,
  // and can inspect: a nested read holds and lets go of its own.
  function capture(value, options, level) {
    const events = [];
    const previous = arrayPrototype.includes;
    let seen = null;
    let referenced = false;
    const isObject = (item) => (typeof item === "object" && item !== null) || typeof item === "function";
    // An object 'level' deep is taken, and answered as seen: workerd marks
    // it circular and formats none of it, so no code of it runs (a getter,
    // a trap). Answered so for the value itself, workerd marks the value a
    // reference too, last.
    function record(item) {
      if (this !== seen || seen.length !== level || !isObject(item)) return Reflect.apply(previous, this, arguments);
      events.push({ object: item });
      if (item === value) referenced = true;
      return true;
    }
    const first = function includes(item) {
      arrayPrototype.includes = previous;
      seen = this;
      Object.defineProperty(seen, "includes", { value: record, writable: true, configurable: true });
      return Reflect.apply(record, this, arguments);
    };
    arrayPrototype.includes = first;
    let text;
    try {
      text = util.inspect(value, {
        showHidden: false, depth: 0, ...options,
        showProxy: true, colors: false, customInspect: false, getters: false, maxStringLength: Infinity,
        breakLength: Infinity, compact: 3, sorted: false, numericSeparator: false,
        stylize(mark, style) {
          if ((seen === null ? 0 : seen.length) === level) events.push(primitiveOf(mark, style) ?? { mark });
          return mark;
        },
      });
    } finally {
      if (arrayPrototype.includes === first) arrayPrototype.includes = previous;
    }
    if (referenced) events.pop();
    return { events, text };
  }
  // The values a slot holds, read from 'read(depth)' (capture's events),
  // each a value, a proxy (its parts, read a level deeper each time, until
  // none is left past the depth) or a revoked proxy. 'count' values, or as
  // many as the first read holds.
  function slotValues(read, count) {
    let nodes;
    for (let depth = 0; ; depth++) {
      const events = read(depth);
      let at = 0;
      let deeper = false;
      // A node 'r' levels in, as this read formats it ('known' from the last).
      const node = (known, r) => {
        if (known !== undefined && known.parts !== undefined) {
          if (r > depth) {
            if (events[at++]?.mark !== PROXY) throw unreadable("a proxy");
            deeper = true;
            return known;
          }
          return { parts: [node(known.parts?.[0], r + 1), node(known.parts?.[1], r + 1)] };
        }
        const event = events[at++];
        if (event === undefined) throw unreadable("a value");
        if ("primitive" in event) return { value: event.primitive };
        if ("object" in event) {
          // Its own mark, past the depth.
          while (at < events.length && "mark" in events[at] && events[at].mark !== PROXY && events[at].mark !== REVOKED) at++;
          return { value: event.object };
        }
        if (event.mark === REVOKED) return { revoked: true };
        if (event.mark === PROXY) {
          deeper = true;
          return { parts: null };
        }
        throw unreadable("a mark (" + event.mark + ")");
      };
      const next = [];
      for (let i = 0; nodes === undefined ? at < events.length : i < nodes.length; i++) {
        next.push(node(nodes?.[i], 1));
        if (count !== undefined && nodes === undefined && next.length === count) break;
      }
      nodes = next;
      if (!deeper) return nodes.map(standIn);
      if (depth === 64) throw unreadable("a proxy 64 deep");
    }
  }
  // Stand-ins: a proxy among a slot's values, rebuilt over its target with a
  // handler of none of a program's traps, and the [target, handler] it
  // stands for (null, revoked). inspect.js never formats one as an object:
  // it asks getProxyDetails first, which unwraps it (below).
  const standIns = new WeakMap();
  function standIn(node) {
    if (node.revoked) {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      standIns.set(revocable.proxy, null);
      return revocable.proxy;
    }
    if (node.parts === undefined) return node.value;
    const parts = [standIn(node.parts[0]), standIn(node.parts[1])];
    const proxy = new Proxy(parts[0], {});
    standIns.set(proxy, parts);
    return proxy;
  }
  // What inspect.js formats for a proxy, showProxy off: its innermost target
  // (no stand-in is formatted as an object, nor any proxy trap run), or a
  // revoked proxy, which throws there as in Node.
  function innermostTarget(target) {
    while (standIns.get(target)) target = standIns.get(target)[0];
    return target;
  }
  // Whether inspect.js would find a custom inspect on 'object', read without
  // running a program's code; a proxy on the way may hold one.
  function reachesCustomInspect(object) {
    for (let at = object; at !== null; at = Object.getPrototypeOf(at)) {
      if (isProxy(at)) return true;
      const own = Object.getOwnPropertyDescriptor(at, customInspect);
      if (own !== undefined) return own.get !== undefined || typeof own.value === "function";
    }
    return false;
  }
  // The prototypes workerd's constructor discovery names without asking
  // their constructors anything (its well-known prototypes).
  const intrinsicPrototypes = new Set([
    Object.prototype, Function.prototype, Array.prototype, Error.prototype,
    Promise.prototype, Map.prototype, Set.prototype, WeakMap.prototype, WeakSet.prototype,
  ]);
  // Whether reading 'key' of 'object' runs none of a program's code: no
  // proxy on the way to the first object holding it, whose descriptor is
  // data; or, given 'intrinsicHolder', that first holder is it.
  function readsInertly(object, key, intrinsicHolder) {
    for (let at = object; at !== null; at = Object.getPrototypeOf(at)) {
      if (isProxy(at)) return false;
      const own = Object.getOwnPropertyDescriptor(at, key);
      if (own === undefined) continue;
      if (intrinsicHolder !== undefined) return at === intrinsicHolder;
      return own.get === undefined && own.set === undefined;
    }
    return true;
  }
  // Whether workerd formats 'holder' with none of a program's code run, as
  // its inspect reads the chain: no proxy on it; no accessor for its
  // Symbol.toStringTag; and, for its constructor discovery, no constructor
  // whose name is read through an accessor or whose instanceof check is a
  // program's (Symbol.hasInstance held anywhere but Function.prototype).
  function formatsInertly(holder) {
    let tag = false;
    for (let at = holder; at !== null; at = Object.getPrototypeOf(at)) {
      if (isProxy(at)) return false;
      const own = tag ? undefined : Object.getOwnPropertyDescriptor(at, Symbol.toStringTag);
      if (own !== undefined) {
        if (own.get !== undefined || own.set !== undefined) return false;
        tag = true;
      }
      if (intrinsicPrototypes.has(at)) continue;
      const constructor = Object.getOwnPropertyDescriptor(at, "constructor");
      if (constructor === undefined || typeof constructor.value !== "function") continue;
      if (!readsInertly(constructor.value, "name") || !readsInertly(constructor.value, Symbol.hasInstance, Function.prototype)) return false;
    }
    return true;
  }
  // What a slot whose holder cannot be read inertly shows (formatsInertly).
  function unknown(text) {
    return Object.freeze(Object.create(null, {
      [customInspect]: { value: (depth, options) => options.stylize(text, "special") },
      [Symbol.toStringTag]: { value: text },
    }));
  }
  const ITEMS_UNKNOWN = unknown("<items unknown>");
  const UNKNOWN = unknown("<unknown>");
  function unreadable(what) {
    return new Error("util.inspect: workerd's inspect did not hand over " + what + " in a V8 slot");
  }
  function getPromiseDetails(promise) {
    if (!formatsInertly(promise)) return [kFulfilled, UNKNOWN];
    const first = capture(promise, {}, 1);
    if (first.events.length > 0 && first.events[0].mark === "<pending>") return [kPending];
    const rejected = first.events.some((event) => event.mark === "<rejected>");
    // Its result, the first value formatted (before the promise's own properties).
    const [result] = slotValues((depth) => (depth === 0 ? first : capture(promise, { depth }, 1)).events, 1);
    return [rejected ? kRejected : kFulfilled, result];
  }
  function getProxyDetails(proxy, showProxy) {
    let parts = standIns.get(proxy);
    if (parts === undefined) {
      const first = capture(proxy, {}, 0);
      // Revoked itself: its one mark (a revoked target's is the first of two parts').
      if (first.events.length === 1 && first.events[0].mark === REVOKED) parts = null;
      else parts = slotValues((depth) => (depth === 0 ? first : capture(proxy, { depth }, 0)).events, 2);
    }
    if (parts === null) return showProxy ? [null, null] : null;
    if (showProxy) return parts;
    // inspect.js calls the target's custom inspect with the proxy as this: a
    // program's own proxy is that; a stand-in must never be, so the target of
    // one, if it has such a hook, is not shown (nor its constructor's checks run).
    const target = innermostTarget(parts[0]);
    return standIns.has(proxy) && !standIns.has(target) && reachesCustomInspect(target) ? UNKNOWN : target;
  }
  function previewEntries(value, isKeyValue) {
    if (!formatsInertly(value)) return isKeyValue === undefined ? [ITEMS_UNKNOWN] : [[ITEMS_UNKNOWN], false];
    // A weak collection's entries are what showHidden shows. The value's own
    // properties follow its entries: counted off by a read showing none.
    const options = { showHidden: isKeyValue === undefined };
    let text;
    const entries = slotValues((depth) => {
      const all = capture(value, { ...options, depth, maxArrayLength: Infinity }, 1);
      const own = capture(value, { ...options, depth, maxArrayLength: 0 }, 1).events;
      text ??= all.text;
      return all.events.slice(0, all.events.length - own.length);
    });
    if (isKeyValue === undefined) return entries;
    const pairs = /^[^{]*\[(?:Map|Set) Entries\] \{/.test(text);
    if (pairs && entries.length % 2 !== 0) throw unreadable("an iterator's pairs");
    return [entries, pairs];
  }
  return { getPromiseDetails, getProxyDetails, previewEntries };
},
  primordialsOf: function (primordials, globalThis) {
'use strict';

/* eslint-disable node-core/prefer-primordials */

// This file subclasses and stores the JS builtins that come from the VM
// so that Node.js's builtin modules do not need to later look these up from
// the global proxy, which can be mutated by users.

// Use of primordials have sometimes a dramatic impact on performance, please
// benchmark all changes made in performance-sensitive areas of the codebase.
// See: https://github.com/nodejs/node/pull/38248

const {
  defineProperty: ReflectDefineProperty,
  getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
  ownKeys: ReflectOwnKeys,
} = Reflect;

// `uncurryThis` is equivalent to `func => Function.prototype.call.bind(func)`.
// It is using `bind.bind(call)` to avoid using `Function.prototype.bind`
// and `Function.prototype.call` after it may have been mutated by users.
const { apply, bind, call } = Function.prototype;
const uncurryThis = bind.bind(call);
primordials.uncurryThis = uncurryThis;

// `applyBind` is equivalent to `func => Function.prototype.apply.bind(func)`.
// It is using `bind.bind(apply)` to avoid using `Function.prototype.bind`
// and `Function.prototype.apply` after it may have been mutated by users.
const applyBind = bind.bind(apply);
primordials.applyBind = applyBind;

// Methods that accept a variable number of arguments, and thus it's useful to
// also create `${prefix}${key}Apply`, which uses `Function.prototype.apply`,
// instead of `Function.prototype.call`, and thus doesn't require iterator
// destructuring.
const varargsMethods = [
  // 'ArrayPrototypeConcat' is omitted, because it performs the spread
  // on its own for arrays and array-likes with a truthy
  // @@isConcatSpreadable symbol property.
  'ArrayOf',
  'ArrayPrototypePush',
  'ArrayPrototypeUnshift',
  // 'FunctionPrototypeCall' is omitted, since there's 'ReflectApply'
  // and 'FunctionPrototypeApply'.
  'MathHypot',
  'MathMax',
  'MathMin',
  'StringFromCharCode',
  'StringFromCodePoint',
  'StringPrototypeConcat',
  'TypedArrayOf',
];

function getNewKey(key) {
  return typeof key === 'symbol' ?
    `Symbol${key.description[7].toUpperCase()}${key.description.slice(8)}` :
    `${key[0].toUpperCase()}${key.slice(1)}`;
}

function copyAccessor(dest, prefix, key, { enumerable, get, set }) {
  ReflectDefineProperty(dest, `${prefix}Get${key}`, {
    __proto__: null,
    value: uncurryThis(get),
    enumerable,
  });
  if (set !== undefined) {
    ReflectDefineProperty(dest, `${prefix}Set${key}`, {
      __proto__: null,
      value: uncurryThis(set),
      enumerable,
    });
  }
}

function copyPropsRenamed(src, dest, prefix) {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, { __proto__: null, ...desc });
      if (varargsMethods.includes(name)) {
        ReflectDefineProperty(dest, `${name}Apply`, {
          __proto__: null,
          // `src` is bound as the `this` so that the static `this` points
          // to the object it was defined on,
          // e.g.: `ArrayOfApply` gets a `this` of `Array`:
          value: applyBind(desc.value, src),
        });
      }
    }
  }
}

function copyPropsRenamedBound(src, dest, prefix) {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const { value } = desc;
      if (typeof value === 'function') {
        desc.value = value.bind(src);
      }

      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, { __proto__: null, ...desc });
      if (varargsMethods.includes(name)) {
        ReflectDefineProperty(dest, `${name}Apply`, {
          __proto__: null,
          value: applyBind(value, src),
        });
      }
    }
  }
}

function copyPrototype(src, dest, prefix) {
  for (const key of ReflectOwnKeys(src)) {
    const newKey = getNewKey(key);
    const desc = ReflectGetOwnPropertyDescriptor(src, key);
    if ('get' in desc) {
      copyAccessor(dest, prefix, newKey, desc);
    } else {
      const { value } = desc;
      if (typeof value === 'function') {
        desc.value = uncurryThis(value);
      }

      const name = `${prefix}${newKey}`;
      ReflectDefineProperty(dest, name, { __proto__: null, ...desc });
      if (varargsMethods.includes(name)) {
        ReflectDefineProperty(dest, `${name}Apply`, {
          __proto__: null,
          value: applyBind(value),
        });
      }
    }
  }
}

// Create copies of configurable value properties of the global object
[
  'Proxy',
  'globalThis',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  primordials[name] = globalThis[name];
});

// Create copies of URI handling functions
[
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
].forEach((fn) => {
  primordials[fn.name] = fn;
});

// Create copies of legacy functions
[
  escape,
  eval,
  unescape,
].forEach((fn) => {
  primordials[fn.name] = fn;
});

// Create copies of the namespace objects
[
  'Atomics',
  'JSON',
  'Math',
  'Proxy',
  'Reflect',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  copyPropsRenamed(globalThis[name], primordials, name);
});

// Create copies of intrinsic objects
[
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Map',
  'Number',
  'Object',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  const original = globalThis[name];
  primordials[name] = original;
  copyPropsRenamed(original, primordials, name);
  copyPrototype(original.prototype, primordials, `${name}Prototype`);
});


// Create copies of intrinsic objects that require a valid `this` to call
// static methods.
// Refs: https://www.ecma-international.org/ecma-262/#sec-promise.all
[
  'Promise',
].forEach((name) => {
  // eslint-disable-next-line no-restricted-globals
  const original = globalThis[name];
  primordials[name] = original;
  copyPropsRenamedBound(original, primordials, name);
  copyPrototype(original.prototype, primordials, `${name}Prototype`);
});

// Create copies of abstract intrinsic objects that are not directly exposed
// on the global object.
// Refs: https://tc39.es/ecma262/#sec-%typedarray%-intrinsic-object
[
  { name: 'TypedArray', original: Reflect.getPrototypeOf(Uint8Array) },
  { name: 'ArrayIterator', original: {
    prototype: Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]()),
  } },
  { name: 'StringIterator', original: {
    prototype: Reflect.getPrototypeOf(String.prototype[Symbol.iterator]()),
  } },
].forEach(({ name, original }) => {
  primordials[name] = original;
  // The static %TypedArray% methods require a valid `this`, but can't be bound,
  // as they need a subclass constructor as the receiver:
  copyPrototype(original, primordials, name);
  copyPrototype(original.prototype, primordials, `${name}Prototype`);
});

primordials.IteratorPrototype = Reflect.getPrototypeOf(primordials.ArrayIteratorPrototype);

/* eslint-enable node-core/prefer-primordials */

const {
  Array: ArrayConstructor,
  ArrayPrototypeForEach,
  ArrayPrototypeMap,
  ArrayPrototypePushApply,
  ArrayPrototypeSlice,
  FinalizationRegistry,
  FunctionPrototypeCall,
  Map,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectSetPrototypeOf,
  Promise,
  PromisePrototypeThen,
  PromiseResolve,
  ReflectApply,
  ReflectConstruct,
  ReflectGet,
  ReflectSet,
  RegExp,
  RegExpPrototype,
  RegExpPrototypeExec,
  RegExpPrototypeGetDotAll,
  RegExpPrototypeGetFlags,
  RegExpPrototypeGetGlobal,
  RegExpPrototypeGetHasIndices,
  RegExpPrototypeGetIgnoreCase,
  RegExpPrototypeGetMultiline,
  RegExpPrototypeGetSource,
  RegExpPrototypeGetSticky,
  RegExpPrototypeGetUnicode,
  Set,
  SymbolIterator,
  SymbolMatch,
  SymbolMatchAll,
  SymbolReplace,
  SymbolSearch,
  SymbolSpecies,
  SymbolSplit,
  WeakMap,
  WeakRef,
  WeakSet,
} = primordials;


/**
 * Creates a class that can be safely iterated over.
 *
 * Because these functions are used by `makeSafe`, which is exposed on the
 * `primordials` object, it's important to use const references to the
 * primordials that they use.
 * @template {Iterable} T
 * @template {*} TReturn
 * @template {*} TNext
 * @param {(self: T) => IterableIterator<T>} factory
 * @param {(...args: [] | [TNext]) => IteratorResult<T, TReturn>} next
 * @returns {Iterator<T, TReturn, TNext>}
 */
const createSafeIterator = (factory, next) => {
  class SafeIterator {
    constructor(iterable) {
      this._iterator = factory(iterable);
    }
    next() {
      return next(this._iterator);
    }
    [SymbolIterator]() {
      return this;
    }
  }
  ObjectSetPrototypeOf(SafeIterator.prototype, null);
  ObjectFreeze(SafeIterator.prototype);
  ObjectFreeze(SafeIterator);
  return SafeIterator;
};

primordials.SafeArrayIterator = createSafeIterator(
  primordials.ArrayPrototypeSymbolIterator,
  primordials.ArrayIteratorPrototypeNext,
);
primordials.SafeStringIterator = createSafeIterator(
  primordials.StringPrototypeSymbolIterator,
  primordials.StringIteratorPrototypeNext,
);

const copyProps = (src, dest) => {
  ArrayPrototypeForEach(ReflectOwnKeys(src), (key) => {
    if (!ReflectGetOwnPropertyDescriptor(dest, key)) {
      ReflectDefineProperty(
        dest,
        key,
        { __proto__: null, ...ReflectGetOwnPropertyDescriptor(src, key) });
    }
  });
};

/**
 * @type {typeof primordials.makeSafe}
 */
const makeSafe = (unsafe, safe) => {
  if (SymbolIterator in unsafe.prototype) {
    const dummy = new unsafe();
    let next; // We can reuse the same `next` method.

    ArrayPrototypeForEach(ReflectOwnKeys(unsafe.prototype), (key) => {
      if (!ReflectGetOwnPropertyDescriptor(safe.prototype, key)) {
        const desc = ReflectGetOwnPropertyDescriptor(unsafe.prototype, key);
        if (
          typeof desc.value === 'function' &&
          desc.value.length === 0 &&
          SymbolIterator in (FunctionPrototypeCall(desc.value, dummy) ?? {})
        ) {
          const createIterator = uncurryThis(desc.value);
          next ??= uncurryThis(createIterator(dummy).next);
          const SafeIterator = createSafeIterator(createIterator, next);
          desc.value = function() {
            return new SafeIterator(this);
          };
        }
        ReflectDefineProperty(safe.prototype, key, { __proto__: null, ...desc });
      }
    });
  } else {
    copyProps(unsafe.prototype, safe.prototype);
  }
  copyProps(unsafe, safe);

  ObjectSetPrototypeOf(safe.prototype, null);
  ObjectFreeze(safe.prototype);
  ObjectFreeze(safe);
  return safe;
};
primordials.makeSafe = makeSafe;

// Subclass the constructors because we need to use their prototype
// methods later.
primordials.SafeMap = makeSafe(
  Map,
  class SafeMap extends Map {},
);
primordials.SafeWeakMap = makeSafe(
  WeakMap,
  class SafeWeakMap extends WeakMap {},
);

primordials.SafeSet = makeSafe(
  Set,
  class SafeSet extends Set {},
);
primordials.SafeWeakSet = makeSafe(
  WeakSet,
  class SafeWeakSet extends WeakSet {},
);

primordials.SafeFinalizationRegistry = makeSafe(
  FinalizationRegistry,
  class SafeFinalizationRegistry extends FinalizationRegistry {},
);
primordials.SafeWeakRef = makeSafe(
  WeakRef,
  class SafeWeakRef extends WeakRef {},
);

const SafePromise = makeSafe(
  Promise,
  class SafePromise extends Promise {},
);

/**
 * Attaches a callback that is invoked when the Promise is settled (fulfilled or
 * rejected). The resolved value cannot be modified from the callback.
 * Prefer using async functions when possible.
 * @param {Promise<any>} thisPromise
 * @param {(() => void) | undefined | null} onFinally The callback to execute
 *        when the Promise is settled (fulfilled or rejected).
 * @returns {Promise} A Promise for the completion of the callback.
 */
primordials.SafePromisePrototypeFinally = (thisPromise, onFinally) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    new SafePromise((a, b) => PromisePrototypeThen(thisPromise, a, b))
      .finally(onFinally)
      .then(a, b),
  );

primordials.AsyncIteratorPrototype =
  primordials.ReflectGetPrototypeOf(
    primordials.ReflectGetPrototypeOf(
      async function* () {}).prototype);

const arrayToSafePromiseIterable = (promises, mapFn) =>
  new primordials.SafeArrayIterator(
    ArrayPrototypeMap(
      promises,
      (promise, i) =>
        new SafePromise((a, b) => PromisePrototypeThen(mapFn == null ? promise : mapFn(promise, i), a, b)),
    ),
  );

/**
 * @template T,U
 * @param {Array<T | PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<Awaited<U>[]>}
 */
primordials.SafePromiseAll = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.all(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

/**
 * Should only be used for internal functions, this would produce similar
 * results as `Promise.all` but without prototype pollution, and the return
 * value is not a genuine Array but an array-like object.
 * @template T,U
 * @param {ArrayLike<T | PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<ArrayLike<Awaited<U>>>}
 */
primordials.SafePromiseAllReturnArrayLike = (promises, mapFn) =>
  new Promise((resolve, reject) => {
    const { length } = promises;

    const returnVal = ArrayConstructor(length);
    ObjectSetPrototypeOf(returnVal, null);
    if (length === 0) resolve(returnVal);

    let pendingPromises = length;
    for (let i = 0; i < length; i++) {
      const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
      PromisePrototypeThen(PromiseResolve(promise), (result) => {
        returnVal[i] = result;
        if (--pendingPromises === 0) resolve(returnVal);
      }, reject);
    }
  });

/**
 * Should only be used when we only care about waiting for all the promises to
 * resolve, not what value they resolve to.
 * @template T,U
 * @param {ArrayLike<T | PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<void>}
 */
primordials.SafePromiseAllReturnVoid = (promises, mapFn) =>
  new Promise((resolve, reject) => {
    let pendingPromises = promises.length;
    if (pendingPromises === 0) resolve();
    const onFulfilled = () => {
      if (--pendingPromises === 0) {
        resolve();
      }
    };
    for (let i = 0; i < promises.length; i++) {
      const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
      PromisePrototypeThen(PromiseResolve(promise), onFulfilled, reject);
    }
  });

/**
 * @template T,U
 * @param {Array<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<PromiseSettledResult<any>[]>}
 */
primordials.SafePromiseAllSettled = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.allSettled(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

/**
 * Should only be used when we only care about waiting for all the promises to
 * settle, not what value they resolve or reject to.
 * @template T,U
 * @param {ArrayLike<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<void>}
 */
primordials.SafePromiseAllSettledReturnVoid = (promises, mapFn) => new Promise((resolve) => {
  let pendingPromises = promises.length;
  if (pendingPromises === 0) resolve();
  const onSettle = () => {
    if (--pendingPromises === 0) resolve();
  };
  for (let i = 0; i < promises.length; i++) {
    const promise = mapFn != null ? mapFn(promises[i], i) : promises[i];
    PromisePrototypeThen(PromiseResolve(promise), onSettle, onSettle);
  }
});

/**
 * @template T,U
 * @param {Array<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<Awaited<U>>}
 */
primordials.SafePromiseAny = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.any(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );

/**
 * @template T,U
 * @param {Array<T|PromiseLike<T>>} promises
 * @param {(v: T|PromiseLike<T>, k: number) => U|PromiseLike<U>} [mapFn]
 * @returns {Promise<Awaited<U>>}
 */
primordials.SafePromiseRace = (promises, mapFn) =>
  // Wrapping on a new Promise is necessary to not expose the SafePromise
  // prototype to user-land.
  new Promise((a, b) =>
    SafePromise.race(arrayToSafePromiseIterable(promises, mapFn)).then(a, b),
  );


const {
  exec: OriginalRegExpPrototypeExec,
  [SymbolMatch]: OriginalRegExpPrototypeSymbolMatch,
  [SymbolMatchAll]: OriginalRegExpPrototypeSymbolMatchAll,
  [SymbolReplace]: OriginalRegExpPrototypeSymbolReplace,
  [SymbolSearch]: OriginalRegExpPrototypeSymbolSearch,
  [SymbolSplit]: OriginalRegExpPrototypeSymbolSplit,
} = RegExpPrototype;

class RegExpLikeForStringSplitting {
  #regex;
  constructor() {
    this.#regex = ReflectConstruct(RegExp, arguments);
  }

  get lastIndex() {
    return ReflectGet(this.#regex, 'lastIndex');
  }
  set lastIndex(value) {
    ReflectSet(this.#regex, 'lastIndex', value);
  }

  exec() {
    return ReflectApply(OriginalRegExpPrototypeExec, this.#regex, arguments);
  }
}
ObjectSetPrototypeOf(RegExpLikeForStringSplitting.prototype, null);

/**
 * @param {RegExp} pattern
 * @returns {RegExp}
 */
primordials.hardenRegExp = function hardenRegExp(pattern) {
  ObjectDefineProperties(pattern, {
    [SymbolMatch]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolMatch,
    },
    [SymbolMatchAll]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolMatchAll,
    },
    [SymbolReplace]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolReplace,
    },
    [SymbolSearch]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolSearch,
    },
    [SymbolSplit]: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeSymbolSplit,
    },
    constructor: {
      __proto__: null,
      configurable: true,
      value: {
        [SymbolSpecies]: RegExpLikeForStringSplitting,
      },
    },
    dotAll: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetDotAll(pattern),
    },
    exec: {
      __proto__: null,
      configurable: true,
      value: OriginalRegExpPrototypeExec,
    },
    global: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetGlobal(pattern),
    },
    hasIndices: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetHasIndices(pattern),
    },
    ignoreCase: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetIgnoreCase(pattern),
    },
    multiline: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetMultiline(pattern),
    },
    source: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetSource(pattern),
    },
    sticky: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetSticky(pattern),
    },
    unicode: {
      __proto__: null,
      configurable: true,
      value: RegExpPrototypeGetUnicode(pattern),
    },
  });
  ObjectDefineProperty(pattern, 'flags', {
    __proto__: null,
    configurable: true,
    value: RegExpPrototypeGetFlags(pattern),
  });
  return pattern;
};


/**
 * @param {string} str
 * @param {RegExp} regexp
 * @returns {number}
 */
primordials.SafeStringPrototypeSearch = (str, regexp) => {
  regexp.lastIndex = 0;
  const match = RegExpPrototypeExec(regexp, str);
  return match ? match.index : -1;
};

/**
 * Variadic functions with lots of arguments will cause stack overflow errors.
 * Use this function when `items` can be arbitrarily large, this function splits
 * it into chunks of size 2**16 making stack overflow less likely.
 * @param {Array<unknown>} arr
 * @param {Parameters<typeof Array.prototype.push>} items
 * @returns {ReturnType<typeof Array.prototype.push>}
 */
primordials.SafeArrayPrototypePushApply = (arr, items) => {
  let end = 0x10000;
  if (end < items.length) {
    let start = 0;
    do {
      ArrayPrototypePushApply(arr, ArrayPrototypeSlice(items, start, start = end));
      end += 0x10000;
    } while (end < items.length);
    items = ArrayPrototypeSlice(items, start);
  }
  return ArrayPrototypePushApply(arr, items);
};

ObjectSetPrototypeOf(primordials, null);
ObjectFreeze(primordials);

  },
  // The East Asian Wide and Fullwidth ranges: `first[-last]` in hex, comma-separated, ascending.
  eastAsianWideRanges: "1100-115f,231a-231b,2329-232a,23e9-23ec,23f0,23f3,25fd-25fe,2614-2615,2630-2637,2648-2653,267f,268a-268f,2693,26a1,26aa-26ab,26bd-26be,26c4-26c5,26ce,26d4,26ea,26f2-26f3,26f5,26fa,26fd,2705,270a-270b,2728,274c,274e,2753-2755,2757,2795-2797,27b0,27bf,2b1b-2b1c,2b50,2b55,2e80-2e99,2e9b-2ef3,2f00-2fd5,2ff0-303e,3041-3096,3099-30ff,3105-312f,3131-318e,3190-31e5,31ef-321e,3220-3247,3250-a48c,a490-a4c6,a960-a97c,ac00-d7a3,f900-faff,fe10-fe19,fe30-fe52,fe54-fe66,fe68-fe6b,ff01-ff60,ffe0-ffe6,16fe0-16fe4,16ff0-16ff6,17000-18cd5,18cff-18d1e,18d80-18df2,1aff0-1aff3,1aff5-1affb,1affd-1affe,1b000-1b122,1b132,1b150-1b152,1b155,1b164-1b167,1b170-1b2fb,1d300-1d356,1d360-1d376,1f004,1f0cf,1f18e,1f191-1f19a,1f200-1f202,1f210-1f23b,1f240-1f248,1f250-1f251,1f260-1f265,1f300-1f320,1f32d-1f335,1f337-1f37c,1f37e-1f393,1f3a0-1f3ca,1f3cf-1f3d3,1f3e0-1f3f0,1f3f4,1f3f8-1f43e,1f440,1f442-1f4fc,1f4ff-1f53d,1f54b-1f54e,1f550-1f567,1f57a,1f595-1f596,1f5a4,1f5fb-1f64f,1f680-1f6c5,1f6cc,1f6d0-1f6d2,1f6d5-1f6d8,1f6dc-1f6df,1f6eb-1f6ec,1f6f4-1f6fc,1f7e0-1f7eb,1f7f0,1f90c-1f93a,1f93c-1f945,1f947-1f9ff,1fa70-1fa7c,1fa80-1fa8a,1fa8e-1fac6,1fac8,1facd-1fadc,1fadf-1faea,1faef-1faf8,20000-2fffd,30000-3fffd",
  builtinObjects: ["Object","Function","Array","Number","Infinity","NaN","Boolean","String","Symbol","Date","Promise","RegExp","Error","AggregateError","EvalError","RangeError","ReferenceError","SyntaxError","TypeError","URIError","JSON","Math","Intl","ArrayBuffer","Atomics","Uint8Array","Int8Array","Uint16Array","Int16Array","Uint32Array","Int32Array","Float32Array","Float64Array","Uint8ClampedArray","BigUint64Array","BigInt64Array","DataView","Map","BigInt","Set","WeakMap","WeakSet","Proxy","Reflect","FinalizationRegistry","WeakRef"],
  uvErrors: [[-7,"E2BIG","argument list too long"],[-13,"EACCES","permission denied"],[-98,"EADDRINUSE","address already in use"],[-99,"EADDRNOTAVAIL","address not available"],[-97,"EAFNOSUPPORT","address family not supported"],[-11,"EAGAIN","resource temporarily unavailable"],[-3000,"EAI_ADDRFAMILY","address family not supported"],[-3001,"EAI_AGAIN","temporary failure"],[-3002,"EAI_BADFLAGS","bad ai_flags value"],[-3013,"EAI_BADHINTS","invalid value for hints"],[-3003,"EAI_CANCELED","request canceled"],[-3004,"EAI_FAIL","permanent failure"],[-3005,"EAI_FAMILY","ai_family not supported"],[-3006,"EAI_MEMORY","out of memory"],[-3007,"EAI_NODATA","no address"],[-3008,"EAI_NONAME","unknown node or service"],[-3009,"EAI_OVERFLOW","argument buffer overflow"],[-3014,"EAI_PROTOCOL","resolved protocol is unknown"],[-3010,"EAI_SERVICE","service not available for socket type"],[-3011,"EAI_SOCKTYPE","socket type not supported"],[-114,"EALREADY","connection already in progress"],[-9,"EBADF","bad file descriptor"],[-16,"EBUSY","resource busy or locked"],[-125,"ECANCELED","operation canceled"],[-4080,"ECHARSET","invalid Unicode character"],[-103,"ECONNABORTED","software caused connection abort"],[-111,"ECONNREFUSED","connection refused"],[-104,"ECONNRESET","connection reset by peer"],[-89,"EDESTADDRREQ","destination address required"],[-17,"EEXIST","file already exists"],[-14,"EFAULT","bad address in system call argument"],[-27,"EFBIG","file too large"],[-113,"EHOSTUNREACH","host is unreachable"],[-4,"EINTR","interrupted system call"],[-22,"EINVAL","invalid argument"],[-5,"EIO","i/o error"],[-106,"EISCONN","socket is already connected"],[-21,"EISDIR","illegal operation on a directory"],[-40,"ELOOP","too many symbolic links encountered"],[-24,"EMFILE","too many open files"],[-90,"EMSGSIZE","message too long"],[-36,"ENAMETOOLONG","name too long"],[-100,"ENETDOWN","network is down"],[-101,"ENETUNREACH","network is unreachable"],[-23,"ENFILE","file table overflow"],[-105,"ENOBUFS","no buffer space available"],[-19,"ENODEV","no such device"],[-2,"ENOENT","no such file or directory"],[-12,"ENOMEM","not enough memory"],[-64,"ENONET","machine is not on the network"],[-92,"ENOPROTOOPT","protocol not available"],[-28,"ENOSPC","no space left on device"],[-38,"ENOSYS","function not implemented"],[-107,"ENOTCONN","socket is not connected"],[-20,"ENOTDIR","not a directory"],[-39,"ENOTEMPTY","directory not empty"],[-88,"ENOTSOCK","socket operation on non-socket"],[-95,"ENOTSUP","operation not supported on socket"],[-75,"EOVERFLOW","value too large for defined data type"],[-1,"EPERM","operation not permitted"],[-32,"EPIPE","broken pipe"],[-71,"EPROTO","protocol error"],[-93,"EPROTONOSUPPORT","protocol not supported"],[-91,"EPROTOTYPE","protocol wrong type for socket"],[-34,"ERANGE","result too large"],[-30,"EROFS","read-only file system"],[-108,"ESHUTDOWN","cannot send after transport endpoint shutdown"],[-29,"ESPIPE","invalid seek"],[-3,"ESRCH","no such process"],[-110,"ETIMEDOUT","connection timed out"],[-26,"ETXTBSY","text file is busy"],[-18,"EXDEV","cross-device link not permitted"],[-4094,"UNKNOWN","unknown error"],[-4095,"EOF","end of file"],[-6,"ENXIO","no such device or address"],[-31,"EMLINK","too many links"],[-112,"EHOSTDOWN","host is down"],[-121,"EREMOTEIO","remote I/O error"],[-25,"ENOTTY","inappropriate ioctl for device"],[-4028,"EFTYPE","inappropriate file type or format"],[-84,"EILSEQ","illegal byte sequence"],[-94,"ESOCKTNOSUPPORT","socket type not supported"],[-61,"ENODATA","no data available"],[-49,"EUNATCH","protocol driver not attached"],[-8,"ENOEXEC","exec format error"]],
  // node's options and their aliases (core node-cli-options.generated.ts): [name, kind, allowed in NODE_OPTIONS].
  cliOptions: [["--abort-on-uncaught-exception","v8",true],["--addons","boolean",true],["--allow-addons","boolean",true],["--allow-child-process","boolean",true],["--allow-fs-read","value",true],["--allow-fs-write","value",true],["--allow-wasi","boolean",true],["--allow-worker","boolean",true],["--build-snapshot","boolean",false],["--build-snapshot-config","value",false],["--check","boolean",false],["--completion-bash","boolean",false],["--conditions","value",true],["--cpu-prof","boolean",true],["--cpu-prof-dir","value",true],["--cpu-prof-interval","value",true],["--cpu-prof-name","value",true],["--debug","boolean",false],["--debug-arraybuffer-allocations","boolean",true],["--debug-brk","boolean",false],["--deprecation","boolean",true],["--diagnostic-dir","value",true],["--disable-proto","value",true],["--disable-sigusr1","boolean",true],["--disable-warning","value",true],["--disable-wasm-trap-handler","boolean",true],["--disallow-code-generation-from-strings","v8",true],["--dns-result-order","value",true],["--enable-etw-stack-walking","v8",true],["--enable-fips","boolean",true],["--enable-source-maps","boolean",true],["--entry-url","boolean",true],["--env-file","value",false],["--env-file-if-exists","value",false],["--eval","value",false],["--experimental-abortcontroller","noop",true],["--experimental-addon-modules","boolean",true],["--experimental-async-context-frame","boolean",true],["--experimental-config-file","value",false],["--experimental-default-config-file","boolean",false],["--experimental-default-type","value",true],["--experimental-detect-module","boolean",true],["--experimental-eventsource","boolean",true],["--experimental-fetch","boolean",true],["--experimental-global-customevent","boolean",true],["--experimental-global-navigator","boolean",true],["--experimental-global-webcrypto","boolean",true],["--experimental-import-meta-resolve","boolean",true],["--experimental-inspector-network-resource","boolean",false],["--experimental-json-modules","noop",true],["--experimental-loader","value",true],["--experimental-modules","noop",true],["--experimental-network-inspection","boolean",false],["--experimental-print-required-tla","boolean",true],["--experimental-repl-await","boolean",true],["--experimental-report","noop",true],["--experimental-require-module","boolean",true],["--experimental-sea-config","value",false],["--experimental-shadow-realm","boolean",true],["--experimental-specifier-resolution","noop",true],["--experimental-sqlite","boolean",true],["--experimental-strip-types","boolean",true],["--experimental-test-coverage","boolean",false],["--experimental-test-isolation","value",false],["--experimental-test-module-mocks","boolean",false],["--experimental-test-snapshots","noop",false],["--experimental-top-level-await","noop",true],["--experimental-transform-types","boolean",true],["--experimental-vm-modules","boolean",true],["--experimental-wasi-unstable-preview1","noop",true],["--experimental-wasm-modules","noop",true],["--experimental-websocket","boolean",true],["--experimental-webstorage","boolean",true],["--experimental-worker","noop",true],["--experimental-worker-inspection","boolean",false],["--expose-gc","v8",true],["--expose-internals","boolean",false],["--extra-info-on-fatal-exception","boolean",true],["--force-async-hooks-checks","boolean",true],["--force-context-aware","boolean",true],["--force-fips","boolean",true],["--force-node-api-uncaught-exceptions-policy","boolean",true],["--frozen-intrinsics","boolean",true],["--global-search-paths","boolean",true],["--harmony-shadow-realm","v8",false],["--heap-prof","boolean",true],["--heap-prof-dir","value",true],["--heap-prof-interval","value",true],["--heap-prof-name","value",true],["--heapsnapshot-near-heap-limit","value",true],["--heapsnapshot-signal","value",true],["--help","boolean",false],["--http-parser","noop",true],["--huge-max-old-generation-size","v8",true],["--icu-data-dir","value",true],["--import","value",true],["--input-type","value",true],["--insecure-http-parser","boolean",true],["--inspect","boolean",true],["--inspect-brk","boolean",true],["--inspect-brk-node","boolean",false],["--inspect-port","value",true],["--inspect-publish-uid","value",true],["--inspect-wait","boolean",true],["--interactive","boolean",false],["--interpreted-frames-native-stack","v8",true],["--jitless","v8",true],["--localstorage-file","value",true],["--max-http-header-size","value",true],["--max-old-space-size","v8",true],["--max-old-space-size-percentage","value",true],["--max-semi-space-size","v8",true],["--napi-modules","noop",true],["--network-family-autoselection","boolean",true],["--network-family-autoselection-attempt-timeout","value",true],["--node-memory-debug","noop",true],["--node-snapshot","boolean",true],["--openssl-config","value",true],["--openssl-legacy-provider","boolean",true],["--openssl-shared-config","boolean",true],["--pending-deprecation","boolean",true],["--perf-basic-prof","v8",true],["--perf-basic-prof-only-functions","v8",true],["--perf-prof","v8",true],["--perf-prof-unwinding-info","v8",true],["--permission","boolean",true],["--preserve-symlinks","boolean",true],["--preserve-symlinks-main","boolean",true],["--print","boolean",false],["--prof","v8",false],["--prof-process","boolean",false],["--redirect-warnings","value",true],["--report-compact","boolean",true],["--report-dir","value",true],["--report-exclude-env","boolean",true],["--report-exclude-network","boolean",true],["--report-filename","value",true],["--report-on-fatalerror","boolean",true],["--report-on-signal","boolean",true],["--report-signal","value",true],["--report-uncaught-exception","boolean",true],["--require","value",true],["--run","value",false],["--secure-heap","value",true],["--secure-heap-min","value",true],["--security-revert","value",false],["--snapshot-blob","value",true],["--stack-trace-limit","value",true],["--test","boolean",false],["--test-concurrency","value",false],["--test-coverage-branches","value",true],["--test-coverage-exclude","value",true],["--test-coverage-functions","value",true],["--test-coverage-include","value",true],["--test-coverage-lines","value",true],["--test-force-exit","boolean",false],["--test-name-pattern","value",true],["--test-only","boolean",true],["--test-reporter","value",true],["--test-reporter-destination","value",true],["--test-shard","value",true],["--test-skip-pattern","value",true],["--test-timeout","value",false],["--test-udp-no-try-send","boolean",false],["--test-update-snapshots","boolean",false],["--throw-deprecation","boolean",true],["--title","value",true],["--tls-cipher-list","value",true],["--tls-keylog","value",true],["--tls-max-v1.2","boolean",true],["--tls-max-v1.3","boolean",true],["--tls-min-v1.0","boolean",true],["--tls-min-v1.1","boolean",true],["--tls-min-v1.2","boolean",true],["--tls-min-v1.3","boolean",true],["--trace-atomics-wait","boolean",true],["--trace-deprecation","boolean",true],["--trace-env","boolean",true],["--trace-env-js-stack","boolean",true],["--trace-env-native-stack","boolean",true],["--trace-event-categories","value",true],["--trace-event-file-pattern","value",true],["--trace-exit","boolean",true],["--trace-promises","boolean",true],["--trace-require-module","value",true],["--trace-sigint","boolean",true],["--trace-sync-io","boolean",true],["--trace-tls","boolean",true],["--trace-uncaught","boolean",true],["--trace-warnings","boolean",true],["--track-heap-objects","boolean",true],["--unhandled-rejections","value",true],["--use-bundled-ca","boolean",true],["--use-env-proxy","boolean",true],["--use-largepages","value",true],["--use-openssl-ca","boolean",true],["--use-system-ca","boolean",true],["--v8-options","boolean",false],["--v8-pool-size","value",true],["--verify-base-objects","boolean",true],["--version","boolean",false],["--warnings","boolean",true],["--watch","boolean",true],["--watch-kill-signal","value",true],["--watch-path","value",true],["--watch-preserve-output","boolean",true],["--zero-fill-buffers","boolean",true],["[has_env_file_string]","boolean",false],["[has_eval_string]","boolean",false],["[ssl_openssl_cert_store]","boolean",false]],
  cliAliases: [["--debug-brk=",["--debug-brk"]],["--debug-port",["--inspect-port"]],["--debug=",["--debug"]],["--enable-network-family-autoselection",["--network-family-autoselection"]],["--es-module-specifier-resolution",["--experimental-specifier-resolution"]],["--experimental-permission",["--permission"]],["--inspect-brk-node=",["--inspect-port","--inspect-brk-node"]],["--inspect-brk=",["--inspect-port","--inspect-brk"]],["--inspect-wait=",["--inspect-port","--inspect-wait"]],["--inspect=",["--inspect-port","--inspect"]],["--loader",["--experimental-loader"]],["--print <arg>",["-pe"]],["--prof-process",["--prof-process","--"]],["--report-directory",["--report-dir"]],["--security-reverts",["--security-revert"]],["--trace-events-enabled",["--trace-event-categories","v8,node,node.async_hooks"]],["-C",["--conditions"]],["-c",["--check"]],["-e",["--eval"]],["-h",["--help"]],["-i",["--interactive"]],["-p",["--print"]],["-pe",["--print","--eval"]],["-r",["--require"]],["-v",["--version"]]],
  sources: {
    "internal/util/inspect": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  AggregateError,
  AggregateErrorPrototype,
  Array,
  ArrayBuffer,
  ArrayBufferPrototype,
  ArrayIsArray,
  ArrayPrototype,
  ArrayPrototypeFilter,
  ArrayPrototypeForEach,
  ArrayPrototypeIncludes,
  ArrayPrototypeIndexOf,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  ArrayPrototypePop,
  ArrayPrototypePush,
  ArrayPrototypePushApply,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  ArrayPrototypeSplice,
  ArrayPrototypeUnshift,
  BigIntPrototypeValueOf,
  Boolean,
  BooleanPrototype,
  BooleanPrototypeValueOf,
  DataView,
  DataViewPrototype,
  Date,
  DatePrototype,
  DatePrototypeGetTime,
  DatePrototypeToISOString,
  DatePrototypeToString,
  Error,
  ErrorPrototype,
  ErrorPrototypeToString,
  Function,
  FunctionPrototype,
  FunctionPrototypeBind,
  FunctionPrototypeCall,
  FunctionPrototypeSymbolHasInstance,
  FunctionPrototypeToString,
  JSONStringify,
  Map,
  MapPrototype,
  MapPrototypeEntries,
  MapPrototypeGetSize,
  MathFloor,
  MathMax,
  MathMin,
  MathRound,
  MathSqrt,
  MathTrunc,
  Number,
  NumberIsFinite,
  NumberIsNaN,
  NumberParseFloat,
  NumberParseInt,
  NumberPrototype,
  NumberPrototypeToString,
  NumberPrototypeValueOf,
  Object,
  ObjectAssign,
  ObjectDefineProperty,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertyNames,
  ObjectGetOwnPropertySymbols,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototype,
  ObjectPrototypeHasOwnProperty,
  ObjectPrototypePropertyIsEnumerable,
  ObjectPrototypeToString,
  ObjectSeal,
  ObjectSetPrototypeOf,
  Promise,
  PromisePrototype,
  RangeError,
  RangeErrorPrototype,
  ReflectApply,
  ReflectOwnKeys,
  RegExp,
  RegExpPrototype,
  RegExpPrototypeExec,
  RegExpPrototypeSymbolReplace,
  RegExpPrototypeSymbolSplit,
  RegExpPrototypeToString,
  SafeMap,
  SafeSet,
  SafeStringIterator,
  Set,
  SetPrototype,
  SetPrototypeGetSize,
  SetPrototypeValues,
  String,
  StringPrototype,
  StringPrototypeCharCodeAt,
  StringPrototypeCodePointAt,
  StringPrototypeEndsWith,
  StringPrototypeIncludes,
  StringPrototypeIndexOf,
  StringPrototypeLastIndexOf,
  StringPrototypeNormalize,
  StringPrototypePadEnd,
  StringPrototypePadStart,
  StringPrototypeRepeat,
  StringPrototypeReplace,
  StringPrototypeReplaceAll,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
  StringPrototypeToLowerCase,
  StringPrototypeValueOf,
  SymbolIterator,
  SymbolPrototypeToString,
  SymbolPrototypeValueOf,
  SymbolToPrimitive,
  SymbolToStringTag,
  TypeError,
  TypeErrorPrototype,
  TypedArray,
  TypedArrayPrototype,
  TypedArrayPrototypeGetLength,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint8Array,
  WeakMap,
  WeakMapPrototype,
  WeakSet,
  WeakSetPrototype,
  globalThis,
  uncurryThis,
} = primordials;

const {
  constants: {
    ALL_PROPERTIES,
    ONLY_ENUMERABLE,
    kPending,
    kRejected,
  },
  getOwnNonIndexProperties,
  getPromiseDetails,
  getProxyDetails,
  previewEntries,
  getConstructorName: internalGetConstructorName,
  getExternalValue,
} = internalBinding('util');

const {
  customInspectSymbol,
  isError,
  join,
  removeColors,
} = require('internal/util');

const {
  isStackOverflowError,
} = require('internal/errors');

const {
  isAsyncFunction,
  isGeneratorFunction,
  isAnyArrayBuffer,
  isArrayBuffer,
  isArgumentsObject,
  isBoxedPrimitive,
  isDataView,
  isExternal,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isPromise,
  isSet,
  isSetIterator,
  isWeakMap,
  isWeakSet,
  isRegExp,
  isDate,
  isTypedArray,
  isStringObject,
  isNumberObject,
  isBooleanObject,
  isBigIntObject,
} = require('internal/util/types');

const assert = require('internal/assert');

const { BuiltinModule } = require('internal/bootstrap/realm');
const {
  validateObject,
  validateString,
  kValidateObjectAllowArray,
} = require('internal/validators');

let hexSlice;
let internalUrl;

function pathToFileUrlHref(filepath) {
  internalUrl ??= require('internal/url');
  return internalUrl.pathToFileURL(filepath).href;
}

function isURL(value) {
  internalUrl ??= require('internal/url');
  return typeof value.href === 'string' && value instanceof internalUrl.URL;
}

const builtInObjects = new SafeSet(
  ArrayPrototypeFilter(
    ObjectGetOwnPropertyNames(globalThis),
    (e) => RegExpPrototypeExec(/^[A-Z][a-zA-Z0-9]+$/, e) !== null,
  ),
);

// https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot
const isUndetectableObject = (v) => typeof v === 'undefined' && v !== undefined;

// These options must stay in sync with `getUserOptions`. So if any option will
// be added or removed, `getUserOptions` must also be updated accordingly.
const inspectDefaultOptions = ObjectSeal({
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
});

const kObjectType = 0;
const kArrayType = 1;
const kArrayExtrasType = 2;

/* eslint-disable no-control-regex */
const strEscapeSequencesRegExp = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacer = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const strEscapeSequencesRegExpSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacerSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/* eslint-enable no-control-regex */

const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const numberRegExp = /^(0|[1-9][0-9]*)$/;

const coreModuleRegExp = /^ {4}at (?:[^/\\(]+ \(|)node:(.+):\d+:\d+\)?$/;

const classRegExp = /^(\s+[^(]*?)\s*{/;
// eslint-disable-next-line node-core/no-unescaped-regexp-dot
const stripCommentsRegExp = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;

const kMinLineLength = 16;

// Constants to map the iterator state.
const kWeak = 0;
const kIterator = 1;
const kMapEntries = 2;

// Escaped control characters (plus the single quote and the backslash). Use
// empty strings to fill up unused entries.
const meta = [
  '\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07', // x07
  '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',           // x0F
  '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17', // x17
  '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F', // x1F
  '', '', '', '', '', '', '', "\\'", '', '', '', '', '', '', '', '',      // x2F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x3F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x4F
  '', '', '', '', '', '', '', '', '', '', '', '', '\\\\', '', '', '',     // x5F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x6F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '\\x7F',    // x7F
  '\\x80', '\\x81', '\\x82', '\\x83', '\\x84', '\\x85', '\\x86', '\\x87', // x87
  '\\x88', '\\x89', '\\x8A', '\\x8B', '\\x8C', '\\x8D', '\\x8E', '\\x8F', // x8F
  '\\x90', '\\x91', '\\x92', '\\x93', '\\x94', '\\x95', '\\x96', '\\x97', // x97
  '\\x98', '\\x99', '\\x9A', '\\x9B', '\\x9C', '\\x9D', '\\x9E', '\\x9F', // x9F
];

// Regex used for ansi escape code splitting
// Ref: https://github.com/chalk/ansi-regex/blob/f338e1814144efb950276aac84135ff86b72dc8e/index.js
// License: MIT by Sindre Sorhus <sindresorhus@gmail.com>
// Matches all ansi escape code sequences in a string
const ansi = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?' +
  '(?:\\u0007|\\u001B\\u005C|\\u009C))' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?' +
  '[\\dA-PR-TZcf-nq-uy=><~]))', 'g',
);

let getStringWidth;

function getUserOptions(ctx, isCrossContext) {
  const ret = {
    stylize: ctx.stylize,
    showHidden: ctx.showHidden,
    depth: ctx.depth,
    colors: ctx.colors,
    customInspect: ctx.customInspect,
    showProxy: ctx.showProxy,
    maxArrayLength: ctx.maxArrayLength,
    maxStringLength: ctx.maxStringLength,
    breakLength: ctx.breakLength,
    compact: ctx.compact,
    sorted: ctx.sorted,
    getters: ctx.getters,
    numericSeparator: ctx.numericSeparator,
    ...ctx.userOptions,
  };

  // Typically, the target value will be an instance of `Object`. If that is
  // *not* the case, the object may come from another vm.Context, and we want
  // to avoid passing it objects from this Context in that case, so we remove
  // the prototype from the returned object itself + the `stylize()` function,
  // and remove all other non-primitives, including non-primitive user options.
  if (isCrossContext) {
    ObjectSetPrototypeOf(ret, null);
    for (const key of ObjectKeys(ret)) {
      if ((typeof ret[key] === 'object' || typeof ret[key] === 'function') &&
          ret[key] !== null) {
        delete ret[key];
      }
    }
    ret.stylize = ObjectSetPrototypeOf((value, flavour) => {
      let stylized;
      try {
        stylized = `${ctx.stylize(value, flavour)}`;
      } catch {
        // Continue regardless of error.
      }

      if (typeof stylized !== 'string') return value;
      // `stylized` is a string as it should be, which is safe to pass along.
      return stylized;
    }, null);
  }

  return ret;
}

/**
 * Echos the value of any input. Tries to print the value out
 * in the best way possible given the different types.
 * @param {any} value The value to print out.
 * @param {object} opts Optional options object that alters the output.
 */
/* Legacy: value, showHidden, depth, colors */
function inspect(value, opts) {
  // Default options
  const ctx = {
    budget: {},
    indentationLvl: 0,
    seen: [],
    currentDepth: 0,
    stylize: stylizeNoColor,
    showHidden: inspectDefaultOptions.showHidden,
    depth: inspectDefaultOptions.depth,
    colors: inspectDefaultOptions.colors,
    customInspect: inspectDefaultOptions.customInspect,
    showProxy: inspectDefaultOptions.showProxy,
    maxArrayLength: inspectDefaultOptions.maxArrayLength,
    maxStringLength: inspectDefaultOptions.maxStringLength,
    breakLength: inspectDefaultOptions.breakLength,
    compact: inspectDefaultOptions.compact,
    sorted: inspectDefaultOptions.sorted,
    getters: inspectDefaultOptions.getters,
    numericSeparator: inspectDefaultOptions.numericSeparator,
  };
  if (arguments.length > 1) {
    // Legacy...
    if (arguments.length > 2) {
      if (arguments[2] !== undefined) {
        ctx.depth = arguments[2];
      }
      if (arguments.length > 3 && arguments[3] !== undefined) {
        ctx.colors = arguments[3];
      }
    }
    // Set user-specified options
    if (typeof opts === 'boolean') {
      ctx.showHidden = opts;
    } else if (opts) {
      const optKeys = ObjectKeys(opts);
      for (let i = 0; i < optKeys.length; ++i) {
        const key = optKeys[i];
        // TODO(BridgeAR): Find a solution what to do about stylize. Either make
        // this function public or add a new API with a similar or better
        // functionality.
        if (
          ObjectPrototypeHasOwnProperty(inspectDefaultOptions, key) ||
          key === 'stylize') {
          ctx[key] = opts[key];
        } else if (ctx.userOptions === undefined) {
          // This is required to pass through the actual user input.
          ctx.userOptions = opts;
        }
      }
    }
  }
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
  if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
  return formatValue(ctx, value, 0);
}
inspect.custom = customInspectSymbol;

ObjectDefineProperty(inspect, 'defaultOptions', {
  __proto__: null,
  get() {
    return inspectDefaultOptions;
  },
  set(options) {
    validateObject(options, 'options');
    return ObjectAssign(inspectDefaultOptions, options);
  },
});

// Set Graphics Rendition https://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Each color consists of an array with the color code as first entry and the
// reset code as second entry.
const defaultFG = 39;
const defaultBG = 49;
inspect.colors = {
  __proto__: null,
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22], // Alias: faint
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  // Swap foreground and background colors
  inverse: [7, 27], // Alias: swapcolors, swapColors
  hidden: [8, 28], // Alias: conceal
  strikethrough: [9, 29], // Alias: strikeThrough, crossedout, crossedOut
  doubleunderline: [21, 24], // Alias: doubleUnderline
  black: [30, defaultFG],
  red: [31, defaultFG],
  green: [32, defaultFG],
  yellow: [33, defaultFG],
  blue: [34, defaultFG],
  magenta: [35, defaultFG],
  cyan: [36, defaultFG],
  white: [37, defaultFG],
  bgBlack: [40, defaultBG],
  bgRed: [41, defaultBG],
  bgGreen: [42, defaultBG],
  bgYellow: [43, defaultBG],
  bgBlue: [44, defaultBG],
  bgMagenta: [45, defaultBG],
  bgCyan: [46, defaultBG],
  bgWhite: [47, defaultBG],
  framed: [51, 54],
  overlined: [53, 55],
  gray: [90, defaultFG], // Alias: grey, blackBright
  redBright: [91, defaultFG],
  greenBright: [92, defaultFG],
  yellowBright: [93, defaultFG],
  blueBright: [94, defaultFG],
  magentaBright: [95, defaultFG],
  cyanBright: [96, defaultFG],
  whiteBright: [97, defaultFG],
  bgGray: [100, defaultBG], // Alias: bgGrey, bgBlackBright
  bgRedBright: [101, defaultBG],
  bgGreenBright: [102, defaultBG],
  bgYellowBright: [103, defaultBG],
  bgBlueBright: [104, defaultBG],
  bgMagentaBright: [105, defaultBG],
  bgCyanBright: [106, defaultBG],
  bgWhiteBright: [107, defaultBG],
};

function defineColorAlias(target, alias) {
  ObjectDefineProperty(inspect.colors, alias, {
    __proto__: null,
    get() {
      return this[target];
    },
    set(value) {
      this[target] = value;
    },
    configurable: true,
    enumerable: false,
  });
}

defineColorAlias('gray', 'grey');
defineColorAlias('gray', 'blackBright');
defineColorAlias('bgGray', 'bgGrey');
defineColorAlias('bgGray', 'bgBlackBright');
defineColorAlias('dim', 'faint');
defineColorAlias('strikethrough', 'crossedout');
defineColorAlias('strikethrough', 'strikeThrough');
defineColorAlias('strikethrough', 'crossedOut');
defineColorAlias('hidden', 'conceal');
defineColorAlias('inverse', 'swapColors');
defineColorAlias('inverse', 'swapcolors');
defineColorAlias('doubleunderline', 'doubleUnderline');

// TODO(BridgeAR): Add function style support for more complex styles.
// Don't use 'blue' not visible on cmd.exe
inspect.styles = ObjectAssign({ __proto__: null }, {
  special: 'cyan',
  number: 'yellow',
  bigint: 'yellow',
  boolean: 'yellow',
  undefined: 'grey',
  null: 'bold',
  string: 'green',
  symbol: 'green',
  date: 'magenta',
  // "name": intentionally not styling
  // TODO(BridgeAR): Highlight regular expressions properly.
  regexp: 'red',
  module: 'underline',
});

function addQuotes(str, quotes) {
  if (quotes === -1) {
    return `"${str}"`;
  }
  if (quotes === -2) {
    return `\`${str}\``;
  }
  return `'${str}'`;
}

function escapeFn(str) {
  const charCode = StringPrototypeCharCodeAt(str);
  return meta.length > charCode ? meta[charCode] : `\\u${NumberPrototypeToString(charCode, 16)}`;
}

// Escape control characters, single quotes and the backslash.
// This is similar to JSON stringify escaping.
function strEscape(str) {
  let escapeTest = strEscapeSequencesRegExp;
  let escapeReplace = strEscapeSequencesReplacer;
  let singleQuote = 39;

  // Check for double quotes. If not present, do not escape single quotes and
  // instead wrap the text in double quotes. If double quotes exist, check for
  // backticks. If they do not exist, use those as fallback instead of the
  // double quotes.
  if (StringPrototypeIncludes(str, "'")) {
    // This invalidates the charCode and therefore can not be matched for
    // anymore.
    if (!StringPrototypeIncludes(str, '"')) {
      singleQuote = -1;
    } else if (!StringPrototypeIncludes(str, '`') &&
               !StringPrototypeIncludes(str, '${')) {
      singleQuote = -2;
    }
    if (singleQuote !== 39) {
      escapeTest = strEscapeSequencesRegExpSingle;
      escapeReplace = strEscapeSequencesReplacerSingle;
    }
  }

  // Some magic numbers that worked out fine while benchmarking with v8 6.0
  if (str.length < 5000 && RegExpPrototypeExec(escapeTest, str) === null)
    return addQuotes(str, singleQuote);
  if (str.length > 100) {
    str = RegExpPrototypeSymbolReplace(escapeReplace, str, escapeFn);
    return addQuotes(str, singleQuote);
  }

  let result = '';
  let last = 0;
  for (let i = 0; i < str.length; i++) {
    const point = StringPrototypeCharCodeAt(str, i);
    if (point === singleQuote ||
        point === 92 ||
        point < 32 ||
        (point > 126 && point < 160)) {
      if (last === i) {
        result += meta[point];
      } else {
        result += `${StringPrototypeSlice(str, last, i)}${meta[point]}`;
      }
      last = i + 1;
    } else if (point >= 0xd800 && point <= 0xdfff) {
      if (point <= 0xdbff && i + 1 < str.length) {
        const point = StringPrototypeCharCodeAt(str, i + 1);
        if (point >= 0xdc00 && point <= 0xdfff) {
          i++;
          continue;
        }
      }
      result += `${StringPrototypeSlice(str, last, i)}\\u${NumberPrototypeToString(point, 16)}`;
      last = i + 1;
    }
  }

  if (last !== str.length) {
    result += StringPrototypeSlice(str, last);
  }
  return addQuotes(result, singleQuote);
}

function stylizeWithColor(str, styleType) {
  const style = inspect.styles[styleType];
  if (style !== undefined) {
    const color = inspect.colors[style];
    if (color !== undefined)
      return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
  }
  return str;
}

function stylizeNoColor(str) {
  return str;
}

// Return a new empty array to push in the results of the default formatter.
function getEmptyFormatArray() {
  return [];
}

function isInstanceof(object, proto) {
  try {
    return object instanceof proto;
  } catch {
    return false;
  }
}

// Special-case for some builtin prototypes in case their `constructor` property has been tampered.
const wellKnownPrototypes = new SafeMap()
  .set(ArrayPrototype, { name: 'Array', constructor: Array })
  .set(ArrayBufferPrototype, { name: 'ArrayBuffer', constructor: ArrayBuffer })
  .set(FunctionPrototype, { name: 'Function', constructor: Function })
  .set(MapPrototype, { name: 'Map', constructor: Map })
  .set(SetPrototype, { name: 'Set', constructor: Set })
  .set(ObjectPrototype, { name: 'Object', constructor: Object })
  .set(TypedArrayPrototype, { name: 'TypedArray', constructor: TypedArray })
  .set(RegExpPrototype, { name: 'RegExp', constructor: RegExp })
  .set(DatePrototype, { name: 'Date', constructor: Date })
  .set(DataViewPrototype, { name: 'DataView', constructor: DataView })

  .set(ErrorPrototype, { name: 'Error', constructor: Error })
  .set(AggregateErrorPrototype, { name: 'AggregateError', constructor: AggregateError })
  .set(RangeErrorPrototype, { name: 'RangeError', constructor: RangeError })
  .set(TypeErrorPrototype, { name: 'TypeError', constructor: TypeError })

  .set(BooleanPrototype, { name: 'Boolean', constructor: Boolean })
  .set(NumberPrototype, { name: 'Number', constructor: Number })
  .set(StringPrototype, { name: 'String', constructor: String })
  .set(PromisePrototype, { name: 'Promise', constructor: Promise })
  .set(WeakMapPrototype, { name: 'WeakMap', constructor: WeakMap })
  .set(WeakSetPrototype, { name: 'WeakSet', constructor: WeakSet });

function getConstructorName(obj, ctx, recurseTimes, protoProps) {
  let firstProto;
  const tmp = obj;
  while (obj || isUndetectableObject(obj)) {
    const wellKnownPrototypeNameAndConstructor = wellKnownPrototypes.get(obj);
    if (wellKnownPrototypeNameAndConstructor !== undefined) {
      const { name, constructor } = wellKnownPrototypeNameAndConstructor;
      if (FunctionPrototypeSymbolHasInstance(constructor, tmp)) {
        if (protoProps !== undefined && firstProto !== obj) {
          addPrototypeProperties(
            ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
        }
        return name;
      }
    }
    const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
    if (descriptor !== undefined &&
        typeof descriptor.value === 'function' &&
        descriptor.value.name !== '' &&
        isInstanceof(tmp, descriptor.value)) {
      if (protoProps !== undefined &&
         (firstProto !== obj ||
         !builtInObjects.has(descriptor.value.name))) {
        addPrototypeProperties(
          ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
      }
      return String(descriptor.value.name);
    }

    obj = ObjectGetPrototypeOf(obj);
    if (firstProto === undefined) {
      firstProto = obj;
    }
  }

  if (firstProto === null) {
    return null;
  }

  const res = internalGetConstructorName(tmp);

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    return `${res} <Complex prototype>`;
  }

  const protoConstr = getConstructorName(
    firstProto, ctx, recurseTimes + 1, protoProps);

  if (protoConstr === null) {
    return `${res} <${inspect(firstProto, {
      ...ctx,
      customInspect: false,
      depth: -1,
    })}>`;
  }

  return `${res} <${protoConstr}>`;
}

// This function has the side effect of adding prototype properties to the
// `output` argument (which is an array). This is intended to highlight user
// defined prototype properties.
function addPrototypeProperties(ctx, main, obj, recurseTimes, output) {
  let depth = 0;
  let keys;
  let keySet;
  do {
    if (depth !== 0 || main === obj) {
      obj = ObjectGetPrototypeOf(obj);
      // Stop as soon as a null prototype is encountered.
      if (obj === null) {
        return;
      }
      // Stop as soon as a built-in object type is detected.
      const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
      if (descriptor !== undefined &&
          typeof descriptor.value === 'function' &&
          builtInObjects.has(descriptor.value.name)) {
        return;
      }
    }

    if (depth === 0) {
      keySet = new SafeSet();
    } else {
      ArrayPrototypeForEach(keys, (key) => keySet.add(key));
    }
    // Get all own property names and symbols.
    keys = ReflectOwnKeys(obj);
    ArrayPrototypePush(ctx.seen, main);
    for (const key of keys) {
      // Ignore the `constructor` property and keys that exist on layers above.
      if (key === 'constructor' ||
          ObjectPrototypeHasOwnProperty(main, key) ||
          (depth !== 0 && keySet.has(key))) {
        continue;
      }
      const desc = ObjectGetOwnPropertyDescriptor(obj, key);
      if (typeof desc.value === 'function') {
        continue;
      }
      const value = formatProperty(
        ctx, obj, recurseTimes, key, kObjectType, desc, main);
      if (ctx.colors) {
        // Faint!
        ArrayPrototypePush(output, `\u001b[2m${value}\u001b[22m`);
      } else {
        ArrayPrototypePush(output, value);
      }
    }
    ArrayPrototypePop(ctx.seen);
  // Limit the inspection to up to three prototype layers. Using `recurseTimes`
  // is not a good choice here, because it's as if the properties are declared
  // on the current object from the users perspective.
  } while (++depth !== 3);
}

/** @type {(constructor: string, tag: string, fallback: string, size?: string) => string} */
function getPrefix(constructor, tag, fallback, size = '') {
  if (constructor === null) {
    if (tag !== '' && fallback !== tag) {
      return `[${fallback}${size}: null prototype] [${tag}] `;
    }
    return `[${fallback}${size}: null prototype] `;
  }

  let result = `${constructor}${size} `;
  if (tag !== '') {
    const position = constructor.indexOf(tag);
    if (position === -1) {
      result += `[${tag}] `;
    } else {
      const endPos = position + tag.length;
      if (endPos !== constructor.length &&
        constructor[endPos] === constructor[endPos].toLowerCase()) {
        result += `[${tag}] `;
      }
    }
  }
  return result;
}

// Look up the keys of the object.
function getKeys(value, showHidden) {
  let keys;
  const symbols = ObjectGetOwnPropertySymbols(value);
  if (showHidden) {
    keys = ObjectGetOwnPropertyNames(value);
    if (symbols.length !== 0)
      ArrayPrototypePushApply(keys, symbols);
  } else {
    // This might throw if `value` is a Module Namespace Object from an
    // unevaluated module, but we don't want to perform the actual type
    // check because it's expensive.
    // TODO(devsnek): track https://github.com/tc39/ecma262/issues/1209
    // and modify this logic as needed.
    try {
      keys = ObjectKeys(value);
    } catch (err) {
      assert(isNativeError(err) && err.name === 'ReferenceError' &&
             isModuleNamespaceObject(value));
      keys = ObjectGetOwnPropertyNames(value);
    }
    if (symbols.length !== 0) {
      const filter = (key) => ObjectPrototypePropertyIsEnumerable(value, key);
      ArrayPrototypePushApply(keys, ArrayPrototypeFilter(symbols, filter));
    }
  }
  return keys;
}

function getCtxStyle(value, constructor, tag) {
  let fallback = '';
  if (constructor === null) {
    fallback = internalGetConstructorName(value);
    if (fallback === tag) {
      fallback = 'Object';
    }
  }
  return getPrefix(constructor, tag, fallback);
}

function formatProxy(ctx, proxy, recurseTimes) {
  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    return ctx.stylize('Proxy [Array]', 'special');
  }
  recurseTimes += 1;
  ctx.indentationLvl += 2;
  const res = [
    formatValue(ctx, proxy[0], recurseTimes),
    formatValue(ctx, proxy[1], recurseTimes),
  ];
  ctx.indentationLvl -= 2;
  return reduceToSingleString(
    ctx, res, '', ['Proxy [', ']'], kArrayExtrasType, recurseTimes);
}

// Note: using `formatValue` directly requires the indentation level to be
// corrected by setting `ctx.indentationLvL += diff` and then to decrease the
// value afterwards again.
function formatValue(ctx, value, recurseTimes, typedArray) {
  // Primitive types cannot have properties.
  if (typeof value !== 'object' &&
      typeof value !== 'function' &&
      !isUndetectableObject(value)) {
    return formatPrimitive(ctx.stylize, value, ctx);
  }
  if (value === null) {
    return ctx.stylize('null', 'null');
  }

  // Memorize the context for custom inspection on proxies.
  const context = value;
  // Always check for proxies to prevent side effects and to prevent triggering
  // any proxy handlers.
  const proxy = getProxyDetails(value, !!ctx.showProxy);
  if (proxy !== undefined) {
    if (proxy === null || proxy[0] === null) {
      return ctx.stylize('<Revoked Proxy>', 'special');
    }
    if (ctx.showProxy) {
      return formatProxy(ctx, proxy, recurseTimes);
    }
    value = proxy;
  }

  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it.
  if (ctx.customInspect) {
    const maybeCustom = value[customInspectSymbol];
    if (typeof maybeCustom === 'function' &&
        // Filter out the util module, its inspect function is special.
        maybeCustom !== inspect &&
        // Also filter out any prototype objects using the circular check.
        ObjectGetOwnPropertyDescriptor(value, 'constructor')?.value?.prototype !== value) {
      // This makes sure the recurseTimes are reported as before while using
      // a counter internally.
      const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
      const isCrossContext =
        proxy !== undefined || !FunctionPrototypeSymbolHasInstance(Object, context);
      const ret = FunctionPrototypeCall(
        maybeCustom,
        context,
        depth,
        getUserOptions(ctx, isCrossContext),
        inspect,
      );
      // If the custom inspection method returned `this`, don't go into
      // infinite recursion.
      if (ret !== context) {
        if (typeof ret !== 'string') {
          return formatValue(ctx, ret, recurseTimes);
        }
        return StringPrototypeReplaceAll(ret, '\n', `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`);
      }
    }
  }

  // Using an array here is actually better for the average case than using
  // a Set. `seen` will only check for the depth and will never grow too large.
  if (ctx.seen.includes(value)) {
    let index = 1;
    if (ctx.circular === undefined) {
      ctx.circular = new SafeMap();
      ctx.circular.set(value, index);
    } else {
      index = ctx.circular.get(value);
      if (index === undefined) {
        index = ctx.circular.size + 1;
        ctx.circular.set(value, index);
      }
    }
    return ctx.stylize(`[Circular *${index}]`, 'special');
  }

  return formatRaw(ctx, value, recurseTimes, typedArray);
}

function formatRaw(ctx, value, recurseTimes, typedArray) {
  let keys;
  let protoProps;
  if (ctx.showHidden && (recurseTimes <= ctx.depth || ctx.depth === null)) {
    protoProps = [];
  }

  const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
  // Reset the variable to check for this later on.
  if (protoProps !== undefined && protoProps.length === 0) {
    protoProps = undefined;
  }

  let tag = value[SymbolToStringTag];
  // Only list the tag in case it's non-enumerable / not an own property.
  // Otherwise we'd print this twice.
  if (typeof tag !== 'string' ||
      (tag !== '' &&
      (ctx.showHidden ?
        ObjectPrototypeHasOwnProperty :
        ObjectPrototypePropertyIsEnumerable)(
        value, SymbolToStringTag,
      ))) {
    tag = '';
  }
  let base = '';
  let formatter = getEmptyFormatArray;
  let braces;
  let noIterator = true;
  let i = 0;
  const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;

  let extrasType = kObjectType;
  let extraKeys;

  // Iterators and the rest are split to reduce checks.
  // We have to check all values in case the constructor is set to null.
  // Otherwise it would not possible to identify all types properly.
  if (SymbolIterator in value || constructor === null) {
    noIterator = false;
    if (ArrayIsArray(value)) {
      // Only set the constructor for non ordinary ("Array [...]") arrays.
      const prefix = (constructor !== 'Array' || tag !== '') ?
        getPrefix(constructor, tag, 'Array', `(${value.length})`) :
        '';
      keys = getOwnNonIndexProperties(value, filter);
      braces = [`${prefix}[`, ']'];
      if (value.length === 0 && keys.length === 0 && protoProps === undefined)
        return `${braces[0]}]`;
      extrasType = kArrayExtrasType;
      formatter = formatArray;
    } else if (isSet(value)) {
      const size = SetPrototypeGetSize(value);
      const prefix = getPrefix(constructor, tag, 'Set', `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = constructor !== null ?
        FunctionPrototypeBind(formatSet, null, value) :
        FunctionPrototypeBind(formatSet, null, SetPrototypeValues(value));
      if (size === 0 && keys.length === 0 && protoProps === undefined)
        return `${prefix}{}`;
      braces = [`${prefix}{`, '}'];
    } else if (isMap(value)) {
      const size = MapPrototypeGetSize(value);
      const prefix = getPrefix(constructor, tag, 'Map', `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = constructor !== null ?
        FunctionPrototypeBind(formatMap, null, value) :
        FunctionPrototypeBind(formatMap, null, MapPrototypeEntries(value));
      if (size === 0 && keys.length === 0 && protoProps === undefined)
        return `${prefix}{}`;
      braces = [`${prefix}{`, '}'];
    } else if (isTypedArray(value)) {
      keys = getOwnNonIndexProperties(value, filter);
      let bound = value;
      let fallback = '';
      if (constructor === null) {
        fallback = TypedArrayPrototypeGetSymbolToStringTag(value);
        // Reconstruct the array information.
        bound = new primordials[fallback](value);
      }
      const size = TypedArrayPrototypeGetLength(value);
      const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
      braces = [`${prefix}[`, ']'];
      if (value.length === 0 && keys.length === 0 && !ctx.showHidden)
        return `${braces[0]}]`;
      // Special handle the value. The original value is required below. The
      // bound function is required to reconstruct missing information.
      formatter = FunctionPrototypeBind(formatTypedArray, null, bound, size);
      extrasType = kArrayExtrasType;

      if (ctx.showHidden) {
        extraKeys = ['BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer'];
        typedArray = true;
      }
    } else if (isMapIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces('Map', tag);
      // Add braces to the formatter parameters.
      formatter = FunctionPrototypeBind(formatIterator, null, braces);
    } else if (isSetIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces('Set', tag);
      // Add braces to the formatter parameters.
      formatter = FunctionPrototypeBind(formatIterator, null, braces);
    } else {
      noIterator = true;
    }
  }
  if (noIterator) {
    keys = getKeys(value, ctx.showHidden);
    braces = ['{', '}'];
    if (typeof value === 'function') {
      base = getFunctionBase(ctx, value, constructor, tag);
      if (keys.length === 0 && protoProps === undefined)
        return ctx.stylize(base, 'special');
    } else if (constructor === 'Object') {
      if (isArgumentsObject(value)) {
        braces[0] = '[Arguments] {';
      } else if (tag !== '') {
        braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
      }
      if (keys.length === 0 && protoProps === undefined) {
        return `${braces[0]}}`;
      }
    } else if (isRegExp(value)) {
      // Make RegExps say that they are RegExps
      base = RegExpPrototypeToString(
        constructor !== null ? value : new RegExp(value),
      );
      const prefix = getPrefix(constructor, tag, 'RegExp');
      if (prefix !== 'RegExp ')
        base = `${prefix}${base}`;
      if ((keys.length === 0 && protoProps === undefined) ||
          (recurseTimes > ctx.depth && ctx.depth !== null)) {
        return ctx.stylize(base, 'regexp');
      }
    } else if (isDate(value)) {
      // Make dates with properties first say the date
      base = NumberIsNaN(DatePrototypeGetTime(value)) ?
        DatePrototypeToString(value) :
        DatePrototypeToISOString(value);
      const prefix = getPrefix(constructor, tag, 'Date');
      if (prefix !== 'Date ')
        base = `${prefix}${base}`;
      if (keys.length === 0 && protoProps === undefined) {
        return ctx.stylize(base, 'date');
      }
    } else if (isError(value)) {
      base = formatError(value, constructor, tag, ctx, keys);
      if (keys.length === 0 && protoProps === undefined)
        return base;
    } else if (isAnyArrayBuffer(value)) {
      // Fast path for ArrayBuffer and SharedArrayBuffer.
      // Can't do the same for DataView because it has a non-primitive
      // .buffer property that we need to recurse for.
      const arrayType = isArrayBuffer(value) ? 'ArrayBuffer' :
        'SharedArrayBuffer';
      const prefix = getPrefix(constructor, tag, arrayType);
      if (typedArray === undefined) {
        formatter = formatArrayBuffer;
      } else if (keys.length === 0 && protoProps === undefined) {
        return prefix +
              `{ [byteLength]: ${formatNumber(ctx.stylize, value.byteLength, false)} }`;
      }
      braces[0] = `${prefix}{`;
      extraKeys = ['byteLength'];
    } else if (isDataView(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'DataView')}{`;
      // .buffer goes last, it's not a primitive like the others.
      extraKeys = ['byteLength', 'byteOffset', 'buffer'];
    } else if (isPromise(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'Promise')}{`;
      formatter = formatPromise;
    } else if (isWeakSet(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'WeakSet')}{`;
      formatter = ctx.showHidden ? formatWeakSet : formatWeakCollection;
    } else if (isWeakMap(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'WeakMap')}{`;
      formatter = ctx.showHidden ? formatWeakMap : formatWeakCollection;
    } else if (isModuleNamespaceObject(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'Module')}{`;
      // Special handle keys for namespace objects.
      formatter = formatNamespaceObject.bind(null, keys);
    } else if (isBoxedPrimitive(value)) {
      base = getBoxedBase(value, ctx, keys, constructor, tag);
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else if (isURL(value) && !(recurseTimes > ctx.depth && ctx.depth !== null)) {
      base = value.href;
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else {
      if (keys.length === 0 && protoProps === undefined) {
        if (isExternal(value)) {
          const address = getExternalValue(value).toString(16);
          return ctx.stylize(`[External: ${address}]`, 'special');
        }
        return `${getCtxStyle(value, constructor, tag)}{}`;
      }
      braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
    }
  }

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    let constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
    if (constructor !== null)
      constructorName = `[${constructorName}]`;
    return ctx.stylize(constructorName, 'special');
  }
  recurseTimes += 1;

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output;
  const indentationLvl = ctx.indentationLvl;
  try {
    output = formatter(ctx, value, recurseTimes);
    if (extraKeys !== undefined) {
      for (i = 0; i < extraKeys.length; i++) {
        let formatted;
        try {
          formatted = formatExtraProperties(ctx, value, recurseTimes, extraKeys[i], typedArray);
        } catch {
          const tempValue = { [extraKeys[i]]: value.buffer[extraKeys[i]] };
          formatted = formatExtraProperties(ctx, tempValue, recurseTimes, extraKeys[i], typedArray);
        }
        ArrayPrototypePush(output, formatted);
      }
    }
    for (i = 0; i < keys.length; i++) {
      ArrayPrototypePush(
        output,
        formatProperty(ctx, value, recurseTimes, keys[i], extrasType),
      );
    }
    if (protoProps !== undefined) {
      ArrayPrototypePushApply(output, protoProps);
    }
  } catch (err) {
    if (!isStackOverflowError(err)) throw err;
    const constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
    return handleMaxCallStackSize(ctx, err, constructorName, indentationLvl);
  }
  if (ctx.circular !== undefined) {
    const index = ctx.circular.get(value);
    if (index !== undefined) {
      const reference = ctx.stylize(`<ref *${index}>`, 'special');
      // Add reference always to the very beginning of the output.
      if (ctx.compact !== true) {
        base = base === '' ? reference : `${reference} ${base}`;
      } else {
        braces[0] = `${reference} ${braces[0]}`;
      }
    }
  }
  ctx.seen.pop();

  if (ctx.sorted) {
    const comparator = ctx.sorted === true ? undefined : ctx.sorted;
    if (extrasType === kObjectType) {
      ArrayPrototypeSort(output, comparator);
    } else if (keys.length > 1) {
      const sorted = ArrayPrototypeSort(ArrayPrototypeSlice(output, output.length - keys.length), comparator);
      ArrayPrototypeUnshift(sorted, output, output.length - keys.length, keys.length);
      ReflectApply(ArrayPrototypeSplice, null, sorted);
    }
  }

  const res = reduceToSingleString(
    ctx, output, base, braces, extrasType, recurseTimes, value);
  const budget = ctx.budget[ctx.indentationLvl] || 0;
  const newLength = budget + res.length;
  ctx.budget[ctx.indentationLvl] = newLength;
  // If any indentationLvl exceeds this limit, limit further inspecting to the
  // minimum. Otherwise the recursive algorithm might continue inspecting the
  // object even though the maximum string size (~2 ** 28 on 32 bit systems and
  // ~2 ** 30 on 64 bit systems) exceeded. The actual output is not limited at
  // exactly 2 ** 27 but a bit higher. This depends on the object shape.
  // This limit also makes sure that huge objects don't block the event loop
  // significantly.
  if (newLength > 2 ** 27) {
    ctx.depth = -1;
  }
  return res;
}

function getIteratorBraces(type, tag) {
  if (tag !== `${type} Iterator`) {
    if (tag !== '')
      tag += '] [';
    tag += `${type} Iterator`;
  }
  return [`[${tag}] {`, '}'];
}

function getBoxedBase(value, ctx, keys, constructor, tag) {
  let fn;
  let type;
  if (isNumberObject(value)) {
    fn = NumberPrototypeValueOf;
    type = 'Number';
  } else if (isStringObject(value)) {
    fn = StringPrototypeValueOf;
    type = 'String';
    // For boxed Strings, we have to remove the 0-n indexed entries,
    // since they just noisy up the output and are redundant
    // Make boxed primitive Strings look like such
    keys.splice(0, value.length);
  } else if (isBooleanObject(value)) {
    fn = BooleanPrototypeValueOf;
    type = 'Boolean';
  } else if (isBigIntObject(value)) {
    fn = BigIntPrototypeValueOf;
    type = 'BigInt';
  } else {
    fn = SymbolPrototypeValueOf;
    type = 'Symbol';
  }
  let base = `[${type}`;
  if (type !== constructor) {
    if (constructor === null) {
      base += ' (null prototype)';
    } else {
      base += ` (${constructor})`;
    }
  }
  base += `: ${formatPrimitive(stylizeNoColor, fn(value), ctx)}]`;
  if (tag !== '' && tag !== constructor) {
    base += ` [${tag}]`;
  }
  if (keys.length !== 0 || ctx.stylize === stylizeNoColor)
    return base;
  return ctx.stylize(base, StringPrototypeToLowerCase(type));
}

function getClassBase(value, constructor, tag) {
  const hasName = ObjectPrototypeHasOwnProperty(value, 'name');
  const name = (hasName && value.name) || '(anonymous)';
  let base = `class ${name}`;
  if (constructor !== 'Function' && constructor !== null) {
    base += ` [${constructor}]`;
  }
  if (tag !== '' && constructor !== tag) {
    base += ` [${tag}]`;
  }
  if (constructor !== null) {
    const superName = ObjectGetPrototypeOf(value).name;
    if (superName) {
      base += ` extends ${superName}`;
    }
  } else {
    base += ' extends [null prototype]';
  }
  return `[${base}]`;
}

function getFunctionBase(ctx, value, constructor, tag) {
  const stringified = FunctionPrototypeToString(value);
  if (StringPrototypeStartsWith(stringified, 'class') && stringified[stringified.length - 1] === '}') {
    const slice = StringPrototypeSlice(stringified, 5, -1);
    const bracketIndex = StringPrototypeIndexOf(slice, '{');
    if (bracketIndex !== -1 &&
        (!StringPrototypeIncludes(StringPrototypeSlice(slice, 0, bracketIndex), '(') ||
        // Slow path to guarantee that it's indeed a class.
        RegExpPrototypeExec(classRegExp, RegExpPrototypeSymbolReplace(stripCommentsRegExp, slice)) !== null)
    ) {
      return getClassBase(value, constructor, tag);
    }
  }
  let type = 'Function';
  if (isGeneratorFunction(value)) {
    type = `Generator${type}`;
  }
  if (isAsyncFunction(value)) {
    type = `Async${type}`;
  }
  let base = `[${type}`;
  if (constructor === null) {
    base += ' (null prototype)';
  }
  if (value.name === '') {
    base += ' (anonymous)';
  } else {
    base += `: ${typeof value.name === 'string' ? value.name : formatValue(ctx, value.name)}`;
  }
  base += ']';
  if (constructor !== type && constructor !== null) {
    base += ` ${constructor}`;
  }
  if (tag !== '' && constructor !== tag) {
    base += ` [${tag}]`;
  }
  return base;
}

function identicalSequenceRange(a, b) {
  for (let i = 0; i < a.length - 3; i++) {
    // Find the first entry of b that matches the current entry of a.
    const pos = ArrayPrototypeIndexOf(b, a[i]);
    if (pos !== -1) {
      const rest = b.length - pos;
      if (rest > 3) {
        let len = 1;
        const maxLen = MathMin(a.length - i, rest);
        // Count the number of consecutive entries.
        while (maxLen > len && a[i + len] === b[pos + len]) {
          len++;
        }
        if (len > 3) {
          return [len, i];
        }
      }
    }
  }

  return [0, 0];
}

function getDuplicateErrorFrameRanges(frames) {
  // Build a map: frame line -> sorted list of indices where it occurs
  const result = [];
  const lineToPositions = new SafeMap();

  for (let i = 0; i < frames.length; i++) {
    const positions = lineToPositions.get(frames[i]);
    if (positions === undefined) {
      lineToPositions.set(frames[i], [i]);
    } else {
      positions[positions.length] = i;
    }
  }

  const minimumDuplicateRange = 3;
  // Not enough duplicate lines to consider collapsing
  if (frames.length - lineToPositions.size <= minimumDuplicateRange) {
    return result;
  }

  for (let i = 0; i < frames.length - minimumDuplicateRange; i++) {
    const positions = lineToPositions.get(frames[i]);
    // Find the next occurrence of the same line after i, if any
    if (positions.length === 1 || positions[positions.length - 1] === i) {
      continue;
    }

    const current = positions.indexOf(i) + 1;
    if (current === positions.length) {
      continue;
    }

    // Theoretical maximum range, adjusted while iterating
    let range = positions[positions.length - 1] - i;
    if (range < minimumDuplicateRange) {
      continue;
    }
    let extraSteps;
    if (current + 1 < positions.length) {
      // Optimize initial step size by choosing the greatest common divisor (GCD)
      // of all candidate distances to the same frame line. This tends to match
      // the true repeating block size and minimizes fallback iterations.
      let gcdRange = 0;
      for (let j = current; j < positions.length; j++) {
        let distance = positions[j] - i;
        while (distance !== 0) {
          const remainder = gcdRange % distance;
          if (gcdRange !== 0) {
            // Add other possible ranges as fallback
            extraSteps ??= new SafeSet();
            extraSteps.add(gcdRange);
          }
          gcdRange = distance;
          distance = remainder;
        }
        if (gcdRange === 1) break;
      }
      range = gcdRange;
      if (extraSteps) {
        extraSteps.delete(range);
        extraSteps = [...extraSteps];
      }
    }
    let maxRange = range;
    let maxDuplicates = 0;

    let duplicateRanges = 0;

    for (let nextStart = i + range; /* ignored */ ; nextStart += range) {
      let equalFrames = 0;
      for (let j = 0; j < range; j++) {
        if (frames[i + j] !== frames[nextStart + j]) {
          break;
        }
        equalFrames++;
      }
      // Adjust the range to match different type of ranges.
      if (equalFrames !== range) {
        if (!extraSteps?.length) {
          break;
        }
        // Memorize former range in case the smaller one would hide less.
        if (duplicateRanges !== 0 && maxRange * maxDuplicates < range * duplicateRanges) {
          maxRange = range;
          maxDuplicates = duplicateRanges;
        }
        range = extraSteps.pop();
        nextStart = i;
        duplicateRanges = 0;
        continue;
      }
      duplicateRanges++;
    }

    if (maxDuplicates !== 0 && maxRange * maxDuplicates >= range * duplicateRanges) {
      range = maxRange;
      duplicateRanges = maxDuplicates;
    }

    if (duplicateRanges * range >= 3) {
      result.push(i + range, range, duplicateRanges);
      // Skip over the collapsed portion to avoid overlapping matches.
      i += range * (duplicateRanges + 1) - 1;
    }
  }

  return result;
}

function getStackString(ctx, error) {
  let stack;
  try {
    stack = error.stack;
  } catch {
    // If stack is getter that throws, we ignore the error.
  }
  if (stack) {
    if (typeof stack === 'string') {
      return stack;
    }
    ctx.seen.push(error);
    ctx.indentationLvl += 4;
    const result = formatValue(ctx, stack);
    ctx.indentationLvl -= 4;
    ctx.seen.pop();
    return `${ErrorPrototypeToString(error)}\n    ${result}`;
  }
  return ErrorPrototypeToString(error);
}

function getStackFrames(ctx, err, stack) {
  const frames = StringPrototypeSplit(stack, '\n');

  let cause;
  try {
    ({ cause } = err);
  } catch {
    // If 'cause' is a getter that throws, ignore it.
  }

  // Remove stack frames identical to frames in cause.
  if (cause != null && isError(cause)) {
    const causeStack = getStackString(ctx, cause);
    const causeStackStart = StringPrototypeIndexOf(causeStack, '\n    at');
    if (causeStackStart !== -1) {
      const causeFrames = StringPrototypeSplit(StringPrototypeSlice(causeStack, causeStackStart + 1), '\n');
      const { 0: len, 1: offset } = identicalSequenceRange(frames, causeFrames);
      if (len > 0) {
        const skipped = len - 2;
        const msg = `    ... ${skipped} lines matching cause stack trace ...`;
        frames.splice(offset + 1, skipped, ctx.stylize(msg, 'undefined'));
      }
    }
  }

  // Remove recursive repetitive stack frames in long stacks
  if (frames.length > 10) {
    const ranges = getDuplicateErrorFrameRanges(frames);

    for (let i = ranges.length - 3; i >= 0; i -= 3) {
      const offset = ranges[i];
      const length = ranges[i + 1];
      const duplicateRanges = ranges[i + 2];

      const msg = `    ... collapsed ${length * duplicateRanges} duplicate lines ` +
        'matching above ' +
        (duplicateRanges > 1 ?
          `${length} lines ${duplicateRanges} times...` :
          'lines ...');
      frames.splice(offset, length * duplicateRanges, ctx.stylize(msg, 'undefined'));
    }
  }

  return frames;
}

/** @type {(stack: string, constructor: string | null, name: unknown, tag: string) => string} */
function improveStack(stack, constructor, name, tag) {
  // A stack trace may contain arbitrary data. Only manipulate the output
  // for "regular errors" (errors that "look normal") for now.
  let len = name.length;

  if (typeof name !== 'string') {
    stack = StringPrototypeReplace(
      stack,
      `${name}`,
      `${name} [${StringPrototypeSlice(getPrefix(constructor, tag, 'Error'), 0, -1)}]`,
    );
  }

  if (constructor === null ||
      (StringPrototypeEndsWith(name, 'Error') &&
      StringPrototypeStartsWith(stack, name) &&
      (stack.length === len || stack[len] === ':' || stack[len] === '\n'))) {
    let fallback = 'Error';
    if (constructor === null) {
      const start = RegExpPrototypeExec(/^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/, stack) ||
      RegExpPrototypeExec(/^([a-z_A-Z0-9-]*Error)$/, stack);
      fallback = (start?.[1]) || '';
      len = fallback.length;
      fallback ||= 'Error';
    }
    const prefix = StringPrototypeSlice(getPrefix(constructor, tag, fallback), 0, -1);
    if (name !== prefix) {
      if (StringPrototypeIncludes(prefix, name)) {
        if (len === 0) {
          stack = `${prefix}: ${stack}`;
        } else {
          stack = `${prefix}${StringPrototypeSlice(stack, len)}`;
        }
      } else {
        stack = `${prefix} [${name}]${StringPrototypeSlice(stack, len)}`;
      }
    }
  }
  return stack;
}

function markNodeModules(ctx, line) {
  let tempLine = '';
  let lastPos = 0;
  let searchFrom = 0;

  while (true) {
    const nodeModulePosition = StringPrototypeIndexOf(line, 'node_modules', searchFrom);
    if (nodeModulePosition === -1) {
      break;
    }

    // Ensure it's a path segment: must have a path separator before and after
    const separator = line[nodeModulePosition - 1];
    const after = line[nodeModulePosition + 12]; // 'node_modules'.length === 12

    if ((after !== '/' && after !== '\\') || (separator !== '/' && separator !== '\\')) {
      // Not a proper segment; continue searching
      searchFrom = nodeModulePosition + 1;
      continue;
    }

    const moduleStart = nodeModulePosition + 13; // Include trailing separator

    // Append up to and including '/node_modules/'
    tempLine += StringPrototypeSlice(line, lastPos, moduleStart);

    let moduleEnd = StringPrototypeIndexOf(line, separator, moduleStart);
    if (line[moduleStart] === '@') {
      // Namespaced modules have an extra slash: @namespace/package
      moduleEnd = StringPrototypeIndexOf(line, separator, moduleEnd + 1);
    }

    const nodeModule = StringPrototypeSlice(line, moduleStart, moduleEnd);
    tempLine += ctx.stylize(nodeModule, 'module');

    lastPos = moduleEnd;
    searchFrom = moduleEnd;
  }

  if (lastPos !== 0) {
    line = tempLine + StringPrototypeSlice(line, lastPos);
  }
  return line;
}

function markCwd(ctx, line, workingDirectory) {
  let cwdStartPos = StringPrototypeIndexOf(line, workingDirectory);
  let tempLine = '';
  let cwdLength = workingDirectory.length;
  if (cwdStartPos !== -1) {
    if (StringPrototypeSlice(line, cwdStartPos - 7, cwdStartPos) === 'file://') {
      cwdLength += 7;
      cwdStartPos -= 7;
    }
    const start = line[cwdStartPos - 1] === '(' ? cwdStartPos - 1 : cwdStartPos;
    const end = start !== cwdStartPos && StringPrototypeEndsWith(line, ')') ? -1 : line.length;
    const workingDirectoryEndPos = cwdStartPos + cwdLength + 1;
    const cwdSlice = StringPrototypeSlice(line, start, workingDirectoryEndPos);

    tempLine += StringPrototypeSlice(line, 0, start);
    tempLine += ctx.stylize(cwdSlice, 'undefined');
    tempLine += StringPrototypeSlice(line, workingDirectoryEndPos, end);
    if (end === -1) {
      tempLine += ctx.stylize(')', 'undefined');
    }
  } else {
    tempLine += line;
  }
  return tempLine;
}

function safeGetCWD() {
  let workingDirectory;
  try {
    workingDirectory = process.cwd();
  } catch {
    return;
  }
  return workingDirectory;
}

function formatError(err, constructor, tag, ctx, keys) {
  let message, name, stack;
  try {
    stack = getStackString(ctx, err);
  } catch {
    return ObjectPrototypeToString(err);
  }

  let messageIsGetterThatThrows = false;
  try {
    message = err.message;
  } catch {
    messageIsGetterThatThrows = true;
  }
  let nameIsGetterThatThrows = false;
  try {
    name = err.name;
  } catch {
    nameIsGetterThatThrows = true;
  }

  if (!ctx.showHidden && keys.length !== 0) {
    const index = ArrayPrototypeIndexOf(keys, 'stack');
    if (index !== -1) {
      ArrayPrototypeSplice(keys, index, 1);
    }

    if (!messageIsGetterThatThrows) {
      const index = ArrayPrototypeIndexOf(keys, 'message');
      // Only hide the property if it's a string and if it's part of the original stack
      if (index !== -1 && (typeof message !== 'string' || StringPrototypeIncludes(stack, message))) {
        ArrayPrototypeSplice(keys, index, 1);
      }
    }

    if (!nameIsGetterThatThrows) {
      const index = ArrayPrototypeIndexOf(keys, 'name');
      // Only hide the property if it's a string and if it's part of the original stack
      if (index !== -1 && (typeof name !== 'string' || StringPrototypeIncludes(stack, name))) {
        ArrayPrototypeSplice(keys, index, 1);
      }
    }
  }
  name ??= 'Error';

  if (ObjectPrototypeHasOwnProperty(err, 'cause') &&
      (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'cause'))) {
    ArrayPrototypePush(keys, 'cause');
  }

  // Print errors aggregated into AggregateError
  try {
    const errors = err.errors;
    if (ArrayIsArray(errors) && ObjectPrototypeHasOwnProperty(err, 'errors') &&
      (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'errors'))) {
      ArrayPrototypePush(keys, 'errors');
    }
  } catch {
    // If errors is a getter that throws, we ignore the error.
  }

  stack = improveStack(stack, constructor, name, tag);

  // Ignore the error message if it's contained in the stack.
  let pos = (message && StringPrototypeIndexOf(stack, message)) || -1;
  if (pos !== -1)
    pos += message.length;
  // Wrap the error in brackets in case it has no stack trace.
  const stackStart = StringPrototypeIndexOf(stack, '\n    at', pos);
  if (stackStart === -1) {
    stack = `[${stack}]`;
  } else {
    let newStack = StringPrototypeSlice(stack, 0, stackStart);
    const stackFramePart = StringPrototypeSlice(stack, stackStart + 1);
    const lines = getStackFrames(ctx, err, stackFramePart);
    if (ctx.colors) {
      // Highlight userland code and node modules.
      const workingDirectory = safeGetCWD();
      let esmWorkingDirectory;
      for (let line of lines) {
        const core = RegExpPrototypeExec(coreModuleRegExp, line);
        if (core !== null && BuiltinModule.exists(core[1])) {
          newStack += `\n${ctx.stylize(line, 'undefined')}`;
        } else {
          newStack += '\n';

          line = markNodeModules(ctx, line);
          if (workingDirectory !== undefined) {
            let newLine = markCwd(ctx, line, workingDirectory);
            if (newLine === line) {
              esmWorkingDirectory ??= pathToFileUrlHref(workingDirectory);
              newLine = markCwd(ctx, line, esmWorkingDirectory);
            }
            line = newLine;
          }

          newStack += line;
        }
      }
    } else {
      newStack += `\n${ArrayPrototypeJoin(lines, '\n')}`;
    }
    stack = newStack;
  }
  // The message and the stack have to be indented as well!
  if (ctx.indentationLvl !== 0) {
    const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
    stack = StringPrototypeReplaceAll(stack, '\n', `\n${indentation}`);
  }
  return stack;
}

function groupArrayElements(ctx, output, value) {
  let totalLength = 0;
  let maxLength = 0;
  let i = 0;
  let outputLength = output.length;
  if (ctx.maxArrayLength < output.length) {
    // This makes sure the "... n more items" part is not taken into account.
    outputLength--;
  }
  const separatorSpace = 2; // Add 1 for the space and 1 for the separator.
  const dataLen = new Array(outputLength);
  // Calculate the total length of all output entries and the individual max
  // entries length of all output entries. We have to remove colors first,
  // otherwise the length would not be calculated properly.
  for (; i < outputLength; i++) {
    const len = getStringWidth(output[i], ctx.colors);
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len)
      maxLength = len;
  }
  // Add two to `maxLength` as we add a single whitespace character plus a comma
  // in-between two entries.
  const actualMax = maxLength + separatorSpace;
  // Check if at least three entries fit next to each other and prevent grouping
  // of arrays that contains entries of very different length (i.e., if a single
  // entry is longer than 1/5 of all other entries combined). Otherwise the
  // space in-between small entries would be enormous.
  if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
      (totalLength / actualMax > 5 || maxLength <= 6)) {

    const approxCharHeights = 2.5;
    const averageBias = MathSqrt(actualMax - totalLength / output.length);
    const biasedMax = MathMax(actualMax - 3 - averageBias, 1);
    // Dynamically check how many columns seem possible.
    const columns = MathMin(
      // Ideally a square should be drawn. We expect a character to be about 2.5
      // times as high as wide. This is the area formula to calculate a square
      // which contains n rectangles of size `actualMax * approxCharHeights`.
      // Divide that by `actualMax` to receive the correct number of columns.
      // The added bias increases the columns for short entries.
      MathRound(
        MathSqrt(
          approxCharHeights * biasedMax * outputLength,
        ) / biasedMax,
      ),
      // Do not exceed the breakLength.
      MathFloor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      // Limit array grouping for small `compact` modes as the user requested
      // minimal grouping.
      ctx.compact * 4,
      // Limit the columns to a maximum of fifteen.
      15,
    );
    // Return with the original output if no grouping should happen.
    if (columns <= 1) {
      return output;
    }
    const tmp = [];
    const maxLineLength = [];
    for (let i = 0; i < columns; i++) {
      let lineMaxLength = 0;
      for (let j = i; j < output.length; j += columns) {
        if (dataLen[j] > lineMaxLength)
          lineMaxLength = dataLen[j];
      }
      lineMaxLength += separatorSpace;
      maxLineLength[i] = lineMaxLength;
    }
    let order = StringPrototypePadStart;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
          order = StringPrototypePadEnd;
          break;
        }
      }
    }
    // Each iteration creates a single line of grouped entries.
    for (let i = 0; i < outputLength; i += columns) {
      // The last lines may contain less entries than columns.
      const max = MathMin(i + columns, outputLength);
      let str = '';
      let j = i;
      for (; j < max - 1; j++) {
        // Calculate extra color padding in case it's active. This has to be
        // done line by line as some lines might contain more colors than
        // others.
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += order(`${output[j]}, `, padding, ' ');
      }
      if (order === StringPrototypePadStart) {
        const padding = maxLineLength[j - i] +
                        output[j].length -
                        dataLen[j] -
                        separatorSpace;
        str += StringPrototypePadStart(output[j], padding, ' ');
      } else {
        str += output[j];
      }
      ArrayPrototypePush(tmp, str);
    }
    if (ctx.maxArrayLength < output.length) {
      ArrayPrototypePush(tmp, output[outputLength]);
    }
    output = tmp;
  }
  return output;
}

function handleMaxCallStackSize(ctx, err, constructorName, indentationLvl) {
  ctx.seen.pop();
  ctx.indentationLvl = indentationLvl;
  return ctx.stylize(
    `[${constructorName}: Inspection interrupted ` +
      'prematurely. Maximum call stack size exceeded.]',
    'special',
  );
}

function addNumericSeparator(integerString) {
  let result = '';
  let i = integerString.length;
  assert(i !== 0);
  const start = integerString[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    result = `_${StringPrototypeSlice(integerString, i - 3, i)}${result}`;
  }
  return i === integerString.length ?
    integerString :
    `${StringPrototypeSlice(integerString, 0, i)}${result}`;
}

function addNumericSeparatorEnd(integerString) {
  let result = '';
  let i = 0;
  for (; i < integerString.length - 3; i += 3) {
    result += `${StringPrototypeSlice(integerString, i, i + 3)}_`;
  }
  return i === 0 ?
    integerString :
    `${result}${StringPrototypeSlice(integerString, i)}`;
}

const remainingText = (remaining) => `... ${remaining} more item${remaining > 1 ? 's' : ''}`;

function formatNumber(fn, number, numericSeparator) {
  if (!numericSeparator) {
    // Format -0 as '-0'. Checking `number === -0` won't distinguish 0 from -0.
    if (ObjectIs(number, -0)) {
      return fn('-0', 'number');
    }
    return fn(`${number}`, 'number');
  }

  const numberString = String(number);
  const integer = MathTrunc(number);

  if (integer === number) {
    if (!NumberIsFinite(number) || StringPrototypeIncludes(numberString, 'e')) {
      return fn(numberString, 'number');
    }
    return fn(addNumericSeparator(numberString), 'number');
  }
  if (NumberIsNaN(number)) {
    return fn(numberString, 'number');
  }

  const decimalIndex = StringPrototypeIndexOf(numberString, '.');
  const integerPart = StringPrototypeSlice(numberString, 0, decimalIndex);
  const fractionalPart = StringPrototypeSlice(numberString, decimalIndex + 1);

  return fn(`${
    addNumericSeparator(integerPart)
  }.${
    addNumericSeparatorEnd(fractionalPart)
  }`, 'number');
}

function formatBigInt(fn, bigint, numericSeparator) {
  const string = String(bigint);
  if (!numericSeparator) {
    return fn(`${string}n`, 'bigint');
  }
  return fn(`${addNumericSeparator(string)}n`, 'bigint');
}

function formatPrimitive(fn, value, ctx) {
  if (typeof value === 'string') {
    let trailer = '';
    if (value.length > ctx.maxStringLength) {
      const remaining = value.length - ctx.maxStringLength;
      value = StringPrototypeSlice(value, 0, ctx.maxStringLength);
      trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
    }
    if (ctx.compact !== true &&
        // We do not support handling unicode characters width with
        // the readline getStringWidth function as there are
        // performance implications.
        value.length > kMinLineLength &&
        value.length > ctx.breakLength - ctx.indentationLvl - 4) {
      return ArrayPrototypeJoin(
        ArrayPrototypeMap(
          RegExpPrototypeSymbolSplit(/(?<=\n)/, value),
          (line) => fn(strEscape(line), 'string'),
        ),
        ` +\n${StringPrototypeRepeat(' ', ctx.indentationLvl + 2)}`,
      ) + trailer;
    }
    return fn(strEscape(value), 'string') + trailer;
  }
  if (typeof value === 'number')
    return formatNumber(fn, value, ctx.numericSeparator);
  if (typeof value === 'bigint')
    return formatBigInt(fn, value, ctx.numericSeparator);
  if (typeof value === 'boolean')
    return fn(`${value}`, 'boolean');
  if (typeof value === 'undefined')
    return fn('undefined', 'undefined');
  // es6 symbol primitive
  return fn(SymbolPrototypeToString(value), 'symbol');
}

function formatNamespaceObject(keys, ctx, value, recurseTimes) {
  const output = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    try {
      output[i] = formatProperty(ctx, value, recurseTimes, keys[i],
                                 kObjectType);
    } catch (err) {
      assert(isNativeError(err) && err.name === 'ReferenceError');
      // Use the existing functionality. This makes sure the indentation and
      // line breaks are always correct. Otherwise it is very difficult to keep
      // this aligned, even though this is a hacky way of dealing with this.
      const tmp = { [keys[i]]: '' };
      output[i] = formatProperty(ctx, tmp, recurseTimes, keys[i], kObjectType);
      const pos = StringPrototypeLastIndexOf(output[i], ' ');
      // We have to find the last whitespace and have to replace that value as
      // it will be visualized as a regular string.
      output[i] = StringPrototypeSlice(output[i], 0, pos + 1) +
                  ctx.stylize('<uninitialized>', 'special');
    }
  }
  // Reset the keys to an empty array. This prevents duplicated inspection.
  keys.length = 0;
  return output;
}

// The array is sparse and/or has extra keys
function formatSpecialArray(ctx, value, recurseTimes, maxLength, output, i) {
  const keys = ObjectKeys(value);
  let index = i;
  for (; i < keys.length && output.length < maxLength; i++) {
    const key = keys[i];
    const tmp = +key;
    // Arrays can only have up to 2^32 - 1 entries
    if (tmp > 2 ** 32 - 2) {
      break;
    }
    if (`${index}` !== key) {
      if (RegExpPrototypeExec(numberRegExp, key) === null) {
        break;
      }
      const emptyItems = tmp - index;
      const ending = emptyItems > 1 ? 's' : '';
      const message = `<${emptyItems} empty item${ending}>`;
      ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
      index = tmp;
      if (output.length === maxLength) {
        break;
      }
    }
    ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, key, kArrayType));
    index++;
  }
  const remaining = value.length - index;
  if (output.length !== maxLength) {
    if (remaining > 0) {
      const ending = remaining > 1 ? 's' : '';
      const message = `<${remaining} empty item${ending}>`;
      ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
    }
  } else if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatArrayBuffer(ctx, value) {
  let buffer;
  try {
    buffer = new Uint8Array(value);
  } catch {
    return [ctx.stylize('(detached)', 'special')];
  }
  if (hexSlice === undefined)
    hexSlice = uncurryThis(require('buffer').Buffer.prototype.hexSlice);
  const rawString = hexSlice(buffer, 0, MathMin(ctx.maxArrayLength, buffer.length));
  let str = '';
  let i = 0;
  for (; i < rawString.length - 2; i += 2) {
    str += `${rawString[i]}${rawString[i + 1]} `;
  }
  if (rawString.length > 0) {
    str += `${rawString[i]}${rawString[i + 1]}`;
  }
  const remaining = buffer.length - ctx.maxArrayLength;
  if (remaining > 0)
    str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  return [`${ctx.stylize('[Uint8Contents]', 'special')}: <${str}>`];
}

function formatArray(ctx, value, recurseTimes) {
  const valLen = value.length;
  const len = MathMin(MathMax(0, ctx.maxArrayLength), valLen);

  const remaining = valLen - len;
  const output = [];
  for (let i = 0; i < len; i++) {
    const desc = ObjectGetOwnPropertyDescriptor(value, i);
    if (desc === undefined) {
      // Special handle sparse arrays.
      return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
    }
    ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, i, kArrayType, desc));
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatTypedArray(value, length, ctx) {
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = value.length - maxLength;
  const output = new Array(maxLength);
  const elementFormatter = value.length > 0 && typeof value[0] === 'number' ?
    formatNumber :
    formatBigInt;
  for (let i = 0; i < maxLength; ++i) {
    output[i] = elementFormatter(ctx.stylize, value[i], ctx.numericSeparator);
  }
  if (remaining > 0) {
    output[maxLength] = remainingText(remaining);
  }
  return output;
}

function formatSet(value, ctx, ignored, recurseTimes) {
  const length = value.size;
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const v of value) {
    if (i >= maxLength) break;
    ArrayPrototypePush(output, formatValue(ctx, v, recurseTimes));
    i++;
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatMap(value, ctx, ignored, recurseTimes) {
  const length = value.size;
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const { 0: k, 1: v } of value) {
    if (i >= maxLength) break;
    ArrayPrototypePush(
      output,
      `${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`,
    );
    i++;
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatSetIterInner(ctx, recurseTimes, entries, state) {
  const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
  const maxLength = MathMin(maxArrayLength, entries.length);
  const output = new Array(maxLength);
  ctx.indentationLvl += 2;
  for (let i = 0; i < maxLength; i++) {
    output[i] = formatValue(ctx, entries[i], recurseTimes);
  }
  ctx.indentationLvl -= 2;
  if (state === kWeak && !ctx.sorted) {
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    ArrayPrototypeSort(output);
  }
  const remaining = entries.length - maxLength;
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatMapIterInner(ctx, recurseTimes, entries, state) {
  const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
  // Entries exist as [key1, val1, key2, val2, ...]
  const len = entries.length / 2;
  const remaining = len - maxArrayLength;
  const maxLength = MathMin(maxArrayLength, len);
  const output = new Array(maxLength);
  let i = 0;
  ctx.indentationLvl += 2;
  if (state === kWeak) {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      output[i] =
        `${formatValue(ctx, entries[pos], recurseTimes)} => ${formatValue(ctx, entries[pos + 1], recurseTimes)}`;
    }
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    if (!ctx.sorted)
      ArrayPrototypeSort(output);
  } else {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      const res = [
        formatValue(ctx, entries[pos], recurseTimes),
        formatValue(ctx, entries[pos + 1], recurseTimes),
      ];
      output[i] = reduceToSingleString(
        ctx, res, '', ['[', ']'], kArrayExtrasType, recurseTimes);
    }
  }
  ctx.indentationLvl -= 2;
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatWeakCollection(ctx) {
  return [ctx.stylize('<items unknown>', 'special')];
}

function formatWeakSet(ctx, value, recurseTimes) {
  const entries = previewEntries(value);
  return formatSetIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatWeakMap(ctx, value, recurseTimes) {
  const entries = previewEntries(value);
  return formatMapIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatIterator(braces, ctx, value, recurseTimes) {
  const { 0: entries, 1: isKeyValue } = previewEntries(value, true);
  if (isKeyValue) {
    // Mark entry iterators as such.
    braces[0] = RegExpPrototypeSymbolReplace(/ Iterator] {$/, braces[0], ' Entries] {');
    return formatMapIterInner(ctx, recurseTimes, entries, kMapEntries);
  }

  return formatSetIterInner(ctx, recurseTimes, entries, kIterator);
}

function formatPromise(ctx, value, recurseTimes) {
  let output;
  const { 0: state, 1: result } = getPromiseDetails(value);
  if (state === kPending) {
    output = [ctx.stylize('<pending>', 'special')];
  } else {
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, result, recurseTimes);
    ctx.indentationLvl -= 2;
    output = [
      state === kRejected ?
        `${ctx.stylize('<rejected>', 'special')} ${str}` :
        str,
    ];
  }
  return output;
}

function formatExtraProperties(ctx, value, recurseTimes, key, typedArray) {
  ctx.indentationLvl += 2;
  const str = formatValue(ctx, value[key], recurseTimes, typedArray);
  ctx.indentationLvl -= 2;

  // These entries are mainly getters. Should they be formatted like getters?
  const name = ctx.stylize(`[${key}]`, 'string');
  return `${name}: ${str}`;
}

function formatProperty(ctx, value, recurseTimes, key, type, desc,
                        original = value) {
  let name, str;
  let extra = ' ';
  desc ??= ObjectGetOwnPropertyDescriptor(value, key);
  if (desc.value !== undefined) {
    const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
    ctx.indentationLvl += diff;
    str = formatValue(ctx, desc.value, recurseTimes);
    if (diff === 3 && ctx.breakLength < getStringWidth(str, ctx.colors)) {
      extra = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
    }
    ctx.indentationLvl -= diff;
  } else if (desc.get !== undefined) {
    const label = desc.set !== undefined ? 'Getter/Setter' : 'Getter';
    const s = ctx.stylize;
    const sp = 'special';
    if (ctx.getters && (ctx.getters === true ||
          (ctx.getters === 'get' && desc.set === undefined) ||
          (ctx.getters === 'set' && desc.set !== undefined))) {
      try {
        const tmp = FunctionPrototypeCall(desc.get, original);
        ctx.indentationLvl += 2;
        if (tmp === null) {
          str = `${s(`[${label}:`, sp)} ${s('null', 'null')}${s(']', sp)}`;
        } else if (typeof tmp === 'object') {
          str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
        } else {
          const primitive = formatPrimitive(s, tmp, ctx);
          str = `${s(`[${label}:`, sp)} ${primitive}${s(']', sp)}`;
        }
        ctx.indentationLvl -= 2;
      } catch (err) {
        const message = `<Inspection threw (${err.message})>`;
        str = `${s(`[${label}:`, sp)} ${message}${s(']', sp)}`;
      }
    } else {
      str = ctx.stylize(`[${label}]`, sp);
    }
  } else if (desc.set !== undefined) {
    str = ctx.stylize('[Setter]', 'special');
  } else {
    str = ctx.stylize('undefined', 'undefined');
  }
  if (type === kArrayType) {
    return str;
  }
  if (typeof key === 'symbol') {
    const tmp = RegExpPrototypeSymbolReplace(
      strEscapeSequencesReplacer,
      SymbolPrototypeToString(key),
      escapeFn,
    );
    name = `[${ctx.stylize(tmp, 'symbol')}]`;
  } else if (key === '__proto__') {
    name = "['__proto__']";
  } else if (desc.enumerable === false) {
    const tmp = RegExpPrototypeSymbolReplace(
      strEscapeSequencesReplacer,
      key,
      escapeFn,
    );
    name = `[${tmp}]`;
  } else if (RegExpPrototypeExec(keyStrRegExp, key) !== null) {
    name = ctx.stylize(key, 'name');
  } else {
    name = ctx.stylize(strEscape(key), 'string');
  }
  return `${name}:${extra}${str}`;
}

function isBelowBreakLength(ctx, output, start, base) {
  // Each entry is separated by at least a comma. Thus, we start with a total
  // length of at least `output.length`. In addition, some cases have a
  // whitespace in-between each other that is added to the total as well.
  // TODO(BridgeAR): Add unicode support. Use the readline getStringWidth
  // function. Check the performance overhead and make it an opt-in in case it's
  // significant.
  let totalLength = output.length + start;
  if (totalLength + output.length > ctx.breakLength)
    return false;
  for (let i = 0; i < output.length; i++) {
    if (ctx.colors) {
      totalLength += removeColors(output[i]).length;
    } else {
      totalLength += output[i].length;
    }
    if (totalLength > ctx.breakLength) {
      return false;
    }
  }
  // Do not line up properties on the same line if `base` contains line breaks.
  return base === '' || !StringPrototypeIncludes(base, '\n');
}

function reduceToSingleString(
  ctx, output, base, braces, extrasType, recurseTimes, value) {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
      // Memorize the original output length. In case the output is grouped,
      // prevent lining up the entries on a single line.
      const entries = output.length;
      // Group array elements together if the array contains at least six
      // separate entries.
      if (extrasType === kArrayExtrasType && entries > 6) {
        output = groupArrayElements(ctx, output, value);
      }
      // `ctx.currentDepth` is set to the most inner depth of the currently
      // inspected object part while `recurseTimes` is the actual current depth
      // that is inspected.
      //
      // Example:
      //
      // const a = { first: [ 1, 2, 3 ], second: { inner: [ 1, 2, 3 ] } }
      //
      // The deepest depth of `a` is 2 (a.second.inner) and `a.first` has a max
      // depth of 1.
      //
      // Consolidate all entries of the local most inner depth up to
      // `ctx.compact`, as long as the properties are smaller than
      // `ctx.breakLength`.
      if (ctx.currentDepth - recurseTimes < ctx.compact &&
          entries === output.length) {
        // Line up all entries on a single line in case the entries do not
        // exceed `breakLength`. Add 10 as constant to start next to all other
        // factors that may reduce `breakLength`.
        const start = output.length + ctx.indentationLvl +
                      braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          const joinedOutput = join(output, ', ');
          if (!StringPrototypeIncludes(joinedOutput, '\n')) {
            return `${base ? `${base} ` : ''}${braces[0]} ${joinedOutput}` +
              ` ${braces[1]}`;
          }
        }
      }
    }
    // Line up each entry on an individual line.
    const indentation = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ` +
      `${join(output, `,${indentation}  `)}${indentation}${braces[1]}`;
  }
  // Line up all entries on a single line in case the entries do not exceed
  // `breakLength`.
  if (isBelowBreakLength(ctx, output, 0, base)) {
    return `${braces[0]}${base ? ` ${base}` : ''} ${join(output, ', ')} ` +
      braces[1];
  }
  const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
  // If the opening "brace" is too large, like in the case of "Set {",
  // we need to force the first item to be on the next line or the
  // items will not line up correctly.
  const ln = base === '' && braces[0].length === 1 ?
    ' ' : `${base ? ` ${base}` : ''}\n${indentation}  `;
  // Line up each entry on an individual line.
  return `${braces[0]}${ln}${join(output, `,\n${indentation}  `)} ${braces[1]}`;
}

function hasBuiltInToString(value) {
  // Prevent triggering proxy traps.
  const getFullProxy = false;
  const proxyTarget = getProxyDetails(value, getFullProxy);
  if (proxyTarget !== undefined) {
    if (proxyTarget === null) {
      return true;
    }
    value = proxyTarget;
  }

  let hasOwnToString = ObjectPrototypeHasOwnProperty;
  let hasOwnToPrimitive = ObjectPrototypeHasOwnProperty;

  // Count objects without `toString` and `Symbol.toPrimitive` function as built-in.
  if (typeof value.toString !== 'function') {
    if (typeof value[SymbolToPrimitive] !== 'function') {
      return true;
    } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
      return false;
    }
    hasOwnToString = returnFalse;
  } else if (ObjectPrototypeHasOwnProperty(value, 'toString')) {
    return false;
  } else if (typeof value[SymbolToPrimitive] !== 'function') {
    hasOwnToPrimitive = returnFalse;
  } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
    return false;
  }

  // Find the object that has the `toString` property or `Symbol.toPrimitive` property
  // as own property in the prototype chain.
  let pointer = value;
  do {
    pointer = ObjectGetPrototypeOf(pointer);
  } while (!hasOwnToString(pointer, 'toString') &&
    !hasOwnToPrimitive(pointer, SymbolToPrimitive));

  // Check closer if the object is a built-in.
  const descriptor = ObjectGetOwnPropertyDescriptor(pointer, 'constructor');
  return descriptor !== undefined &&
    typeof descriptor.value === 'function' &&
    builtInObjects.has(descriptor.value.name);
}

function returnFalse() {
  return false;
}

const firstErrorLine = (error) => StringPrototypeSplit(error.message, '\n', 1)[0];
let CIRCULAR_ERROR_MESSAGE;
function tryStringify(arg) {
  try {
    return JSONStringify(arg);
  } catch (err) {
    // Populate the circular error message lazily
    if (!CIRCULAR_ERROR_MESSAGE) {
      try {
        const a = {};
        a.a = a;
        JSONStringify(a);
      } catch (circularError) {
        CIRCULAR_ERROR_MESSAGE = firstErrorLine(circularError);
      }
    }
    if (err.name === 'TypeError' &&
        firstErrorLine(err) === CIRCULAR_ERROR_MESSAGE) {
      return '[Circular]';
    }
    throw err;
  }
}

function format(...args) {
  return formatWithOptionsInternal(undefined, args);
}

function formatWithOptions(inspectOptions, ...args) {
  validateObject(inspectOptions, 'inspectOptions', kValidateObjectAllowArray);
  return formatWithOptionsInternal(inspectOptions, args);
}

function formatNumberNoColor(number, options) {
  return formatNumber(
    stylizeNoColor,
    number,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
  );
}

function formatBigIntNoColor(bigint, options) {
  return formatBigInt(
    stylizeNoColor,
    bigint,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
  );
}

function formatWithOptionsInternal(inspectOptions, args) {
  const first = args[0];
  let a = 0;
  let str = '';
  let join = '';

  if (typeof first === 'string') {
    if (args.length === 1) {
      return first;
    }
    let tempStr;
    let lastPos = 0;

    for (let i = 0; i < first.length - 1; i++) {
      if (StringPrototypeCharCodeAt(first, i) === 37) { // '%'
        const nextChar = StringPrototypeCharCodeAt(first, ++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: { // 's'
              const tempArg = args[++a];
              if (typeof tempArg === 'number') {
                tempStr = formatNumberNoColor(tempArg, inspectOptions);
              } else if (typeof tempArg === 'bigint') {
                tempStr = formatBigIntNoColor(tempArg, inspectOptions);
              } else if (typeof tempArg !== 'object' ||
                         tempArg === null ||
                         !hasBuiltInToString(tempArg)) {
                tempStr = String(tempArg);
              } else {
                tempStr = inspect(tempArg, {
                  ...inspectOptions,
                  compact: 3,
                  colors: false,
                  depth: 0,
                });
              }
              break;
            }
            case 106: // 'j'
              tempStr = tryStringify(args[++a]);
              break;
            case 100: { // 'd'
              const tempNum = args[++a];
              if (typeof tempNum === 'bigint') {
                tempStr = formatBigIntNoColor(tempNum, inspectOptions);
              } else if (typeof tempNum === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(Number(tempNum), inspectOptions);
              }
              break;
            }
            case 79: // 'O'
              tempStr = inspect(args[++a], inspectOptions);
              break;
            case 111: // 'o'
              tempStr = inspect(args[++a], {
                ...inspectOptions,
                showHidden: true,
                showProxy: true,
                depth: 4,
              });
              break;
            case 105: { // 'i'
              const tempInteger = args[++a];
              if (typeof tempInteger === 'bigint') {
                tempStr = formatBigIntNoColor(tempInteger, inspectOptions);
              } else if (typeof tempInteger === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(
                  NumberParseInt(tempInteger), inspectOptions);
              }
              break;
            }
            case 102: { // 'f'
              const tempFloat = args[++a];
              if (typeof tempFloat === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(
                  NumberParseFloat(tempFloat), inspectOptions);
              }
              break;
            }
            case 99: // 'c'
              a += 1;
              tempStr = '';
              break;
            case 37: // '%'
              str += StringPrototypeSlice(first, lastPos, i);
              lastPos = i + 1;
              continue;
            default: // Any other character is not a correct placeholder
              continue;
          }
          if (lastPos !== i - 1) {
            str += StringPrototypeSlice(first, lastPos, i - 1);
          }
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += StringPrototypeSlice(first, lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a++;
      join = ' ';
      if (lastPos < first.length) {
        str += StringPrototypeSlice(first, lastPos);
      }
    }
  }

  while (a < args.length) {
    const value = args[a];
    str += join;
    str += typeof value !== 'string' ? inspect(value, inspectOptions) : value;
    join = ' ';
    a++;
  }
  return str;
}

function isZeroWidthCodePoint(code) {
  return code <= 0x1F || // C0 control codes
    (code >= 0x7F && code <= 0x9F) || // C1 control codes
    (code >= 0x300 && code <= 0x36F) || // Combining Diacritical Marks
    (code >= 0x200B && code <= 0x200F) || // Modifying Invisible Characters
    // Combining Diacritical Marks for Symbols
    (code >= 0x20D0 && code <= 0x20FF) ||
    (code >= 0xFE00 && code <= 0xFE0F) || // Variation Selectors
    (code >= 0xFE20 && code <= 0xFE2F) || // Combining Half Marks
    (code >= 0xE0100 && code <= 0xE01EF); // Variation Selectors
}

if (internalBinding('config').hasIntl) {
  const icu = internalBinding('icu');
  // icu.getStringWidth(string, ambiguousAsFullWidth, expandEmojiSequence)
  // Defaults: ambiguousAsFullWidth = false; expandEmojiSequence = true;
  // TODO(BridgeAR): Expose the options to the user. That is probably the
  // best thing possible at the moment, since it's difficult to know what
  // the receiving end supports.
  getStringWidth = function getStringWidth(str, removeControlChars = true) {
    let width = 0;

    if (removeControlChars) {
      str = stripVTControlCharacters(str);
    }
    for (let i = 0; i < str.length; i++) {
      // Try to avoid calling into C++ by first handling the ASCII portion of
      // the string. If it is fully ASCII, we skip the C++ part.
      const code = str.charCodeAt(i);
      if (code >= 127) {
        width += icu.getStringWidth(StringPrototypeNormalize(StringPrototypeSlice(str, i), 'NFC'));
        break;
      }
      width += code >= 32 ? 1 : 0;
    }
    return width;
  };
} else {
  /**
   * Returns the number of columns required to display the given string.
   */
  getStringWidth = function getStringWidth(str, removeControlChars = true) {
    let width = 0;

    if (removeControlChars)
      str = stripVTControlCharacters(str);
    str = StringPrototypeNormalize(str, 'NFC');
    for (const char of new SafeStringIterator(str)) {
      const code = StringPrototypeCodePointAt(char, 0);
      if (isFullWidthCodePoint(code)) {
        width += 2;
      } else if (!isZeroWidthCodePoint(code)) {
        width++;
      }
    }

    return width;
  };

  /**
   * Returns true if the character represented by a given
   * Unicode code point is full-width. Otherwise returns false.
   */
  const isFullWidthCodePoint = (code) => {
    // Code points are partially derived from:
    // https://www.unicode.org/Public/UNIDATA/EastAsianWidth.txt
    return code >= 0x1100 && (
      code <= 0x115f ||  // Hangul Jamo
      code === 0x2329 || // LEFT-POINTING ANGLE BRACKET
      code === 0x232a || // RIGHT-POINTING ANGLE BRACKET
      // CJK Radicals Supplement .. Enclosed CJK Letters and Months
      (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
      // Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
      (code >= 0x3250 && code <= 0x4dbf) ||
      // CJK Unified Ideographs .. Yi Radicals
      (code >= 0x4e00 && code <= 0xa4c6) ||
      // Hangul Jamo Extended-A
      (code >= 0xa960 && code <= 0xa97c) ||
      // Hangul Syllables
      (code >= 0xac00 && code <= 0xd7a3) ||
      // CJK Compatibility Ideographs
      (code >= 0xf900 && code <= 0xfaff) ||
      // Vertical Forms
      (code >= 0xfe10 && code <= 0xfe19) ||
      // CJK Compatibility Forms .. Small Form Variants
      (code >= 0xfe30 && code <= 0xfe6b) ||
      // Halfwidth and Fullwidth Forms
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      // Kana Supplement
      (code >= 0x1b000 && code <= 0x1b001) ||
      // Enclosed Ideographic Supplement
      (code >= 0x1f200 && code <= 0x1f251) ||
      // Miscellaneous Symbols and Pictographs 0x1f300 - 0x1f5ff
      // Emoticons 0x1f600 - 0x1f64f
      (code >= 0x1f300 && code <= 0x1f64f) ||
      // CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
      (code >= 0x20000 && code <= 0x3fffd)
    );
  };

}

/**
 * Remove all VT control characters. Use to estimate displayed string width.
 */
function stripVTControlCharacters(str) {
  validateString(str, 'str');

  return RegExpPrototypeSymbolReplace(ansi, str, '');
}

module.exports = {
  identicalSequenceRange,
  inspect,
  inspectDefaultOptions,
  format,
  formatWithOptions,
  getStringWidth,
  stripVTControlCharacters,
  isZeroWidthCodePoint,
};

    },
    get "internal/source_map/source_map"() { return require("./node-lib-rest.js").sources["internal/source_map/source_map"]; },
    "internal/validators": function (exports, require, module, process, internalBinding, primordials) {
/* eslint jsdoc/require-jsdoc: "error" */

'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  NumberIsFinite,
  NumberIsInteger,
  NumberIsNaN,
  NumberMAX_SAFE_INTEGER,
  NumberMIN_SAFE_INTEGER,
  NumberParseInt,
  ObjectPrototypeHasOwnProperty,
  RegExpPrototypeExec,
  String,
  StringPrototypeIncludes,
  StringPrototypeToUpperCase,
  StringPrototypeTrim,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_TYPE: { HideStackFramesError: ERR_INVALID_ARG_TYPE },
    ERR_INVALID_ARG_VALUE: { HideStackFramesError: ERR_INVALID_ARG_VALUE },
    ERR_INVALID_THIS: { HideStackFramesError: ERR_INVALID_THIS },
    ERR_OUT_OF_RANGE: { HideStackFramesError: ERR_OUT_OF_RANGE },
    ERR_SOCKET_BAD_PORT: { HideStackFramesError: ERR_SOCKET_BAD_PORT },
    ERR_UNKNOWN_SIGNAL: { HideStackFramesError: ERR_UNKNOWN_SIGNAL },
  },
  hideStackFrames,
} = require('internal/errors');
const { normalizeEncoding } = require('internal/util');
const {
  isAsyncFunction,
  isArrayBufferView,
} = require('internal/util/types');
const { signals } = internalBinding('constants').os;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isInt32(value) {
  return value === (value | 0);
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function isUint32(value) {
  return value === (value >>> 0);
}

const octalReg = /^[0-7]+$/;
const modeDesc = 'must be a 32-bit unsigned integer or an octal string';

/**
 * Parse and validate values that will be converted into mode_t (the S_*
 * constants). Only valid numbers and octal strings are allowed. They could be
 * converted to 32-bit unsigned integers or non-negative signed integers in the
 * C++ land, but any value higher than 0o777 will result in platform-specific
 * behaviors.
 * @param {*} value Values to be validated
 * @param {string} name Name of the argument
 * @param {number} [def] If specified, will be returned for invalid values
 * @returns {number}
 */
function parseFileMode(value, name, def) {
  value ??= def;
  if (typeof value === 'string') {
    if (RegExpPrototypeExec(octalReg, value) === null) {
      throw new ERR_INVALID_ARG_VALUE(name, value, modeDesc);
    }
    value = NumberParseInt(value, 8);
  }

  validateUint32(value, name);
  return value;
}

/**
 * @callback validateInteger
 * @param {*} value
 * @param {string} name
 * @param {number} [min]
 * @param {number} [max]
 * @returns {asserts value is number}
 */

/** @type {validateInteger} */
const validateInteger = hideStackFrames(
  (value, name, min = NumberMIN_SAFE_INTEGER, max = NumberMAX_SAFE_INTEGER) => {
    if (typeof value !== 'number')
      throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
    if (!NumberIsInteger(value))
      throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
    if (value < min || value > max)
      throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  },
);

/**
 * @callback validateInt32
 * @param {*} value
 * @param {string} name
 * @param {number} [min]
 * @param {number} [max]
 * @returns {asserts value is number}
 */

/** @type {validateInt32} */
const validateInt32 = hideStackFrames(
  (value, name, min = -2147483648, max = 2147483647) => {
    // The defaults for min and max correspond to the limits of 32-bit integers.
    if (typeof value !== 'number') {
      throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
    }
    if (!NumberIsInteger(value)) {
      throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
    }
    if (value < min || value > max) {
      throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
    }
  },
);

/**
 * @callback validateUint32
 * @param {*} value
 * @param {string} name
 * @param {boolean} [positive=false]
 * @returns {asserts value is number}
 */

/** @type {validateUint32} */
const validateUint32 = hideStackFrames((value, name, positive = false) => {
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
  if (!NumberIsInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  }
  const min = positive ? 1 : 0;
  // 2 ** 32 === 4294967296
  const max = 4_294_967_295;
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  }
});

/**
 * @callback validateString
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is string}
 */

/** @type {validateString} */
const validateString = hideStackFrames((value, name) => {
  if (typeof value !== 'string')
    throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
});

/** @type {validateString} */
const validateStringWithoutNullBytes = hideStackFrames((value, name) => {
  validateString(value, name);
  if (StringPrototypeIncludes(value, '\u0000')) {
    throw new ERR_INVALID_ARG_VALUE(name, value, 'must be a string without null bytes');
  }
});

/**
 * @callback validateNumber
 * @param {*} value
 * @param {string} name
 * @param {number} [min]
 * @param {number} [max]
 * @returns {asserts value is number}
 */

/** @type {validateNumber} */
const validateNumber = hideStackFrames((value, name, min = undefined, max) => {
  if (typeof value !== 'number')
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);

  if ((min != null && value < min) || (max != null && value > max) ||
    ((min != null || max != null) && NumberIsNaN(value))) {
    throw new ERR_OUT_OF_RANGE(
      name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`,
      value);
  }
});

/**
 * @callback validateOneOf
 * @template T
 * @param {T} value
 * @param {string} name
 * @param {T[]} oneOf
 */

/** @type {validateOneOf} */
const validateOneOf = hideStackFrames((value, name, oneOf) => {
  if (!ArrayPrototypeIncludes(oneOf, value)) {
    const allowed = ArrayPrototypeJoin(
      ArrayPrototypeMap(oneOf, (v) =>
        (typeof v === 'string' ? `'${v}'` : String(v))),
      ', ');
    const reason = 'must be one of: ' + allowed;
    throw new ERR_INVALID_ARG_VALUE(name, value, reason);
  }
});

/**
 * @callback validateBoolean
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is boolean}
 */

/** @type {validateBoolean} */
const validateBoolean = hideStackFrames((value, name) => {
  if (typeof value !== 'boolean')
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
});

const kValidateObjectNone = 0;
const kValidateObjectAllowNullable = 1 << 0;
const kValidateObjectAllowArray = 1 << 1;
const kValidateObjectAllowFunction = 1 << 2;
const kValidateObjectAllowObjects = kValidateObjectAllowArray |
  kValidateObjectAllowFunction;
const kValidateObjectAllowObjectsAndNull = kValidateObjectAllowNullable |
  kValidateObjectAllowArray |
  kValidateObjectAllowFunction;

/**
 * @callback validateObject
 * @param {*} value
 * @param {string} name
 * @param {number} [options]
 */

/** @type {validateObject} */
const validateObject = hideStackFrames(
  (value, name, options = kValidateObjectNone) => {
    if (options === kValidateObjectNone) {
      if (value === null || ArrayIsArray(value)) {
        throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
      }

      if (typeof value !== 'object') {
        throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
      }
    } else {
      const throwOnNullable = (kValidateObjectAllowNullable & options) === 0;

      if (throwOnNullable && value === null) {
        throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
      }

      const throwOnArray = (kValidateObjectAllowArray & options) === 0;

      if (throwOnArray && ArrayIsArray(value)) {
        throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
      }

      const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
      const typeofValue = typeof value;

      if (typeofValue !== 'object' && (throwOnFunction || typeofValue !== 'function')) {
        throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
      }
    }
  });

/**
 * @callback validateDictionary - We are using the Web IDL Standard definition
 *                                of "dictionary" here, which means any value
 *                                whose Type is either Undefined, Null, or
 *                                Object (which includes functions).
 * @param {*} value
 * @param {string} name
 * @see https://webidl.spec.whatwg.org/#es-dictionary
 * @see https://tc39.es/ecma262/#table-typeof-operator-results
 */

/** @type {validateDictionary} */
const validateDictionary = hideStackFrames(
  (value, name) => {
    if (value != null && typeof value !== 'object' && typeof value !== 'function') {
      throw new ERR_INVALID_ARG_TYPE(name, 'a dictionary', value);
    }
  });

/**
 * @callback validateArray
 * @param {*} value
 * @param {string} name
 * @param {number} [minLength]
 * @returns {asserts value is any[]}
 */

/** @type {validateArray} */
const validateArray = hideStackFrames((value, name, minLength = 0) => {
  if (!ArrayIsArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
  }
  if (value.length < minLength) {
    const reason = `must be longer than ${minLength}`;
    throw new ERR_INVALID_ARG_VALUE(name, value, reason);
  }
});

/**
 * @callback validateStringArray
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is string[]}
 */

/** @type {validateStringArray} */
const validateStringArray = hideStackFrames((value, name) => {
  validateArray(value, name);
  for (let i = 0; i < value.length; ++i) {
    // Don't use validateString here for performance reasons, as
    // we would generate intermediate strings for the name.
    if (typeof value[i] !== 'string') {
      throw new ERR_INVALID_ARG_TYPE(`${name}[${i}]`, 'string', value[i]);
    }
  }
});

/**
 * @callback validateBooleanArray
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is boolean[]}
 */

/** @type {validateBooleanArray} */
const validateBooleanArray = hideStackFrames((value, name) => {
  validateArray(value, name);
  for (let i = 0; i < value.length; ++i) {
    // Don't use validateBoolean here for performance reasons, as
    // we would generate intermediate strings for the name.
    if (value[i] !== true && value[i] !== false) {
      throw new ERR_INVALID_ARG_TYPE(`${name}[${i}]`, 'boolean', value[i]);
    }
  }
});

/**
 * @callback validateAbortSignalArray
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is AbortSignal[]}
 */

/** @type {validateAbortSignalArray} */
function validateAbortSignalArray(value, name) {
  validateArray(value, name);
  for (let i = 0; i < value.length; i++) {
    const signal = value[i];
    const indexedName = `${name}[${i}]`;
    if (signal == null) {
      throw new ERR_INVALID_ARG_TYPE(indexedName, 'AbortSignal', signal);
    }
    validateAbortSignal(signal, indexedName);
  }
}

/**
 * @param {*} signal
 * @param {string} [name='signal']
 * @returns {asserts signal is keyof signals}
 */
const validateSignalName = hideStackFrames((signal, name = 'signal') => {
  validateString(signal, name);

  if (signals[signal] === undefined) {
    if (signals[StringPrototypeToUpperCase(signal)] !== undefined) {
      throw new ERR_UNKNOWN_SIGNAL(signal +
                                   ' (signals must use all capital letters)');
    }

    throw new ERR_UNKNOWN_SIGNAL(signal);
  }
});

/**
 * @callback validateBuffer
 * @param {*} buffer
 * @param {string} [name='buffer']
 * @returns {asserts buffer is ArrayBufferView}
 */

/** @type {validateBuffer} */
const validateBuffer = hideStackFrames((buffer, name = 'buffer') => {
  if (!isArrayBufferView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE(name,
                                   ['Buffer', 'TypedArray', 'DataView'],
                                   buffer);
  }
});

/**
 * @param {string} data
 * @param {string} encoding
 */
const validateEncoding = hideStackFrames((data, encoding) => {
  const normalizedEncoding = normalizeEncoding(encoding);
  const length = data.length;

  if (normalizedEncoding === 'hex' && length % 2 !== 0) {
    throw new ERR_INVALID_ARG_VALUE('encoding', encoding,
                                    `is invalid for data of length ${length}`);
  }
});

/**
 * Check that the port number is not NaN when coerced to a number,
 * is an integer and that it falls within the legal range of port numbers.
 * @param {*} port
 * @param {string} [name='Port']
 * @param {boolean} [allowZero=true]
 * @returns {number}
 */
const validatePort = hideStackFrames((port, name = 'Port', allowZero = true) => {
  if ((typeof port !== 'number' && typeof port !== 'string') ||
      (typeof port === 'string' && StringPrototypeTrim(port).length === 0) ||
      +port !== (+port >>> 0) ||
      port > 0xFFFF ||
      (port === 0 && !allowZero)) {
    throw new ERR_SOCKET_BAD_PORT(name, port, allowZero);
  }
  return port | 0;
});

/**
 * @callback validateAbortSignal
 * @param {*} signal
 * @param {string} name
 */

/** @type {validateAbortSignal} */
const validateAbortSignal = hideStackFrames((signal, name) => {
  if (signal !== undefined &&
      (signal === null ||
       typeof signal !== 'object' ||
       !('aborted' in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
});

/**
 * @callback validateFunction
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is Function}
 */

/** @type {validateFunction} */
const validateFunction = hideStackFrames((value, name) => {
  if (typeof value !== 'function')
    throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
});

/**
 * @callback validatePlainFunction
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is Function}
 */

/** @type {validatePlainFunction} */
const validatePlainFunction = hideStackFrames((value, name) => {
  if (typeof value !== 'function' || isAsyncFunction(value))
    throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
});

/**
 * @callback validateUndefined
 * @param {*} value
 * @param {string} name
 * @returns {asserts value is undefined}
 */

/** @type {validateUndefined} */
const validateUndefined = hideStackFrames((value, name) => {
  if (value !== undefined)
    throw new ERR_INVALID_ARG_TYPE(name, 'undefined', value);
});

/**
 * @template T
 * @param {T} value
 * @param {string} name
 * @param {T[]} union
 */
function validateUnion(value, name, union) {
  if (!ArrayPrototypeIncludes(union, value)) {
    throw new ERR_INVALID_ARG_TYPE(name, `('${ArrayPrototypeJoin(union, '|')}')`, value);
  }
}

/*
  The rules for the Link header field are described here:
  https://www.rfc-editor.org/rfc/rfc8288.html#section-3

  This regex validates any string surrounded by angle brackets
  (not necessarily a valid URI reference) followed by zero or more
  link-params separated by semicolons.
*/
const linkValueRegExp = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(")?[^;"\s]*\1)?)*$/;

/**
 * @param {any} value
 * @param {string} name
 */
const validateLinkHeaderFormat = hideStackFrames((value, name) => {
  if (
    typeof value === 'undefined' ||
    !RegExpPrototypeExec(linkValueRegExp, value)
  ) {
    throw new ERR_INVALID_ARG_VALUE(
      name,
      value,
      'must be an array or string of format "</styles.css>; rel=preload; as=style"',
    );
  }
});

/**
 * Validate provided `this` object by checking that it has specific own property
 * @param {any} object
 * @param {string|symbol} fieldKey
 * @param {string} className
 */
const validateThisInternalField = hideStackFrames((object, fieldKey, className) => {
  if (typeof object !== 'object' || object === null || !ObjectPrototypeHasOwnProperty(object, fieldKey)) {
    throw new ERR_INVALID_THIS(className);
  }
});

/**
 * @param {any} hints
 * @return {string}
 */
const validateLinkHeaderValue = hideStackFrames((hints) => {
  if (typeof hints === 'string') {
    validateLinkHeaderFormat.withoutStackTrace(hints, 'hints');
    return hints;
  } else if (ArrayIsArray(hints)) {
    const hintsLength = hints.length;
    let result = '';

    if (hintsLength === 0) {
      return result;
    }

    for (let i = 0; i < hintsLength; i++) {
      const link = hints[i];
      validateLinkHeaderFormat.withoutStackTrace(link, 'hints');
      result += link;

      if (i !== hintsLength - 1) {
        result += ', ';
      }
    }

    return result;
  }

  throw new ERR_INVALID_ARG_VALUE(
    'hints',
    hints,
    'must be an array or string of format "</styles.css>; rel=preload; as=style"',
  );
});

// 1. Returns false for undefined and NaN
// 2. Returns true for finite numbers
// 3. Throws ERR_INVALID_ARG_TYPE for non-numbers
// 4. Throws ERR_OUT_OF_RANGE for infinite numbers
const validateFiniteNumber = hideStackFrames((number, name) => {
  // Common case
  if (number === undefined) {
    return false;
  }

  if (NumberIsFinite(number)) {
    return true; // Is a valid number
  }

  if (NumberIsNaN(number)) {
    return false;
  }

  validateNumber(number, name);

  // Infinite numbers
  throw new ERR_OUT_OF_RANGE(name, 'a finite number', number);
});

// 1. Returns def for number when it's undefined or NaN
// 2. Returns number for finite numbers >= lower and <= upper
// 3. Throws ERR_INVALID_ARG_TYPE for non-numbers
// 4. Throws ERR_OUT_OF_RANGE for infinite numbers or numbers > upper or < lower
const checkRangesOrGetDefault = hideStackFrames(
  (number, name, lower, upper, def) => {
    if (!validateFiniteNumber(number, name)) {
      return def;
    }
    if (number < lower || number > upper) {
      throw new ERR_OUT_OF_RANGE(name, `>= ${lower} and <= ${upper}`, number);
    }
    return number;
  },
);

module.exports = {
  isInt32,
  isUint32,
  parseFileMode,
  validateArray,
  validateStringArray,
  validateBooleanArray,
  validateAbortSignalArray,
  validateBoolean,
  validateBuffer,
  validateDictionary,
  validateEncoding,
  validateFunction,
  validateInt32,
  validateInteger,
  validateNumber,
  validateObject,
  kValidateObjectNone,
  kValidateObjectAllowNullable,
  kValidateObjectAllowArray,
  kValidateObjectAllowFunction,
  kValidateObjectAllowObjects,
  kValidateObjectAllowObjectsAndNull,
  validateOneOf,
  validatePlainFunction,
  validatePort,
  validateSignalName,
  validateString,
  validateStringWithoutNullBytes,
  validateUint32,
  validateUndefined,
  validateUnion,
  validateAbortSignal,
  validateLinkHeaderValue,
  validateThisInternalField,
  validateFiniteNumber,
  checkRangesOrGetDefault,
};

    },
    get "internal/util/colors"() { return require("./node-lib-rest.js").sources["internal/util/colors"]; },
    get "internal/util/comparisons"() { return require("./node-lib-rest.js").sources["internal/util/comparisons"]; },
    get "internal/errors/error_source"() { return require("./node-lib-rest.js").sources["internal/errors/error_source"]; },
    get "internal/assert/assertion_error"() { return require("./node-lib-rest.js").sources["internal/assert/assertion_error"]; },
    get "internal/assert/myers_diff"() { return require("./node-lib-rest.js").sources["internal/assert/myers_diff"]; },
    get "internal/assert/utils"() { return require("./node-lib-rest.js").sources["internal/assert/utils"]; },
    get "internal/assert/calltracker"() { return require("./node-lib-rest.js").sources["internal/assert/calltracker"]; },
    get "assert"() { return require("./node-lib-rest.js").sources["assert"]; },
    get "internal/querystring"() { return require("./node-lib-rest.js").sources["internal/querystring"]; },
    get "querystring"() { return require("./node-lib-rest.js").sources["querystring"]; },
    get "punycode"() { return require("./node-lib-rest.js").sources["punycode"]; },
    get "internal/streams/utils"() { return require("./node-lib-rest.js").sources["internal/streams/utils"]; },
    get "internal/util/debuglog"() { return require("./node-lib-rest.js").sources["internal/util/debuglog"]; },
    get "internal/mime"() { return require("./node-lib-rest.js").sources["internal/mime"]; },
    get "internal/util/diff"() { return require("./node-lib-rest.js").sources["internal/util/diff"]; },
    get "internal/util/parse_args/utils"() { return require("./node-lib-rest.js").sources["internal/util/parse_args/utils"]; },
    get "internal/util/parse_args/parse_args"() { return require("./node-lib-rest.js").sources["internal/util/parse_args/parse_args"]; },
    get "internal/util/trace_sigint"() { return require("./node-lib-rest.js").sources["internal/util/trace_sigint"]; },
    get "internal/process/per_thread"() { return require("./node-lib-rest.js").sources["internal/process/per_thread"]; },
    get "util"() { return require("./node-lib-rest.js").sources["util"]; },
    get "dns"() { return require("./node-dns.js").sources["dns"]; },
    get "dns/promises"() { return require("./node-dns.js").sources["dns/promises"]; },
    get "internal/dns/utils"() { return require("./node-dns.js").sources["internal/dns/utils"]; },
    get "internal/dns/callback_resolver"() { return require("./node-dns.js").sources["internal/dns/callback_resolver"]; },
    get "internal/dns/promises"() { return require("./node-dns.js").sources["internal/dns/promises"]; },
    get "internal/net"() { return require("./node-dns.js").sources["internal/net"]; },
    get "internal/fs/cp/cp"() { return require("./node-cp.js").sources["internal/fs/cp/cp"]; },
    get "internal/fs/cp/cp-sync"() { return require("./node-cp.js").sources["internal/fs/cp/cp-sync"]; },
  },
};
