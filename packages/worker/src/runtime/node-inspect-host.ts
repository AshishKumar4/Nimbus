/**
 * Source of what Node's util.inspect (node-inspect-source.ts) is given in a
 * Worker in place of Node's internal modules and bindings:
 * `createNodeInspect(platform)`, which runs inspect.js and returns its
 * exports. generateShimsCode embeds this text (node-shims.ts,
 * "util.inspect"), and tests/unit/node-inspect-matches-node.mjs evaluates
 * the same text beside Node's own. A string, not a function's toString():
 * tsc and bun print function source differently (see
 * javascript-string-literal.ts).
 *
 * Node's own functions are ported: lib/internal/util.js join, removeColors
 * and isError; lib/internal/errors.js isStackOverflowError and the message
 * of ERR_INVALID_ARG_TYPE; lib/internal/validators.js validateObject and
 * validateString; src/node_i18n.cc GetStringWidth. Of the util binding, the
 * property and constructor-name readers are JavaScript. What only V8's
 * internals read (a promise's state, a proxy's target, an iterator's or a
 * weak collection's entries), and the properties of a workerd API object
 * with no inspect method of its own (its prototype's kResourceTypeInspect,
 * workerd jsg/resource.h), are formatted by the platform's own inspect,
 * workerd's port of Node's, which reads them: inspect.js reaches every
 * object through getProxyDetails first and formats what that answers in the
 * value's place, through its inspect hook. So what such a value holds is
 * printed as workerd prints it (a symbol key bare, `Symbol(k)` for Node's
 * `[Symbol(k)]`), and with customInspect false it is printed with none of
 * those internals: a promise `<pending>`, an iterator's entries empty, a
 * proxy through its traps, where Node reads V8 there too.
 *
 * `platform`: { util (the platform's node:util), Buffer, url ({ URL,
 * pathToFileURL }), process, builtinModules, eastAsianWide(code),
 * primordialsOf(primordials, globalThis), inspectOf(exports, require, module,
 * process, internalBinding, primordials) }, the last two running the
 * upstream sources.
 */
