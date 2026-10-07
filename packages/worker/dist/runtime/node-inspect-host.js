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
 * property and constructor-name readers are JavaScript, and every brand
 * check is intrinsic (util.types), never the prototype chain.
 *
 * THE BINDING. A promise's state and result, a proxy's target and handler,
 * a Map or Set iterator's and a weak collection's entries are V8 slots no
 * user-land JavaScript can read. Only for those slots, the binding renders
 * the slot's content with the platform's inspect (workerd's port of Node's,
 * which reads them), under the options the slot is formatted with, and
 * hands inspect.js a value that prints as that text where Node's binding
 * result goes. Nothing else ever goes through the platform's inspect.
 * Named limits: what such a slot holds is printed by workerd's port (it
 * prints a symbol key bare, `Symbol(k)` for Node's `[Symbol(k)]`); and
 * `util.format('%s', proxy)` reads the proxy's toString as a built-in's.
 *
 * `platform`: { util (the platform's node:util), Buffer, url ({ URL,
 * pathToFileURL }), process, builtinModules, builtinObjects (Node's
 * NODE_BUILTIN_OBJECTS), eastAsianWide(code),
 * primordialsOf(primordials, globalThis), inspectOf(exports, require, module,
 * process, internalBinding, primordials) }, the last two running the
 * upstream sources.
 */
