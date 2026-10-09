module.exports = {
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
    "internal/errors": { codes: nodeErrorCodes, hideStackFrames, isErrorStackTraceLimitWritable, isStackOverflowError, ErrnoException, ExceptionWithHostPort, AbortError },
    "internal/options": { getOptionValue: (name) => platform.optionValue(name) },
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
  const bindings = {
    util: utilBinding,
    config: { hasIntl: true },
    icu: icuBinding,
    constants: { os: { signals: platform.signals } },
    buffer: { compare: (a, b) => platform.Buffer.compare(a, b) },
    errors: { getErrorSourcePositions: (error) => platform.errorSourcePositions(error) },
    // Node's tracing is off: no category is enabled, and nothing traces.
    trace_events: { getCategoryEnabledBuffer: () => new Uint8Array(1), trace() {} },
  };
  const internalBinding = (name) => bindings[name];
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
  const ported = { "timers/promises": timersPromises, "internal/timers/legacy": legacyTimers };
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
    "internal/source_map/source_map": function (exports, require, module, process, internalBinding, primordials) {
// This file is a modified version of:
// https://cs.chromium.org/chromium/src/v8/tools/SourceMap.js?rcl=dd10454c1d
// from the V8 codebase. Logic specific to WebInspector is removed and linting
// is made to match the Node.js style guide.

// Copyright 2013 the V8 project authors. All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
//       copyright notice, this list of conditions and the following
//       disclaimer in the documentation and/or other materials provided
//       with the distribution.
//     * Neither the name of Google Inc. nor the names of its
//       contributors may be used to endorse or promote products derived
//       from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// This is a copy from blink dev tools, see:
// http://src.chromium.org/viewvc/blink/trunk/Source/devtools/front_end/SourceMap.js
// revision: 153407

/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

const {
  ArrayIsArray,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  ObjectPrototypeHasOwnProperty,
  StringPrototypeCharAt,
  Symbol,
} = primordials;

const { validateObject } = require('internal/validators');

let base64Map;

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE_MASK = (1 << 5) - 1;
const VLQ_CONTINUATION_MASK = 1 << 5;

const kMappings = Symbol('kMappings');

class StringCharIterator {
  /**
   * @constructor
   * @param {string} string
   */
  constructor(string) {
    this._string = string;
    this._position = 0;
  }

  /**
   * @return {string}
   */
  next() {
    return StringPrototypeCharAt(this._string, this._position++);
  }

  /**
   * @return {string}
   */
  peek() {
    return StringPrototypeCharAt(this._string, this._position);
  }

  /**
   * @return {boolean}
   */
  hasNext() {
    return this._position < this._string.length;
  }
}

/**
 * Implements Source Map V3 model.
 * See https://github.com/google/closure-compiler/wiki/Source-Maps
 * for format description.
 */
class SourceMap {
  #payload;
  #mappings = [];
  #sources = {};
  #sourceContentByURL = {};
  #lineLengths = undefined;

  /**
   * @constructor
   * @param {SourceMapV3} payload
   */
  constructor(payload, { lineLengths } = { __proto__: null }) {
    if (!base64Map) {
      const base64Digits =
             'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      base64Map = {};
      for (let i = 0; i < base64Digits.length; ++i)
        base64Map[base64Digits[i]] = i;
    }
    this.#payload = cloneSourceMapV3(payload);
    this.#parseMappingPayload();
    if (ArrayIsArray(lineLengths) && lineLengths.length) {
      this.#lineLengths = lineLengths;
    }
  }

  /**
   * @return {object} raw source map v3 payload.
   */
  get payload() {
    return cloneSourceMapV3(this.#payload);
  }

  get [kMappings]() {
    return this.#mappings;
  }

  /**
   * @return {number[] | undefined} line lengths of generated source code
   */
  get lineLengths() {
    if (this.#lineLengths) {
      return ArrayPrototypeSlice(this.#lineLengths);
    }
    return undefined;
  }

  #parseMappingPayload = () => {
    if (this.#payload.sections) {
      this.#parseSections(this.#payload.sections);
    } else {
      this.#parseMap(this.#payload, 0, 0);
    }
    ArrayPrototypeSort(this.#mappings, compareSourceMapEntry);
  };

  /**
   * @param {Array.<SourceMapV3.Section>} sections
   */
  #parseSections = (sections) => {
    for (let i = 0; i < sections.length; ++i) {
      const section = sections[i];
      this.#parseMap(section.map, section.offset.line, section.offset.column);
    }
  };

  /**
   * @param {number} lineOffset 0-indexed line offset in compiled resource
   * @param {number} columnOffset 0-indexed column offset in compiled resource
   * @return {object} representing start of range if found, or empty object
   */
  findEntry(lineOffset, columnOffset) {
    let first = 0;
    let count = this.#mappings.length;
    while (count > 1) {
      const step = count >> 1;
      const middle = first + step;
      const mapping = this.#mappings[middle];
      if (lineOffset < mapping[0] ||
          (lineOffset === mapping[0] && columnOffset < mapping[1])) {
        count = step;
      } else {
        first = middle;
        count -= step;
      }
    }
    const entry = this.#mappings[first];
    if (!first && entry && (lineOffset < entry[0] ||
        (lineOffset === entry[0] && columnOffset < entry[1]))) {
      return {};
    } else if (!entry) {
      return {};
    }
    return {
      generatedLine: entry[0],
      generatedColumn: entry[1],
      originalSource: entry[2],
      originalLine: entry[3],
      originalColumn: entry[4],
      name: entry[5],
    };
  }

  /**
   * @param {number} lineNumber 1-indexed line number in compiled resource call site
   * @param {number} columnNumber 1-indexed column number in compiled resource call site
   * @return {object} representing origin call site if found, or empty object
   */
  findOrigin(lineNumber, columnNumber) {
    const range = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (
      range.originalSource === undefined ||
      range.originalLine === undefined ||
      range.originalColumn === undefined ||
      range.generatedLine === undefined ||
      range.generatedColumn === undefined
    ) {
      return {};
    }
    const lineOffset = lineNumber - range.generatedLine;
    const columnOffset = columnNumber - range.generatedColumn;
    return {
      name: range.name,
      fileName: range.originalSource,
      lineNumber: range.originalLine + lineOffset,
      columnNumber: range.originalColumn + columnOffset,
    };
  }

  /**
   * @override
   */
  #parseMap(map, lineNumber, columnNumber) {
    let sourceIndex = 0;
    let sourceLineNumber = 0;
    let sourceColumnNumber = 0;
    let nameIndex = 0;

    const sources = [];
    const originalToCanonicalURLMap = {};
    for (let i = 0; i < map.sources.length; ++i) {
      const url = map.sources[i];
      originalToCanonicalURLMap[url] = url;
      ArrayPrototypePush(sources, url);
      this.#sources[url] = true;

      if (map.sourcesContent?.[i])
        this.#sourceContentByURL[url] = map.sourcesContent[i];
    }

    const stringCharIterator = new StringCharIterator(map.mappings);
    let sourceURL = sources[sourceIndex];
    while (true) {
      if (stringCharIterator.peek() === ',')
        stringCharIterator.next();
      else {
        while (stringCharIterator.peek() === ';') {
          lineNumber += 1;
          columnNumber = 0;
          stringCharIterator.next();
        }
        if (!stringCharIterator.hasNext())
          break;
      }

      columnNumber += decodeVLQ(stringCharIterator);
      if (isSeparator(stringCharIterator.peek())) {
        ArrayPrototypePush(this.#mappings, [lineNumber, columnNumber]);
        continue;
      }

      const sourceIndexDelta = decodeVLQ(stringCharIterator);
      if (sourceIndexDelta) {
        sourceIndex += sourceIndexDelta;
        sourceURL = sources[sourceIndex];
      }
      sourceLineNumber += decodeVLQ(stringCharIterator);
      sourceColumnNumber += decodeVLQ(stringCharIterator);

      let name;
      if (!isSeparator(stringCharIterator.peek())) {
        nameIndex += decodeVLQ(stringCharIterator);
        name = map.names?.[nameIndex];
      }

      ArrayPrototypePush(
        this.#mappings,
        [lineNumber, columnNumber, sourceURL, sourceLineNumber,
         sourceColumnNumber, name],
      );
    }
  }
}

/**
 * @param {string} char
 * @return {boolean}
 */
function isSeparator(char) {
  return char === ',' || char === ';';
}

/**
 * @param {SourceMap.StringCharIterator} stringCharIterator
 * @return {number}
 */
function decodeVLQ(stringCharIterator) {
  // Read unsigned value.
  let result = 0;
  let shift = 0;
  let digit;
  do {
    digit = base64Map[stringCharIterator.next()];
    result += (digit & VLQ_BASE_MASK) << shift;
    shift += VLQ_BASE_SHIFT;
  } while (digit & VLQ_CONTINUATION_MASK);

  // Fix the sign.
  const negative = result & 1;
  // Use unsigned right shift, so that the 32nd bit is properly shifted to the
  // 31st, and the 32nd becomes unset.
  result >>>= 1;
  if (!negative) {
    return result;
  }

  // We need to OR here to ensure the 32nd bit (the sign bit in an Int32) is
  // always set for negative numbers. If `result` were 1, (meaning `negate` is
  // true and all other bits were zeros), `result` would now be 0. But -0
  // doesn't flip the 32nd bit as intended. All other numbers will successfully
  // set the 32nd bit without issue, so doing this is a noop for them.
  return -result | (1 << 31);
}

/**
 * @param {SourceMapV3} payload
 * @return {SourceMapV3}
 */
function cloneSourceMapV3(payload) {
  validateObject(payload, 'payload');
  payload = { ...payload };
  for (const key in payload) {
    if (ObjectPrototypeHasOwnProperty(payload, key) &&
        ArrayIsArray(payload[key])) {
      payload[key] = ArrayPrototypeSlice(payload[key]);
    }
  }
  return payload;
}

/**
 * @param {Array} entry1 source map entry [lineNumber, columnNumber, sourceURL,
 *  sourceLineNumber, sourceColumnNumber]
 * @param {Array} entry2 source map entry.
 * @return {number}
 */
function compareSourceMapEntry(entry1, entry2) {
  const { 0: lineNumber1, 1: columnNumber1 } = entry1;
  const { 0: lineNumber2, 1: columnNumber2 } = entry2;
  if (lineNumber1 !== lineNumber2) {
    return lineNumber1 - lineNumber2;
  }
  return columnNumber1 - columnNumber2;
}

module.exports = {
  kMappings,
  SourceMap,
};

    },
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
    "internal/util/colors": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

let internalTTy;
function lazyInternalTTY() {
  internalTTy ??= require('internal/tty');
  return internalTTy;
}

module.exports = {
  blue: '',
  green: '',
  white: '',
  red: '',
  gray: '',
  clear: '',
  reset: '',
  hasColors: false,
  shouldColorize(stream) {
    if (process.env.FORCE_COLOR !== undefined) {
      return lazyInternalTTY().getColorDepth() > 2;
    }
    return stream?.isTTY && (
      typeof stream.getColorDepth === 'function' ?
        stream.getColorDepth() > 2 : true);
  },
  refresh() {
    const hasColors = module.exports.shouldColorize(process.stderr);
    module.exports.blue = hasColors ? '\u001b[34m' : '';
    module.exports.green = hasColors ? '\u001b[32m' : '';
    module.exports.white = hasColors ? '\u001b[39m' : '';
    module.exports.yellow = hasColors ? '\u001b[33m' : '';
    module.exports.red = hasColors ? '\u001b[31m' : '';
    module.exports.gray = hasColors ? '\u001b[90m' : '';
    module.exports.clear = hasColors ? '\u001bc' : '';
    module.exports.reset = hasColors ? '\u001b[0m' : '';
    module.exports.hasColors = hasColors;
  },
};

module.exports.refresh();

    },
    "internal/util/comparisons": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Array,
  ArrayBuffer,
  ArrayIsArray,
  ArrayPrototypeFilter,
  ArrayPrototypePush,
  BigInt,
  BigInt64Array,
  BigIntPrototypeValueOf,
  BigUint64Array,
  Boolean,
  BooleanPrototypeValueOf,
  DataView,
  Date,
  DatePrototypeGetTime,
  Error,
  Float32Array,
  Float64Array,
  Function,
  Int16Array,
  Int32Array,
  Int8Array,
  Map,
  Number,
  NumberPrototypeValueOf,
  Object,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertySymbols: getOwnSymbols,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty: hasOwn,
  ObjectPrototypePropertyIsEnumerable: hasEnumerable,
  ObjectPrototypeToString,
  Promise,
  RegExp,
  SafeSet,
  Set,
  String,
  StringPrototypeValueOf,
  Symbol,
  SymbolPrototypeValueOf,
  TypedArrayPrototypeGetByteLength: getByteLength,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
  WeakMap,
  WeakSet,
  globalThis: { Float16Array },
} = primordials;

const { compare } = internalBinding('buffer');
const assert = require('internal/assert');
const { isError } = require('internal/util');
const { isURL } = require('internal/url');
const { Buffer } = require('buffer');

const wellKnownConstructors = new SafeSet()
  .add(Array)
  .add(ArrayBuffer)
  .add(BigInt)
  .add(BigInt64Array)
  .add(BigUint64Array)
  .add(Boolean)
  .add(Buffer)
  .add(DataView)
  .add(Date)
  .add(Error)
  .add(Float32Array)
  .add(Float64Array)
  .add(Function)
  .add(Int16Array)
  .add(Int32Array)
  .add(Int8Array)
  .add(Map)
  .add(Number)
  .add(Object)
  .add(Promise)
  .add(RegExp)
  .add(Set)
  .add(String)
  .add(Symbol)
  .add(Uint16Array)
  .add(Uint32Array)
  .add(Uint8Array)
  .add(Uint8ClampedArray)
  .add(WeakMap)
  .add(WeakSet);

if (Float16Array) { // TODO(BridgeAR): Remove when regularly supported
  wellKnownConstructors.add(Float16Array);
}

const types = require('internal/util/types');
const {
  isAnyArrayBuffer,
  isArrayBufferView,
  isDate,
  isMap,
  isRegExp,
  isSet,
  isNativeError,
  isBoxedPrimitive,
  isNumberObject,
  isStringObject,
  isBooleanObject,
  isBigIntObject,
  isSymbolObject,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isKeyObject,
  isCryptoKey,
  isWeakMap,
  isWeakSet,
} = types;
const {
  constants: {
    ONLY_ENUMERABLE,
    SKIP_SYMBOLS,
  },
  getOwnNonIndexProperties,
} = internalBinding('util');

const kStrict = 1;
const kLoose = 0;
const kPartial = 2;

const kNoIterator = 0;
const kIsArray = 1;
const kIsSet = 2;
const kIsMap = 3;

let kKeyObject;

// Check if they have the same source and flags
function areSimilarRegExps(a, b) {
  return a.source === b.source &&
         a.flags === b.flags &&
         a.lastIndex === b.lastIndex;
}

function isPartialUint8Array(a, b) {
  const lenA = getByteLength(a);
  const lenB = getByteLength(b);
  if (lenA < lenB) {
    return false;
  }
  let offsetA = 0;
  for (let offsetB = 0; offsetB < lenB; offsetB++) {
    while (!ObjectIs(a[offsetA], b[offsetB])) {
      offsetA++;
      if (offsetA > lenA - lenB + offsetB) {
        return false;
      }
    }
    offsetA++;
  }
  return true;
}

function isPartialArrayBufferView(a, b) {
  if (a.byteLength < b.byteLength) {
    return false;
  }
  return isPartialUint8Array(
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
  );
}

function areSimilarFloatArrays(a, b) {
  const len = getByteLength(a);
  if (len !== getByteLength(b)) {
    return false;
  }
  for (let offset = 0; offset < len; offset++) {
    if (a[offset] !== b[offset]) {
      return false;
    }
  }
  return true;
}

function areSimilarTypedArrays(a, b) {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return compare(new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
                 new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

function areEqualArrayBuffers(buf1, buf2) {
  return buf1.byteLength === buf2.byteLength &&
    compare(new Uint8Array(buf1), new Uint8Array(buf2)) === 0;
}

function isEqualBoxedPrimitive(val1, val2) {
  if (isNumberObject(val1)) {
    return isNumberObject(val2) &&
           ObjectIs(NumberPrototypeValueOf(val1),
                    NumberPrototypeValueOf(val2));
  }
  if (isStringObject(val1)) {
    return isStringObject(val2) &&
           StringPrototypeValueOf(val1) === StringPrototypeValueOf(val2);
  }
  if (isBooleanObject(val1)) {
    return isBooleanObject(val2) &&
           BooleanPrototypeValueOf(val1) === BooleanPrototypeValueOf(val2);
  }
  if (isBigIntObject(val1)) {
    return isBigIntObject(val2) &&
           BigIntPrototypeValueOf(val1) === BigIntPrototypeValueOf(val2);
  }
  if (isSymbolObject(val1)) {
    return isSymbolObject(val2) &&
          SymbolPrototypeValueOf(val1) === SymbolPrototypeValueOf(val2);
  }
  /* c8 ignore next */
  assert.fail(`Unknown boxed type ${val1}`);
}

function isEnumerableOrIdentical(val1, val2, prop, mode, memos, method) {
  return hasEnumerable(val2, prop) || // This is handled by Object.keys()
      (mode === kPartial && (val2[prop] === undefined || (prop === 'message' && val2[prop] === ''))) ||
      innerDeepEqual(val1[prop], val2[prop], mode, memos);
}

function innerDeepEqual(val1, val2, mode, memos) {
  // All identical values are equivalent, as determined by ===.
  if (val1 === val2) {
    return val1 !== 0 || ObjectIs(val1, val2) || mode === kLoose;
  }

  // Check more closely if val1 and val2 are equal.
  if (mode !== kLoose) {
    if (typeof val1 === 'number') {
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      return val1 !== val1 && val2 !== val2;
    }
    if (typeof val2 !== 'object' ||
        typeof val1 !== 'object' ||
        val1 === null ||
        val2 === null) {
      return false;
    }
  } else {
    if (val1 === null || typeof val1 !== 'object') {
      return (val2 === null || typeof val2 !== 'object') &&
             // Check for NaN
             // eslint-disable-next-line eqeqeq, no-self-compare
             (val1 == val2 || (val1 !== val1 && val2 !== val2));
    }
    if (val2 === null || typeof val2 !== 'object') {
      return false;
    }
  }
  return objectComparisonStart(val1, val2, mode, memos);
}

function objectComparisonStart(val1, val2, mode, memos) {
  if (mode === kStrict) {
    if (wellKnownConstructors.has(val1.constructor) ||
        (val1.constructor !== undefined && !hasOwn(val1, 'constructor'))) {
      if (val1.constructor !== val2.constructor) {
        return false;
      }
    } else if (ObjectGetPrototypeOf(val1) !== ObjectGetPrototypeOf(val2)) {
      return false;
    }
  }

  const val1Tag = ObjectPrototypeToString(val1);
  const val2Tag = ObjectPrototypeToString(val2);

  if (val1Tag !== val2Tag) {
    return false;
  }

  if (ArrayIsArray(val1)) {
    if (!ArrayIsArray(val2) ||
        (val1.length !== val2.length && (mode !== kPartial || val1.length < val2.length))) {
      return false;
    }

    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsArray, keys2);
  } else if (val1Tag === '[object Object]') {
    return keyCheck(val1, val2, mode, memos, kNoIterator);
  } else if (isDate(val1)) {
    if (!isDate(val2) ||
        DatePrototypeGetTime(val1) !== DatePrototypeGetTime(val2)) {
      return false;
    }
  } else if (isRegExp(val1)) {
    if (!isRegExp(val2) || !areSimilarRegExps(val1, val2)) {
      return false;
    }
  } else if (isArrayBufferView(val1)) {
    if (TypedArrayPrototypeGetSymbolToStringTag(val1) !==
        TypedArrayPrototypeGetSymbolToStringTag(val2)) {
      return false;
    }
    if (mode === kPartial && val1.byteLength !== val2.byteLength) {
      if (!isPartialArrayBufferView(val1, val2)) {
        return false;
      }
    } else if (mode === kLoose &&
               (isFloat32Array(val1) || isFloat64Array(val1) || isFloat16Array(val1))) {
      if (!areSimilarFloatArrays(val1, val2)) {
        return false;
      }
    } else if (!areSimilarTypedArrays(val1, val2)) {
      return false;
    }
    // Buffer.compare returns true, so val1.length === val2.length. If they both
    // only contain numeric keys, we don't need to exam further than checking
    // the symbols.
    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kNoIterator, keys2);
  } else if (isSet(val1)) {
    if (!isSet(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size))) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsSet);
  } else if (isMap(val1)) {
    if (!isMap(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size))) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsMap);
  } else if (isAnyArrayBuffer(val1)) {
    if (!isAnyArrayBuffer(val2)) {
      return false;
    }
    if (mode !== kPartial || val1.byteLength === val2.byteLength) {
      if (!areEqualArrayBuffers(val1, val2)) {
        return false;
      }
    } else if (!isPartialUint8Array(new Uint8Array(val1), new Uint8Array(val2))) {
      return false;
    }
  } else if (isError(val1)) {
    // Do not compare the stack as it might differ even though the error itself
    // is otherwise identical.
    if (!isError(val2) ||
        !isEnumerableOrIdentical(val1, val2, 'message', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'name', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'cause', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'errors', mode, memos)) {
      return false;
    }
    const hasOwnVal2Cause = hasOwn(val2, 'cause');
    if ((hasOwnVal2Cause !== hasOwn(val1, 'cause') && (mode !== kPartial || hasOwnVal2Cause))) {
      return false;
    }
  } else if (isBoxedPrimitive(val1)) {
    if (!isEqualBoxedPrimitive(val1, val2)) {
      return false;
    }
  } else if (ArrayIsArray(val2) ||
             isArrayBufferView(val2) ||
             isSet(val2) ||
             isMap(val2) ||
             isDate(val2) ||
             isRegExp(val2) ||
             isAnyArrayBuffer(val2) ||
             isBoxedPrimitive(val2) ||
             isNativeError(val2) ||
             val2 instanceof Error) {
    return false;
  } else if (isURL(val1)) {
    if (!isURL(val2) || val1.href !== val2.href) {
      return false;
    }
  } else if (isKeyObject(val1)) {
    if (!isKeyObject(val2) || !val1.equals(val2)) {
      return false;
    }
  } else if (isCryptoKey(val1)) {
    kKeyObject ??= require('internal/crypto/util').kKeyObject;
    if (!isCryptoKey(val2) ||
      val1.extractable !== val2.extractable ||
      !innerDeepEqual(val1.algorithm, val2.algorithm, mode, memos) ||
      !innerDeepEqual(val1.usages, val2.usages, mode, memos) ||
      !innerDeepEqual(val1[kKeyObject], val2[kKeyObject], mode, memos)
    ) {
      return false;
    }
  } else if (isWeakMap(val1) || isWeakSet(val1)) {
    return false;
  }

  return keyCheck(val1, val2, mode, memos, kNoIterator);
}

function getEnumerables(val, keys) {
  return ArrayPrototypeFilter(keys, (key) => hasEnumerable(val, key));
}

