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
 * user-land JavaScript can read. Node's util binding reads them; here
 * `platform.slots` does, with its signatures (getPromiseDetails,
 * getProxyDetails, previewEntries), after the host's intrinsic brand check,
 * and hands inspect.js the slots' values, which it formats itself: one
 * formatter for every value. In workerd, platform.slots is
 * createWorkerdSlots (WORKERD_SLOTS_SOURCE); where Node runs this host (its
 * parity test), Node's own binding. Named limits (fine-print capabilities):
 * a proxy among a slot's values is a stand-in over its target and handler,
 * which no program code is ever handed: shown without showProxy, its
 * target's custom inspect is not called (Node calls it with the proxy as
 * this), and a proxy inside it is shown by its innermost target, its traps
 * not run; and a holder whose own Symbol.toStringTag is an accessor, or with
 * a proxy on its prototype chain, shows its slot as unknown, since reading
 * it would run that code once more than Node.
 *
 * `platform`: { util (the platform's node:util), slots, Buffer, url ({ URL,
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
    getProxyDetails: (value, showProxy) => (types.isProxy(value) ? slots.getProxyDetails(value, showProxy) : undefined),
    getPromiseDetails: (promise) => slots.getPromiseDetails(promise),
    // As inspect.js asks: a weak collection's entries alone, an iterator's with whether they pair.
    previewEntries: (...args) => Reflect.apply(slots.previewEntries, slots, args),
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

  function evaluate() {
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
  const nodeInspect = evaluate();
  lazyInspect = nodeInspect;
  return nodeInspect;
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
export const WORKERD_SLOTS_SOURCE = String.raw `function createWorkerdSlots(util) {
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
  // A target shown without its custom inspect (withoutCustomInspect).
  const views = new WeakSet();
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
  // 'target' as inspect.js formats it without its custom inspect, which it
  // would call with a stand-in as this: every other read is the target's, a
  // getter's this the target, over a shadow no invariant ties to it.
  function withoutCustomInspect(target) {
    const shadow = Array.isArray(target) ? [] : Object.create(null);
    const view = new Proxy(shadow, {
      get: (_, key) => (key === customInspect ? undefined : Reflect.get(target, key, target)),
      has: (_, key) => key !== customInspect && Reflect.has(target, key),
      ownKeys: () => Reflect.ownKeys(target),
      getPrototypeOf: () => Reflect.getPrototypeOf(target),
      getOwnPropertyDescriptor(_, key) {
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        if (own === undefined || (Array.isArray(shadow) && key === "length")) return own;
        const get = own.get;
        return { ...own, configurable: true, ...(get ? { get: function () { return Reflect.apply(get, target, []); } } : {}) };
      },
    });
    views.add(view);
    return view;
  }
  // Whether workerd formats 'holder' with none of a program's code run: no
  // proxy on its prototype chain (its constructor name is read there), and
  // no accessor for its Symbol.toStringTag, read as workerd reads it.
  function formatsInertly(holder) {
    let tag = false;
    for (let at = holder; at !== null; at = Object.getPrototypeOf(at)) {
      if (isProxy(at)) return false;
      const own = tag ? undefined : Object.getOwnPropertyDescriptor(at, Symbol.toStringTag);
      if (own === undefined) continue;
      if (own.get !== undefined || own.set !== undefined) return false;
      tag = true;
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
    if (views.has(proxy)) return undefined;
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
    // program's own proxy is that; a stand-in must never be.
    const target = innermostTarget(parts[0]);
    return standIns.has(proxy) && !standIns.has(target) && reachesCustomInspect(target) ? withoutCustomInspect(target) : target;
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