export const NODE_INSPECT_HOST_SOURCE = String.raw`function createNodeInspect(platform) {
  "use strict";
  const platformUtil = platform.util;
  const types = platformUtil.types;
  const primordials = {};
  platform.primordialsOf(primordials, globalThis);
  const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  let lazyInspect;

  // lib/internal/errors.js: the errors inspect.js and its validators raise.
  function nodeError(Base, code, message) {
    const error = new Base(message);
    Object.defineProperty(error, "code", { value: code, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(error, "toString", {
      value() { return this.name + " [" + code + "]: " + this.message; }, writable: true, configurable: true,
    });
    return error;
  }
  function determineSpecificType(value) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    switch (typeof value) {
      case "bigint": return "type bigint (" + value + "n)";
      case "number":
        if (value === 0) return 1 / value === -Infinity ? "type number (-0)" : "type number (0)";
        if (value !== value) return "type number (NaN)";
        if (value === Infinity) return "type number (Infinity)";
        if (value === -Infinity) return "type number (-Infinity)";
        return "type number (" + value + ")";
      case "boolean": return value ? "type boolean (true)" : "type boolean (false)";
      case "symbol": return "type symbol (" + String(value) + ")";
      case "function": return "function " + value.name;
      case "object":
        if (value.constructor && "name" in value.constructor) return "an instance of " + value.constructor.name;
        return lazyInspect.inspect(value, { depth: -1 });
      case "string": {
        const text = value.length > 28 ? value.slice(0, 25) + "..." : value;
        if (text.indexOf("'") === -1) return "type string ('" + text + "')";
        return "type string (" + JSON.stringify(text) + ")";
      }
      default: {
        let inspected = lazyInspect.inspect(value, { colors: false });
        if (inspected.length > 28) inspected = inspected.slice(0, 25) + "...";
        return "type " + typeof value + " (" + inspected + ")";
      }
    }
  }
  // ERR_INVALID_ARG_TYPE for the one type each validator here expects.
  function invalidArgType(name, type, actual) {
    const kind = name.includes(".") ? "property" : "argument";
    return nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
      "The \"" + name + "\" " + kind + " must be of type " + type + ". Received " + determineSpecificType(actual));
  }
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
  function assert(value, message) {
    if (!value) {
      throw nodeError(Error, "ERR_INTERNAL_ASSERTION", message ?? "This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n");
    }
  }
  assert.fail = (message) => assert(false, message);

  // lib/internal/validators.js
  const kValidateObjectNone = 0;
  const kValidateObjectAllowNullable = 1 << 0;
  const kValidateObjectAllowArray = 1 << 1;
  const kValidateObjectAllowFunction = 1 << 2;
  function validateObject(value, name, options = kValidateObjectNone) {
    if (options === kValidateObjectNone) {
      if (value === null || Array.isArray(value) || typeof value !== "object") throw invalidArgType(name, "object", value);
      return;
    }
    if ((kValidateObjectAllowNullable & options) === 0 && value === null) throw invalidArgType(name, "object", value);
    if ((kValidateObjectAllowArray & options) === 0 && Array.isArray(value)) throw invalidArgType(name, "object", value);
    const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
    if (typeof value !== "object" && (throwOnFunction || typeof value !== "function")) throw invalidArgType(name, "object", value);
  }
  function validateString(value, name) {
    if (typeof value !== "string") throw invalidArgType(name, "string", value);
  }

  // lib/internal/util.js
  const colorRegExp = /\u001b\[\d\d?m/g;
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
  };

  // The util binding. getProxyDetails answers, for a value only V8's
  // internals or workerd read, a stand-in whose inspect hook the platform
  // formats it for; a call through the exports below says whether hooks run.
  let customInspectOn = true;
  // Which objects' formatting needs the platform, by their prototype, so a
  // plain object costs one native check (is it a proxy?), as Node's
  // getProxyDetails does: an object whose chain holds the prototype of a
  // promise, a Map or Set iterator, a WeakMap or WeakSet, or a workerd API
  // type (its kResourceTypeInspect, workerd jsg/resource.h). A value of those
  // kinds whose prototype was replaced is formatted by inspect.js alone.
  const mapIteratorPrototype = Object.getPrototypeOf(new Map().entries());
  const setIteratorPrototype = Object.getPrototypeOf(new Set().values());
  const platformPrototypes = new Set([Promise.prototype, mapIteratorPrototype, setIteratorPrototype, WeakMap.prototype, WeakSet.prototype]);
  const chainNeedsPlatform = new WeakMap();
  function protoNeedsPlatform(proto) {
    if (proto === null || proto === Object.prototype || proto === Array.prototype) return false;
    let needs = chainNeedsPlatform.get(proto);
    if (needs === undefined) {
      needs = platformPrototypes.has(proto)
        || Object.getOwnPropertySymbols(proto).some((symbol) => symbol.description === "kResourceTypeInspect")
        || protoNeedsPlatform(Object.getPrototypeOf(proto));
      chainNeedsPlatform.set(proto, needs);
    }
    return needs;
  }
  function needsPlatform(value) {
    if (types.isProxy(value)) return true;
    if (!protoNeedsPlatform(Object.getPrototypeOf(value))) return false;
    if (types.isPromise(value) || types.isMapIterator(value) || types.isSetIterator(value) || types.isWeakMap(value) || types.isWeakSet(value)) return true;
    // A workerd object that brings its own inspect method is formatted by it, as Node does.
    return typeof value[customInspectSymbol] !== "function";
  }
  function formattedByPlatform(value) {
    return Object.create(null, {
      [customInspectSymbol]: {
        value(depth, options) {
          let text = platformUtil.inspect(value, { ...options, depth });
          if (!types.isProxy(value)) return text;
          // workerd marks each proxy it looks through (Proxy(<target>)); Node
          // 22 prints the target as it is.
          const open = options.stylize("Proxy(", "special");
          const close = options.stylize(")", "special");
          while (text.startsWith(open) && text.endsWith(close)) text = text.slice(open.length, text.length - close.length);
          return text;
        },
      },
    });
  }
  // V8's names (Object::GetConstructorName) for objects inspect.js finds no named constructor for.
  const builtinNames = [
    ["isMap", "Map"], ["isSet", "Set"], ["isWeakMap", "WeakMap"], ["isWeakSet", "WeakSet"], ["isDate", "Date"],
    ["isRegExp", "RegExp"], ["isPromise", "Promise"], ["isNativeError", "Error"], ["isArrayBuffer", "ArrayBuffer"],
    ["isSharedArrayBuffer", "SharedArrayBuffer"], ["isDataView", "DataView"], ["isNumberObject", "Number"],
    ["isStringObject", "String"], ["isBooleanObject", "Boolean"], ["isBigIntObject", "BigInt"], ["isSymbolObject", "Symbol"],
  ];
  const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
  const isArrayIndex = (key) => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
  const utilBinding = {
    constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE: 2, kPending: 0, kRejected: 2 },
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
        if (filter === 2 && !Object.prototype.propertyIsEnumerable.call(object, key)) continue;
        keys.push(key);
      }
      return keys;
    },
    getProxyDetails(value, showProxy) {
      if (!customInspectOn || (showProxy && types.isProxy(value)) || !needsPlatform(value)) return undefined;
      return formattedByPlatform(value);
    },
    getPromiseDetails: () => [0, undefined],
    previewEntries: (value, isKeyValue) => (isKeyValue ? [[], false] : []),
    getConstructorName(value) {
      if (Array.isArray(value)) return "Array";
      if (types.isTypedArray(value)) return String(Reflect.apply(typedArrayTag, value, []));
      for (const [test, name] of builtinNames) if (types[test](value)) return name;
      return typeof value === "function" ? "Function" : "Object";
    },
    getExternalValue: () => 0n,
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

  const modules = {
    "internal/util": internalUtil,
    "internal/errors": { isStackOverflowError },
    "internal/util/types": types,
    "internal/assert": assert,
    // Node's own modules, whose frames read node:<id> (colored grey).
    "internal/bootstrap/realm": { BuiltinModule: { exists: (id) => id.startsWith("internal/") || platform.builtinModules.includes(id) } },
    "internal/validators": { validateObject, validateString, kValidateObjectAllowArray },
    "internal/url": platform.url,
    buffer: { Buffer: platform.Buffer },
  };
  const bindings = { util: utilBinding, config: { hasIntl: true }, icu: icuBinding };
  const module = { exports: {} };
  platform.inspectOf(module.exports, (id) => modules[id], module, platform.process, (name) => bindings[name], primordials);
  const nodeInspect = module.exports;
  lazyInspect = nodeInspect;

  // A call through these runs the hooks as its options say (getProxyDetails).
  const customInspectOf = (options) => (options !== null && typeof options === "object" && "customInspect" in options
    ? options.customInspect !== false
    : nodeInspect.inspectDefaultOptions.customInspect !== false);
  function withCustomInspect(on, run) {
    const previous = customInspectOn;
    customInspectOn = on;
    try {
      return run();
    } finally {
      customInspectOn = previous;
    }
  }
  const nodeInspectFunction = nodeInspect.inspect;
  const inspect = function inspect(value, options) {
    return withCustomInspect(customInspectOf(options), () => Reflect.apply(nodeInspectFunction, this, [...arguments]));
  };
  for (const key of Reflect.ownKeys(nodeInspectFunction)) {
    if (key !== "prototype" && key !== "length" && key !== "name") {
      Object.defineProperty(inspect, key, Object.getOwnPropertyDescriptor(nodeInspectFunction, key));
    }
  }
  return {
    ...nodeInspect,
    inspect,
    format: (...args) => withCustomInspect(customInspectOf(undefined), () => nodeInspect.format(...args)),
    formatWithOptions: (options, ...args) => withCustomInspect(customInspectOf(options), () => nodeInspect.formatWithOptions(options, ...args)),
  };
}`;
