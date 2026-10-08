/**
 * Source of what Node's own modules (node-lib-source.ts) are given in a
 * Worker in place of Node's internal modules and bindings:
 * `createNodeLib(platform)`, whose `require(id)` runs a module of Node's
 * library once, the first time it is asked for, and returns its exports.
 * generateShimsCode embeds this text (node-shims.ts, "Node's library"), and
 * tests/unit/node-inspect-matches-node.mjs evaluates the same text beside
 * Node's own. A string, not a function's toString(): tsc and bun print
 * function source differently (see javascript-string-literal.ts).
 *
 * What Node's modules require of its internals that is not itself one of
 * them is ported here: lib/internal/util.js join, removeColors, isError,
 * deprecate, setOwnProperty and normalizeEncoding; lib/internal/errors.js
 * codes (core _shared/node-error.ts nodeErrorCodes, Node's messages),
 * hideStackFrames, isErrorStackTraceLimitWritable and isStackOverflowError;
 * lib/internal/url.js isURL; lib/internal/util/types.js's typed-array
 * checks; src/node_i18n.cc GetStringWidth; and the bindings below. The
 * errors are the shims' (node-error.ts), which the text calls by name. Of
 * the util binding, the property and constructor-name readers are
 * JavaScript, and every brand check is intrinsic (util.types), never the
 * prototype chain.
 *
 * THE BINDING. A promise's state and result, a proxy's target and handler,
 * a Map or Set iterator's and a weak collection's entries are V8 slots no
 * user-land JavaScript can read. Node's util binding reads them; here
 * `platform.slots` does, with its signatures (getPromiseDetails,
 * getProxyDetails, previewEntries), after the host's intrinsic brand check,
 * and hands inspect.js the slots' values, which it formats itself: one
 * formatter for every value. In workerd, platform.slots is
 * createWorkerdSlots (WORKERD_SLOTS_SOURCE); where Node runs this host (its
 * parity test), Node's own binding. Named limits (fine-print capabilities):
 * a proxy among a slot's values is a stand-in over its target and handler,
 * which no program code is ever handed: shown without showProxy, one whose
 * target has a custom inspect shows as unknown (Node calls the hook with the
 * proxy as this), and a proxy inside it is shown by its innermost target,
 * its traps not run; and a holder whose class has its own instanceof check
 * or a name getter, whose own Symbol.toStringTag is an accessor, or with
 * a proxy on its prototype chain, shows its slot as unknown, since reading
 * it would run that code once more than Node.
 *
 * `platform`: { util (the platform's node:util), slots, Buffer, url ({ URL,
 * pathToFileURL }), process, builtinModules, builtinObjects (Node's
 * NODE_BUILTIN_OBJECTS), eastAsianWide(code), signals (os.constants.signals),
 * insideNodeModules() (whether the caller's code is a package's),
 * errorSourcePositions(error) (where V8 places the frame an error was
 * captured at: { sourceLine, scriptResourceName, lineNumber, startColumn },
 * or undefined), tokenizer(code, options) (acorn's), sourceMaps
 * ({ getSourceMapsSupport, findSourceMap, getSourceLine }), colorDepth()
 * (internal/tty getColorDepth), primordialsOf(primordials, globalThis), and
 * sources: { [id]: (exports, require, module, process, internalBinding,
 * primordials) => void } }, the last two running the upstream text.
 */
export const NODE_LIB_HOST_SOURCE = String.raw`function createNodeLib(platform) {
  "use strict";
  const platformUtil = platform.util;
  const primordials = {};
  platform.primordialsOf(primordials, globalThis);
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

  // Node's internal modules that are not its own text here, by id.
  const hosted = {
    "internal/util": internalUtil,
    "internal/errors": { codes: nodeErrorCodes, hideStackFrames, isErrorStackTraceLimitWritable, isStackOverflowError },
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
  function require(id) {
    if (Object.prototype.hasOwnProperty.call(hosted, id)) return hosted[id];
    const cached = loaded.get(id);
    if (cached !== undefined) return cached.exports;
    const source = platform.sources[id];
    if (source === undefined) throw new Error("No such built-in module: " + id);
    const module = { exports: {}, id };
    loaded.set(id, module);
    source(module.exports, require, module, platform.process, internalBinding, id === "internal/util/inspect" ? inspectPrimordials : primordials);
    return module.exports;
  }
  return { require };
}`;


/**
 * Source of `createWorkerdSlots(util)`: Node's util binding's V8 slot
 * readers (getPromiseDetails, getProxyDetails, previewEntries) over
 * workerd's node:util, whose inspect reads those slots and no other
 * workerd API does. A read runs workerd's inspect on the value with
 * customInspect and getters off, and takes each value it formats one level
 * in as the formatter reaches it, in order: an object at the cycle check
 * every object passes (`ctx.seen.includes(value)`), which answers it seen so
 * none of it is formatted, a primitive at `stylize`, as the literal it is
 * handed decodes. Of what it
 * renders, only workerd's own marks are read: a proxy past the depth
 * (`Proxy [Array]`), a revoked one (`<Revoked Proxy>`), a promise's
 * state, and whether an iterator's entries are key-value pairs (its brace,
 * `[Map Entries] {`).
 *
 * A proxy among a slot's values is read the same way, its target and
 * handler a level deeper, and handed over as a stand-in over its target
 * with none of the program's traps, which getProxyDetails unwraps whenever
 * inspect.js meets it, so no program code is handed one. A holder workerd
 * could not format without running program code (formatsInertly) is not
 * read: its slot shows as unknown.
 */
export const WORKERD_SLOTS_SOURCE = String.raw`function createWorkerdSlots(util) {
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
}`;