function partialSymbolEquiv(val1, val2, keys2) {
  const symbolKeys = getOwnSymbols(val2);
  if (symbolKeys.length !== 0) {
    for (const key of symbolKeys) {
      if (hasEnumerable(val2, key)) {
        if (!hasEnumerable(val1, key)) {
          return false;
        }
        ArrayPrototypePush(keys2, key);
      }
    }
  }
  return true;
}

function keyCheck(val1, val2, mode, memos, iterationType, keys2) {
  // For all remaining Object pairs, including Array, objects and Maps,
  // equivalence is determined by having:
  // a) The same number of owned enumerable properties
  // b) The same set of keys/indexes (although not necessarily the same order)
  // c) Equivalent values for every corresponding key/index
  // d) For Sets and Maps, equal contents
  // Note: this accounts for both named and indexed properties on Arrays.
  const isArrayLikeObject = keys2 !== undefined;

  if (keys2 === undefined) {
    keys2 = ObjectKeys(val2);
  }
  let keys1;

  if (!isArrayLikeObject) {
    // The pair must have the same number of owned properties.
    if (mode === kPartial) {
      if (!partialSymbolEquiv(val1, val2, keys2)) {
        return false;
      }
    } else if (keys2.length !== (keys1 = ObjectKeys(val1)).length) {
      return false;
    } else if (mode === kStrict) {
      const symbolKeysA = getOwnSymbols(val1);
      if (symbolKeysA.length !== 0) {
        let count = 0;
        for (const key of symbolKeysA) {
          if (hasEnumerable(val1, key)) {
            if (!hasEnumerable(val2, key)) {
              return false;
            }
            ArrayPrototypePush(keys2, key);
            count++;
          } else if (hasEnumerable(val2, key)) {
            return false;
          }
        }
        const symbolKeysB = getOwnSymbols(val2);
        if (symbolKeysA.length !== symbolKeysB.length &&
            getEnumerables(val2, symbolKeysB).length !== count) {
          return false;
        }
      } else {
        const symbolKeysB = getOwnSymbols(val2);
        if (symbolKeysB.length !== 0 &&
            getEnumerables(val2, symbolKeysB).length !== 0) {
          return false;
        }
      }
    }
  }

  if (keys2.length === 0 &&
      (iterationType === kNoIterator ||
        (iterationType === kIsArray && val2.length === 0) ||
        val2.size === 0)) {
    return true;
  }

  if (memos === null) {
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }
  return handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType);
}

function handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType) {
  // Use memos to handle cycles.
  if (memos === undefined) {
    memos = {
      set: undefined,
      a: val1,
      b: val2,
      c: undefined,
      d: undefined,
      deep: false,
    };
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }

  if (memos.set === undefined) {
    if (memos.deep === false) {
      if (memos.a === val1) {
        if (memos.b === val2) return true;
      }
      memos.c = val1;
      memos.d = val2;
      memos.deep = true;
      const result = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
      memos.deep = false;
      return result;
    }
    memos.set = new SafeSet();
    memos.set.add(memos.a);
    memos.set.add(memos.b);
    memos.set.add(memos.c);
    memos.set.add(memos.d);
  }

  const { set } = memos;

  const originalSize = set.size;
  set.add(val1);
  set.add(val2);
  if (originalSize === set.size) {
    return true;
  }

  const areEq = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);

  set.delete(val1);
  set.delete(val2);

  return areEq;
}

// See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness#Loose_equality_using
// Sadly it is not possible to detect corresponding values properly in case the
// type is a string, number, bigint or boolean. The reason is that those values
// can match lots of different string values (e.g., 1n == '+00001').
function findLooseMatchingPrimitives(prim) {
  switch (typeof prim) {
    case 'undefined':
      return null;
    case 'object': // Only pass in null as object!
      return undefined;
    case 'symbol':
      return false;
    case 'string':
      prim = +prim;
      // Loose equal entries exist only if the string is possible to convert to
      // a regular number and not NaN.
      // Fall through
    case 'number':
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      if (prim !== prim) {
        return false;
      }
  }
  return true;
}

function setMightHaveLoosePrim(a, b, prim) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null)
    return altValue;

  return !b.has(altValue) && a.has(altValue);
}

function mapMightHaveLoosePrim(a, b, prim, item2, memo) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null) {
    return altValue;
  }
  const item1 = a.get(altValue);
  if ((item1 === undefined && !a.has(altValue)) ||
      !innerDeepEqual(item1, item2, kLoose, memo)) {
    return false;
  }
  return !b.has(altValue) && innerDeepEqual(item1, item2, kLoose, memo);
}

function partialObjectSetEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const val1 of a) {
    aPos++;
    if (!b.has(val1)) {
      let innerStart = start;
      if (direction === 1) {
        if (innerDeepEqual(val1, array[start], mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of set b might match a later element in set a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      if (!innerDeepEqual(val1, array[end], mode, memo)) {
        direction = 1;
        matched = arrayHasEqualElement(array, val1, mode, memo, innerDeepEqual, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualElement(array, val1, mode, memo, comparator, start, end) {
  let matched = false;
  for (let i = end - 1; i >= start; i--) {
    if (comparator(val1, array[i], mode, memo)) {
      // Remove the matching element to make sure we do not check that again.
      array.splice(i, 1);
      matched = true;
      break;
    }
  }
  return matched;
}

function setObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;
  const extraChecks = mode === kLoose || array.length !== a.size;
  for (const val1 of a) {
    if (extraChecks) {
      if (typeof val1 === 'object') {
        if (b.has(val1)) {
          continue;
        }
      } else if (b.has(val1)) {
        continue;
      } else if (mode !== kLoose) {
        return false;
      }
    }

    let innerStart = start;
    if (direction === 1) {
      if (comparator(val1, array[start], mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    if (!comparator(val1, array[end], mode, memo)) {
      direction = 1;
      if (!arrayHasEqualElement(array, val1, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function compareSmallSets(a, b, val, iteratorB, mode, memo) {
  const iteratorA = a.values();
  const firstA = iteratorA.next().value;
  const first = innerDeepEqual(firstA, val, mode, memo);
  if (first) {
    if (b.size === 1) { // Partial mode && a.size === 1 || b.size === 1
      return true;
    }
    const secondA = iteratorA.next().value;
    return b.has(secondA) || innerDeepEqual(secondA, iteratorB.next().value, mode, memo);
  }
  return a.size !== 1 && innerDeepEqual(iteratorA.next().value, val, mode, memo) && (
    b.size === 1 || // Partial mode
    b.has(firstA) || // Primitive or reference equal
    innerDeepEqual(firstA, iteratorB.next().value, mode, memo)
  );
}

function setEquiv(a, b, mode, memo) {
  // This is a lazily initiated Set of entries which have to be compared
  // pairwise.
  let array;

  const iteratorB = b.values();
  for (const val of iteratorB) {
    if (!a.has(val)) {
      if ((typeof val !== 'object' || val === null) &&
          (mode !== kLoose || !setMightHaveLoosePrim(a, b, val))) {
        return false;
      }

      if (array === undefined) {
        if (a.size < 3) {
          return compareSmallSets(a, b, val, iteratorB, mode, memo);
        }
        array = [];
      }
      // If the specified value doesn't exist in the second set it's a object
      // (or in loose mode: a non-matching primitive). Find the
      // deep-(mode-)equal element in a set copy to reduce duplicate checks.
      array.push(val);
    }
  }

  if (array === undefined) {
    return true;
  }
  if (mode === kPartial) {
    return partialObjectSetEquiv(array, a, b, mode, memo);
  }
  return setObjectEquiv(array, a, b, mode, memo);
}

function partialObjectMapEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const { 0: key1, 1: item1 } of a) {
    aPos++;
    if (typeof key1 === 'object' && key1 !== null) {
      let innerStart = start;
      if (direction === 1) {
        const key2 = array[start];
        if (objectComparisonStart(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of map b might match a later element in map a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      const key2 = array[end];
      if (!objectComparisonStart(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo)) {
        direction = 1;
        matched = arrayHasEqualMapElement(array, key1, item1, b, mode, memo, objectComparisonStart, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, start, end) {
  let matched = false;
  for (let i = end - 1; i >= start; i--) {
    const key2 = array[i];
    if (comparator(key1, key2, mode, memo) &&
        innerDeepEqual(item1, b.get(key2), mode, memo)) {
      // Remove the matching element to make sure we do not check that again.
      array.splice(i, 1);
      matched = true;
      break;
    }
  }
  return matched;
}

function mapObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;
  const extraChecks = mode === kLoose || array.length !== a.size;

  for (const { 0: key1, 1: item1 } of a) {
    if (extraChecks && (typeof key1 !== 'object' || key1 === null)) {
      if (b.has(key1)) {
        if (mode !== kLoose || innerDeepEqual(item1, b.get(key1), mode, memo)) {
          continue;
        }
      } else if (mode !== kLoose) {
        return false;
      }
    }

    let innerStart = start;
    if (direction === 1) {
      const key2 = array[start];
      if (comparator(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    const key2 = array[end];
    if ((!comparator(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo))) {
      direction = 1;
      if (!arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function mapEquiv(a, b, mode, memo) {
  let array;

  for (const { 0: key2, 1: item2 } of b) {
    if (typeof key2 === 'object' && key2 !== null) {
      if (array === undefined) {
        if (a.size === 1) {
          const { 0: key1, 1: item1 } = a.entries().next().value;
          return innerDeepEqual(key1, key2, mode, memo) &&
                  innerDeepEqual(item1, item2, mode, memo);
        }
        array = [];
      }
      array.push(key2);
    } else {
      // By directly retrieving the value we prevent another b.has(key2) check in
      // almost all possible cases.
      const item1 = a.get(key2);
      if (((item1 === undefined && !a.has(key2)) ||
          !innerDeepEqual(item1, item2, mode, memo))) {
        if (mode !== kLoose)
          return false;
        // Fast path to detect missing string, symbol, undefined and null
        // keys.
        if (!mapMightHaveLoosePrim(a, b, key2, item2, memo))
          return false;
        if (array === undefined) {
          array = [];
        }
        array.push(key2);
      }
    }
  }

  if (array === undefined) {
    return true;
  }

  if (mode === kPartial) {
    return partialObjectMapEquiv(array, a, b, mode, memo);
  }

  return mapObjectEquiv(array, a, b, mode, memo);
}

function partialSparseArrayEquiv(a, b, mode, memos, startA, startB) {
  let aPos = 0;
  const keysA = ObjectKeys(a).slice(startA);
  const keysB = ObjectKeys(b).slice(startB);
  if (keysA.length < keysB.length) {
    return false;
  }
  for (let i = 0; i < keysB.length; i++) {
    const keyB = keysB[i];
    while (!innerDeepEqual(a[keysA[aPos]], b[keyB], mode, memos)) {
      aPos++;
      if (aPos > keysA.length - keysB.length + i) {
        return false;
      }
    }
    aPos++;
  }
  return true;
}

function partialArrayEquiv(a, b, mode, memos) {
  let aPos = 0;
  for (let i = 0; i < b.length; i++) {
    let isSparse = b[i] === undefined && !hasOwn(b, i);
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    while (!(isSparse = a[aPos] === undefined && !hasOwn(a, aPos)) &&
           !innerDeepEqual(a[aPos], b[i], mode, memos)) {
      aPos++;
      if (aPos > a.length - b.length + i) {
        return false;
      }
    }
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    aPos++;
  }
  return true;
}

function sparseArrayEquiv(a, b, mode, memos, i) {
  // TODO(BridgeAR): Use internal method to only get index properties. The
  // same applies to the partial implementation.
  const keysA = ObjectKeys(a);
  const keysB = ObjectKeys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (; i < keysB.length; i++) {
    const key = keysB[i];
    if ((a[key] === undefined && !hasOwn(a, key)) || !innerDeepEqual(a[key], b[key], mode, memos)) {
      return false;
    }
  }
  return true;
}

function objEquiv(a, b, mode, keys1, keys2, memos, iterationType) {
  // The pair must have equivalent values for every corresponding key.
  if (keys2.length > 0) {
    let i = 0;
    // Ordered keys
    if (keys1 !== undefined) {
      for (; i < keys2.length; i++) {
        const key = keys2[i];
        if (keys1[i] !== key) {
          break;
        }
        if (!innerDeepEqual(a[key], b[key], mode, memos)) {
          return false;
        }
      }
    }
    // Unordered keys
    for (; i < keys2.length; i++) {
      const key = keys2[i];
      // It is faster to get the whole descriptor and to check it's enumerable
      // property in V8 13.0 compared to calling Object.propertyIsEnumerable()
      // and accessing the property regularly.
      const descriptor = ObjectGetOwnPropertyDescriptor(a, key);
      if (!descriptor?.enumerable ||
          !innerDeepEqual(descriptor.value !== undefined ? descriptor.value : a[key], b[key], mode, memos)) {
        return false;
      }
    }
  }

  if (iterationType === kIsArray) {
    if (mode === kPartial) {
      return partialArrayEquiv(a, b, mode, memos);
    }
    for (let i = 0; i < a.length; i++) {
      if (b[i] === undefined) {
        if (!hasOwn(b, i))
          return sparseArrayEquiv(a, b, mode, memos, i);
        if (a[i] !== undefined || !hasOwn(a, i))
          return false;
      } else if (a[i] === undefined || !innerDeepEqual(a[i], b[i], mode, memos)) {
        return false;
      }
    }
  } else if (iterationType === kIsSet) {
    if (!setEquiv(a, b, mode, memos)) {
      return false;
    }
  } else if (iterationType === kIsMap) {
    if (!mapEquiv(a, b, mode, memos)) {
      return false;
    }
  }

  return true;
}

// Only handle cycles when they are detected.
// eslint-disable-next-line func-style
let detectCycles = function(val1, val2, mode) {
  try {
    return innerDeepEqual(val1, val2, mode, null);
  } catch {
    detectCycles = innerDeepEqual;
    return innerDeepEqual(val1, val2, mode, undefined);
  }
};

module.exports = {
  isDeepEqual(val1, val2) {
    return detectCycles(val1, val2, kLoose);
  },
  isDeepStrictEqual(val1, val2) {
    return detectCycles(val1, val2, kStrict);
  },
  isPartialStrictEqual(val1, val2) {
    return detectCycles(val1, val2, kPartial);
  },
};

    },
    "internal/errors/error_source": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  FunctionPrototypeBind,
  StringPrototypeSlice,
} = primordials;

const {
  getErrorSourcePositions,
} = internalBinding('errors');
const {
  getSourceMapsSupport,
  findSourceMap,
  getSourceLine,
} = require('internal/source_map/source_map_cache');

/**
 * Get the source location of an error. If source map is enabled, resolve the source location
 * based on the source map.
 *
 * The `error.stack` must not have been accessed. The resolution is based on the structured
 * error stack data.
 * @param {Error|object} error An error object, or an object being invoked with ErrorCaptureStackTrace
 * @returns {{sourceLine: string, startColumn: number}|undefined}
 */
function getErrorSourceLocation(error) {
  const pos = getErrorSourcePositions(error);
  const {
    sourceLine,
    scriptResourceName,
    lineNumber,
    startColumn,
  } = pos;

  // Source map is not enabled. Return the source line directly.
  if (!getSourceMapsSupport().enabled) {
    return { sourceLine, startColumn };
  }

  const sm = findSourceMap(scriptResourceName);
  if (sm === undefined) {
    return;
  }
  const {
    originalLine,
    originalColumn,
    originalSource,
  } = sm.findEntry(lineNumber - 1, startColumn);
  const originalSourceLine = getSourceLine(sm, originalSource, originalLine, originalColumn);

  if (!originalSourceLine) {
    return;
  }

  return {
    sourceLine: originalSourceLine,
    startColumn: originalColumn,
  };
}

const memberAccessTokens = [ '.', '?.', '[', ']' ];
const memberNameTokens = [ 'name', 'string', 'num' ];
let tokenizer;
/**
 * Get the first expression in a code string at the startColumn.
 * @param {string} code source code line
 * @param {number} startColumn which column the error is constructed
 * @returns {string}
 */
function getFirstExpression(code, startColumn) {
  // Lazy load acorn.
  if (tokenizer === undefined) {
    const Parser = require('internal/deps/acorn/acorn/dist/acorn').Parser;
    tokenizer = FunctionPrototypeBind(Parser.tokenizer, Parser);
  }

  let lastToken;
  let firstMemberAccessNameToken;
  let terminatingCol;
  let parenLvl = 0;
  // Tokenize the line to locate the expression at the startColumn.
  // The source line may be an incomplete JavaScript source, so do not parse the source line.
  for (const token of tokenizer(code, { ecmaVersion: 'latest' })) {
    // Peek before the startColumn.
    if (token.start < startColumn) {
      // There is a semicolon. This is a statement before the startColumn, so reset the memo.
      if (token.type.label === ';') {
        firstMemberAccessNameToken = null;
        continue;
      }
      // Try to memo the member access expressions before the startColumn, so that the
      // returned source code contains more info:
      //   assert.ok(value)
      //          ^ startColumn
      // The member expression can also be like
      //   assert['ok'](value) or assert?.ok(value)
      //               ^ startColumn      ^ startColumn
      if (memberAccessTokens.includes(token.type.label) && lastToken?.type.label === 'name') {
        // First member access name token must be a 'name'.
        firstMemberAccessNameToken ??= lastToken;
      } else if (!memberAccessTokens.includes(token.type.label) &&
        !memberNameTokens.includes(token.type.label)) {
        // Reset the memo if it is not a simple member access.
        // For example: assert[(() => 'ok')()](value)
        //                                    ^ startColumn
        firstMemberAccessNameToken = null;
      }
      lastToken = token;
      continue;
    }
    // Now after the startColumn, this must be an expression.
    if (token.type.label === '(') {
      parenLvl++;
      continue;
    }
    if (token.type.label === ')') {
      parenLvl--;
      if (parenLvl === 0) {
        // A matched closing parenthesis found after the startColumn,
        // terminate here. Include the token.
        //   (assert.ok(false), assert.ok(true))
        //           ^ startColumn
        terminatingCol = token.start + 1;
        break;
      }
      continue;
    }
    if (token.type.label === ';') {
      // A semicolon found after the startColumn, terminate here.
      //   assert.ok(false); assert.ok(true));
      //          ^ startColumn
      terminatingCol = token;
      break;
    }
    // If no semicolon found after the startColumn. The string after the
    // startColumn must be the expression.
    //   assert.ok(false)
    //          ^ startColumn
  }
  const start = firstMemberAccessNameToken?.start ?? startColumn;
  return StringPrototypeSlice(code, start, terminatingCol);
}

/**
 * Get the source expression of an error. If source map is enabled, resolve the source location
 * based on the source map.
 *
 * The `error.stack` must not have been accessed, or the source location may be incorrect. The
 * resolution is based on the structured error stack data.
 * @param {Error|object} error An error object, or an object being invoked with ErrorCaptureStackTrace
 * @returns {string|undefined}
 */
function getErrorSourceExpression(error) {
  const loc = getErrorSourceLocation(error);
  if (loc === undefined) {
    return;
  }
  const { sourceLine, startColumn } = loc;
  return getFirstExpression(sourceLine, startColumn);
}

module.exports = {
  getErrorSourceLocation,
  getErrorSourceExpression,
};

    },
    "internal/assert/assertion_error": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeJoin,
  ArrayPrototypePop,
  ArrayPrototypeSlice,
  Error,
  ErrorCaptureStackTrace,
  ObjectAssign,
  ObjectDefineProperty,
  ObjectGetPrototypeOf,
  ObjectPrototypeHasOwnProperty,
  SafeSet,
  String,
  StringPrototypeRepeat,
  StringPrototypeSlice,
  StringPrototypeSplit,
} = primordials;

const { isError } = require('internal/util');

const { inspect } = require('internal/util/inspect');
const colors = require('internal/util/colors');
const { validateObject } = require('internal/validators');
const { isErrorStackTraceLimitWritable } = require('internal/errors');
const { myersDiff, printMyersDiff, printSimpleMyersDiff } = require('internal/assert/myers_diff');

const kReadableOperator = {
  deepStrictEqual: 'Expected values to be strictly deep-equal:',
  partialDeepStrictEqual: 'Expected values to be partially and strictly deep-equal:',
  strictEqual: 'Expected values to be strictly equal:',
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: 'Expected values to be loosely deep-equal:',
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject:
    'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: 'Values have same structure but are not reference-equal:',
  notDeepEqualUnequal: 'Expected values not to be loosely deep-equal:',
};

const kMaxShortStringLength = 12;
const kMaxLongStringLength = 512;

const kMethodsWithCustomMessageDiff = new SafeSet()
  .add('deepStrictEqual')
  .add('strictEqual')
  .add('partialDeepStrictEqual');

function copyError(source) {
  const target = ObjectAssign(
    { __proto__: ObjectGetPrototypeOf(source) },
    source,
  );
  ObjectDefineProperty(target, 'message', {
    __proto__: null,
    value: source.message,
  });
  if (ObjectPrototypeHasOwnProperty(source, 'cause')) {
    let { cause } = source;

    if (isError(cause)) {
      cause = copyError(cause);
    }

    ObjectDefineProperty(target, 'cause', { __proto__: null, value: cause });
  }
  return target;
}

function inspectValue(val) {
  // The util.inspect default values could be changed. This makes sure the
  // error messages contain the necessary information nevertheless.
  return inspect(val, {
    compact: false,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Infinity,
    // Assert compares only enumerable properties (with a few exceptions).
    showHidden: false,
    // Assert does not detect proxies currently.
    showProxy: false,
    sorted: true,
    // Inspect getters as we also check them when comparing entries.
    getters: true,
  });
}

function getErrorMessage(operator, message) {
  return message || kReadableOperator[operator];
}

function checkOperator(actual, expected, operator) {
  // In case both values are objects or functions explicitly mark them as not
  // reference equal for the `strictEqual` operator.
  if (
    operator === 'strictEqual' &&
    ((typeof actual === 'object' &&
      actual !== null &&
      typeof expected === 'object' &&
      expected !== null) ||
      (typeof actual === 'function' && typeof expected === 'function'))
  ) {
    operator = 'strictEqualObject';
  }

  return operator;
}

function getColoredMyersDiff(actual, expected) {
  const header = `${colors.green}actual${colors.white} ${colors.red}expected${colors.white}`;
  const skipped = false;

  const diff = myersDiff(StringPrototypeSplit(actual, ''), StringPrototypeSplit(expected, ''));
  let message = printSimpleMyersDiff(diff);

  if (skipped) {
    message += '...';
  }

  return { message, header, skipped };
}

function getStackedDiff(actual, expected) {
  const isStringComparison = typeof actual === 'string' && typeof expected === 'string';

  let message = `\n${colors.green}+${colors.white} ${actual}\n${colors.red}- ${colors.white}${expected}`;
  const stringsLen = actual.length + expected.length;
  const maxTerminalLength = process.stderr.isTTY ? process.stderr.columns : 80;
  const showIndicator = isStringComparison && (stringsLen <= maxTerminalLength);

  if (showIndicator) {
    let indicatorIdx = -1;

    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        // Skip the indicator for the first 2 characters because the diff is immediately apparent
        // It is 3 instead of 2 to account for the quotes
        if (i >= 3) {
          indicatorIdx = i;
        }
        break;
      }
    }

    if (indicatorIdx !== -1) {
      message += `\n${StringPrototypeRepeat(' ', indicatorIdx + 2)}^`;
    }
  }

  return { message };
}

function getSimpleDiff(originalActual, actual, originalExpected, expected) {
  let stringsLen = actual.length + expected.length;
  // Accounting for the quotes wrapping strings
  if (typeof originalActual === 'string') {
    stringsLen -= 2;
  }
  if (typeof originalExpected === 'string') {
    stringsLen -= 2;
  }
  if (stringsLen <= kMaxShortStringLength && (originalActual !== 0 || originalExpected !== 0)) {
    return { message: `${actual} !== ${expected}`, header: '' };
  }

  const isStringComparison = typeof originalActual === 'string' && typeof originalExpected === 'string';
  // colored myers diff
  if (isStringComparison && colors.hasColors) {
    return getColoredMyersDiff(actual, expected);
  }

  return getStackedDiff(actual, expected);
}

function isSimpleDiff(actual, inspectedActual, expected, inspectedExpected) {
  if (inspectedActual.length > 1 || inspectedExpected.length > 1) {
    return false;
  }

  return typeof actual !== 'object' || actual === null || typeof expected !== 'object' || expected === null;
}

function createErrDiff(actual, expected, operator, customMessage, diffType = 'simple') {
  operator = checkOperator(actual, expected, operator);

  let skipped = false;
  let message = '';
  const inspectedActual = inspectValue(actual);
  const inspectedExpected = inspectValue(expected);
  const inspectedSplitActual = StringPrototypeSplit(inspectedActual, '\n');
  const inspectedSplitExpected = StringPrototypeSplit(inspectedExpected, '\n');
  const showSimpleDiff = isSimpleDiff(actual, inspectedSplitActual, expected, inspectedSplitExpected);
  let header = `${colors.green}+ actual${colors.white} ${colors.red}- expected${colors.white}`;

  if (showSimpleDiff) {
    const simpleDiff = getSimpleDiff(actual, inspectedSplitActual[0], expected, inspectedSplitExpected[0]);
    message = simpleDiff.message;
    if (typeof simpleDiff.header !== 'undefined') {
      header = simpleDiff.header;
    }
    if (simpleDiff.skipped) {
      skipped = true;
    }
  } else if (inspectedActual === inspectedExpected) {
    // Handles the case where the objects are structurally the same but different references
    operator = 'notIdentical';
    if (inspectedSplitActual.length > 50 && diffType !== 'full') {
      message = `${ArrayPrototypeJoin(ArrayPrototypeSlice(inspectedSplitActual, 0, 50), '\n')}\n...}`;
      skipped = true;
    } else {
      message = ArrayPrototypeJoin(inspectedSplitActual, '\n');
    }
    header = '';
  } else {
    const checkCommaDisparity = actual != null && typeof actual === 'object';
    const diff = myersDiff(inspectedSplitActual, inspectedSplitExpected, checkCommaDisparity);

    const myersDiffMessage = printMyersDiff(diff, operator);
    message = myersDiffMessage.message;

    if (operator === 'partialDeepStrictEqual') {
      header = `${colors.gray}${colors.hasColors ? '' : '+ '}actual${colors.white} ${colors.red}- expected${colors.white}`;
    }

    if (myersDiffMessage.skipped) {
      skipped = true;
    }
  }

  const headerMessage = `${getErrorMessage(operator, customMessage)}\n${header}`;
  const skippedMessage = skipped ? '\n... Skipped lines' : '';

  return `${headerMessage}${skippedMessage}\n${message}\n`;
}

function addEllipsis(string) {
  const lines = StringPrototypeSplit(string, '\n', 11);
  if (lines.length > 10) {
    lines.length = 10;
    return `${ArrayPrototypeJoin(lines, '\n')}\n...`;
  } else if (string.length > kMaxLongStringLength) {
    return `${StringPrototypeSlice(string, kMaxLongStringLength)}...`;
  }
  return string;
}

class AssertionError extends Error {
  constructor(options) {
    validateObject(options, 'options');
    const {
      message,
      operator,
      stackStartFn,
      details,
      // Compatibility with older versions.
      stackStartFunction,
      diff = 'simple',
    } = options;
    let {
      actual,
      expected,
    } = options;

    const limit = Error.stackTraceLimit;
    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = 0;

    if (message != null) {
      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else {
        super(String(message));
      }
    } else {
      // Reset colors on each call to make sure we handle dynamically set environment
      // variables correct.
      colors.refresh();
      // Prevent the error stack from being visible by duplicating the error
      // in a very close way to the original in case both sides are actually
      // instances of Error.
      if (typeof actual === 'object' && actual !== null &&
          typeof expected === 'object' && expected !== null &&
          'stack' in actual && actual instanceof Error &&
          'stack' in expected && expected instanceof Error) {
        actual = copyError(actual);
        expected = copyError(expected);
      }

      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else if (operator === 'notDeepStrictEqual' ||
        operator === 'notStrictEqual') {
        // In case the objects are equal but the operator requires unequal, show
        // the first object and say A equals B
        let base = kReadableOperator[operator];
        const res = StringPrototypeSplit(inspectValue(actual), '\n');

        // In case "actual" is an object or a function, it should not be
        // reference equal.
        if (operator === 'notStrictEqual' &&
            ((typeof actual === 'object' && actual !== null) ||
             typeof actual === 'function')) {
          base = kReadableOperator.notStrictEqualObject;
        }

        // Only remove lines in case it makes sense to collapse those.
        if (res.length > 50 && diff !== 'full') {
          res[46] = `${colors.blue}...${colors.white}`;
          while (res.length > 47) {
            ArrayPrototypePop(res);
          }
        }

        // Only print a single input.
        if (res.length === 1) {
          super(`${base}${res[0].length > 5 ? '\n\n' : ' '}${res[0]}`);
        } else {
          super(`${base}\n\n${ArrayPrototypeJoin(res, '\n')}\n`);
        }
      } else {
        let res = inspectValue(actual);
        let other = inspectValue(expected);
        const knownOperator = kReadableOperator[operator];
        if (operator === 'notDeepEqual' && res === other) {
          res = `${knownOperator}\n\n${res}`;
          if (res.length > 1024 && diff !== 'full') {
            res = `${StringPrototypeSlice(res, 0, 1021)}...`;
          }
          super(res);
        } else {
          if (res.length > kMaxLongStringLength && diff !== 'full') {
            res = `${StringPrototypeSlice(res, 0, 509)}...`;
          }
          if (other.length > kMaxLongStringLength && diff !== 'full') {
            other = `${StringPrototypeSlice(other, 0, 509)}...`;
          }
          if (operator === 'deepEqual') {
            res = `${knownOperator}\n\n${res}\n\nshould loosely deep-equal\n\n`;
          } else {
            const newOp = kReadableOperator[`${operator}Unequal`];
            if (newOp) {
              res = `${newOp}\n\n${res}\n\nshould not loosely deep-equal\n\n`;
            } else {
              other = ` ${operator} ${other}`;
            }
          }
          super(`${res}${other}`);
        }
      }
    }

    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = limit;

    this.generatedMessage = !message;
    ObjectDefineProperty(this, 'name', {
      __proto__: null,
      value: 'AssertionError [ERR_ASSERTION]',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.code = 'ERR_ASSERTION';
    if (details) {
      this.actual = undefined;
      this.expected = undefined;
      this.operator = undefined;
      for (let i = 0; i < details.length; i++) {
        this['message ' + i] = details[i].message;
        this['actual ' + i] = details[i].actual;
        this['expected ' + i] = details[i].expected;
        this['operator ' + i] = details[i].operator;
        this['stack trace ' + i] = details[i].stack;
      }
    } else {
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
    }
    ErrorCaptureStackTrace(this, stackStartFn || stackStartFunction);
    // Create error message including the error code in the name.
    this.stack; // eslint-disable-line no-unused-expressions
    // Reset the name.
    this.name = 'AssertionError';
    this.diff = diff;
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [inspect.custom](recurseTimes, ctx) {
    // Long strings should not be fully inspected.
    const tmpActual = this.actual;
    const tmpExpected = this.expected;

    if (typeof this.actual === 'string') {
      this.actual = addEllipsis(this.actual);
    }
    if (typeof this.expected === 'string') {
      this.expected = addEllipsis(this.expected);
    }

    // This limits the `actual` and `expected` property default inspection to
    // the minimum depth. Otherwise those values would be too verbose compared
    // to the actual error message which contains a combined view of these two
    // input values.
    const result = inspect(this, {
      ...ctx,
      customInspect: false,
      depth: 0,
    });

    // Reset the properties after inspection.
    this.actual = tmpActual;
    this.expected = tmpExpected;

    return result;
  }
}

module.exports = AssertionError;

    },
    "internal/assert/myers_diff": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypePush,
  Int32Array,
  StringPrototypeEndsWith,
} = primordials;

const {
  codes: {
    ERR_OUT_OF_RANGE,
  },
} = require('internal/errors');

const colors = require('internal/util/colors');

const kNopLinesToCollapse = 5;
const kOperations = {
  DELETE: -1,
  NOP: 0,
  INSERT: 1,
};

function areLinesEqual(actual, expected, checkCommaDisparity) {
  if (actual === expected) {
    return true;
  }
  if (checkCommaDisparity) {
    return (actual + ',') === expected || actual === (expected + ',');
  }
  return false;
}

function myersDiff(actual, expected, checkCommaDisparity = false) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  if (max > 2 ** 31 - 1) {
    throw new ERR_OUT_OF_RANGE(
      'myersDiff input size',
      '< 2^31',
      max,
    );
  }

  const v = new Int32Array(2 * max + 1);
  const trace = [];

  for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
    ArrayPrototypePush(trace, new Int32Array(v)); // Clone the current state of `v`

    for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
      const offset = diagonalIndex + max;
      const previousOffset = v[offset - 1];
      const nextOffset = v[offset + 1];
      let x = diagonalIndex === -diffLevel || (diagonalIndex !== diffLevel && previousOffset < nextOffset) ?
        nextOffset :
        previousOffset + 1;
      let y = x - diagonalIndex;

      while (
        x < actualLength &&
        y < expectedLength &&
        areLinesEqual(actual[x], expected[y], checkCommaDisparity)
      ) {
        x++;
        y++;
      }

      v[offset] = x;

      if (x >= actualLength && y >= expectedLength) {
        return backtrack(trace, actual, expected, checkCommaDisparity);
      }
    }
  }
}

function backtrack(trace, actual, expected, checkCommaDisparity) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  let x = actualLength;
  let y = expectedLength;
  const result = [];

  for (let diffLevel = trace.length - 1; diffLevel >= 0; diffLevel--) {
    const v = trace[diffLevel];
    const diagonalIndex = x - y;
    const offset = diagonalIndex + max;

    let prevDiagonalIndex;
    if (
      diagonalIndex === -diffLevel ||
      (diagonalIndex !== diffLevel && v[offset - 1] < v[offset + 1])
    ) {
      prevDiagonalIndex = diagonalIndex + 1;
    } else {
      prevDiagonalIndex = diagonalIndex - 1;
    }

    const prevX = v[prevDiagonalIndex + max];
    const prevY = prevX - prevDiagonalIndex;

    while (x > prevX && y > prevY) {
      const actualItem = actual[x - 1];
      const value = checkCommaDisparity && !StringPrototypeEndsWith(actualItem, ',') ? expected[y - 1] : actualItem;
      ArrayPrototypePush(result, [ kOperations.NOP, value ]);
      x--;
      y--;
    }

    if (diffLevel > 0) {
      if (x > prevX) {
        ArrayPrototypePush(result, [ kOperations.INSERT, actual[--x] ]);
      } else {
        ArrayPrototypePush(result, [ kOperations.DELETE, expected[--y] ]);
      }
    }
  }

  return result;
}

function printSimpleMyersDiff(diff) {
  let message = '';

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    let color = colors.white;

    if (operation === kOperations.INSERT) {
      color = colors.green;
    } else if (operation === kOperations.DELETE) {
      color = colors.red;
    }

    message += `${color}${value}${colors.white}`;
  }

  return `\n${message}`;
}

function printMyersDiff(diff, operator) {
  let message = '';
  let skipped = false;
  let nopCount = 0;

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    const previousOperation = diffIdx < diff.length - 1 ? diff[diffIdx + 1][0] : null;

    // Avoid grouping if only one line would have been grouped otherwise
    if (previousOperation === kOperations.NOP && operation !== previousOperation) {
      if (nopCount === kNopLinesToCollapse + 1) {
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount === kNopLinesToCollapse + 2) {
        message += `${colors.white}  ${diff[diffIdx + 2][1]}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount >= kNopLinesToCollapse + 3) {
        message += `${colors.blue}...${colors.white}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
        skipped = true;
      }
      nopCount = 0;
    }

    if (operation === kOperations.INSERT) {
      if (operator === 'partialDeepStrictEqual') {
        message += `${colors.gray}${colors.hasColors ? ' ' : '+'} ${value}${colors.white}\n`;
      } else {
        message += `${colors.green}+${colors.white} ${value}\n`;
      }
    } else if (operation === kOperations.DELETE) {
      message += `${colors.red}-${colors.white} ${value}\n`;
    } else if (operation === kOperations.NOP) {
      if (nopCount < kNopLinesToCollapse) {
        message += `${colors.white}  ${value}\n`;
      }
      nopCount++;
    }
  }

  message = message.trimEnd();

  return { message: `\n${message}`, skipped };
}

module.exports = { myersDiff, printMyersDiff, printSimpleMyersDiff };

    },
    "internal/assert/utils": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Error,
  ErrorCaptureStackTrace,
  StringPrototypeCharCodeAt,
  StringPrototypeReplace,
} = primordials;

const {
  isErrorStackTraceLimitWritable,
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const { isError } = require('internal/util');

const {
  getErrorSourceExpression,
} = require('internal/errors/error_source');

// Escape control characters but not \n and \t to keep the line breaks and
// indentation intact.
// eslint-disable-next-line no-control-regex
const escapeSequencesRegExp = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const meta = [
  '\\u0000', '\\u0001', '\\u0002', '\\u0003', '\\u0004',
  '\\u0005', '\\u0006', '\\u0007', '\\b', '',
  '', '\\u000b', '\\f', '', '\\u000e',
  '\\u000f', '\\u0010', '\\u0011', '\\u0012', '\\u0013',
  '\\u0014', '\\u0015', '\\u0016', '\\u0017', '\\u0018',
  '\\u0019', '\\u001a', '\\u001b', '\\u001c', '\\u001d',
  '\\u001e', '\\u001f',
];

const escapeFn = (str) => meta[StringPrototypeCharCodeAt(str, 0)];

function getErrMessage(fn) {
  const tmpLimit = Error.stackTraceLimit;
  const errorStackTraceLimitIsWritable = isErrorStackTraceLimitWritable();
  // Make sure the limit is set to 1. Otherwise it could fail (<= 0) or it
  // does to much work.
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = 1;
  // We only need the stack trace. To minimize the overhead use an object
  // instead of an error.
  const err = {};
  ErrorCaptureStackTrace(err, fn);
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = tmpLimit;

  let source = getErrorSourceExpression(err);
  if (source) {
    source = StringPrototypeReplace(source, escapeSequencesRegExp, escapeFn);
    return `The expression evaluated to a falsy value:\n\n  ${source}\n`;
  }
}

function innerOk(fn, argLen, value, message) {
  if (!value) {
    let generatedMessage = false;

    if (argLen === 0) {
      generatedMessage = true;
      message = 'No value argument passed to `assert.ok()`';
    } else if (message == null) {
      generatedMessage = true;
      message = getErrMessage(fn);
    } else if (isError(message)) {
      throw message;
    }

    const err = new AssertionError({
      actual: value,
      expected: true,
      message,
      operator: '==',
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

module.exports = {
  innerOk,
};

    },
    "internal/assert/calltracker": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Error,
  FunctionPrototype,
  ObjectFreeze,
  Proxy,
  ReflectApply,
  SafeSet,
  SafeWeakMap,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_VALUE,
    ERR_UNAVAILABLE_DURING_EXIT,
  },
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const {
  validateUint32,
} = require('internal/validators');

const noop = FunctionPrototype;

class CallTrackerContext {
  #expected;
  #calls;
  #name;
  #stackTrace;
  constructor({ expected, stackTrace, name }) {
    this.#calls = [];
    this.#expected = expected;
    this.#stackTrace = stackTrace;
    this.#name = name;
  }

  track(thisArg, args) {
    const argsClone = ObjectFreeze(ArrayPrototypeSlice(args));
    ArrayPrototypePush(this.#calls, ObjectFreeze({ thisArg, arguments: argsClone }));
  }

  get delta() {
    return this.#calls.length - this.#expected;
  }

  reset() {
    this.#calls = [];
  }
  getCalls() {
    return ObjectFreeze(ArrayPrototypeSlice(this.#calls));
  }

  report() {
    if (this.delta !== 0) {
      const message = `Expected the ${this.#name} function to be ` +
                      `executed ${this.#expected} time(s) but was ` +
                      `executed ${this.#calls.length} time(s).`;
      return {
        message,
        actual: this.#calls.length,
        expected: this.#expected,
        operator: this.#name,
        stack: this.#stackTrace,
      };
    }
  }
}

class CallTracker {

  #callChecks = new SafeSet();
  #trackedFunctions = new SafeWeakMap();

  #getTrackedFunction(tracked) {
    if (!this.#trackedFunctions.has(tracked)) {
      throw new ERR_INVALID_ARG_VALUE('tracked', tracked, 'is not a tracked function');
    }
    return this.#trackedFunctions.get(tracked);
  }

  reset(tracked) {
    if (tracked === undefined) {
      this.#callChecks.forEach((check) => check.reset());
      return;
    }

    this.#getTrackedFunction(tracked).reset();
  }

  getCalls(tracked) {
    return this.#getTrackedFunction(tracked).getCalls();
  }

  calls(fn, expected = 1) {
    if (process._exiting)
      throw new ERR_UNAVAILABLE_DURING_EXIT();
    if (typeof fn === 'number') {
      expected = fn;
      fn = noop;
    } else if (fn === undefined) {
      fn = noop;
    }

    validateUint32(expected, 'expected', true);

    const context = new CallTrackerContext({
      expected,
      // eslint-disable-next-line no-restricted-syntax
      stackTrace: new Error(),
      name: fn.name || 'calls',
    });
    const tracked = new Proxy(fn, {
      __proto__: null,
      apply(fn, thisArg, argList) {
        context.track(thisArg, argList);
        return ReflectApply(fn, thisArg, argList);
      },
    });
    this.#callChecks.add(context);
    this.#trackedFunctions.set(tracked, context);
    return tracked;
  }

  report() {
    const errors = [];
    for (const context of this.#callChecks) {
      const message = context.report();
      if (message !== undefined) {
        ArrayPrototypePush(errors, message);
      }
    }
    return errors;
  }

  verify() {
    const errors = this.report();
    if (errors.length === 0) {
      return;
    }
    const message = errors.length === 1 ?
      errors[0].message :
      'Functions were not called the expected number of times';
    throw new AssertionError({
      message,
      details: errors,
    });
  }
}

module.exports = CallTracker;

    },
    "assert": function (exports, require, module, process, internalBinding, primordials) {
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayPrototypeForEach,
  ArrayPrototypeIndexOf,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Error,
  NumberIsNaN,
  ObjectAssign,
  ObjectDefineProperty,
  ObjectIs,
  ObjectKeys,
  ObjectPrototypeIsPrototypeOf,
  ReflectApply,
  RegExpPrototypeExec,
  String,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeSplit,
  Symbol,
} = primordials;

const {
  codes: {
    ERR_AMBIGUOUS_ARGUMENT,
    ERR_CONSTRUCT_CALL_REQUIRED,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_RETURN_VALUE,
    ERR_MISSING_ARGS,
  },
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const { inspect } = require('internal/util/inspect');
const {
  isPromise,
  isRegExp,
} = require('internal/util/types');
const { isError, deprecate, setOwnProperty } = require('internal/util');
const { innerOk } = require('internal/assert/utils');

const CallTracker = require('internal/assert/calltracker');
const {
  validateFunction,
  validateOneOf,
} = require('internal/validators');

const kOptions = Symbol('options');

let isDeepEqual;
let isDeepStrictEqual;
let isPartialStrictEqual;

function lazyLoadComparison() {
  const comparison = require('internal/util/comparisons');
  isDeepEqual = comparison.isDeepEqual;
  isDeepStrictEqual = comparison.isDeepStrictEqual;
  isPartialStrictEqual = comparison.isPartialStrictEqual;
}

let warned = false;

// The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

const assert = module.exports = ok;

const NO_EXCEPTION_SENTINEL = {};

/**
 * Assert options.
 * @typedef {object} AssertOptions
 * @property {'full'|'simple'} [diff='simple'] - If set to 'full', shows the full diff in assertion errors.
 * @property {boolean} [strict=true] - If set to true, non-strict methods behave like their corresponding
 *   strict methods.
 */

/**
 * @class Assert
 * @param {AssertOptions} [options] - Optional configuration for assertions.
 * @throws {ERR_CONSTRUCT_CALL_REQUIRED} If not called with `new`.
 */
function Assert(options) {
  if (!new.target) {
    throw new ERR_CONSTRUCT_CALL_REQUIRED('Assert');
  }

  options = ObjectAssign({ __proto__: null, strict: true }, options);

  const allowedDiffs = ['simple', 'full'];
  if (options.diff !== undefined) {
    validateOneOf(options.diff, 'options.diff', allowedDiffs);
  }

  this.AssertionError = AssertionError;
  ObjectDefineProperty(this, kOptions, {
    __proto__: null,
    value: options,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  if (options.strict) {
    this.equal = this.strictEqual;
    this.deepEqual = this.deepStrictEqual;
    this.notEqual = this.notStrictEqual;
    this.notDeepEqual = this.notDeepStrictEqual;
  }
}

// All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided. All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

// DESTRUCTURING WARNING: All Assert.prototype methods use optional chaining
// (this?.[kOptions]) to safely access instance configuration. When methods are
// destructured from an Assert instance (e.g., const {strictEqual} = myAssert),
// they lose their `this` context and will use default behavior instead of the
// instance's custom options.

function innerFail(obj) {
  if (obj.message instanceof Error) throw obj.message;

  throw new AssertionError(obj);
}

/**
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @param {string} [operator]
 * @param {Function} [stackStartFn]
 */
Assert.prototype.fail = function fail(actual, expected, message, operator, stackStartFn) {
  const argsLen = arguments.length;

  let internalMessage = false;
  if (actual == null && argsLen <= 1) {
    internalMessage = true;
    message = 'Failed';
  } else if (argsLen === 1) {
    message = actual;
    actual = undefined;
  } else {
    if (warned === false) {
      warned = true;
      process.emitWarning(
        'assert.fail() with more than one argument is deprecated. ' +
          'Please use assert.strictEqual() instead or only pass a message.',
        'DeprecationWarning',
        'DEP0094',
      );
    }
    if (argsLen === 2)
      operator = '!=';
  }

  if (message instanceof Error) throw message;

  // IMPORTANT: When adding new references to `this`, ensure they use optional chaining
  // (this?.[kOptions]?.diff) to handle cases where the method is destructured from an
  // Assert instance and loses its context. Destructured methods will fall back
  // to default behavior when `this` is undefined.
  const errArgs = {
    actual,
    expected,
    operator: operator === undefined ? 'fail' : operator,
    stackStartFn: stackStartFn || fail,
    message,
    diff: this?.[kOptions]?.diff,
  };
  const err = new AssertionError(errArgs);
  if (internalMessage) {
    err.generatedMessage = true;
  }
  throw err;
};

// The AssertionError is defined in internal/error.
assert.AssertionError = AssertionError;

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * @param {...any} args
 * @returns {void}
 */
function ok(...args) {
  innerOk(ok, args.length, ...args);
}

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * Duplicated as the other `ok` function is supercharged and exposed as default export.
 * @param {...any} args
 * @returns {void}
 */
Assert.prototype.ok = function ok(...args) {
  innerOk(ok, args.length, ...args);
};

/**
 * The equality assertion tests shallow, coercive equality with ==.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.equal = function equal(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual != expected && (!NumberIsNaN(actual) || !NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '==',
      stackStartFn: equal,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The non-equality assertion tests for whether two objects are not
 * equal with !=.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notEqual = function notEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (NumberIsNaN(actual) && NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '!=',
      stackStartFn: notEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep equivalence assertion tests a deep equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.deepEqual = function deepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepEqual',
      stackStartFn: deepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep non-equivalence assertion tests for any deep inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepEqual',
      stackStartFn: notDeepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict equivalence assertion tests a deep strict equality
 * relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepStrictEqual',
      stackStartFn: deepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict non-equivalence assertion tests for any deep strict
 * inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notDeepStrictEqual = notDeepStrictEqual;
function notDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepStrictEqual',
      stackStartFn: notDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
}

/**
 * The strict equivalence assertion tests a strict equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.strictEqual = function strictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (!ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'strictEqual',
      stackStartFn: strictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict non-equivalence assertion tests for any strict inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notStrictEqual',
      stackStartFn: notStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict equivalence assertion test between two objects
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.partialDeepStrictEqual = function partialDeepStrictEqual(
  actual,
  expected,
  message,
) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isPartialStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'partialDeepStrictEqual',
      stackStartFn: partialDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

class Comparison {
  constructor(obj, keys, actual) {
    for (const key of keys) {
      if (key in obj) {
        if (actual !== undefined &&
            typeof actual[key] === 'string' &&
            isRegExp(obj[key]) &&
            RegExpPrototypeExec(obj[key], actual[key]) !== null) {
          this[key] = actual[key];
        } else {
          this[key] = obj[key];
        }
      }
    }
  }
}

function compareExceptionKey(actual, expected, key, message, keys, fn) {
  if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
    if (!message) {
      // Create placeholder objects to create a nice output.
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);

      const err = new AssertionError({
        actual: a,
        expected: b,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
  }
}

function expectedException(actual, expected, message, fn) {
  let generatedMessage = false;
  let throwError = false;

  if (typeof expected !== 'function') {
    // Handle regular expressions.
    if (isRegExp(expected)) {
      const str = String(actual);
      if (RegExpPrototypeExec(expected, str) !== null)
        return;

      if (!message) {
        generatedMessage = true;
        message = 'The input did not match the regular expression ' +
                  `${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
      throwError = true;
      // Handle primitives properly.
    } else if (typeof actual !== 'object' || actual === null) {
      const err = new AssertionError({
        actual,
        expected,
        message,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.operator = fn.name;
      throw err;
    } else {
      // Handle validation objects.
      const keys = ObjectKeys(expected);
      // Special handle errors to make sure the name and the message are
      // compared as well.
      if (expected instanceof Error) {
        ArrayPrototypePush(keys, 'name', 'message');
      } else if (keys.length === 0) {
        throw new ERR_INVALID_ARG_VALUE('error',
                                        expected, 'may not be an empty object');
      }
      if (isDeepEqual === undefined) lazyLoadComparison();
      for (const key of keys) {
        if (typeof actual[key] === 'string' &&
            isRegExp(expected[key]) &&
            RegExpPrototypeExec(expected[key], actual[key]) !== null) {
          continue;
        }
        compareExceptionKey(actual, expected, key, message, keys, fn);
      }
      return;
    }
  // Guard instanceof against arrow functions as they don't have a prototype.
  // Check for matching Error classes.
  } else if (expected.prototype !== undefined && actual instanceof expected) {
    return;
  } else if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    if (!message) {
      generatedMessage = true;
      message = 'The error is expected to be an instance of ' +
        `"${expected.name}". Received `;
      if (isError(actual)) {
        const name = (actual.constructor?.name) ||
                     actual.name;
        if (expected.name === name) {
          message += 'an error with identical name but a different prototype.';
        } else {
          message += `"${name}"`;
        }
        if (actual.message) {
          message += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        message += `"${inspect(actual, { depth: -1 })}"`;
      }
    }
    throwError = true;
  } else {
    // Check validation functions return value.
    const res = ReflectApply(expected, {}, [actual]);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = expected.name ? `"${expected.name}" ` : '';
        message = `The ${name}validation function is expected to return` +
          ` "true". Received ${inspect(res)}`;

        if (isError(actual)) {
          message += `\n\nCaught error:\n\n${actual}`;
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionError({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

function getActual(fn) {
  validateFunction(fn, 'fn');
  try {
    fn();
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function checkIsPromise(obj) {
  // Accept native ES6 promises and promises that are implemented in a similar
  // way. Do not accept thenables that use a function as `obj` and that have no
  // `catch` handler.
  return isPromise(obj) ||
    (obj !== null && typeof obj === 'object' &&
    typeof obj.then === 'function' &&
    typeof obj.catch === 'function');
}

async function waitForActual(promiseFn) {
  let resultPromise;
  if (typeof promiseFn === 'function') {
    // Return a rejected promise if `promiseFn` throws synchronously.
    resultPromise = promiseFn();
    // Fail in case no promise is returned.
    if (!checkIsPromise(resultPromise)) {
      throw new ERR_INVALID_RETURN_VALUE('instance of Promise',
                                         'promiseFn', resultPromise);
    }
  } else if (checkIsPromise(promiseFn)) {
    resultPromise = promiseFn;
  } else {
    throw new ERR_INVALID_ARG_TYPE(
      'promiseFn', ['Function', 'Promise'], promiseFn);
  }

  try {
    await resultPromise;
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function expectsError(stackStartFn, actual, error, message) {
  if (typeof error === 'string') {
    if (arguments.length === 4) {
      throw new ERR_INVALID_ARG_TYPE('error',
                                     ['Object', 'Error', 'Function', 'RegExp'],
                                     error);
    }
    if (typeof actual === 'object' && actual !== null) {
      if (actual.message === error) {
        throw new ERR_AMBIGUOUS_ARGUMENT(
          'error/message',
          `The error message "${actual.message}" is identical to the message.`,
        );
      }
    } else if (actual === error) {
      throw new ERR_AMBIGUOUS_ARGUMENT(
        'error/message',
        `The error "${actual}" is identical to the message.`,
      );
    }
    message = error;
    error = undefined;
  } else if (error != null &&
             typeof error !== 'object' &&
             typeof error !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('error',
                                   ['Object', 'Error', 'Function', 'RegExp'],
                                   error);
  }

  if (actual === NO_EXCEPTION_SENTINEL) {
    let details = '';
    if (error?.name) {
      details += ` (${error.name})`;
    }
    details += message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.rejects ? 'rejection' : 'exception';
    innerFail({
      actual: undefined,
      expected: error,
      operator: stackStartFn.name,
      message: `Missing expected ${fnType}${details}`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }

  if (!error)
    return;

  expectedException.call(this, actual, error, message, stackStartFn);
}

function hasMatchingError(actual, expected) {
  if (typeof expected !== 'function') {
    if (isRegExp(expected)) {
      const str = String(actual);
      return RegExpPrototypeExec(expected, str) !== null;
    }
    throw new ERR_INVALID_ARG_TYPE(
      'expected', ['Function', 'RegExp'], expected,
    );
  }
  // Guard instanceof against arrow functions as they don't have a prototype.
  if (expected.prototype !== undefined && actual instanceof expected) {
    return true;
  }
  if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    return false;
  }
  return ReflectApply(expected, {}, [actual]) === true;
}

function expectsNoError(stackStartFn, actual, error, message) {
  if (actual === NO_EXCEPTION_SENTINEL)
    return;

  if (typeof error === 'string') {
    message = error;
    error = undefined;
  }

  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.doesNotReject ?
      'rejection' : 'exception';
    innerFail({
      actual,
      expected: error,
      operator: stackStartFn.name,
      message: `Got unwanted ${fnType}${details}\n` +
               `Actual message: "${actual?.message}"`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }
  throw actual;
}

/**
 * Expects the function `promiseFn` to throw an error.
 * @param {() => any} promiseFn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.throws = function throws(promiseFn, ...args) {
  expectsError(throws, getActual(promiseFn), ...args);
};

/**
 * Expects `promiseFn` function or its value to reject.
 * @param {() => Promise<any>} promiseFn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.rejects = async function rejects(promiseFn, ...args) {
  expectsError(rejects, await waitForActual(promiseFn), ...args);
};

/**
 * Asserts that the function `fn` does not throw an error.
 * @param {() => any} fn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.doesNotThrow = function doesNotThrow(fn, ...args) {
  expectsNoError(doesNotThrow, getActual(fn), ...args);
};

/**
 * Expects `fn` or its value to not reject.
 * @param {() => Promise<any>} fn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.doesNotReject = async function doesNotReject(fn, ...args) {
  expectsNoError(doesNotReject, await waitForActual(fn), ...args);
};

/**
 * Throws `AssertionError` if the value is not `null` or `undefined`.
 * @param {any} err
 * @returns {void}
 */
Assert.prototype.ifError = function ifError(err) {
  if (err !== null && err !== undefined) {
    let message = 'ifError got unwanted exception: ';
    if (typeof err === 'object' && typeof err.message === 'string') {
      if (err.message.length === 0 && err.constructor) {
        message += err.constructor.name;
      } else {
        message += err.message;
      }
    } else {
      message += inspect(err);
    }

    const newErr = new AssertionError({
      actual: err,
      expected: null,
      operator: 'ifError',
      message,
      stackStartFn: ifError,
      diff: this?.[kOptions]?.diff,
    });

    // Make sure we actually have a stack trace!
    const origStack = err.stack;

    if (typeof origStack === 'string') {
      // This will remove any duplicated frames from the error frames taken
      // from within `ifError` and add the original error frames to the newly
      // created ones.
      const origStackStart = StringPrototypeIndexOf(origStack, '\n    at');
      if (origStackStart !== -1) {
        const originalFrames = StringPrototypeSplit(
          StringPrototypeSlice(origStack, origStackStart + 1),
          '\n',
        );
        // Filter all frames existing in err.stack.
        let newFrames = StringPrototypeSplit(newErr.stack, '\n');
        for (const errFrame of originalFrames) {
          // Find the first occurrence of the frame.
          const pos = ArrayPrototypeIndexOf(newFrames, errFrame);
          if (pos !== -1) {
            // Only keep new frames.
            newFrames = ArrayPrototypeSlice(newFrames, 0, pos);
            break;
          }
        }
        const stackStart = ArrayPrototypeJoin(newFrames, '\n');
        const stackEnd = ArrayPrototypeJoin(originalFrames, '\n');
        newErr.stack = `${stackStart}\n${stackEnd}`;
      }
    }

    throw newErr;
  }
};

function internalMatch(string, regexp, message, fn) {
  if (!isRegExp(regexp)) {
    throw new ERR_INVALID_ARG_TYPE(
      'regexp', 'RegExp', regexp,
    );
  }
  const match = fn === Assert.prototype.match;
  if (typeof string !== 'string' ||
      RegExpPrototypeExec(regexp, string) !== null !== match) {
    if (message instanceof Error) {
      throw message;
    }

    const generatedMessage = !message;

    // 'The input was expected to not match the regular expression ' +
    message ||= (typeof string !== 'string' ?
      'The "string" argument must be of type string. Received type ' +
        `${typeof string} (${inspect(string)})` :
      (match ?
        'The input did not match the regular expression ' :
        'The input was expected to not match the regular expression ') +
          `${inspect(regexp)}. Input:\n\n${inspect(string)}\n`);
    const err = new AssertionError({
      actual: string,
      expected: regexp,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

/**
 * Expects the `string` input to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.match = function match(string, regexp, message) {
  internalMatch(string, regexp, message, match);
};

/**
 * Expects the `string` input not to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.doesNotMatch = function doesNotMatch(string, regexp, message) {
  internalMatch(string, regexp, message, doesNotMatch);
};

assert.CallTracker = deprecate(CallTracker, 'assert.CallTracker is deprecated.', 'DEP0173');

/**
 * Expose a strict only variant of assert.
 * @param {...any} args
 * @returns {void}
 */
function strict(...args) {
  innerOk(strict, args.length, ...args);
}

// TODO(aduh95): take `ok` from `Assert.prototype` instead of a self-ref in a next major.
assert.ok = assert;
ArrayPrototypeForEach([
  'fail', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual',
  'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual',
  'notStrictEqual', 'partialDeepStrictEqual', 'match', 'doesNotMatch',
  'throws', 'rejects', 'doesNotThrow', 'doesNotReject', 'ifError',
], (name) => {
  setOwnProperty(assert, name, Assert.prototype[name]);
});

assert.strict = ObjectAssign(strict, assert, {
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  notEqual: assert.notStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
});

assert.strict.Assert = Assert;
assert.strict.strict = assert.strict;

assert.Assert = Assert;

    },
    "internal/querystring": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Array,
  Int8Array,
  NumberPrototypeToString,
  StringPrototypeCharCodeAt,
  StringPrototypeSlice,
  StringPrototypeToUpperCase,
} = primordials;

const { ERR_INVALID_URI } = require('internal/errors').codes;

const hexTable = new Array(256);
for (let i = 0; i < 256; ++i)
  hexTable[i] = '%' +
                StringPrototypeToUpperCase((i < 16 ? '0' : '') +
                                           NumberPrototypeToString(i, 16));

const isHexTable = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 64 - 79
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 96 - 111
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 112 - 127
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 128 ...
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // ... 256
]);

/**
 * @param {string} str
 * @param {Int8Array} noEscapeTable
 * @param {string[]} hexTable
 * @returns {string}
 */
function encodeStr(str, noEscapeTable, hexTable) {
  const len = str.length;
  if (len === 0)
    return '';

  let out = '';
  let lastPos = 0;
  let i = 0;

  outer:
  for (; i < len; i++) {
    let c = StringPrototypeCharCodeAt(str, i);

    // ASCII
    while (c < 0x80) {
      if (noEscapeTable[c] !== 1) {
        if (lastPos < i)
          out += StringPrototypeSlice(str, lastPos, i);
        lastPos = i + 1;
        out += hexTable[c];
      }

      if (++i === len)
        break outer;

      c = StringPrototypeCharCodeAt(str, i);
    }

    if (lastPos < i)
      out += StringPrototypeSlice(str, lastPos, i);

    // Multi-byte characters ...
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xC0 | (c >> 6)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    if (c < 0xD800 || c >= 0xE000) {
      lastPos = i + 1;
      out += hexTable[0xE0 | (c >> 12)] +
             hexTable[0x80 | ((c >> 6) & 0x3F)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    // Surrogate pair
    ++i;

    // This branch should never happen because all URLSearchParams entries
    // should already be converted to USVString. But, included for
    // completion's sake anyway.
    if (i >= len)
      throw new ERR_INVALID_URI();

    const c2 = StringPrototypeCharCodeAt(str, i) & 0x3FF;

    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3FF) << 10) | c2);
    out += hexTable[0xF0 | (c >> 18)] +
           hexTable[0x80 | ((c >> 12) & 0x3F)] +
           hexTable[0x80 | ((c >> 6) & 0x3F)] +
           hexTable[0x80 | (c & 0x3F)];
  }
  if (lastPos === 0)
    return str;
  if (lastPos < len)
    return out + StringPrototypeSlice(str, lastPos);
  return out;
}

module.exports = {
  encodeStr,
  hexTable,
  isHexTable,
};

    },
    "querystring": function (exports, require, module, process, internalBinding, primordials) {
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// Query String Utilities

'use strict';

const {
  Array,
  ArrayIsArray,
  Int8Array,
  MathAbs,
  NumberIsFinite,
  ObjectKeys,
  String,
  StringPrototypeCharCodeAt,
  StringPrototypeSlice,
  decodeURIComponent,
} = primordials;

const { Buffer } = require('buffer');
const {
  encodeStr,
  hexTable,
  isHexTable,
} = require('internal/querystring');
const QueryString = module.exports = {
  unescapeBuffer,
  // `unescape()` is a JS global, so we need to use a different local name
  unescape: qsUnescape,

  // `escape()` is a JS global, so we need to use a different local name
  escape: qsEscape,

  stringify,
  encode: stringify,

  parse,
  decode: parse,
};

const unhexTable = new Int8Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 0 - 15
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 16 - 31
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 32 - 47
  +0, +1, +2, +3, +4, +5, +6, +7, +8, +9, -1, -1, -1, -1, -1, -1, // 48 - 63
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 64 - 79
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 80 - 95
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 96 - 111
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 112 - 127
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 128 ...
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  // ... 255
]);
/**
 * A safe fast alternative to decodeURIComponent
 * @param {string} s
 * @param {boolean} decodeSpaces
 * @returns {string}
 */
function unescapeBuffer(s, decodeSpaces) {
  const out = Buffer.allocUnsafe(s.length);
  let index = 0;
  let outIndex = 0;
  let currentChar;
  let nextChar;
  let hexHigh;
  let hexLow;
  const maxLength = s.length - 2;
  // Flag to know if some hex chars have been decoded
  let hasHex = false;
  while (index < s.length) {
    currentChar = StringPrototypeCharCodeAt(s, index);
    if (currentChar === 43 /* '+' */ && decodeSpaces) {
      out[outIndex++] = 32; // ' '
      index++;
      continue;
    }
    if (currentChar === 37 /* '%' */ && index < maxLength) {
      currentChar = StringPrototypeCharCodeAt(s, ++index);
      hexHigh = unhexTable[currentChar];
      if (!(hexHigh >= 0)) {
        out[outIndex++] = 37; // '%'
        continue;
      } else {
        nextChar = StringPrototypeCharCodeAt(s, ++index);
        hexLow = unhexTable[nextChar];
        if (!(hexLow >= 0)) {
          out[outIndex++] = 37; // '%'
          index--;
        } else {
          hasHex = true;
          currentChar = hexHigh * 16 + hexLow;
        }
      }
    }
    out[outIndex++] = currentChar;
    index++;
  }
  return hasHex ? out.slice(0, outIndex) : out;
}

/**
 * @param {string} s
 * @param {boolean} decodeSpaces
 * @returns {string}
 */
function qsUnescape(s, decodeSpaces) {
  try {
    return decodeURIComponent(s);
  } catch {
    return QueryString.unescapeBuffer(s, decodeSpaces).toString();
  }
}


// These characters do not need escaping when generating query strings:
// ! - . _ ~
// ' ( ) *
// digits
// alpha (uppercase)
// alpha (lowercase)
const noEscape = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0,  // 112 - 127
]);

/**
 * QueryString.escape() replaces encodeURIComponent()
 * @see https://www.ecma-international.org/ecma-262/5.1/#sec-15.1.3.4
 * @param {any} str
 * @returns {string}
 */
function qsEscape(str) {
  if (typeof str !== 'string') {
    if (typeof str === 'object')
      str = String(str);
    else
      str += '';
  }

  return encodeStr(str, noEscape, hexTable);
}

/**
 * @param {string | number | bigint | boolean | symbol | undefined | null} v
 * @returns {string}
 */
function stringifyPrimitive(v) {
  if (typeof v === 'string')
    return v;
  if (typeof v === 'number' && NumberIsFinite(v))
    return '' + v;
  if (typeof v === 'bigint')
    return '' + v;
  if (typeof v === 'boolean')
    return v ? 'true' : 'false';
  return '';
}

/**
 * @param {string | number | bigint | boolean} v
 * @param {(v: string) => string} encode
 * @returns {string}
 */
function encodeStringified(v, encode) {
  if (typeof v === 'string')
    return (v.length ? encode(v) : '');
  if (typeof v === 'number' && NumberIsFinite(v)) {
    // Values >= 1e21 automatically switch to scientific notation which requires
    // escaping due to the inclusion of a '+' in the output
    return (MathAbs(v) < 1e21 ? '' + v : encode('' + v));
  }
  if (typeof v === 'bigint')
    return '' + v;
  if (typeof v === 'boolean')
    return v ? 'true' : 'false';
  return '';
}

/**
 * @param {string | number | boolean | null} v
 * @param {(v: string) => string} encode
 * @returns {string}
 */
function encodeStringifiedCustom(v, encode) {
  return encode(stringifyPrimitive(v));
}

/**
 * @param {Record<string, string | number | boolean
 * | ReadonlyArray<string | number | boolean> | null>} obj
 * @param {string} [sep]
 * @param {string} [eq]
 * @param {{ encodeURIComponent?: (v: string) => string }} [options]
 * @returns {string}
 */
function stringify(obj, sep, eq, options) {
  sep ||= '&';
  eq ||= '=';

  let encode = QueryString.escape;
  if (options && typeof options.encodeURIComponent === 'function') {
    encode = options.encodeURIComponent;
  }
  const convert =
    (encode === qsEscape ? encodeStringified : encodeStringifiedCustom);

  if (obj !== null && typeof obj === 'object') {
    const keys = ObjectKeys(obj);
    const len = keys.length;
    let fields = '';
    for (let i = 0; i < len; ++i) {
      const k = keys[i];
      const v = obj[k];
      let ks = convert(k, encode);
      ks += eq;

      if (ArrayIsArray(v)) {
        const vlen = v.length;
        if (vlen === 0) continue;
        if (fields)
          fields += sep;
        for (let j = 0; j < vlen; ++j) {
          if (j)
            fields += sep;
          fields += ks;
          fields += convert(v[j], encode);
        }
      } else {
        if (fields)
          fields += sep;
        fields += ks;
        fields += convert(v, encode);
      }
    }
    return fields;
  }
  return '';
}

/**
 * @param {string} str
 * @returns {number[]}
 */
function charCodes(str) {
  if (str.length === 0) return [];
  if (str.length === 1) return [StringPrototypeCharCodeAt(str, 0)];
  const ret = new Array(str.length);
  for (let i = 0; i < str.length; ++i)
    ret[i] = StringPrototypeCharCodeAt(str, i);
  return ret;
}
const defSepCodes = [38]; // &
const defEqCodes = [61]; // =

function addKeyVal(obj, key, value, keyEncoded, valEncoded, decode) {
  if (key.length > 0 && keyEncoded)
    key = decodeStr(key, decode);
  if (value.length > 0 && valEncoded)
    value = decodeStr(value, decode);

  if (obj[key] === undefined) {
    obj[key] = value;
  } else {
    const curValue = obj[key];
    // A simple Array-specific property check is enough here to
    // distinguish from a string value and is faster and still safe
    // since we are generating all of the values being assigned.
    if (curValue.pop)
      curValue[curValue.length] = value;
    else
      obj[key] = [curValue, value];
  }
}

/**
 * Parse a key/val string.
 * @param {string} qs
 * @param {string} sep
 * @param {string} eq
 * @param {{
 *   maxKeys?: number;
 *   decodeURIComponent?(v: string): string;
 *   }} [options]
 * @returns {Record<string, string | string[]>}
 */
function parse(qs, sep, eq, options) {
  const obj = { __proto__: null };

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  const sepCodes = (!sep ? defSepCodes : charCodes(String(sep)));
  const eqCodes = (!eq ? defEqCodes : charCodes(String(eq)));
  const sepLen = sepCodes.length;
  const eqLen = eqCodes.length;

  let pairs = 1000;
  if (options && typeof options.maxKeys === 'number') {
    // -1 is used in place of a value like Infinity for meaning
    // "unlimited pairs" because of additional checks V8 (at least as of v5.4)
    // has to do when using variables that contain values like Infinity. Since
    // `pairs` is always decremented and checked explicitly for 0, -1 works
    // effectively the same as Infinity, while providing a significant
    // performance boost.
    pairs = (options.maxKeys > 0 ? options.maxKeys : -1);
  }

  let decode = QueryString.unescape;
  if (options && typeof options.decodeURIComponent === 'function') {
    decode = options.decodeURIComponent;
  }
  const customDecode = (decode !== qsUnescape);

  let lastPos = 0;
  let sepIdx = 0;
  let eqIdx = 0;
  let key = '';
  let value = '';
  let keyEncoded = customDecode;
  let valEncoded = customDecode;
  const plusChar = (customDecode ? '%20' : ' ');
  let encodeCheck = 0;
  for (let i = 0; i < qs.length; ++i) {
    const code = StringPrototypeCharCodeAt(qs, i);

    // Try matching key/value pair separator (e.g. '&')
    if (code === sepCodes[sepIdx]) {
      if (++sepIdx === sepLen) {
        // Key/value pair separator match!
        const end = i - sepIdx + 1;
        if (eqIdx < eqLen) {
          // We didn't find the (entire) key/value separator
          if (lastPos < end) {
            // Treat the substring as part of the key instead of the value
            key += StringPrototypeSlice(qs, lastPos, end);
          } else if (key.length === 0) {
            // We saw an empty substring between separators
            if (--pairs === 0)
              return obj;
            lastPos = i + 1;
            sepIdx = eqIdx = 0;
            continue;
          }
        } else if (lastPos < end) {
          value += StringPrototypeSlice(qs, lastPos, end);
        }

        addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

        if (--pairs === 0)
          return obj;
        keyEncoded = valEncoded = customDecode;
        key = value = '';
        encodeCheck = 0;
        lastPos = i + 1;
        sepIdx = eqIdx = 0;
      }
    } else {
      sepIdx = 0;
      // Try matching key/value separator (e.g. '=') if we haven't already
      if (eqIdx < eqLen) {
        if (code === eqCodes[eqIdx]) {
          if (++eqIdx === eqLen) {
            // Key/value separator match!
            const end = i - eqIdx + 1;
            if (lastPos < end)
              key += StringPrototypeSlice(qs, lastPos, end);
            encodeCheck = 0;
            lastPos = i + 1;
          }
          continue;
        } else {
          eqIdx = 0;
          if (!keyEncoded) {
            // Try to match an (valid) encoded byte once to minimize unnecessary
            // calls to string decoding functions
            if (code === 37/* % */) {
              encodeCheck = 1;
              continue;
            } else if (encodeCheck > 0) {
              if (isHexTable[code] === 1) {
                if (++encodeCheck === 3)
                  keyEncoded = true;
                continue;
              } else {
                encodeCheck = 0;
              }
            }
          }
        }
        if (code === 43/* + */) {
          if (lastPos < i)
            key += StringPrototypeSlice(qs, lastPos, i);
          key += plusChar;
          lastPos = i + 1;
          continue;
        }
      }
      if (code === 43/* + */) {
        if (lastPos < i)
          value += StringPrototypeSlice(qs, lastPos, i);
        value += plusChar;
        lastPos = i + 1;
      } else if (!valEncoded) {
        // Try to match an (valid) encoded byte (once) to minimize unnecessary
        // calls to string decoding functions
        if (code === 37/* % */) {
          encodeCheck = 1;
        } else if (encodeCheck > 0) {
          if (isHexTable[code] === 1) {
            if (++encodeCheck === 3)
              valEncoded = true;
          } else {
            encodeCheck = 0;
          }
        }
      }
    }
  }

  // Deal with any leftover key or value data
  if (lastPos < qs.length) {
    if (eqIdx < eqLen)
      key += StringPrototypeSlice(qs, lastPos);
    else if (sepIdx < sepLen)
      value += StringPrototypeSlice(qs, lastPos);
  } else if (eqIdx === 0 && key.length === 0) {
    // We ended on an empty substring
    return obj;
  }

  addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

  return obj;
}


/**
 * V8 does not optimize functions with try-catch blocks, so we isolate them here
 * to minimize the damage (Note: no longer true as of V8 5.4 -- but still will
 * not be inlined).
 * @param {string} s
 * @param {(v: string) => string} decoder
 * @returns {string}
 */
function decodeStr(s, decoder) {
  try {
    return decoder(s);
  } catch {
    return QueryString.unescape(s, true);
  }
}

    },
    "punycode": function (exports, require, module, process, internalBinding, primordials) {
'use strict';
const {
  isInsideNodeModules,
} = internalBinding('util');

if (!isInsideNodeModules()) {
	process.emitWarning(
		'The `punycode` module is deprecated. Please use a userland ' +
		'alternative instead.',
		'DeprecationWarning',
		'DEP0040',
	);
}

/** Highest positive signed 32-bit float value */
const maxInt = 2147483647; // aka. 0x7FFFFFFF or 2^31-1

/** Bootstring parameters */
const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128; // 0x80
const delimiter = '-'; // '\x2D'

/** Regular expressions */
const regexPunycode = /^xn--/;
const regexNonASCII = /[^\0-\x7F]/; // Note: U+007F DEL is excluded too.
const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g; // RFC 3490 separators

/** Error messages */
const errors = {
	'overflow': 'Overflow: input needs wider integers to process',
	'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
	'invalid-input': 'Invalid input'
};

/** Convenience shortcuts */
const baseMinusTMin = base - tMin;
const floor = Math.floor;
const stringFromCharCode = String.fromCharCode;

/*--------------------------------------------------------------------------*/

/**
 * A generic error utility function.
 * @private
 * @param {String} type The error type.
 * @returns {Error} Throws a `RangeError` with the applicable error message.
 */
function error(type) {
	throw new RangeError(errors[type]);
}

/**
 * A generic `Array#map` utility function.
 * @private
 * @param {Array} array The array to iterate over.
 * @param {Function} callback The function that gets called for every array
 * item.
 * @returns {Array} A new array of values returned by the callback function.
 */
function map(array, callback) {
	const result = [];
	let length = array.length;
	while (length--) {
		result[length] = callback(array[length]);
	}
	return result;
}

/**
 * A simple `Array#map`-like wrapper to work with domain name strings or email
 * addresses.
 * @private
 * @param {String} domain The domain name or email address.
 * @param {Function} callback The function that gets called for every
 * character.
 * @returns {String} A new string of characters returned by the callback
 * function.
 */
function mapDomain(domain, callback) {
	const parts = domain.split('@');
	let result = '';
	if (parts.length > 1) {
		// In email addresses, only the domain name should be punycoded. Leave
		// the local part (i.e. everything up to `@`) intact.
		result = parts[0] + '@';
		domain = parts[1];
	}
	// Avoid `split(regex)` for IE8 compatibility. See #17.
	domain = domain.replace(regexSeparators, '\x2E');
	const labels = domain.split('.');
	const encoded = map(labels, callback).join('.');
	return result + encoded;
}

/**
 * Creates an array containing the numeric code points of each Unicode
 * character in the string. While JavaScript uses UCS-2 internally,
 * this function will convert a pair of surrogate halves (each of which
 * UCS-2 exposes as separate characters) into a single code point,
 * matching UTF-16.
 * @see `punycode.ucs2.encode`
 * @see <https://mathiasbynens.be/notes/javascript-encoding>
 * @memberOf punycode.ucs2
 * @name decode
 * @param {String} string The Unicode input string (UCS-2).
 * @returns {Array} The new array of code points.
 */
function ucs2decode(string) {
	const output = [];
	let counter = 0;
	const length = string.length;
	while (counter < length) {
		const value = string.charCodeAt(counter++);
		if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
			// It's a high surrogate, and there is a next character.
			const extra = string.charCodeAt(counter++);
			if ((extra & 0xFC00) == 0xDC00) { // Low surrogate.
				output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
			} else {
				// It's an unmatched surrogate; only append this code unit, in case the
				// next code unit is the high surrogate of a surrogate pair.
				output.push(value);
				counter--;
			}
		} else {
			output.push(value);
		}
	}
	return output;
}

/**
 * Creates a string based on an array of numeric code points.
 * @see `punycode.ucs2.decode`
 * @memberOf punycode.ucs2
 * @name encode
 * @param {Array} codePoints The array of numeric code points.
 * @returns {String} The new Unicode string (UCS-2).
 */
const ucs2encode = codePoints => String.fromCodePoint(...codePoints);

/**
 * Converts a basic code point into a digit/integer.
 * @see `digitToBasic()`
 * @private
 * @param {Number} codePoint The basic numeric code point value.
 * @returns {Number} The numeric value of a basic code point (for use in
 * representing integers) in the range `0` to `base - 1`, or `base` if
 * the code point does not represent a value.
 */
const basicToDigit = function(codePoint) {
	if (codePoint >= 0x30 && codePoint < 0x3A) {
		return 26 + (codePoint - 0x30);
	}
	if (codePoint >= 0x41 && codePoint < 0x5B) {
		return codePoint - 0x41;
	}
	if (codePoint >= 0x61 && codePoint < 0x7B) {
		return codePoint - 0x61;
	}
	return base;
};

/**
 * Converts a digit/integer into a basic code point.
 * @see `basicToDigit()`
 * @private
 * @param {Number} digit The numeric value of a basic code point.
 * @returns {Number} The basic code point whose value (when used for
 * representing integers) is `digit`, which needs to be in the range
 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
 * used; else, the lowercase form is used. The behavior is undefined
 * if `flag` is non-zero and `digit` has no uppercase form.
 */
const digitToBasic = function(digit, flag) {
	//  0..25 map to ASCII a..z or A..Z
	// 26..35 map to ASCII 0..9
	return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
};

/**
 * Bias adaptation function as per section 3.4 of RFC 3492.
 * https://tools.ietf.org/html/rfc3492#section-3.4
 * @private
 */
const adapt = function(delta, numPoints, firstTime) {
	let k = 0;
	delta = firstTime ? floor(delta / damp) : delta >> 1;
	delta += floor(delta / numPoints);
	for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
		delta = floor(delta / baseMinusTMin);
	}
	return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
};

/**
 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
 * symbols.
 * @memberOf punycode
 * @param {String} input The Punycode string of ASCII-only symbols.
 * @returns {String} The resulting string of Unicode symbols.
 */
const decode = function(input) {
	// Don't use UCS-2.
	const output = [];
	const inputLength = input.length;
	let i = 0;
	let n = initialN;
	let bias = initialBias;

	// Handle the basic code points: let `basic` be the number of input code
	// points before the last delimiter, or `0` if there is none, then copy
	// the first basic code points to the output.

	let basic = input.lastIndexOf(delimiter);
	if (basic < 0) {
		basic = 0;
	}

	for (let j = 0; j < basic; ++j) {
		// if it's not a basic code point
		if (input.charCodeAt(j) >= 0x80) {
			error('not-basic');
		}
		output.push(input.charCodeAt(j));
	}

	// Main decoding loop: start just after the last delimiter if any basic code
	// points were copied; start at the beginning otherwise.

	for (let index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

		// `index` is the index of the next character to be consumed.
		// Decode a generalized variable-length integer into `delta`,
		// which gets added to `i`. The overflow checking is easier
		// if we increase `i` as we go, then subtract off its starting
		// value at the end to obtain `delta`.
		const oldi = i;
		for (let w = 1, k = base; /* no condition */; k += base) {

			if (index >= inputLength) {
				error('invalid-input');
			}

			const digit = basicToDigit(input.charCodeAt(index++));

			if (digit >= base) {
				error('invalid-input');
			}
			if (digit > floor((maxInt - i) / w)) {
				error('overflow');
			}

			i += digit * w;
			const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

			if (digit < t) {
				break;
			}

			const baseMinusT = base - t;
			if (w > floor(maxInt / baseMinusT)) {
				error('overflow');
			}

			w *= baseMinusT;

		}

		const out = output.length + 1;
		bias = adapt(i - oldi, out, oldi == 0);

		// `i` was supposed to wrap around from `out` to `0`,
		// incrementing `n` each time, so we'll fix that now:
		if (floor(i / out) > maxInt - n) {
			error('overflow');
		}

		n += floor(i / out);
		i %= out;

		// Insert `n` at position `i` of the output.
		output.splice(i++, 0, n);

	}

	return String.fromCodePoint(...output);
};

/**
 * Converts a string of Unicode symbols (e.g. a domain name label) to a
 * Punycode string of ASCII-only symbols.
 * @memberOf punycode
 * @param {String} input The string of Unicode symbols.
 * @returns {String} The resulting Punycode string of ASCII-only symbols.
 */
const encode = function(input) {
	const output = [];

	// Convert the input in UCS-2 to an array of Unicode code points.
	input = ucs2decode(input);

	// Cache the length.
	const inputLength = input.length;

	// Initialize the state.
	let n = initialN;
	let delta = 0;
	let bias = initialBias;

	// Handle the basic code points.
	for (const currentValue of input) {
		if (currentValue < 0x80) {
			output.push(stringFromCharCode(currentValue));
		}
	}

	const basicLength = output.length;
	let handledCPCount = basicLength;

	// `handledCPCount` is the number of code points that have been handled;
	// `basicLength` is the number of basic code points.

	// Finish the basic string with a delimiter unless it's empty.
	if (basicLength) {
		output.push(delimiter);
	}

	// Main encoding loop:
	while (handledCPCount < inputLength) {

		// All non-basic code points < n have been handled already. Find the next
		// larger one:
		let m = maxInt;
		for (const currentValue of input) {
			if (currentValue >= n && currentValue < m) {
				m = currentValue;
			}
		}

		// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
		// but guard against overflow.
		const handledCPCountPlusOne = handledCPCount + 1;
		if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
			error('overflow');
		}

		delta += (m - n) * handledCPCountPlusOne;
		n = m;

		for (const currentValue of input) {
			if (currentValue < n && ++delta > maxInt) {
				error('overflow');
			}
			if (currentValue === n) {
				// Represent delta as a generalized variable-length integer.
				let q = delta;
				for (let k = base; /* no condition */; k += base) {
					const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
					if (q < t) {
						break;
					}
					const qMinusT = q - t;
					const baseMinusT = base - t;
					output.push(
						stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
					);
					q = floor(qMinusT / baseMinusT);
				}

				output.push(stringFromCharCode(digitToBasic(q, 0)));
				bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
				delta = 0;
				++handledCPCount;
			}
		}

		++delta;
		++n;

	}
	return output.join('');
};

/**
 * Converts a Punycode string representing a domain name or an email address
 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
 * it doesn't matter if you call it on a string that has already been
 * converted to Unicode.
 * @memberOf punycode
 * @param {String} input The Punycoded domain name or email address to
 * convert to Unicode.
 * @returns {String} The Unicode representation of the given Punycode
 * string.
 */
const toUnicode = function(input) {
	return mapDomain(input, function(string) {
		return regexPunycode.test(string)
			? decode(string.slice(4).toLowerCase())
			: string;
	});
};

/**
 * Converts a Unicode string representing a domain name or an email address to
 * Punycode. Only the non-ASCII parts of the domain name will be converted,
 * i.e. it doesn't matter if you call it with a domain that's already in
 * ASCII.
 * @memberOf punycode
 * @param {String} input The domain name or email address to convert, as a
 * Unicode string.
 * @returns {String} The Punycode representation of the given domain name or
 * email address.
 */
const toASCII = function(input) {
	return mapDomain(input, function(string) {
		return regexNonASCII.test(string)
			? 'xn--' + encode(string)
			: string;
	});
};

/*--------------------------------------------------------------------------*/

/** Define the public API */
const punycode = {
	/**
	 * A string representing the current Punycode.js version number.
	 * @memberOf punycode
	 * @type String
	 */
	'version': '2.1.0',
	/**
	 * An object of methods to convert from JavaScript's internal character
	 * representation (UCS-2) to Unicode code points, and back.
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode
	 * @type Object
	 */
	'ucs2': {
		'decode': ucs2decode,
		'encode': ucs2encode
	},
	'decode': decode,
	'encode': encode,
	'toASCII': toASCII,
	'toUnicode': toUnicode
};

module.exports = punycode;

    },
    "internal/streams/utils": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Symbol,
  SymbolAsyncIterator,
  SymbolFor,
  SymbolIterator,
} = primordials;

// We need to use SymbolFor to make these globally available
// for interoperability with readable-stream, i.e. readable-stream
// and node core needs to be able to read/write private state
// from each other for proper interoperability.
const kIsDestroyed = SymbolFor('nodejs.stream.destroyed');
const kIsErrored = SymbolFor('nodejs.stream.errored');
const kIsReadable = SymbolFor('nodejs.stream.readable');
const kIsWritable = SymbolFor('nodejs.stream.writable');
const kIsDisturbed = SymbolFor('nodejs.stream.disturbed');

const kOnConstructed = Symbol('kOnConstructed');

const kIsClosedPromise = SymbolFor('nodejs.webstream.isClosedPromise');
const kControllerErrorFunction = SymbolFor('nodejs.webstream.controllerErrorFunction');

const kState = Symbol('kState');
const kObjectMode = 1 << 0;
const kErrorEmitted = 1 << 1;
const kAutoDestroy = 1 << 2;
const kEmitClose = 1 << 3;
const kDestroyed = 1 << 4;
const kClosed = 1 << 5;
const kCloseEmitted = 1 << 6;
const kErrored = 1 << 7;
const kConstructed = 1 << 8;

function isReadableNodeStream(obj, strict = false) {
  return !!(
    obj &&
    typeof obj.pipe === 'function' &&
    typeof obj.on === 'function' &&
    (
      !strict ||
      (typeof obj.pause === 'function' && typeof obj.resume === 'function')
    ) &&
    (!obj._writableState || obj._readableState?.readable !== false) && // Duplex
    (!obj._writableState || obj._readableState) // Writable has .pipe.
  );
}

function isWritableNodeStream(obj) {
  return !!(
    obj &&
    typeof obj.write === 'function' &&
    typeof obj.on === 'function' &&
    (!obj._readableState || obj._writableState?.writable !== false) // Duplex
  );
}

function isDuplexNodeStream(obj) {
  return !!(
    obj &&
    (typeof obj.pipe === 'function' && obj._readableState) &&
    typeof obj.on === 'function' &&
    typeof obj.write === 'function'
  );
}

function isNodeStream(obj) {
  return (
    obj &&
    (
      obj._readableState ||
      obj._writableState ||
      (typeof obj.write === 'function' && typeof obj.on === 'function') ||
      (typeof obj.pipe === 'function' && typeof obj.on === 'function')
    )
  );
}

function isReadableStream(obj) {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.pipeThrough === 'function' &&
    typeof obj.getReader === 'function' &&
    typeof obj.cancel === 'function'
  );
}

function isWritableStream(obj) {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.getWriter === 'function' &&
    typeof obj.abort === 'function'
  );
}

function isTransformStream(obj) {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.readable === 'object' &&
    typeof obj.writable === 'object'
  );
}

function isWebStream(obj) {
  return isReadableStream(obj) || isWritableStream(obj) || isTransformStream(obj);
}

function isIterable(obj, isAsync) {
  if (obj == null) return false;
  if (isAsync === true) return typeof obj[SymbolAsyncIterator] === 'function';
  if (isAsync === false) return typeof obj[SymbolIterator] === 'function';
  return typeof obj[SymbolAsyncIterator] === 'function' ||
    typeof obj[SymbolIterator] === 'function';
}

function isDestroyed(stream) {
  if (!isNodeStream(stream)) return null;
  const wState = stream._writableState;
  const rState = stream._readableState;
  const state = wState || rState;
  return !!(stream.destroyed || stream[kIsDestroyed] || state?.destroyed);
}

// Have been end():d.
function isWritableEnded(stream) {
  if (!isWritableNodeStream(stream)) return null;
  if (stream.writableEnded === true) return true;
  const wState = stream._writableState;
  if (wState?.errored) return false;
  if (typeof wState?.ended !== 'boolean') return null;
  return wState.ended;
}

// Have emitted 'finish'.
function isWritableFinished(stream, strict) {
  if (!isWritableNodeStream(stream)) return null;
  if (stream.writableFinished === true) return true;
  const wState = stream._writableState;
  if (wState?.errored) return false;
  if (typeof wState?.finished !== 'boolean') return null;
  return !!(
    wState.finished ||
    (strict === false && wState.ended === true && wState.length === 0)
  );
}

// Have been push(null):d.
function isReadableEnded(stream) {
  if (!isReadableNodeStream(stream)) return null;
  if (stream.readableEnded === true) return true;
  const rState = stream._readableState;
  if (!rState || rState.errored) return false;
  if (typeof rState?.ended !== 'boolean') return null;
  return rState.ended;
}

// Have emitted 'end'.
function isReadableFinished(stream, strict) {
  if (!isReadableNodeStream(stream)) return null;
  const rState = stream._readableState;
  if (rState?.errored) return false;
  if (typeof rState?.endEmitted !== 'boolean') return null;
  return !!(
    rState.endEmitted ||
    (strict === false && rState.ended === true && rState.length === 0)
  );
}

function isReadable(stream) {
  if (stream && stream[kIsReadable] != null) return stream[kIsReadable];
  if (typeof stream?.readable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return isReadableNodeStream(stream) &&
    stream.readable &&
    !isReadableFinished(stream);
}

function isWritable(stream) {
  if (stream && stream[kIsWritable] != null) return stream[kIsWritable];
  if (typeof stream?.writable !== 'boolean') return null;
  if (isDestroyed(stream)) return false;
  return isWritableNodeStream(stream) &&
    stream.writable &&
    !isWritableEnded(stream);
}

function isFinished(stream, opts) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (isDestroyed(stream)) {
    return true;
  }

  if (opts?.readable !== false && isReadable(stream)) {
    return false;
  }

  if (opts?.writable !== false && isWritable(stream)) {
    return false;
  }

  return true;
}

function isWritableErrored(stream) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (stream.writableErrored) {
    return stream.writableErrored;
  }

  return stream._writableState?.errored ?? null;
}

function isReadableErrored(stream) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (stream.readableErrored) {
    return stream.readableErrored;
  }

  return stream._readableState?.errored ?? null;
}

function isClosed(stream) {
  if (!isNodeStream(stream)) {
    return null;
  }

  if (typeof stream.closed === 'boolean') {
    return stream.closed;
  }

  const wState = stream._writableState;
  const rState = stream._readableState;

  if (
    typeof wState?.closed === 'boolean' ||
    typeof rState?.closed === 'boolean'
  ) {
    return wState?.closed || rState?.closed;
  }

  if (typeof stream._closed === 'boolean' && isOutgoingMessage(stream)) {
    return stream._closed;
  }

  return null;
}

function isOutgoingMessage(stream) {
  return (
    typeof stream._closed === 'boolean' &&
    typeof stream._defaultKeepAlive === 'boolean' &&
    typeof stream._removedConnection === 'boolean' &&
    typeof stream._removedContLen === 'boolean'
  );
}

function isServerResponse(stream) {
  return (
    typeof stream._sent100 === 'boolean' &&
    isOutgoingMessage(stream)
  );
}

function isServerRequest(stream) {
  return (
    typeof stream._consuming === 'boolean' &&
    typeof stream._dumped === 'boolean' &&
    stream.req?.upgradeOrConnect === undefined
  );
}

function willEmitClose(stream) {
  if (!isNodeStream(stream)) return null;

  const wState = stream._writableState;
  const rState = stream._readableState;
  const state = wState || rState;

  return (!state && isServerResponse(stream)) || !!(
    state?.autoDestroy &&
    state.emitClose &&
    state.closed === false
  );
}

function isDisturbed(stream) {
  return !!(stream && (
    stream[kIsDisturbed] ??
    (stream.readableDidRead || stream.readableAborted)
  ));
}

function isErrored(stream) {
  return !!(stream && (
    stream[kIsErrored] ??
    stream.readableErrored ??
    stream.writableErrored ??
    stream._readableState?.errorEmitted ??
    stream._writableState?.errorEmitted ??
    stream._readableState?.errored ??
    stream._writableState?.errored
  ));
}

module.exports = {
  kOnConstructed,
  isDestroyed,
  kIsDestroyed,
  isDisturbed,
  kIsDisturbed,
  isErrored,
  kIsErrored,
  isReadable,
  kIsReadable,
  kIsClosedPromise,
  kControllerErrorFunction,
  kIsWritable,
  isClosed,
  isDuplexNodeStream,
  isFinished,
  isIterable,
  isReadableNodeStream,
  isReadableStream,
  isReadableEnded,
  isReadableFinished,
  isReadableErrored,
  isNodeStream,
  isWebStream,
  isWritable,
  isWritableNodeStream,
  isWritableStream,
  isWritableEnded,
  isWritableFinished,
  isWritableErrored,
  isServerRequest,
  isServerResponse,
  willEmitClose,
  isTransformStream,
  kState,
  // bitfields
  kObjectMode,
  kErrorEmitted,
  kAutoDestroy,
  kEmitClose,
  kDestroyed,
  kClosed,
  kCloseEmitted,
  kErrored,
  kConstructed,
};

    },
    "internal/util/debuglog": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  MathFloor,
  Number,
  NumberPrototypeToFixed,
  ObjectDefineProperty,
  RegExp,
  RegExpPrototypeExec,
  SafeArrayIterator,
  SafeMap,
  StringPrototypePadStart,
  StringPrototypeSplit,
  StringPrototypeToLowerCase,
  StringPrototypeToUpperCase,
} = primordials;
const {
  CHAR_LOWERCASE_B: kTraceBegin,
  CHAR_LOWERCASE_E: kTraceEnd,
  CHAR_LOWERCASE_N: kTraceInstant,
} = require('internal/constants');
const { inspect, format, formatWithOptions } = require('internal/util/inspect');
const { getCategoryEnabledBuffer, trace } = internalBinding('trace_events');

// `debugImpls` and `testEnabled` are deliberately not initialized so any call
// to `debuglog()` before `initializeDebugEnv()` is called will throw.
let debugImpls;
let testEnabled;


// `debugEnv` is initial value of process.env.NODE_DEBUG
function initializeDebugEnv(debugEnv) {
  debugImpls = { __proto__: null };
  if (debugEnv) {
    // This is run before any user code, it's OK not to use primordials.
    debugEnv = debugEnv.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll(',', '$|^');
    const debugEnvRegex = new RegExp(`^${debugEnv}$`, 'i');
    testEnabled = (str) => RegExpPrototypeExec(debugEnvRegex, str) !== null;
  } else {
    testEnabled = () => false;
  }
}

// Emits warning when user sets
// NODE_DEBUG=http or NODE_DEBUG=http2.
function emitWarningIfNeeded(set) {
  if ('HTTP' === set || 'HTTP2' === set) {
    process.emitWarning('Setting the NODE_DEBUG environment variable ' +
      'to \'' + StringPrototypeToLowerCase(set) + '\' can expose sensitive ' +
      'data (such as passwords, tokens and authentication headers) ' +
      'in the resulting log.');
  }
}

const noop = () => {};

let utilColors;
function lazyUtilColors() {
  utilColors ??= require('internal/util/colors');
  return utilColors;
}

function debuglogImpl(enabled, set) {
  if (debugImpls[set] === undefined) {
    if (enabled) {
      const pid = process.pid;
      emitWarningIfNeeded(set);
      debugImpls[set] = function debug(...args) {
        const colors = lazyUtilColors().shouldColorize(process.stderr);
        const msg = formatWithOptions({ colors }, ...args);
        const coloredPID = inspect(pid, { colors });
        process.stderr.write(format('%s %s: %s\n', set, coloredPID, msg));
      };
    } else {
      debugImpls[set] = noop;
    }
  }
  return debugImpls[set];
}

// debuglogImpl depends on process.pid and process.env.NODE_DEBUG,
// so it needs to be called lazily in top scopes of internal modules
// that may be loaded before these run time states are allowed to
// be accessed.
function debuglog(set, cb) {
  function init() {
    set = StringPrototypeToUpperCase(set);
    enabled = testEnabled(set);
  }
  let debug = (...args) => {
    init();
    // Only invokes debuglogImpl() when the debug function is
    // called for the first time.
    debug = debuglogImpl(enabled, set);
    if (typeof cb === 'function') {
      ObjectDefineProperty(debug, 'enabled', {
        __proto__: null,
        get() {
          return enabled;
        },
        configurable: true,
        enumerable: true,
      });
      cb(debug);
    }
    switch (args.length) {
      case 1: return debug(args[0]);
      case 2: return debug(args[0], args[1]);
      default: return debug(...new SafeArrayIterator(args));
    }
  };
  let enabled;
  let test = () => {
    init();
    test = () => enabled;
    return enabled;
  };
  const logger = (...args) => {
    // Improve performance when debug is disabled, avoid calling `new SafeArrayIterator(args)`
    if (enabled === false) return;
    switch (args.length) {
      case 1: return debug(args[0]);
      case 2: return debug(args[0], args[1]);
      default: return debug(...new SafeArrayIterator(args));
    }
  };
  ObjectDefineProperty(logger, 'enabled', {
    __proto__: null,
    get() {
      return test();
    },
    configurable: true,
    enumerable: true,
  });
  return logger;
}

function pad(value) {
  return StringPrototypePadStart(`${value}`, 2, '0');
}

const kNone = 1 << 0;
const kSkipLog = 1 << 1;
const kSkipTrace = 1 << 2;
const kShouldSkipAll = kSkipLog | kSkipTrace;

const kSecond = 1000;
const kMinute = 60 * kSecond;
const kHour = 60 * kMinute;

function formatTime(ms) {
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (ms >= kSecond) {
    if (ms >= kMinute) {
      if (ms >= kHour) {
        hours = MathFloor(ms / kHour);
        ms = ms % kHour;
      }
      minutes = MathFloor(ms / kMinute);
      ms = ms % kMinute;
    }
    seconds = ms / kSecond;
  }

  if (hours !== 0 || minutes !== 0) {
    ({ 0: seconds, 1: ms } = StringPrototypeSplit(
      NumberPrototypeToFixed(seconds, 3),
      '.',
      2,
    ));
    const res = hours !== 0 ? `${hours}:${pad(minutes)}` : minutes;
    return `${res}:${pad(seconds)}.${ms} (${hours !== 0 ? 'h:m' : ''}m:ss.mmm)`;
  }

  if (seconds !== 0) {
    return `${NumberPrototypeToFixed(seconds, 3)}s`;
  }

  return `${Number(NumberPrototypeToFixed(ms, 3))}ms`;
}

function safeTraceLabel(label) {
  return label.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * @typedef {(label: string, timeFormatted: string, args?: any[]) => void} LogImpl
 */

/**
 * Returns true if label was found
 * @param {string} timesStore
 * @param {string} implementation
 * @param {LogImpl} logImp
 * @param {string} label
 * @param {any} args
 * @returns {void}
 */
function timeLogImpl(timesStore, implementation, logImp, label, args) {
  const time = timesStore.get(label);
  if (time === undefined) {
    process.emitWarning(`No such label '${label}' for ${implementation}`);
    return;
  }

  const duration = process.hrtime(time);
  const ms = duration[0] * 1000 + duration[1] / 1e6;

  const formatted = formatTime(ms);

  if (args === undefined) {
    logImp(label, formatted);
  } else {
    logImp(label, formatted, args);
  }
}

/**
 * @param {SafeMap} timesStore
 * @param {string} traceCategory
 * @param {string} implementation
 * @param {number} timerFlags
 * @param {string} logLabel
 * @param {string} traceLabel
 * @returns {void}
 */
function time(timesStore, traceCategory, implementation, timerFlags, logLabel = 'default', traceLabel = undefined) {
  // Coerces everything other than Symbol to a string
  logLabel = `${logLabel}`;

  if (traceLabel !== undefined) {
    traceLabel = `${traceLabel}`;
  } else {
    traceLabel = logLabel;
  }

  if (timesStore.has(logLabel)) {
    process.emitWarning(`Label '${logLabel}' already exists for ${implementation}`);
    return;
  }

  if ((timerFlags & kSkipTrace) === 0) {
    traceLabel = safeTraceLabel(traceLabel);
    trace(kTraceBegin, traceCategory, traceLabel, 0);
  }

  timesStore.set(logLabel, process.hrtime());
}

/**
 * @param {SafeMap} timesStore
 * @param {string} traceCategory
 * @param {string} implementation
 * @param {number} timerFlags
 * @param {LogImpl} logImpl
 * @param {string} logLabel
 * @param {string} traceLabel
 * @returns {void}
 */
function timeEnd(
  timesStore,
  traceCategory,
  implementation,
  timerFlags,
  logImpl,
  logLabel = 'default',
  traceLabel = undefined,
) {
  // Coerces everything other than Symbol to a string
  logLabel = `${logLabel}`;

  if (traceLabel !== undefined) {
    traceLabel = `${traceLabel}`;
  } else {
    traceLabel = logLabel;
  }

  if ((timerFlags & kSkipLog) === 0) {
    timeLogImpl(timesStore, implementation, logImpl, logLabel);
  }

  if ((timerFlags & kSkipTrace) === 0) {
    traceLabel = safeTraceLabel(traceLabel);
    trace(kTraceEnd, traceCategory, traceLabel, 0);
  }

  timesStore.delete(logLabel);
}

/**
 * @param {SafeMap} timesStore
 * @param {string} traceCategory
 * @param {string} implementation
 * @param {number} timerFlags
 * @param {LogImpl} logImpl
 * @param {string} logLabel
 * @param {string} traceLabel
 * @param {any[]} args
 * @returns {void}
 */
function timeLog(
  timesStore,
  traceCategory,
  implementation,
  timerFlags,
  logImpl,
  logLabel = 'default',
  traceLabel = undefined,
  args,
) {
  // Coerces everything other than Symbol to a string
  logLabel = `${logLabel}`;

  if (traceLabel !== undefined) {
    traceLabel = `${traceLabel}`;
  } else {
    traceLabel = logLabel;
  }

  if ((timerFlags & kSkipLog) === 0) {
    timeLogImpl(timesStore, implementation, logImpl, logLabel, args);
  }

  if ((timerFlags & kSkipTrace) === 0) {
    traceLabel = safeTraceLabel(traceLabel);
    trace(kTraceInstant, traceCategory, traceLabel, 0);
  }
}

/**
 * @type {Record<string, SafeMap>}
 */
let tracesStores;

/**
 * @typedef {(logLabel: string, traceLabel?: string) => void} TimerStart
 */

/**
 * @typedef {(logLabel: string, traceLabel?: string) => void} TimerEnd
 */

/**
 * @typedef {(logLabel: string, traceLabel?: string, args?: any[]) => void} TimerLog
 */

/**
 * Debuglog with time fns and support for trace
 * @param {string} set
 * @param {(startTimer: TimerStart, endTimer: TimerEnd, logTimer: TimerLog) => void} cb
 * @returns {{startTimer: TimerStart, endTimer: TimerEnd, logTimer: TimerLog}}
 */
function debugWithTimer(set, cb) {
  set = StringPrototypeToUpperCase(set);

  if (tracesStores === undefined) {
    tracesStores = { __proto__: null };
  }

  /**
   * @type {LogImpl}
   */
  function logImpl(label, timeFormatted, args) {
    const pid = process.pid;
    const colors = { colors: lazyUtilColors().shouldColorize(process.stderr) };
    const coloredPID = inspect(pid, colors);

    if (args === undefined)
      process.stderr.write(format('%s %s %s: %s\n', set, coloredPID, label, timeFormatted));
    else
      process.stderr.write(
        format(
          '%s %s %s: %s\n',
          set,
          coloredPID,
          label,
          timeFormatted,
          ...new SafeArrayIterator(args),
        ),
      );
  }

  const traceCategory = `node,node.${StringPrototypeToLowerCase(set)}`;
  let traceCategoryBuffer;
  let debugLogCategoryEnabled = false;
  let timerFlags = kNone;

  function ensureTimerFlagsAreUpdated() {
    timerFlags &= ~kSkipTrace;

    if (traceCategoryBuffer[0] === 0) {
      timerFlags |= kSkipTrace;
    }
  }

  /**
   * @type {TimerStart}
   */
  function internalStartTimer(logLabel, traceLabel) {
    ensureTimerFlagsAreUpdated();

    if ((timerFlags & kShouldSkipAll) === kShouldSkipAll) {
      return;
    }

    time(
      tracesStores[set],
      traceCategory,
      'debuglog.time',
      timerFlags,
      logLabel,
      traceLabel,
    );
  }

  /**
   * @type {TimerEnd}
   */
  function internalEndTimer(logLabel, traceLabel) {
    ensureTimerFlagsAreUpdated();

    if ((timerFlags & kShouldSkipAll) === kShouldSkipAll) {
      return;
    }

    timeEnd(
      tracesStores[set],
      traceCategory,
      'debuglog.timeEnd',
      timerFlags,
      logImpl,
      logLabel,
      traceLabel,
    );
  }

  /**
   * @type {TimerLog}
   */
  function internalLogTimer(logLabel, traceLabel, args) {
    ensureTimerFlagsAreUpdated();

    if ((timerFlags & kShouldSkipAll) === kShouldSkipAll) {
      return;
    }

    timeLog(
      tracesStores[set],
      traceCategory,
      'debuglog.timeLog',
      timerFlags,
      logImpl,
      logLabel,
      traceLabel,
      args,
    );
  }

  function init() {
    if (tracesStores[set] === undefined) {
      tracesStores[set] = new SafeMap();
    }
    emitWarningIfNeeded(set);
    debugLogCategoryEnabled = testEnabled(set);
    traceCategoryBuffer = getCategoryEnabledBuffer(traceCategory);

    timerFlags = kNone;

    if (!debugLogCategoryEnabled) {
      timerFlags |= kSkipLog;
    }

    if (traceCategoryBuffer[0] === 0) {
      timerFlags |= kSkipTrace;
    }

    cb(internalStartTimer, internalEndTimer, internalLogTimer);
  }

  /**
   * @type {TimerStart}
   */
  const startTimer = (logLabel, traceLabel) => {
    init();

    if ((timerFlags & kShouldSkipAll) !== kShouldSkipAll)
      internalStartTimer(logLabel, traceLabel);
  };

  /**
   * @type {TimerEnd}
   */
  const endTimer = (logLabel, traceLabel) => {
    init();

    if ((timerFlags & kShouldSkipAll) !== kShouldSkipAll)
      internalEndTimer(logLabel, traceLabel);
  };

  /**
   * @type {TimerLog}
   */
  const logTimer = (logLabel, traceLabel, args) => {
    init();

    if ((timerFlags & kShouldSkipAll) !== kShouldSkipAll)
      internalLogTimer(logLabel, traceLabel, args);
  };

  return {
    startTimer,
    endTimer,
    logTimer,
  };
}

module.exports = {
  kNone,
  kSkipLog,
  kSkipTrace,
  formatTime,
  time,
  timeEnd,
  timeLog,
  debuglog,
  debugWithTimer,
  initializeDebugEnv,
};

    },
    "internal/mime": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  FunctionPrototypeCall,
  ObjectDefineProperty,
  RegExpPrototypeExec,
  SafeMap,
  SafeStringPrototypeSearch,
  StringPrototypeCharAt,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
  SymbolIterator,
} = primordials;
const {
  ERR_INVALID_MIME_SYNTAX,
} = require('internal/errors').codes;

const NOT_HTTP_TOKEN_CODE_POINT = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/g;
const NOT_HTTP_QUOTED_STRING_CODE_POINT = /[^\t\u0020-~\u0080-\u00FF]/g;

const END_BEGINNING_WHITESPACE = /[^\r\n\t ]|$/;
const START_ENDING_WHITESPACE = /[\r\n\t ]*$/;

function toASCIILower(str) {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(str)) return StringPrototypeToLowerCase(str);
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    result += char >= 'A' && char <= 'Z' ?
      StringPrototypeToLowerCase(char) :
      char;
  }
  return result;
}

