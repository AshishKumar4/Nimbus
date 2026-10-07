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
export function createNodeInspect(platform) {
    const { util: platformUtil, Buffer, url, process, builtinModules } = platform;
    const types = platformUtil.types;
    const primordials = {};
    platform.primordialsOf(primordials, globalThis);
    const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
    let lazyInspect;
    // lib/internal/errors.js: the errors inspect.js and its validators raise.
    function nodeError(Base, code, message) {
        const error = new Base(message);
        Object.defineProperty(error, 'code', { value: code, enumerable: true, writable: true, configurable: true });
        Object.defineProperty(error, 'toString', {
            value() { return `${this.name} [${code}]: ${this.message}`; }, writable: true, configurable: true,
        });
        return error;
    }
    function determineSpecificType(value) {
        if (value === null)
            return 'null';
        if (value === undefined)
            return 'undefined';
        switch (typeof value) {
            case 'bigint': return `type bigint (${value}n)`;
            case 'number':
                if (value === 0)
                    return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
                if (value !== value)
                    return 'type number (NaN)';
                if (value === Infinity)
                    return 'type number (Infinity)';
                if (value === -Infinity)
                    return 'type number (-Infinity)';
                return `type number (${value})`;
            case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
            case 'symbol': return `type symbol (${String(value)})`;
            case 'function': return `function ${value.name}`;
            case 'object': {
                const constructor = Reflect.get(value, 'constructor');
                if (constructor && (typeof constructor === 'object' || typeof constructor === 'function') && 'name' in constructor) {
                    return `an instance of ${String(constructor.name)}`;
                }
                return `${lazyInspect.inspect(value, { depth: -1 })}`;
            }
            case 'string': {
                const text = value.length > 28 ? `${value.slice(0, 25)}...` : value;
                if (text.indexOf("'") === -1)
                    return `type string ('${text}')`;
                return `type string (${JSON.stringify(text)})`;
            }
            default: {
                let inspected = lazyInspect.inspect(value, { colors: false });
                if (inspected.length > 28)
                    inspected = `${inspected.slice(0, 25)}...`;
                return `type ${typeof value} (${inspected})`;
            }
        }
    }
    // ERR_INVALID_ARG_TYPE for the one type each validator here expects.
    function invalidArgType(name, type, actual) {
        const kind = name.includes('.') ? 'property' : 'argument';
        return nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" ${kind} must be of type ${type}. Received ${determineSpecificType(actual)}`);
    }
    let maxStackErrorName;
    let maxStackErrorMessage;
    function isStackOverflowError(err) {
        if (maxStackErrorMessage === undefined) {
            const overflowStack = () => overflowStack();
            try {
                overflowStack();
            }
            catch (e) {
                maxStackErrorMessage = e.message;
                maxStackErrorName = e.name;
            }
        }
        return !!err && err.name === maxStackErrorName && err.message === maxStackErrorMessage;
    }
    const assert = Object.assign((value, message) => {
        if (!value) {
            throw nodeError(Error, 'ERR_INTERNAL_ASSERTION', message ?? 'This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n');
        }
    }, { fail: (message) => assert(false, message) });
    // lib/internal/validators.js
    const kValidateObjectNone = 0;
    const kValidateObjectAllowNullable = 1 << 0;
    const kValidateObjectAllowArray = 1 << 1;
    const kValidateObjectAllowFunction = 1 << 2;
    function validateObject(value, name, options = kValidateObjectNone) {
        if (options === kValidateObjectNone) {
            if (value === null || Array.isArray(value) || typeof value !== 'object')
                throw invalidArgType(name, 'object', value);
            return;
        }
        if ((kValidateObjectAllowNullable & options) === 0 && value === null)
            throw invalidArgType(name, 'object', value);
        if ((kValidateObjectAllowArray & options) === 0 && Array.isArray(value))
            throw invalidArgType(name, 'object', value);
        const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
        if (typeof value !== 'object' && (throwOnFunction || typeof value !== 'function'))
            throw invalidArgType(name, 'object', value);
    }
    function validateString(value, name) {
        if (typeof value !== 'string')
            throw invalidArgType(name, 'string', value);
    }
    // lib/internal/util.js
    const colorRegExp = /\u001b\[\d\d?m/g;
    const internalUtil = {
        customInspectSymbol,
        isError: (e) => types.isNativeError(e) || e instanceof Error,
        join(output, separator) {
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
        removeColors: (str) => str.replace(colorRegExp, ''),
    };
    // The util binding. getProxyDetails answers, for a value only V8's
    // internals can read, a stand-in whose inspect hook the platform formats
    // the value for; the calls through the exports below say whether hooks run.
    let customInspectOn = true;
    // A workerd API object (URL, Headers, Request, a stream) is read through
    // its prototype's kResourceTypeInspect symbol (workerd jsg/resource.h),
    // which only the platform's inspect reads; known per prototype.
    const resourceTypes = new WeakMap();
    function isResourceType(value) {
        for (let proto = Object.getPrototypeOf(value); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
            let resource = resourceTypes.get(proto);
            if (resource === undefined) {
                resource = Object.getOwnPropertySymbols(proto).some((symbol) => symbol.description === 'kResourceTypeInspect');
                resourceTypes.set(proto, resource);
            }
            if (resource)
                return true;
        }
        return false;
    }
    const needsInternals = (value) => types.isPromise(value) || types.isProxy(value) || types.isMapIterator(value)
        || types.isSetIterator(value) || types.isWeakMap(value) || types.isWeakSet(value)
        || (value !== null && typeof value === 'object' && isResourceType(value));
    const formattedByPlatform = (value) => Object.create(null, {
        [customInspectSymbol]: {
            value(depth, options) {
                return platformUtil.inspect(value, { ...options, depth });
            },
        },
    });
    // V8's names (Object::GetConstructorName) for objects inspect.js finds no named constructor for.
    const builtinNames = [
        ['isMap', 'Map'], ['isSet', 'Set'], ['isWeakMap', 'WeakMap'], ['isWeakSet', 'WeakSet'], ['isDate', 'Date'],
        ['isRegExp', 'RegExp'], ['isPromise', 'Promise'], ['isNativeError', 'Error'], ['isArrayBuffer', 'ArrayBuffer'],
        ['isSharedArrayBuffer', 'SharedArrayBuffer'], ['isDataView', 'DataView'], ['isNumberObject', 'Number'],
        ['isStringObject', 'String'], ['isBooleanObject', 'Boolean'], ['isBigIntObject', 'BigInt'], ['isSymbolObject', 'Symbol'],
    ];
    const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
    const isArrayIndex = (key) => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
    const utilBinding = {
        constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE: 2, kPending: 0, kRejected: 2 },
        getOwnNonIndexProperties(object, filter) {
            const keys = [];
            for (const key of Reflect.ownKeys(object)) {
                if (typeof key === 'string' && isArrayIndex(key))
                    continue;
                if (filter === 2 && !Object.prototype.propertyIsEnumerable.call(object, key))
                    continue;
                keys.push(key);
            }
            return keys;
        },
        getProxyDetails(value, showProxy) {
            if (!customInspectOn || (showProxy && types.isProxy(value)) || !needsInternals(value))
                return undefined;
            return formattedByPlatform(value);
        },
        getPromiseDetails: () => [0, undefined],
        previewEntries: (_value, isKeyValue) => (isKeyValue ? [[], false] : []),
        getConstructorName(value) {
            if (Array.isArray(value))
                return 'Array';
            if (types.isTypedArray(value))
                return String(Reflect.apply(typedArrayTag, value, []));
            for (const [test, name] of builtinNames)
                if (types[test](value))
                    return name;
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
        getStringWidth(str) {
            let width = 0;
            for (const char of str) {
                if (platform.eastAsianWide(char.codePointAt(0)) || emojiPresentation.test(char))
                    width += 2;
                else if (!zeroWidth.test(char))
                    width += 1;
            }
            return width;
        },
    };
    const modules = {
        'internal/util': internalUtil,
        'internal/errors': { isStackOverflowError },
        'internal/util/types': types,
        'internal/assert': assert,
        // Node's own modules, whose frames read `node:<id>` (colored grey).
        'internal/bootstrap/realm': { BuiltinModule: { exists: (id) => id.startsWith('internal/') || builtinModules.includes(id) } },
        'internal/validators': { validateObject, validateString, kValidateObjectAllowArray },
        'internal/url': url,
        buffer: { Buffer },
    };
    const bindings = { util: utilBinding, config: { hasIntl: true }, icu: icuBinding };
    const module = { exports: {} };
    platform.inspectOf(module.exports, (id) => modules[id], module, process, (name) => bindings[name], primordials);
    const nodeInspect = module.exports;
    lazyInspect = nodeInspect;
    // A call through these runs the hooks as its options say (getProxyDetails).
    const customInspectOf = (options) => (options !== null && typeof options === 'object' && 'customInspect' in options
        ? options.customInspect !== false
        : nodeInspect.inspectDefaultOptions.customInspect !== false);
    function withCustomInspect(on, run) {
        const previous = customInspectOn;
        customInspectOn = on;
        try {
            return run();
        }
        finally {
            customInspectOn = previous;
        }
    }
    const nodeInspectFunction = nodeInspect.inspect;
    const publicInspect = function inspect(value, options) {
        return withCustomInspect(customInspectOf(options), () => Reflect.apply(nodeInspectFunction, this, [...arguments]));
    };
    for (const key of Reflect.ownKeys(nodeInspectFunction)) {
        if (key !== 'prototype' && key !== 'length' && key !== 'name') {
            Object.defineProperty(publicInspect, key, Object.getOwnPropertyDescriptor(nodeInspectFunction, key));
        }
    }
    return {
        ...nodeInspect,
        inspect: publicInspect,
        format: (...args) => withCustomInspect(customInspectOf(undefined), () => nodeInspect.format(...args)),
        formatWithOptions: (options, ...args) => withCustomInspect(customInspectOf(options), () => nodeInspect.formatWithOptions(options, ...args)),
    };
}
