/**
 * What Node's util.inspect (node-inspect-source.ts) is given in a Worker in
 * place of Node's internal modules and bindings. createNodeInspect is
 * serialized into the shims (node-shims.ts, "util.inspect"), so it reads
 * nothing outside itself: its platform is passed in.
 *
 * Node's own functions are ported: lib/internal/util.js join, removeColors
 * and isError; lib/internal/errors.js isStackOverflowError and the message
 * of ERR_INVALID_ARG_TYPE; lib/internal/validators.js validateObject and
 * validateString; src/node_i18n.cc GetStringWidth. Of the util binding, the
 * property and constructor-name readers are JavaScript. What only V8's
 * internals can read (a promise's state, a proxy's target, an iterator's or
 * a weak collection's entries), and a workerd API object's properties, a
 * value needing them is formatted by the platform's own inspect for,
 * workerd's port of Node's, which reads them:
 * inspect.js reaches every object through getProxyDetails first, and formats
 * what that answers in the value's place, through its inspect hook. With
 * customInspect false the hook is not called, so such a value is formatted
 * with none of them: a promise is `<pending>`, an iterator's entries empty,
 * a proxy through its traps; Node reads them there too.
 */

/** A function of the platform's node:util, or of Node's inspect.js. */
type Fn = (...args: never[]) => unknown;

export interface NodeInspectPlatform {
  /** The platform's node:util: its inspect, for what only V8 reads, and its types. */
  util: { inspect(value: unknown, options?: object): string; types: Record<string, (value: unknown) => boolean> };
  Buffer: unknown;
  url: { pathToFileURL: Fn; URL: unknown };
  process: unknown;
  /** Node's public builtin module names (node:module builtinModules). */
  builtinModules: readonly string[];
  /** Whether a code point is East Asian Wide or Fullwidth (node-inspect-source.ts). */
  eastAsianWide(code: number): boolean;
  /** Runs lib/internal/per_context/primordials.js, filling `primordials`. */
  primordialsOf(primordials: object, global: typeof globalThis): void;
  /** Runs lib/internal/util/inspect.js as Node's loader runs a builtin. */
  inspectOf(
    exports: object, require: (id: string) => unknown, module: { exports: object },
    process: unknown, internalBinding: (name: string) => unknown, primordials: object,
  ): void;
}

/** What lib/internal/util/inspect.js exports, as the shims use it. */
export interface NodeInspectExports {
  inspect: ((value: unknown, options?: unknown) => string) & { defaultOptions: { customInspect: boolean } };
  inspectDefaultOptions: { customInspect: boolean };
  format(...args: unknown[]): string;
  formatWithOptions(options: unknown, ...args: unknown[]): string;
  getStringWidth(str: string, removeControlChars?: boolean): number;
  stripVTControlCharacters(str: string): string;
}