const SOLIDUS = '/';
const SEMICOLON = ';';

function parseTypeAndSubtype(str) {
  // Skip only HTTP whitespace from start
  let position = SafeStringPrototypeSearch(str, END_BEGINNING_WHITESPACE);
  // read until '/'
  const typeEnd = StringPrototypeIndexOf(str, SOLIDUS, position);
  const trimmedType = typeEnd === -1 ?
    StringPrototypeSlice(str, position) :
    StringPrototypeSlice(str, position, typeEnd);
  const invalidTypeIndex = SafeStringPrototypeSearch(trimmedType,
                                                     NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedType === '' || invalidTypeIndex !== -1 || typeEnd === -1) {
    throw new ERR_INVALID_MIME_SYNTAX('type', str, invalidTypeIndex);
  }
  // skip type and '/'
  position = typeEnd + 1;
  const type = toASCIILower(trimmedType);
  // read until ';'
  const subtypeEnd = StringPrototypeIndexOf(str, SEMICOLON, position);
  const rawSubtype = subtypeEnd === -1 ?
    StringPrototypeSlice(str, position) :
    StringPrototypeSlice(str, position, subtypeEnd);
  position += rawSubtype.length;
  if (subtypeEnd !== -1) {
    // skip ';'
    position += 1;
  }
  const trimmedSubtype = StringPrototypeSlice(
    rawSubtype,
    0,
    SafeStringPrototypeSearch(rawSubtype, START_ENDING_WHITESPACE));
  const invalidSubtypeIndex = SafeStringPrototypeSearch(trimmedSubtype,
                                                        NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedSubtype === '' || invalidSubtypeIndex !== -1) {
    throw new ERR_INVALID_MIME_SYNTAX('subtype', str, invalidSubtypeIndex);
  }
  const subtype = toASCIILower(trimmedSubtype);
  return [
    type,
    subtype,
    position,
  ];
}