export const NODE_INSPECT_HOST_SOURCE = String.raw `function createNodeInspect(platform) {
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

  // ── THE BINDING: V8's internal slots, read by workerd's inspect ─────────
  // A promise's state and result, a proxy's target and handler, a Map or Set
  // iterator's and a weak collection's entries are V8 internals no user-land
  // JavaScript can read; workerd's inspect reads them. After an intrinsic
  // brand check (util.types), this binding renders just that slot's content
  // with workerd's inspect, under the options the slot is being formatted
  // with, and hands inspect.js a value that renders as that text exactly
  // where Node's binding result would go ('slot'). Nothing else ever goes
  // through workerd's inspect, and nothing here invents a state. What the
  // slot holds is then printed by workerd's port, not Node's (the support
  // matrix lists its divergences).
  const platformInspect = (value, options) => platformUtil.inspect(value, options);
  // Each public call's renderings, by value and options: one exotic's slots
  // are read from one rendering.
  let renderings = null;
  function rendering(value, options) {
    const key = JSON.stringify(options);
    let byOptions = renderings?.get(value);
    if (byOptions === undefined) {
      byOptions = new Map();
      renderings?.set(value, byOptions);
    }
    let text = byOptions.get(key);
    if (text === undefined) {
      text = platformInspect(value, options);
      byOptions.set(key, text);
    }
    return text;
  }
  // The options a slot is rendered with: the call's, at the slot's depth,
  // every entry shown (inspect.js applies maxArrayLength itself) and the
  // custom-inspect choice of the call, not of the instance running it.
  function slotOptions(depth, options) {
    return {
      showHidden: options.showHidden, depth: depth === null ? null : depth + 1, colors: options.colors,
      customInspect: callCustomInspect, showProxy: options.showProxy, maxArrayLength: options.maxArrayLength,
      maxStringLength: options.maxStringLength, breakLength: options.breakLength, compact: options.compact,
      sorted: options.sorted, getters: options.getters, numericSeparator: options.numericSeparator,
    };
  }
  const ANSI = /\u001b\[[0-9;]*m/y;
  // The top-level entries of 'text' from 'from' to its closing bracket, as
  // inspect prints them: separated by ", " or ",\n" outside brackets and
  // quoted strings (or by 'separator'). Returns the entries and where the
  // closing bracket is.
  function topLevelEntries(text, from, separator) {
    const entries = [];
    let depth = 0;
    let quote = null;
    let start = from;
    let previous = " ";
    for (let i = from; i < text.length; i++) {
      ANSI.lastIndex = i;
      const escape = ANSI.exec(text);
      if (escape !== null) {
        i += escape[0].length - 1;
        continue;
      }
      const char = text[i];
      if (quote !== null) {
        if (char === "\\") i++;
        else if (char === quote) quote = null;
        previous = char;
        continue;
      }
      if ((char === "'" || char === "\"" || char === "\u0060") && " \n[{(,:".includes(previous)) quote = char;
      else if (char === "[" || char === "{" || char === "(") depth++;
      else if (char === "]" || char === "}" || char === ")") {
        if (depth === 0) {
          entries.push(text.slice(start, i));
          return { entries, end: i };
        }
        depth--;
      } else if (depth === 0 && separator !== undefined && text.startsWith(separator, i)) {
        entries.push(text.slice(start, i));
        start = i + separator.length;
        i += separator.length - 1;
      } else if (separator === undefined && char === "," && depth === 0 && (text[i + 1] === " " || text[i + 1] === "\n")) {
        entries.push(text.slice(start, i));
        start = i + 1;
      }
      previous = char;
    }
    entries.push(text.slice(start));
    return { entries, end: text.length };
  }
  // An entry as inspect.js takes a hook's text: its own indentation gone
  // (workerd printed it 'indent' columns in), surrounding blank space trimmed.
  function entryText(raw, indent) {
    return raw.replace(/^\s+|\s+$/g, "").split("\n").map((line, i) => (i === 0 ? line : line.replace(new RegExp("^ {0," + indent + "}"), ""))).join("\n");
  }
  // The entries inside the first top-level brace or bracket of 'text'.
  function slotEntries(text, open) {
    let at = 0;
    for (; at < text.length; at++) {
      ANSI.lastIndex = at;
      const escape = ANSI.exec(text);
      if (escape !== null) {
        at += escape[0].length - 1;
        continue;
      }
      if (text[at] === open) break;
    }
    const { entries } = topLevelEntries(text, at + 1);
    return entries.map((entry) => entryText(entry, 2)).filter((entry, i, all) => entry !== "" || all.length > 1);
  }
  // A value inspect.js formats as 'render(depth, options)', where Node's
  // binding result would be. Found by the custom-inspect symbol of the
  // instance formatting it (see 'privateCustom'), so it renders in both.
  function slot(render) {
    const value = Object.create(null);
    const hook = { value(depth, options) { return render(depth, options); } };
    Object.defineProperty(value, customInspectSymbol, hook);
    Object.defineProperty(value, privateCustom, hook);
    return Object.freeze(value);
  }
  // Whether inspect.js would show own properties of 'value' beside its slot.
  function ownKeysShown(value, showHidden) {
    const keys = showHidden ? Reflect.ownKeys(value) : Reflect.ownKeys(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key));
    return keys.length > 0;
  }
  const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");
  const plain = { depth: 0, colors: false, customInspect: false, showProxy: false, maxArrayLength: Infinity, breakLength: Infinity, compact: 3 };

  function promiseDetails(promise) {
    const state = stripAnsi(slotEntries(rendering(promise, plain), "{")[0] ?? "");
    if (state === "<pending>") return [0, undefined];
    const rejected = state.startsWith("<rejected> ");
    const result = slot((depth, options) => {
      const text = rendering(promise, slotOptions(depth, options));
      let entry = ownKeysShown(promise, options.showHidden)
        ? slotEntries(text, "{")[0]
        : entryText(text.slice(text.indexOf("{") + 1, text.lastIndexOf("}")), 2);
      // Node puts its own '<rejected> ' before the result.
      if (rejected) entry = entry.replace(/^(?:\u001b\[[0-9;]*m)*<rejected>(?:\u001b\[[0-9;]*m)* /, "");
      return entry;
    });
    return [rejected ? 2 : 1, result];
  }
  function entriesOf(value, isKeyValue) {
    // A weak collection's entries are what showHidden shows (Node asks only then).
    const weak = types.isWeakMap(value) || types.isWeakSet(value);
    const text = rendering(value, weak ? { ...plain, showHidden: true } : plain);
    const keyValue = isKeyValue === true && /^\[[^\]]* Entries\] \{/.test(stripAnsi(text));
    const count = slotEntries(text, "{").filter((entry) => stripAnsi(entry) !== "").length;
    // Entry 'i', or its key (part 0) or value (part 1): '[ k, v ]' for an
    // entries iterator, 'k => v' for a WeakMap.
    const entryAt = (i, part) => slot((depth, options) => {
      const shown = slotEntries(rendering(value, slotOptions(depth, options)), "{")[i] ?? "";
      if (part === undefined) return shown;
      // Its parts were formatted where the entry was: one dedent was all they needed.
      const parts = types.isWeakMap(value)
        ? topLevelEntries(shown, 0, " => ").entries
        : topLevelEntries(shown, shown.indexOf("[") + 1).entries;
      return entryText(parts[part] ?? "", 0);
    });
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (keyValue || types.isWeakMap(value)) entries.push(entryAt(i, 0), entryAt(i, 1));
      else entries.push(entryAt(i));
    }
    return isKeyValue === undefined ? entries : [entries, keyValue];
  }
  function proxyDetails(proxy, showProxy) {
    if (stripAnsi(rendering(proxy, plain)) === "<Revoked Proxy>") return null;
    if (!showProxy) {
      return slot((depth, options) => entryText(rendering(proxy, { ...slotOptions(depth, options), showProxy: false, depth }), 0));
    }
    const part = (i) => slot((depth, options) => slotEntries(rendering(proxy, { ...slotOptions(depth, options), showProxy: true }), "[")[i] ?? "");
    return [part(0), part(1)];
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
    getProxyDetails: (value, showProxy) => (types.isProxy(value) ? proxyDetails(value, showProxy) : undefined),
    getPromiseDetails: (promise) => promiseDetails(promise),
    previewEntries: (value, isKeyValue) => entriesOf(value, isKeyValue),
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

  // inspect.js runs as two instances over the same binding: 'node', whose
  // custom-inspect symbol is Node's (util.inspect.custom), for every call
  // that runs programs' hooks; and, for a call with customInspect false,
  // 'opaque', whose symbol is 'privateCustom', called with customInspect on:
  // it runs no program's hook, and still renders the binding's slots, which
  // answer both symbols. Its styles, colours and defaults are 'node''s.
  const privateCustom = Symbol("nimbus.inspect.slot");
  let callCustomInspect = true;
  function evaluate(customSymbol) {
    const modules = {
      "internal/util": { ...internalUtil, customInspectSymbol: customSymbol },
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
    platform.inspectOf(module.exports, (id) => modules[id], module, platform.process, (name) => bindings[name], inspectPrimordials);
    return module.exports;
  }
  // inspect.js reads primordials.globalThis once, for the names it counts as
  // built-in (showHidden shows a prototype's properties when its
  // constructor's name is not one): the capitalised globals there were when
  // Node loaded it, measured (node-inspect-source.ts NODE_BUILTIN_OBJECTS).
  const bootGlobal = Object.create(null);
  for (const name of platform.builtinObjects) bootGlobal[name] = globalThis[name];
  const inspectPrimordials = Object.create(null);
  for (const key of Reflect.ownKeys(primordials)) inspectPrimordials[key] = primordials[key];
  inspectPrimordials.globalThis = bootGlobal;
  const nodeInspect = evaluate(customInspectSymbol);
  lazyInspect = nodeInspect;
  let opaqueInspect = null;
  function opaque() {
    if (opaqueInspect === null) {
      opaqueInspect = evaluate(privateCustom);
      opaqueInspect.inspect.styles = nodeInspect.inspect.styles;
      opaqueInspect.inspect.colors = nodeInspect.inspect.colors;
    }
    return opaqueInspect;
  }

  const customInspectOf = (options) => (options !== null && typeof options === "object" && "customInspect" in options
    ? options.customInspect !== false
    : nodeInspect.inspectDefaultOptions.customInspect !== false);
  // One public call: the instance its customInspect asks for, the options
  // 'opaque' takes for it, and the binding's renderings kept for its length.
  function call(options, run) {
    const custom = customInspectOf(options);
    const previous = [callCustomInspect, renderings];
    callCustomInspect = custom;
    renderings = new WeakMap();
    try {
      if (custom) return run(nodeInspect, options);
      const merged = { ...nodeInspect.inspectDefaultOptions, ...(options !== null && typeof options === "object" ? options : {}), customInspect: true };
      return run(opaque(), merged);
    } finally {
      [callCustomInspect, renderings] = previous;
    }
  }
  const nodeInspectFunction = nodeInspect.inspect;
  const inspect = function inspect(value, options) {
    // inspect(value, showHidden, depth, colors), the legacy form, is Node's own.
    if (arguments.length > 2 || (options !== undefined && (options === null || typeof options !== "object"))) {
      return call(undefined, () => Reflect.apply(nodeInspectFunction, this, [...arguments]));
    }
    return call(options, (instance, merged) => instance.inspect(value, merged));
  };
  for (const key of Reflect.ownKeys(nodeInspectFunction)) {
    if (key !== "prototype" && key !== "length" && key !== "name") {
      Object.defineProperty(inspect, key, Object.getOwnPropertyDescriptor(nodeInspectFunction, key));
    }
  }
  return {
    ...nodeInspect,
    inspect,
    format: (...args) => call(undefined, (instance, merged) => (instance === nodeInspect ? nodeInspect.format(...args) : instance.formatWithOptions(merged, ...args))),
    formatWithOptions(options, ...args) {
      // Its own validation, before any call's options are read.
      if (options === null || typeof options !== "object" || Array.isArray(options)) return nodeInspect.formatWithOptions(options, ...args);
      return call(options, (instance, merged) => instance.formatWithOptions(merged, ...args));
    },
  };
}`;