export function createNodeInspect(platform: NodeInspectPlatform): NodeInspectExports {
  const { util: platformUtil, Buffer, url, process, builtinModules } = platform;
  const types = platformUtil.types;
  const primordials = {};
  platform.primordialsOf(primordials, globalThis);
  const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
  let lazyInspect: NodeInspectExports | undefined;

  // lib/internal/errors.js: the errors inspect.js and its validators raise.
  function nodeError(Base: ErrorConstructor | TypeErrorConstructor, code: string, message: string): Error {
    const error = new Base(message);
    Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(error, 'toString', {
      value(this: Error) { return `${this.name} [${code}]: ${this.message}`; }, writable: true, configurable: true,
    });
    return error;
  }
  function determineSpecificType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    switch (typeof value) {
      case 'bigint': return `type bigint (${value}n)`;
      case 'number':
        if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
        if (value !== value) return 'type number (NaN)';
        if (value === Infinity) return 'type number (Infinity)';
        if (value === -Infinity) return 'type number (-Infinity)';
        return `type number (${value})`;
      case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
      case 'symbol': return `type symbol (${String(value)})`;
      case 'function': return `function ${value.name}`;
      case 'object': {
        const constructor: unknown = Reflect.get(value, 'constructor');
        if (constructor && (typeof constructor === 'object' || typeof constructor === 'function') && 'name' in constructor) {
          return `an instance of ${String(constructor.name)}`;
        }
        return `${lazyInspect!.inspect(value, { depth: -1 })}`;
      }
      case 'string': {
        const text = value.length > 28 ? `${value.slice(0, 25)}...` : value;
        if (text.indexOf("'") === -1) return `type string ('${text}')`;
        return `type string (${JSON.stringify(text)})`;
      }
      default: {
        let inspected = lazyInspect!.inspect(value, { colors: false });
        if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
        return `type ${typeof value} (${inspected})`;
      }
    }
  }
  // ERR_INVALID_ARG_TYPE for the one type each validator here expects.
  function invalidArgType(name: string, type: string, actual: unknown): Error {
    const kind = name.includes('.') ? 'property' : 'argument';
    return nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" ${kind} must be of type ${type}. Received ${determineSpecificType(actual)}`);
  }
  let maxStackErrorName: string | undefined;
  let maxStackErrorMessage: string | undefined;
  function isStackOverflowError(err: { name?: unknown; message?: unknown } | null | undefined): boolean {
    if (maxStackErrorMessage === undefined) {
      const overflowStack = (): never => overflowStack();
      try {
        overflowStack();
      } catch (e) {
        maxStackErrorMessage = (e as Error).message;
        maxStackErrorName = (e as Error).name;
      }
    }
    return !!err && err.name === maxStackErrorName && err.message === maxStackErrorMessage;
  }
  const assert = Object.assign((value: unknown, message?: string): void => {
    if (!value) {
      throw nodeError(Error, 'ERR_INTERNAL_ASSERTION', message ?? 'This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n');
    }
  }, { fail: (message?: string): void => assert(false, message) });

  // lib/internal/validators.js
  const kValidateObjectNone = 0;
  const kValidateObjectAllowNullable = 1 << 0;
  const kValidateObjectAllowArray = 1 << 1;
  const kValidateObjectAllowFunction = 1 << 2;
  function validateObject(value: unknown, name: string, options = kValidateObjectNone): void {
    if (options === kValidateObjectNone) {
      if (value === null || Array.isArray(value) || typeof value !== 'object') throw invalidArgType(name, 'object', value);
      return;
    }
    if ((kValidateObjectAllowNullable & options) === 0 && value === null) throw invalidArgType(name, 'object', value);
    if ((kValidateObjectAllowArray & options) === 0 && Array.isArray(value)) throw invalidArgType(name, 'object', value);
    const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
    if (typeof value !== 'object' && (throwOnFunction || typeof value !== 'function')) throw invalidArgType(name, 'object', value);
  }
  function validateString(value: unknown, name: string): void {
    if (typeof value !== 'string') throw invalidArgType(name, 'string', value);
  }

  // lib/internal/util.js
  const colorRegExp = /\u001b\[\d\d?m/g;
  const internalUtil = {
    customInspectSymbol,
    isError: (e: unknown) => types.isNativeError(e) || e instanceof Error,
    join(output: readonly string[], separator: string): string {
      let str = '';
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
    removeColors: (str: string) => String.prototype.replace.call(str, colorRegExp, ''),
  };

  // The util binding. getProxyDetails answers, for a value only V8's
  // internals can read, a stand-in whose inspect hook the platform formats
  // the value for; the calls through the exports below say whether hooks run.
  let customInspectOn = true;
  // A workerd API object (URL, Headers, Request, a stream) is read through
  // its prototype's kResourceTypeInspect symbol (workerd jsg/resource.h),
  // which only the platform's inspect reads; known per prototype.
  const resourceTypes = new WeakMap<object, boolean>();
  function isResourceType(value: object): boolean {
    for (let proto = Object.getPrototypeOf(value); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      let resource = resourceTypes.get(proto);
      if (resource === undefined) {
        resource = Object.getOwnPropertySymbols(proto).some((symbol) => symbol.description === 'kResourceTypeInspect');
        resourceTypes.set(proto, resource);
      }
      if (resource) return true;
    }
    return false;
  }
  const needsInternals = (value: unknown) => types.isPromise(value) || types.isProxy(value) || types.isMapIterator(value)
    || types.isSetIterator(value) || types.isWeakMap(value) || types.isWeakSet(value)
    || (value !== null && typeof value === 'object' && isResourceType(value));
  const formattedByPlatform = (value: unknown) => Object.create(null, {
    [customInspectSymbol]: {
      value(depth: number | null, options: Record<string, unknown>) {
        return platformUtil.inspect(value, { ...options, depth });
      },
    },
  });
  // V8's names (Object::GetConstructorName) for objects inspect.js finds no named constructor for.
  const builtinNames: ReadonlyArray<[string, string]> = [
    ['isMap', 'Map'], ['isSet', 'Set'], ['isWeakMap', 'WeakMap'], ['isWeakSet', 'WeakSet'], ['isDate', 'Date'],
    ['isRegExp', 'RegExp'], ['isPromise', 'Promise'], ['isNativeError', 'Error'], ['isArrayBuffer', 'ArrayBuffer'],
    ['isSharedArrayBuffer', 'SharedArrayBuffer'], ['isDataView', 'DataView'], ['isNumberObject', 'Number'],
    ['isStringObject', 'String'], ['isBooleanObject', 'Boolean'], ['isBigIntObject', 'BigInt'], ['isSymbolObject', 'Symbol'],
  ];
  const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!;
  const isArrayIndex = (key: string) => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
  const utilBinding = {
    constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE: 2, kPending: 0, kRejected: 2 },
    getOwnNonIndexProperties(object: object, filter: number): Array<string | symbol> {
      const keys: Array<string | symbol> = [];
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key === 'string' && isArrayIndex(key)) continue;
        if (filter === 2 && !Object.prototype.propertyIsEnumerable.call(object, key)) continue;
        keys.push(key);
      }
      return keys;
    },
    getProxyDetails(value: unknown, showProxy: boolean): unknown {
      if (!customInspectOn || (showProxy && types.isProxy(value)) || !needsInternals(value)) return undefined;
      return formattedByPlatform(value);
    },
    getPromiseDetails: (): [number, unknown] => [0, undefined],
    previewEntries: (_value: unknown, isKeyValue?: boolean): unknown => (isKeyValue ? [[], false] : []),
    getConstructorName(value: unknown): string {
      if (Array.isArray(value)) return 'Array';
      if (types.isTypedArray(value)) return String(Reflect.apply(typedArrayTag, value, []));
      for (const [test, name] of builtinNames) if (types[test](value)) return name;
      return typeof value === 'function' ? 'Function' : 'Object';
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
    getStringWidth(str: string): number {
      let width = 0;
      for (const char of str) {
        if (platform.eastAsianWide(char.codePointAt(0)!) || emojiPresentation.test(char)) width += 2;
        else if (!zeroWidth.test(char)) width += 1;
      }
      return width;
    },
  };

  const modules: Record<string, unknown> = {
    'internal/util': internalUtil,
    'internal/errors': { isStackOverflowError },
    'internal/util/types': types,
    'internal/assert': assert,
    // Node's own modules, whose frames read `node:<id>` (colored grey).
    'internal/bootstrap/realm': { BuiltinModule: { exists: (id: string) => id.startsWith('internal/') || builtinModules.includes(id) } },
    'internal/validators': { validateObject, validateString, kValidateObjectAllowArray },
    'internal/url': url,
    buffer: { Buffer },
  };
  const bindings: Record<string, unknown> = { util: utilBinding, config: { hasIntl: true }, icu: icuBinding };
  const module = { exports: {} };
  platform.inspectOf(module.exports, (id) => modules[id], module, process, (name) => bindings[name], primordials);
  const nodeInspect = module.exports as NodeInspectExports;
  lazyInspect = nodeInspect;

  // A call through these runs the hooks as its options say (getProxyDetails).
  const customInspectOf = (options: unknown) => (options !== null && typeof options === 'object' && 'customInspect' in options
    ? options.customInspect !== false
    : nodeInspect.inspectDefaultOptions.customInspect !== false);
  function withCustomInspect<T>(on: boolean, run: () => T): T {
    const previous = customInspectOn;
    customInspectOn = on;
    try {
      return run();
    } finally {
      customInspectOn = previous;
    }
  }
  const nodeInspectFunction = nodeInspect.inspect;
  const publicInspect = function inspect(this: unknown, value: unknown, options?: unknown): string {
    return withCustomInspect(customInspectOf(options), () => Reflect.apply(nodeInspectFunction, this, [...arguments]));
  };
  for (const key of Reflect.ownKeys(nodeInspectFunction)) {
    if (key !== 'prototype' && key !== 'length' && key !== 'name') {
      Object.defineProperty(publicInspect, key, Object.getOwnPropertyDescriptor(nodeInspectFunction, key)!);
    }
  }
  return {
    ...nodeInspect,
    inspect: publicInspect as NodeInspectExports['inspect'],
    format: (...args) => withCustomInspect(customInspectOf(undefined), () => nodeInspect.format(...args)),
    formatWithOptions: (options, ...args) => withCustomInspect(customInspectOf(options), () => nodeInspect.formatWithOptions(options, ...args)),
  };
}