const EQUALS_SEMICOLON_OR_END = /[;=]|$/;
const QUOTED_VALUE_PATTERN = /^(?:([\\]$)|[\\][\s\S]|[^"])*(?:(")|$)/u;

function removeBackslashes(str) {
  let ret = '';
  // We stop at str.length - 1 because we want to look ahead one character.
  let i;
  for (i = 0; i < str.length - 1; i++) {
    const c = str[i];
    if (c === '\\') {
      i++;
      ret += str[i];
    } else {
      ret += c;
    }
  }
  // We add the last character if we didn't skip to it.
  if (i === str.length - 1) {
    ret += str[i];
  }
  return ret;
}


function escapeQuoteOrSolidus(str) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    result += (char === '"' || char === '\\') ? `\\${char}` : char;
  }
  return result;
}

const encode = (value) => {
  if (value.length === 0) return '""';
  const encode = SafeStringPrototypeSearch(value, NOT_HTTP_TOKEN_CODE_POINT) !== -1;
  if (!encode) return value;
  const escaped = escapeQuoteOrSolidus(value);
  return `"${escaped}"`;
};

class MIMEParams {
  #data = new SafeMap();
  // We set the flag the MIMEParams instance as processed on initialization
  // to defer the parsing of a potentially large string.
  #processed = true;
  #string = null;

  /**
   * Used to instantiate a MIMEParams object within the MIMEType class and
   * to allow it to be parsed lazily.
   */
  static instantiateMimeParams(str) {
    const instance = new MIMEParams();
    instance.#string = str;
    instance.#processed = false;
    return instance;
  }

  delete(name) {
    this.#parse();
    this.#data.delete(name);
  }

  get(name) {
    this.#parse();
    const data = this.#data;
    if (data.has(name)) {
      return data.get(name);
    }
    return null;
  }

  has(name) {
    this.#parse();
    return this.#data.has(name);
  }

  set(name, value) {
    this.#parse();
    const data = this.#data;
    name = `${name}`;
    value = `${value}`;
    const invalidNameIndex = SafeStringPrototypeSearch(name, NOT_HTTP_TOKEN_CODE_POINT);
    if (name.length === 0 || invalidNameIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX(
        'parameter name',
        name,
        invalidNameIndex,
      );
    }
    const invalidValueIndex = SafeStringPrototypeSearch(
      value,
      NOT_HTTP_QUOTED_STRING_CODE_POINT);
    if (invalidValueIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX(
        'parameter value',
        value,
        invalidValueIndex,
      );
    }
    data.set(name, value);
  }

  *entries() {
    this.#parse();
    yield* this.#data.entries();
  }

  *keys() {
    this.#parse();
    yield* this.#data.keys();
  }

  *values() {
    this.#parse();
    yield* this.#data.values();
  }

  toString() {
    this.#parse();
    let ret = '';
    for (const { 0: key, 1: value } of this.#data) {
      const encoded = encode(value);
      // Ensure they are separated
      if (ret.length) ret += ';';
      ret += `${key}=${encoded}`;
    }
    return ret;
  }

  // Used to act as a friendly class to stringifying stuff
  // not meant to be exposed to users, could inject invalid values
  #parse() {
    if (this.#processed) return;  // already parsed
    const paramsMap = this.#data;
    let position = 0;
    const str = this.#string;
    const endOfSource = SafeStringPrototypeSearch(
      StringPrototypeSlice(str, position),
      START_ENDING_WHITESPACE,
    ) + position;
    while (position < endOfSource) {
      // Skip any whitespace before parameter
      position += SafeStringPrototypeSearch(
        StringPrototypeSlice(str, position),
        END_BEGINNING_WHITESPACE,
      );
      // Read until ';' or '='
      const afterParameterName = SafeStringPrototypeSearch(
        StringPrototypeSlice(str, position),
        EQUALS_SEMICOLON_OR_END,
      ) + position;
      const parameterString = toASCIILower(
        StringPrototypeSlice(str, position, afterParameterName),
      );
      position = afterParameterName;
      // If we found a terminating character
      if (position < endOfSource) {
        // Safe to use because we never do special actions for surrogate pairs
        const char = StringPrototypeCharAt(str, position);
        // Skip the terminating character
        position += 1;
        // Ignore parameters without values
        if (char === ';') {
          continue;
        }
      }
      // If we are at end of the string, it cannot have a value
      if (position >= endOfSource) break;
      // Safe to use because we never do special actions for surrogate pairs
      const char = StringPrototypeCharAt(str, position);
      let parameterValue = null;
      if (char === '"') {
        // Handle quoted-string form of values
        // skip '"'
        position += 1;
        // Find matching closing '"' or end of string
        //   use $1 to see if we terminated on unmatched '\'
        //   use $2 to see if we terminated on a matching '"'
        //   so we can skip the last char in either case
        const insideMatch = RegExpPrototypeExec(
          QUOTED_VALUE_PATTERN,
          StringPrototypeSlice(str, position));
        position += insideMatch[0].length;
        // Skip including last character if an unmatched '\' or '"' during
        // unescape
        const inside = insideMatch[1] || insideMatch[2] ?
          StringPrototypeSlice(insideMatch[0], 0, -1) :
          insideMatch[0];
        // Unescape '\' quoted characters
        parameterValue = removeBackslashes(inside);
        // If we did have an unmatched '\' add it back to the end
        if (insideMatch[1]) parameterValue += '\\';
      } else {
        // Handle the normal parameter value form
        const valueEnd = StringPrototypeIndexOf(str, SEMICOLON, position);
        const rawValue = valueEnd === -1 ?
          StringPrototypeSlice(str, position) :
          StringPrototypeSlice(str, position, valueEnd);
        position += rawValue.length;
        const trimmedValue = StringPrototypeSlice(
          rawValue,
          0,
          SafeStringPrototypeSearch(rawValue, START_ENDING_WHITESPACE),
        );
        // Ignore parameters without values
        if (trimmedValue === '') continue;
        parameterValue = trimmedValue;
      }
      if (
        parameterString !== '' &&
        SafeStringPrototypeSearch(parameterString,
                                  NOT_HTTP_TOKEN_CODE_POINT) === -1 &&
        SafeStringPrototypeSearch(parameterValue,
                                  NOT_HTTP_QUOTED_STRING_CODE_POINT) === -1 &&
        paramsMap.has(parameterString) === false
      ) {
        paramsMap.set(parameterString, parameterValue);
      }
      position++;
    }
    this.#data = paramsMap;
    this.#processed = true;
  }
}
const MIMEParamsStringify = MIMEParams.prototype.toString;
ObjectDefineProperty(MIMEParams.prototype, SymbolIterator, {
  __proto__: null,
  configurable: true,
  value: MIMEParams.prototype.entries,
  writable: true,
});
ObjectDefineProperty(MIMEParams.prototype, 'toJSON', {
  __proto__: null,
  configurable: true,
  value: MIMEParamsStringify,
  writable: true,
});

const { instantiateMimeParams } = MIMEParams;
delete MIMEParams.instantiateMimeParams;

class MIMEType {
  #type;
  #subtype;
  #parameters;
  constructor(string) {
    string = `${string}`;
    const data = parseTypeAndSubtype(string);
    this.#type = data[0];
    this.#subtype = data[1];
    this.#parameters = instantiateMimeParams(StringPrototypeSlice(string, data[2]));
  }

  get type() {
    return this.#type;
  }

  set type(v) {
    v = `${v}`;
    const invalidTypeIndex = SafeStringPrototypeSearch(v, NOT_HTTP_TOKEN_CODE_POINT);
    if (v.length === 0 || invalidTypeIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX('type', v, invalidTypeIndex);
    }
    this.#type = toASCIILower(v);
  }

  get subtype() {
    return this.#subtype;
  }

  set subtype(v) {
    v = `${v}`;
    const invalidSubtypeIndex = SafeStringPrototypeSearch(v, NOT_HTTP_TOKEN_CODE_POINT);
    if (v.length === 0 || invalidSubtypeIndex !== -1) {
      throw new ERR_INVALID_MIME_SYNTAX('subtype', v, invalidSubtypeIndex);
    }
    this.#subtype = toASCIILower(v);
  }

  get essence() {
    return `${this.#type}/${this.#subtype}`;
  }

  get params() {
    return this.#parameters;
  }

  toString() {
    let ret = `${this.#type}/${this.#subtype}`;
    const paramStr = FunctionPrototypeCall(MIMEParamsStringify, this.#parameters);
    if (paramStr.length) ret += `;${paramStr}`;
    return ret;
  }
}
ObjectDefineProperty(MIMEType.prototype, 'toJSON', {
  __proto__: null,
  configurable: true,
  value: MIMEType.prototype.toString,
  writable: true,
});

module.exports = {
  MIMEParams,
  MIMEType,
};

    },
    "internal/util/diff": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeReverse,
} = primordials;

const { validateStringArray, validateString } = require('internal/validators');
const { myersDiff } = require('internal/assert/myers_diff');

function validateInput(value, name) {
  if (!ArrayIsArray(value)) {
    validateString(value, name);
    return;
  }

  validateStringArray(value, name);
}

/**
 * Generate a difference report between two values
 * @param {Array | string} actual - The first value to compare
 * @param {Array | string} expected - The second value to compare
 * @returns {Array} - An array of differences between the two values.
 * The returned data is an array of arrays, where each sub-array has two elements:
 * 1. The operation to perform: -1 for delete, 0 for no-op, 1 for insert
 * 2. The value to perform the operation on
 */
function diff(actual, expected) {
  if (actual === expected) {
    return [];
  }

  validateInput(actual, 'actual');
  validateInput(expected, 'expected');

  return ArrayPrototypeReverse(myersDiff(actual, expected));
}

module.exports = {
  diff,
};

    },
    "internal/util/parse_args/utils": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeFind,
  ObjectEntries,
  ObjectPrototypeHasOwnProperty: ObjectHasOwn,
  StringPrototypeCharAt,
  StringPrototypeIncludes,
  StringPrototypeStartsWith,
} = primordials;

const {
  validateObject,
} = require('internal/validators');

// These are internal utilities to make the parsing logic easier to read, and
// add lots of detail for the curious. They are in a separate file to allow
// unit testing, although that is not essential (this could be rolled into
// main file and just tested implicitly via API).
//
// These routines are for internal use, not for export to client.

/**
 * Return the named property, but only if it is an own property.
 */
function objectGetOwn(obj, prop) {
  if (ObjectHasOwn(obj, prop))
    return obj[prop];
}

/**
 * Return the named options property, but only if it is an own property.
 */
function optionsGetOwn(options, longOption, prop) {
  if (ObjectHasOwn(options, longOption))
    return objectGetOwn(options[longOption], prop);
}

/**
 * Determines if the argument may be used as an option value.
 * @example
 * isOptionValue('V') // returns true
 * isOptionValue('-v') // returns true (greedy)
 * isOptionValue('--foo') // returns true (greedy)
 * isOptionValue(undefined) // returns false
 */
function isOptionValue(value) {
  if (value == null) return false;

  // Open Group Utility Conventions are that an option-argument
  // is the argument after the option, and may start with a dash.
  return true; // greedy!
}

/**
 * Detect whether there is possible confusion and user may have omitted
 * the option argument, like `--port --verbose` when `port` of type:string.
 * In strict mode we throw errors if value is option-like.
 */
function isOptionLikeValue(value) {
  if (value == null) return false;

  return value.length > 1 && StringPrototypeCharAt(value, 0) === '-';
}

/**
 * Determines if `arg` is just a short option.
 * @example '-f'
 */
function isLoneShortOption(arg) {
  return arg.length === 2 &&
    StringPrototypeCharAt(arg, 0) === '-' &&
    StringPrototypeCharAt(arg, 1) !== '-';
}

/**
 * Determines if `arg` is a lone long option.
 * @example
 * isLoneLongOption('a') // returns false
 * isLoneLongOption('-a') // returns false
 * isLoneLongOption('--foo') // returns true
 * isLoneLongOption('--foo=bar') // returns false
 */
function isLoneLongOption(arg) {
  return arg.length > 2 &&
    StringPrototypeStartsWith(arg, '--') &&
    !StringPrototypeIncludes(arg, '=', 3);
}

/**
 * Determines if `arg` is a long option and value in the same argument.
 * @example
 * isLongOptionAndValue('--foo') // returns false
 * isLongOptionAndValue('--foo=bar') // returns true
 */
function isLongOptionAndValue(arg) {
  return arg.length > 2 &&
    StringPrototypeStartsWith(arg, '--') &&
    StringPrototypeIncludes(arg, '=', 3);
}

/**
 * Determines if `arg` is a short option group.
 *
 * See Guideline 5 of the [Open Group Utility Conventions](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html).
 *   One or more options without option-arguments, followed by at most one
 *   option that takes an option-argument, should be accepted when grouped
 *   behind one '-' delimiter.
 * @example
 * isShortOptionGroup('-a', {}) // returns false
 * isShortOptionGroup('-ab', {}) // returns true
 * // -fb is an option and a value, not a short option group
 * isShortOptionGroup('-fb', {
 *   options: { f: { type: 'string' } }
 * }) // returns false
 * isShortOptionGroup('-bf', {
 *   options: { f: { type: 'string' } }
 * }) // returns true
 * // -bfb is an edge case, return true and caller sorts it out
 * isShortOptionGroup('-bfb', {
 *   options: { f: { type: 'string' } }
 * }) // returns true
 */
function isShortOptionGroup(arg, options) {
  if (arg.length <= 2) return false;
  if (StringPrototypeCharAt(arg, 0) !== '-') return false;
  if (StringPrototypeCharAt(arg, 1) === '-') return false;

  const firstShort = StringPrototypeCharAt(arg, 1);
  const longOption = findLongOptionForShort(firstShort, options);
  return optionsGetOwn(options, longOption, 'type') !== 'string';
}

/**
 * Determine if arg is a short string option followed by its value.
 * @example
 * isShortOptionAndValue('-a', {}); // returns false
 * isShortOptionAndValue('-ab', {}); // returns false
 * isShortOptionAndValue('-fFILE', {
 *   options: { foo: { short: 'f', type: 'string' }}
 * }) // returns true
 */
function isShortOptionAndValue(arg, options) {
  validateObject(options, 'options');

  if (arg.length <= 2) return false;
  if (StringPrototypeCharAt(arg, 0) !== '-') return false;
  if (StringPrototypeCharAt(arg, 1) === '-') return false;

  const shortOption = StringPrototypeCharAt(arg, 1);
  const longOption = findLongOptionForShort(shortOption, options);
  return optionsGetOwn(options, longOption, 'type') === 'string';
}

/**
 * Find the long option associated with a short option. Looks for a configured
 * `short` and returns the short option itself if a long option is not found.
 * @example
 * findLongOptionForShort('a', {}) // returns 'a'
 * findLongOptionForShort('b', {
 *   options: { bar: { short: 'b' } }
 * }) // returns 'bar'
 */
function findLongOptionForShort(shortOption, options) {
  validateObject(options, 'options');
  const longOptionEntry = ArrayPrototypeFind(
    ObjectEntries(options),
    ({ 1: optionConfig }) => objectGetOwn(optionConfig, 'short') === shortOption,
  );
  return longOptionEntry?.[0] ?? shortOption;
}

/**
 * Check if the given option includes a default value
 * and that option has not been set by the input args.
 * @param {string} longOption - long option name e.g. 'foo'
 * @param {object} optionConfig - the option configuration properties
 * @param {object} values - option values returned in `values` by parseArgs
 */
function useDefaultValueOption(longOption, optionConfig, values) {
  return objectGetOwn(optionConfig, 'default') !== undefined &&
    values[longOption] === undefined;
}

module.exports = {
  findLongOptionForShort,
  isLoneLongOption,
  isLoneShortOption,
  isLongOptionAndValue,
  isOptionValue,
  isOptionLikeValue,
  isShortOptionAndValue,
  isShortOptionGroup,
  useDefaultValueOption,
  objectGetOwn,
  optionsGetOwn,
};

    },
    "internal/util/parse_args/parse_args": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypeForEach,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  ArrayPrototypePushApply,
  ArrayPrototypeShift,
  ArrayPrototypeSlice,
  ArrayPrototypeUnshiftApply,
  ObjectEntries,
  ObjectPrototypeHasOwnProperty: ObjectHasOwn,
  StringPrototypeCharAt,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeStartsWith,
} = primordials;

const {
  validateArray,
  validateBoolean,
  validateBooleanArray,
  validateObject,
  validateString,
  validateStringArray,
  validateUnion,
} = require('internal/validators');

const {
  findLongOptionForShort,
  isLoneLongOption,
  isLoneShortOption,
  isLongOptionAndValue,
  isOptionValue,
  isOptionLikeValue,
  isShortOptionAndValue,
  isShortOptionGroup,
  useDefaultValueOption,
  objectGetOwn,
  optionsGetOwn,
} = require('internal/util/parse_args/utils');

const {
  codes: {
    ERR_INVALID_ARG_VALUE,
    ERR_PARSE_ARGS_INVALID_OPTION_VALUE,
    ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL,
    ERR_PARSE_ARGS_UNKNOWN_OPTION,
  },
} = require('internal/errors');

const {
  kEmptyObject,
} = require('internal/util');

const { getOptionValue } = require('internal/options');

function getMainArgs() {
  // -p / --print internally sets --eval, so this works for all cases
  const evalValue = getOptionValue('--eval');

  if (evalValue.length !== 0) {
    return ArrayPrototypeSlice(process.argv, 1);
  }

  return ArrayPrototypeSlice(process.argv, 2);
}

/**
 * In strict mode, throw for possible usage errors like --foo --bar
 * @param {object} token - from tokens as available from parseArgs
 */
function checkOptionLikeValue(token) {
  if (!token.inlineValue && isOptionLikeValue(token.value)) {
    // Only show short example if user used short option.
    const example = StringPrototypeStartsWith(token.rawName, '--') ?
      `'${token.rawName}=-XYZ'` :
      `'--${token.name}=-XYZ' or '${token.rawName}-XYZ'`;
    const errorMessage = `Option '${token.rawName}' argument is ambiguous.
Did you forget to specify the option argument for '${token.rawName}'?
To specify an option argument starting with a dash use ${example}.`;
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(errorMessage);
  }
}

/**
 * In strict mode, throw for usage errors.
 * @param {object} config - from config passed to parseArgs
 * @param {object} token - from tokens as available from parseArgs
 */
function checkOptionUsage(config, token) {
  let tokenName = token.name;
  if (!ObjectHasOwn(config.options, tokenName)) {
    // Check for negated boolean option.
    if (config.allowNegative && StringPrototypeStartsWith(tokenName, 'no-')) {
      tokenName = StringPrototypeSlice(tokenName, 3);
      if (!ObjectHasOwn(config.options, tokenName) || optionsGetOwn(config.options, tokenName, 'type') !== 'boolean') {
        throw new ERR_PARSE_ARGS_UNKNOWN_OPTION(
          token.rawName, config.allowPositionals);
      }
    } else {
      throw new ERR_PARSE_ARGS_UNKNOWN_OPTION(
        token.rawName, config.allowPositionals);
    }
  }

  const short = optionsGetOwn(config.options, tokenName, 'short');
  const shortAndLong = `${short ? `-${short}, ` : ''}--${tokenName}`;
  const type = optionsGetOwn(config.options, tokenName, 'type');
  if (type === 'string' && typeof token.value !== 'string') {
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(`Option '${shortAndLong} <value>' argument missing`);
  }
  // (Idiomatic test for undefined||null, expecting undefined.)
  if (type === 'boolean' && token.value != null) {
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(`Option '${shortAndLong}' does not take an argument`);
  }
}


/**
 * Store the option value in `values`.
 * @param {object} token - from tokens as available from parseArgs
 * @param {object} options - option configs, from parseArgs({ options })
 * @param {object} values - option values returned in `values` by parseArgs
 * @param {boolean} allowNegative - allow negative optinons if true
 */
function storeOption(token, options, values, allowNegative) {
  let longOption = token.name;
  let optionValue = token.value;
  if (longOption === '__proto__') {
    return; // No. Just no.
  }

  if (allowNegative && StringPrototypeStartsWith(longOption, 'no-') && optionValue === undefined) {
    // Boolean option negation: --no-foo
    longOption = StringPrototypeSlice(longOption, 3);
    token.name = longOption;
    optionValue = false;
  }

  // We store based on the option value rather than option type,
  // preserving the users intent for author to deal with.
  const newValue = optionValue ?? true;
  if (optionsGetOwn(options, longOption, 'multiple')) {
    // Always store value in array, including for boolean.
    // values[longOption] starts out not present,
    // first value is added as new array [newValue],
    // subsequent values are pushed to existing array.
    // (note: values has null prototype, so simpler usage)
    if (values[longOption]) {
      ArrayPrototypePush(values[longOption], newValue);
    } else {
      values[longOption] = [newValue];
    }
  } else {
    values[longOption] = newValue;
  }
}

/**
 * Store the default option value in `values`.
 * @param {string} longOption - long option name e.g. 'foo'
 * @param {string
 *         | boolean
 *         | string[]
 *         | boolean[]} optionValue - default value from option config
 * @param {object} values - option values returned in `values` by parseArgs
 */
function storeDefaultOption(longOption, optionValue, values) {
  if (longOption === '__proto__') {
    return; // No. Just no.
  }

  values[longOption] = optionValue;
}

/**
 * Process args and turn into identified tokens:
 * - option (along with value, if any)
 * - positional
 * - option-terminator
 * @param {string[]} args - from parseArgs({ args }) or mainArgs
 * @param {object} options - option configs, from parseArgs({ options })
 */
function argsToTokens(args, options) {
  const tokens = [];
  let index = -1;
  let groupCount = 0;

  const remainingArgs = ArrayPrototypeSlice(args);
  while (remainingArgs.length > 0) {
    const arg = ArrayPrototypeShift(remainingArgs);
    const nextArg = remainingArgs[0];
    if (groupCount > 0)
      groupCount--;
    else
      index++;

    // Check if `arg` is an options terminator.
    // Guideline 10 in https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html
    if (arg === '--') {
      // Everything after a bare '--' is considered a positional argument.
      ArrayPrototypePush(tokens, { kind: 'option-terminator', index });
      ArrayPrototypePushApply(
        tokens, ArrayPrototypeMap(remainingArgs, (arg) => {
          return { kind: 'positional', index: ++index, value: arg };
        }),
      );
      break; // Finished processing args, leave while loop.
    }

    if (isLoneShortOption(arg)) {
      // e.g. '-f'
      const shortOption = StringPrototypeCharAt(arg, 1);
      const longOption = findLongOptionForShort(shortOption, options);
      let value;
      let inlineValue;
      if (optionsGetOwn(options, longOption, 'type') === 'string' &&
          isOptionValue(nextArg)) {
        // e.g. '-f', 'bar'
        value = ArrayPrototypeShift(remainingArgs);
        inlineValue = false;
      }
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: arg,
          index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isShortOptionGroup(arg, options)) {
      // Expand -fXzy to -f -X -z -y
      const expanded = [];
      for (let index = 1; index < arg.length; index++) {
        const shortOption = StringPrototypeCharAt(arg, index);
        const longOption = findLongOptionForShort(shortOption, options);
        if (optionsGetOwn(options, longOption, 'type') !== 'string' ||
          index === arg.length - 1) {
          // Boolean option, or last short in group. Well formed.
          ArrayPrototypePush(expanded, `-${shortOption}`);
        } else {
          // String option in middle. Yuck.
          // Expand -abfFILE to -a -b -fFILE
          ArrayPrototypePush(expanded, `-${StringPrototypeSlice(arg, index)}`);
          break; // finished short group
        }
      }
      ArrayPrototypeUnshiftApply(remainingArgs, expanded);
      groupCount = expanded.length;
      continue;
    }

    if (isShortOptionAndValue(arg, options)) {
      // e.g. -fFILE
      const shortOption = StringPrototypeCharAt(arg, 1);
      const longOption = findLongOptionForShort(shortOption, options);
      const value = StringPrototypeSlice(arg, 2);
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: `-${shortOption}`,
          index, value, inlineValue: true });
      continue;
    }

    if (isLoneLongOption(arg)) {
      // e.g. '--foo'
      const longOption = StringPrototypeSlice(arg, 2);
      let value;
      let inlineValue;
      if (optionsGetOwn(options, longOption, 'type') === 'string' &&
          isOptionValue(nextArg)) {
        // e.g. '--foo', 'bar'
        value = ArrayPrototypeShift(remainingArgs);
        inlineValue = false;
      }
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: arg,
          index, value, inlineValue });
      if (value != null) ++index;
      continue;
    }

    if (isLongOptionAndValue(arg)) {
      // e.g. --foo=bar
      const equalIndex = StringPrototypeIndexOf(arg, '=');
      const longOption = StringPrototypeSlice(arg, 2, equalIndex);
      const value = StringPrototypeSlice(arg, equalIndex + 1);
      ArrayPrototypePush(
        tokens,
        { kind: 'option', name: longOption, rawName: `--${longOption}`,
          index, value, inlineValue: true });
      continue;
    }

    ArrayPrototypePush(tokens, { kind: 'positional', index, value: arg });
  }
  return tokens;
}

const parseArgs = (config = kEmptyObject) => {
  const args = objectGetOwn(config, 'args') ?? getMainArgs();
  const strict = objectGetOwn(config, 'strict') ?? true;
  const allowPositionals = objectGetOwn(config, 'allowPositionals') ?? !strict;
  const returnTokens = objectGetOwn(config, 'tokens') ?? false;
  const allowNegative = objectGetOwn(config, 'allowNegative') ?? false;
  const options = objectGetOwn(config, 'options') ?? { __proto__: null };
  // Bundle these up for passing to strict-mode checks.
  const parseConfig = { args, strict, options, allowPositionals, allowNegative };

  // Validate input configuration.
  validateArray(args, 'args');
  validateBoolean(strict, 'strict');
  validateBoolean(allowPositionals, 'allowPositionals');
  validateBoolean(returnTokens, 'tokens');
  validateBoolean(allowNegative, 'allowNegative');
  validateObject(options, 'options');
  ArrayPrototypeForEach(
    ObjectEntries(options),
    ({ 0: longOption, 1: optionConfig }) => {
      validateObject(optionConfig, `options.${longOption}`);

      // type is required
      const optionType = objectGetOwn(optionConfig, 'type');
      validateUnion(optionType, `options.${longOption}.type`, ['string', 'boolean']);

      if (ObjectHasOwn(optionConfig, 'short')) {
        const shortOption = optionConfig.short;
        validateString(shortOption, `options.${longOption}.short`);
        if (shortOption.length !== 1) {
          throw new ERR_INVALID_ARG_VALUE(
            `options.${longOption}.short`,
            shortOption,
            'must be a single character',
          );
        }
      }

      const multipleOption = objectGetOwn(optionConfig, 'multiple');
      if (ObjectHasOwn(optionConfig, 'multiple')) {
        validateBoolean(multipleOption, `options.${longOption}.multiple`);
      }

      const defaultValue = objectGetOwn(optionConfig, 'default');
      if (defaultValue !== undefined) {
        let validator;
        switch (optionType) {
          case 'string':
            validator = multipleOption ? validateStringArray : validateString;
            break;

          case 'boolean':
            validator = multipleOption ? validateBooleanArray : validateBoolean;
            break;
        }
        validator(defaultValue, `options.${longOption}.default`);
      }
    },
  );

  // Phase 1: identify tokens
  const tokens = argsToTokens(args, options);

  // Phase 2: process tokens into parsed option values and positionals
  const result = {
    values: { __proto__: null },
    positionals: [],
  };
  if (returnTokens) {
    result.tokens = tokens;
  }
  ArrayPrototypeForEach(tokens, (token) => {
    if (token.kind === 'option') {
      if (strict) {
        checkOptionUsage(parseConfig, token);
        checkOptionLikeValue(token);
      }
      storeOption(token, options, result.values, parseConfig.allowNegative);
    } else if (token.kind === 'positional') {
      if (!allowPositionals) {
        throw new ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL(token.value);
      }
      ArrayPrototypePush(result.positionals, token.value);
    }
  });

  // Phase 3: fill in default values for missing args
  ArrayPrototypeForEach(ObjectEntries(options), ({ 0: longOption,
                                                   1: optionConfig }) => {
    const mustSetDefault = useDefaultValueOption(longOption,
                                                 optionConfig,
                                                 result.values);
    if (mustSetDefault) {
      storeDefaultOption(longOption,
                         objectGetOwn(optionConfig, 'default'),
                         result.values);
    }
  });


  return result;
};

module.exports = {
  parseArgs,
};

    },
    "internal/util/trace_sigint": function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const { isMainThread } = require('worker_threads');
const {
  ERR_WORKER_UNSUPPORTED_OPERATION,
} = require('internal/errors').codes;

let sigintWatchdog;
function getSigintWatchdog() {
  if (!sigintWatchdog) {
    const { SigintWatchdog } = require('internal/watchdog');
    sigintWatchdog = new SigintWatchdog();
  }
  return sigintWatchdog;
}

function setTraceSigInt(enable) {
  if (!isMainThread)
    throw new ERR_WORKER_UNSUPPORTED_OPERATION('Calling util.setTraceSigInt');
  if (enable) {
    getSigintWatchdog().start();
  } else {
    getSigintWatchdog().stop();
  }
};

module.exports = {
  setTraceSigInt,
};

    },
    "util": function (exports, require, module, process, internalBinding, primordials) {
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypePop,
  ArrayPrototypePush,
  ArrayPrototypeReduce,
  Date,
  DatePrototypeGetDate,
  DatePrototypeGetHours,
  DatePrototypeGetMinutes,
  DatePrototypeGetMonth,
  DatePrototypeGetSeconds,
  Error,
  ErrorCaptureStackTrace,
  FunctionPrototypeBind,
  NumberIsSafeInteger,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectGetOwnPropertyDescriptors,
  ObjectKeys,
  ObjectPrototypeToString,
  ObjectSetPrototypeOf,
  ObjectValues,
  ReflectApply,
  RegExp,
  RegExpPrototypeSymbolReplace,
  StringPrototypePadStart,
  StringPrototypeToWellFormed,
} = primordials;

const {
  ErrnoException,
  ExceptionWithHostPort,
  codes: {
    ERR_FALSY_VALUE_REJECTION,
    ERR_INVALID_ARG_TYPE,
    ERR_OUT_OF_RANGE,
  },
  isErrorStackTraceLimitWritable,
} = require('internal/errors');
const {
  format,
  formatWithOptions,
  inspect,
  stripVTControlCharacters,
} = require('internal/util/inspect');
const { debuglog } = require('internal/util/debuglog');
const {
  validateBoolean,
  validateFunction,
  validateNumber,
  validateString,
  validateOneOf,
  validateObject,
} = require('internal/validators');
const { isBuffer } = require('buffer').Buffer;
const {
  isReadableStream,
  isWritableStream,
  isNodeStream,
} = require('internal/streams/utils');
const types = require('internal/util/types');

let utilColors;
function lazyUtilColors() {
  utilColors ??= require('internal/util/colors');
  return utilColors;
}
const { getOptionValue } = require('internal/options');

const binding = internalBinding('util');

const {
  deprecate,
  getLazy,
  getSystemErrorMap,
  getSystemErrorName: internalErrorName,
  getSystemErrorMessage: internalErrorMessage,
  promisify,
  defineLazyProperties,
} = require('internal/util');

let abortController;

function lazyAbortController() {
  abortController ??= require('internal/abort_controller');
  return abortController;
}

let internalDeepEqual;

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is boolean}
 */
function isBoolean(arg) {
  return typeof arg === 'boolean';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is null}
 */
function isNull(arg) {
  return arg === null;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is (null | undefined)}
 */
function isNullOrUndefined(arg) {
  return arg === null || arg === undefined;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is number}
 */
function isNumber(arg) {
  return typeof arg === 'number';
}

/**
 * @param {any} arg
 * @returns {arg is string}
 */
function isString(arg) {
  return typeof arg === 'string';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is symbol}
 */
function isSymbol(arg) {
  return typeof arg === 'symbol';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is undefined}
 */
function isUndefined(arg) {
  return arg === undefined;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {a is NonNullable<object>}
 */
function isObject(arg) {
  return arg !== null && typeof arg === 'object';
}

/**
 * @deprecated since v4.0.0
 * @param {any} e
 * @returns {arg is Error}
 */
function isError(e) {
  return ObjectPrototypeToString(e) === '[object Error]' || e instanceof Error;
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is Function}
 */
function isFunction(arg) {
  return typeof arg === 'function';
}

/**
 * @deprecated since v4.0.0
 * @param {any} arg
 * @returns {arg is (boolean | null | number | string | symbol | undefined)}
 */
function isPrimitive(arg) {
  return arg === null ||
         (typeof arg !== 'object' && typeof arg !== 'function');
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad(n) {
  return StringPrototypePadStart(n.toString(), 2, '0');
}

/**
 * @param {string} [code]
 * @returns {string}
 */
function escapeStyleCode(code) {
  if (code === undefined) return '';
  return `\u001b[${code}m`;
}

/**
 * @param {string | string[]} format
 * @param {string} text
 * @param {object} [options={}]
 * @param {boolean} [options.validateStream=true] - Whether to validate the stream.
 * @param {Stream} [options.stream=process.stdout] - The stream used for validation.
 * @returns {string}
 */
function styleText(format, text, { validateStream = true, stream = process.stdout } = {}) {
  validateString(text, 'text');
  validateBoolean(validateStream, 'options.validateStream');

  let skipColorize;
  if (validateStream) {
    if (
      !isReadableStream(stream) &&
      !isWritableStream(stream) &&
      !isNodeStream(stream)
    ) {
      throw new ERR_INVALID_ARG_TYPE('stream', ['ReadableStream', 'WritableStream', 'Stream'], stream);
    }

    // If the stream is falsy or should not be colorized, set skipColorize to true
    skipColorize = !lazyUtilColors().shouldColorize(stream);
  }

  // If the format is not an array, convert it to an array
  const formatArray = ArrayIsArray(format) ? format : [format];

  const codes = [];
  for (const key of formatArray) {
    if (key === 'none') continue;
    const formatCodes = inspect.colors[key];
    // If the format is not a valid style, throw an error
    if (formatCodes == null) {
      validateOneOf(key, 'format', ObjectKeys(inspect.colors));
    }
    if (skipColorize) continue;
    ArrayPrototypePush(codes, formatCodes);
  }

  if (skipColorize) {
    return text;
  }

  // Build opening codes
  let openCodes = '';
  for (let i = 0; i < codes.length; i++) {
    openCodes += escapeStyleCode(codes[i][0]);
  }

  // Process the text to handle nested styles
  let processedText;
  if (codes.length > 0) {
    processedText = ArrayPrototypeReduce(
      codes,
      (text, code) => RegExpPrototypeSymbolReplace(
        // Find the reset code
        new RegExp(`\\u001b\\[${code[1]}m`, 'g'),
        text,
        (match, offset) => {
          // Check if there's more content after this reset
          if (offset + match.length < text.length) {
            if (
              code[0] === inspect.colors.dim[0] ||
              code[0] === inspect.colors.bold[0]
            ) {
              // Dim and bold are not mutually exclusive, so we need to reapply
              return `${match}${escapeStyleCode(code[0])}`;
            }
            return escapeStyleCode(code[0]);
          }
          return match;
        },
      ),
      text,
    );
  } else {
    processedText = text;
  }

  // Build closing codes in reverse order
  let closeCodes = '';
  for (let i = codes.length - 1; i >= 0; i--) {
    closeCodes += escapeStyleCode(codes[i][1]);
  }

  return `${openCodes}${processedText}${closeCodes}`;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                'Oct', 'Nov', 'Dec'];

/**
 * @returns {string}  26 Feb 16:19:34
 */
function timestamp() {
  const d = new Date();
  const t = ArrayPrototypeJoin([
    pad(DatePrototypeGetHours(d)),
    pad(DatePrototypeGetMinutes(d)),
    pad(DatePrototypeGetSeconds(d)),
  ], ':');
  return `${DatePrototypeGetDate(d)} ${months[DatePrototypeGetMonth(d)]} ${t}`;
}

let console;
/**
 * Log is just a thin wrapper to console.log that prepends a timestamp
 * @deprecated since v6.0.0
 * @type {(...args: any[]) => void}
 */
function log(...args) {
  console ??= require('internal/console/global');
  console.log('%s - %s', timestamp(), format(...args));
}

/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 * @param {Function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {Function} superCtor Constructor function to inherit prototype from.
 * @throws {TypeError} Will error if either constructor is null, or if
 *     the super constructor lacks a prototype.
 */
function inherits(ctor, superCtor) {

  if (ctor === undefined || ctor === null)
    throw new ERR_INVALID_ARG_TYPE('ctor', 'Function', ctor);

  if (superCtor === undefined || superCtor === null)
    throw new ERR_INVALID_ARG_TYPE('superCtor', 'Function', superCtor);

  if (superCtor.prototype === undefined) {
    throw new ERR_INVALID_ARG_TYPE('superCtor.prototype',
                                   'Object', superCtor.prototype);
  }
  ObjectDefineProperty(ctor, 'super_', {
    __proto__: null,
    value: superCtor,
    writable: true,
    configurable: true,
  });
  ObjectSetPrototypeOf(ctor.prototype, superCtor.prototype);
}

/**
 * @deprecated since v6.0.0
 * @template T
 * @template S
 * @param {T} target
 * @param {S} source
 * @returns {S extends null ? T : (T & S)}
 */
function _extend(target, source) {
  // Don't do anything if source isn't an object
  if (source === null || typeof source !== 'object') return target;

  const keys = ObjectKeys(source);
  let i = keys.length;
  while (i--) {
    target[keys[i]] = source[keys[i]];
  }
  return target;
}

const callbackifyOnRejected = (reason, cb) => {
  // `!reason` guard inspired by bluebird (Ref: https://goo.gl/t5IS6M).
  // Because `null` is a special error value in callbacks which means "no error
  // occurred", we error-wrap so the callback consumer can distinguish between
  // "the promise rejected with null" or "the promise fulfilled with undefined".
  if (!reason) {
    reason = new ERR_FALSY_VALUE_REJECTION.HideStackFramesError(reason);
    ErrorCaptureStackTrace(reason, callbackifyOnRejected);
  }
  return cb(reason);
};

/**
 * @template {(...args: any[]) => Promise<any>} T
 * @param {T} original
 * @returns {T extends (...args: infer TArgs) => Promise<infer TReturn> ?
 *   ((...params: [...TArgs, ((err: Error, ret: TReturn) => any)]) => void) :
 *   never
 * }
 */
function callbackify(original) {
  validateFunction(original, 'original');

  // We DO NOT return the promise as it gives the user a false sense that
  // the promise is actually somehow related to the callback's execution
  // and that the callback throwing will reject the promise.
  function callbackified(...args) {
    const maybeCb = ArrayPrototypePop(args);
    validateFunction(maybeCb, 'last argument');
    const cb = FunctionPrototypeBind(maybeCb, this);
    // In true node style we process the callback on `nextTick` with all the
    // implications (stack, `uncaughtException`, `async_hooks`)
    ReflectApply(original, this, args)
      .then((ret) => process.nextTick(cb, null, ret),
            (rej) => process.nextTick(callbackifyOnRejected, rej, cb));
  }

  const descriptors = ObjectGetOwnPropertyDescriptors(original);
  // It is possible to manipulate a functions `length` or `name` property. This
  // guards against the manipulation.
  if (typeof descriptors.length.value === 'number') {
    descriptors.length.value++;
  }
  if (typeof descriptors.name.value === 'string') {
    descriptors.name.value += 'Callbackified';
  }
  const propertiesValues = ObjectValues(descriptors);
  for (let i = 0; i < propertiesValues.length; i++) {
  // We want to use null-prototype objects to not rely on globally mutable
  // %Object.prototype%.
    ObjectSetPrototypeOf(propertiesValues[i], null);
  }
  ObjectDefineProperties(callbackified, descriptors);
  return callbackified;
}

/**
 * @param {number} err
 * @returns {string}
 */
function getSystemErrorMessage(err) {
  validateNumber(err, 'err');
  if (err >= 0 || !NumberIsSafeInteger(err)) {
    throw new ERR_OUT_OF_RANGE('err', 'a negative integer', err);
  }
  return internalErrorMessage(err);
}

/**
 * @param {number} err
 * @returns {string}
 */
function getSystemErrorName(err) {
  validateNumber(err, 'err');
  if (err >= 0 || !NumberIsSafeInteger(err)) {
    throw new ERR_OUT_OF_RANGE('err', 'a negative integer', err);
  }
  return internalErrorName(err);
}

function _errnoException(...args) {
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const e = new ErrnoException(...args);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(e, _errnoException);
    return e;
  }
  return new ErrnoException(...args);
}

function _exceptionWithHostPort(...args) {
  if (isErrorStackTraceLimitWritable()) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const e = new ExceptionWithHostPort(...args);
    Error.stackTraceLimit = limit;
    ErrorCaptureStackTrace(e, _exceptionWithHostPort);
    return e;
  }
  return new ExceptionWithHostPort(...args);
}

/**
 * Parses the content of a `.env` file.
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnv(content) {
  validateString(content, 'content');
  return binding.parseEnv(content);
}

const lazySourceMap = getLazy(() => require('internal/source_map/source_map_cache'));

/**
 * @typedef {object} CallSite // The call site
 * @property {string} scriptName // The name of the resource that contains the
 * script for the function for this StackFrame
 * @property {string} functionName // The name of the function associated with this stack frame
 * @property {number} lineNumber // The number, 1-based, of the line for the associate function call
 * @property {number} columnNumber // The 1-based column offset on the line for the associated function call
 */

/**
 * @param {CallSite} callSite // The call site object to reconstruct from source map
 * @returns {CallSite | undefined} // The reconstructed call site object
 */
function reconstructCallSite(callSite) {
  const { scriptName, lineNumber, columnNumber } = callSite;
  const sourceMap = lazySourceMap().findSourceMap(scriptName);
  if (!sourceMap) return;
  const entry = sourceMap.findEntry(lineNumber - 1, columnNumber - 1);
  if (!entry?.originalSource) return;
  return {
    __proto__: null,
    // If the name is not found, it is an empty string to match the behavior of `util.getCallSite()`
    functionName: entry.name ?? '',
    scriptName: entry.originalSource,
    lineNumber: entry.originalLine + 1,
    column: entry.originalColumn + 1,
    columnNumber: entry.originalColumn + 1,
  };
}

/**
 *
 * The call site array to map
 * @param {CallSite[]} callSites
 * Array of objects with the reconstructed call site
 * @returns {CallSite[]}
 */
function mapCallSite(callSites) {
  const result = [];
  for (let i = 0; i < callSites.length; ++i) {
    const callSite = callSites[i];
    const found = reconstructCallSite(callSite);
    ArrayPrototypePush(result, found ?? callSite);
  }
  return result;
}

/**
 * @typedef {object} CallSiteOptions // The call site options
 * @property {boolean} sourceMap // Enable source map support
 */

/**
 * Returns the callSite
 * @param {number} frameCount
 * @param {CallSiteOptions} options
 * @returns {CallSite[]}
 */
function getCallSites(frameCount = 10, options) {
  // If options is not provided check if frameCount is an object
  if (options === undefined) {
    if (typeof frameCount === 'object') {
      // If frameCount is an object, it is the options object
      options = frameCount;
      validateObject(options, 'options');
      if (options.sourceMap !== undefined) {
        validateBoolean(options.sourceMap, 'options.sourceMap');
      }
      frameCount = 10;
    } else {
      // If options is not provided, set it to an empty object
      options = {};
    };
  } else {
    // If options is provided, validate it
    validateObject(options, 'options');
    if (options.sourceMap !== undefined) {
      validateBoolean(options.sourceMap, 'options.sourceMap');
    }
  }

  // Using kDefaultMaxCallStackSizeToCapture as reference
  validateNumber(frameCount, 'frameCount', 1, 200);
  // If options.sourceMaps is true or if sourceMaps are enabled but the option.sourceMaps is not set explicitly to false
  if (options.sourceMap === true || (getOptionValue('--enable-source-maps') && options.sourceMap !== false)) {
    return mapCallSite(binding.getCallSites(frameCount));
  }
  return binding.getCallSites(frameCount);
};

// Keep the `exports =` so that various functions can still be monkeypatched
module.exports = {
  _errnoException,
  _exceptionWithHostPort,
  _extend: deprecate(_extend,
                     'The `util._extend` API is deprecated. Please use Object.assign() instead.',
                     'DEP0060'),
  callbackify,
  debug: debuglog,
  debuglog,
  deprecate,
  format,
  styleText,
  formatWithOptions,
  // Deprecated getCallSite.
  // This API can be removed in next semver-minor release.
  getCallSite: deprecate(getCallSites,
                         'The `util.getCallSite` API has been renamed to `util.getCallSites()`.',
                         'ExperimentalWarning'),
  getCallSites,
  getSystemErrorMap,
  getSystemErrorName,
  getSystemErrorMessage,
  inherits,
  inspect,
  isArray: deprecate(ArrayIsArray,
                     'The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.',
                     'DEP0044'),
  isBoolean: deprecate(isBoolean,
                       'The `util.isBoolean` API is deprecated.  Please use `typeof arg === "boolean"` instead.',
                       'DEP0045'),
  isBuffer: deprecate(isBuffer,
                      'The `util.isBuffer` API is deprecated. Please use `Buffer.isBuffer()` instead.',
                      'DEP0046'),
  isDeepStrictEqual(a, b) {
    if (internalDeepEqual === undefined) {
      internalDeepEqual = require('internal/util/comparisons')
        .isDeepStrictEqual;
    }
    return internalDeepEqual(a, b);
  },
  isNull: deprecate(isNull,
                    'The `util.isNull` API is deprecated. Please use `arg === null` instead.',
                    'DEP0050'),
  isNullOrUndefined: deprecate(isNullOrUndefined,
                               'The `util.isNullOrUndefined` API is deprecated. ' +
                               'Please use `arg === null || arg === undefined` instead.',
                               'DEP0051'),
  isNumber: deprecate(isNumber,
                      'The `util.isNumber` API is deprecated. Please use `typeof arg === "number"` instead.',
                      'DEP0052'),
  isString: deprecate(isString,
                      'The `util.isString` API is deprecated.  Please use `typeof arg === "string"` instead.',
                      'DEP0056'),
  isSymbol: deprecate(isSymbol,
                      'The `util.isSymbol` API is deprecated.  Please use `arg === "symbol"` instead.',
                      'DEP0057'),
  isUndefined: deprecate(isUndefined,
                         'The `util.isUndefined` API is deprecated. Please use `arg === undefined` instead.',
                         'DEP0058'),
  isRegExp: deprecate(types.isRegExp,
                      'The `util.isRegExp` API is deprecated. Please use `arg instanceof RegExp` instead.',
                      'DEP0055'),
  isObject: deprecate(isObject,
                      'The `util.isObject` API is deprecated. ' +
                      'Please use `arg !== null && typeof arg === "object"` instead.',
                      'DEP0053'),
  isDate: deprecate(types.isDate,
                    'The `util.isDate` API is deprecated.  Please use `arg instanceof Date` instead.',
                    'DEP0047'),
  isError: deprecate(isError,
                     'The `util.isError` API is deprecated. ' +
                     'Please use `ObjectPrototypeToString(e) === "[object Error]" ' +
                     '|| e instanceof Error` instead.',
                     'DEP0048'),
  isFunction: deprecate(isFunction,
                        'The `util.isFunction` API is deprecated.  Please use `typeof arg === "function"` instead.',
                        'DEP0049'),
  isPrimitive: deprecate(isPrimitive,
                         'The `util.isPrimitive` API is deprecated. ' +
                         'Please use `arg === null || ' +
                         '(typeof arg !== "object" && typeof arg !== "function")` instead.',
                         'DEP0054'),
  log: deprecate(log,
                 'The `util.log API is deprecated. ' +
                 'Please use console.log() with a custom formatter or a third-party logger instead.',
                 'DEP0059'),
  promisify,
  stripVTControlCharacters,
  toUSVString(input) {
    return StringPrototypeToWellFormed(`${input}`);
  },
  get transferableAbortSignal() {
    return lazyAbortController().transferableAbortSignal;
  },
  get transferableAbortController() {
    return lazyAbortController().transferableAbortController;
  },
  get aborted() {
    return lazyAbortController().aborted;
  },
  types,
  parseEnv,
};

defineLazyProperties(
  module.exports,
  'internal/util/parse_args/parse_args',
  ['parseArgs'],
);

defineLazyProperties(
  module.exports,
  'internal/encoding',
  ['TextDecoder', 'TextEncoder'],
);

defineLazyProperties(
  module.exports,
  'internal/mime',
  ['MIMEType', 'MIMEParams'],
);

defineLazyProperties(
  module.exports,
  'internal/util/diff',
  ['diff'],
);

defineLazyProperties(
  module.exports,
  'internal/util/trace_sigint',
  ['setTraceSigInt'],
);

    },
  },
};
