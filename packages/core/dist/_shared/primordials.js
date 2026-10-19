/**
 * primordials.ts — built-ins captured before any program code runs, for the
 * code that shares a realm with a program and must not reach what the
 * program replaced: the interpreter (interpreter/primordials.ts, loaded at a
 * launch's start), and the guest's module loading (node:path's posix half,
 * posix-path.ts; the ES module resolver, esm-resolver.ts, its package maps,
 * package-map.ts, and Node's errors, node-error.ts), which the node shims
 * evaluate before the program's first statement. Only captures, the
 * collections and lists built on them, and what makes the runtime's own
 * generators drive through them (safeGenerator): every process of a launch
 * evaluates it (tests/unit/primordials-audit.mjs checks that its readers
 * call nothing else).
 */
export const reflectApply = Reflect.apply;
export const reflectConstruct = Reflect.construct;
export const reflectGet = Reflect.get;
export const reflectSet = Reflect.set;
export const reflectHas = Reflect.has;
export const reflectOwnKeys = Reflect.ownKeys;
export const reflectDefineProperty = Reflect.defineProperty;
export const reflectDeleteProperty = Reflect.deleteProperty;
export const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
export const reflectGetPrototypeOf = Reflect.getPrototypeOf;
export const reflectSetPrototypeOf = Reflect.setPrototypeOf;
export const objectCreate = Object.create;
export const objectKeys = Object.keys;
export const objectFreeze = Object.freeze;
export const objectAssign = Object.assign;
export const objectHasOwn = Object.hasOwn;
export const objectGetOwnPropertyNames = Object.getOwnPropertyNames;
export const arrayIsArray = Array.isArray;
export const symbolFor = Symbol.for;
export const symbolIterator = Symbol.iterator;
export const symbolAsyncIterator = Symbol.asyncIterator;
export const symbolUnscopables = Symbol.unscopables;
export const stringOf = String;
/** ToObject, for a value that is not null or undefined. */
export const ObjectOf = Object;
export const PromiseConstructor = Promise;
export const PromiseResolve = Promise.resolve;
export const PromiseReject = Promise.reject;
export const PromisePrototypeThen = Promise.prototype.then;
export const ObjectPrototypePropertyIsEnumerable = Object.prototype.propertyIsEnumerable;
export const ArrayConstructor = Array;
export const ArrayFrom = Array.from;
export const ArrayValues = Array.prototype[Symbol.iterator];
export const ArrayIteratorPrototype = Reflect.getPrototypeOf([][Symbol.iterator]()) ?? {};
export const ArrayIteratorNext = Reflect.get(ArrayIteratorPrototype, 'next');
// ES2023's copying methods: they make their result with ArrayCreate, not the
// receiver's species, and fill it with own data properties, never [[Set]].
export const ArrayPrototypeWith = Reflect.get(Array.prototype, 'with');
export const ArrayPrototypeToSpliced = Reflect.get(Array.prototype, 'toSpliced');
export const StringPrototypeSlice = String.prototype.slice;
export const StringPrototypeLastIndexOf = String.prototype.lastIndexOf;
export const StringPrototypeCharCodeAt = String.prototype.charCodeAt;
export const SymbolPrototypeToString = Symbol.prototype.toString;
// What the parser reaches (parser-realm.ts): acorn, as the interpreter bundles
// it, calls these and no other built-in.
export const StringPrototypeCharAt = String.prototype.charAt;
export const StringPrototypeIndexOf = String.prototype.indexOf;
export const StringPrototypeSubstr = String.prototype.substr;
export const StringFromCharCode = String.fromCharCode;
export const ArrayPrototypePop = Array.prototype.pop;
export const ArrayPrototypeIndexOf = Array.prototype.indexOf;
export const ArrayPrototypeLastIndexOf = Array.prototype.lastIndexOf;
export const RegExpPrototypeExec = RegExp.prototype.exec;
/** RegExp.prototype's accessors (source, global, unicode, ...), each reading the regexp's own internal slots. */
export const RegExpPrototypeAccessors = (() => {
    const accessors = objectCreate(null);
    const names = Object.getOwnPropertyNames(RegExp.prototype);
    for (let i = 0; i < names.length; i++) {
        const getter = Reflect.getOwnPropertyDescriptor(RegExp.prototype, names[i])?.get;
        if (getter !== undefined)
            accessors[names[i]] = getter;
    }
    return accessors;
})();
export const NumberPrototypeToString = Number.prototype.toString;
export const BigIntPrototypeToString = BigInt.prototype.toString;
export const ObjectPrototype = Object.prototype;
export const ObjectPrototypeHasOwnProperty = Object.prototype.hasOwnProperty;
export const ObjectPrototypeToString = Object.prototype.toString;
export const objectDefineProperties = Object.defineProperties;
export const parseIntOf = parseInt;
export const parseFloatOf = parseFloat;
export const SymbolConstructor = Symbol;
export const SymbolPrototypeDescription = Reflect.getOwnPropertyDescriptor(Symbol.prototype, 'description')?.get;
export const globalObject = globalThis;
export const JSONParse = JSON.parse;
export const JSONStringify = JSON.stringify;
export const decodeURIComponentOf = decodeURIComponent;
export const encodeURIComponentOf = encodeURIComponent;
export const NumberOf = Number;
export const numberIsInteger = Number.isInteger;
export const objectIs = Object.is;
export const objectIsExtensible = Object.isExtensible;
export const mathAbs = Math.abs;
export const mathMin = Math.min;
/**
 * Error.captureStackTrace as the runtime has it before any program code:
 * V8's (none where the engine has none), or the one the launch's cell
 * runtime installs over it, which places interpreted frames
 * (useCaptureStackTrace). Node's errors capture their stacks through it.
 */
let runtimeCaptureStackTrace = Reflect.get(Error, 'captureStackTrace');
export function captureStackTraceOf() {
    return runtimeCaptureStackTrace;
}
/** The runtime's own Error.captureStackTrace, installed before any program code (commonjs-cell). */
export function useCaptureStackTrace(capture) {
    runtimeCaptureStackTrace = capture;
}
const BigIntOf = BigInt;
const ErrorConstructor = Error;
const RangeErrorConstructor = RangeError;
const ReferenceErrorConstructor = ReferenceError;
const RegExpConstructor = RegExp;
const SyntaxErrorConstructor = SyntaxError;
const TypeErrorConstructor = TypeError;
const URIErrorConstructor = URIError;
// None in a realm with no URL (a test262 realm's), where nothing resolves a module.
const URLConstructor = typeof URL === 'function' ? URL : undefined;
// The interpreter's modules import these under the globals' names, so their
// `new TypeError(...)` constructs the realm's own.
export { BigIntOf as BigInt, ErrorConstructor as Error, RangeErrorConstructor as RangeError, ReferenceErrorConstructor as ReferenceError, RegExpConstructor as RegExp, SyntaxErrorConstructor as SyntaxError, TypeErrorConstructor as TypeError, URIErrorConstructor as URIError, URLConstructor as URL, };
/**
 * A data property descriptor that inherits nothing: ToPropertyDescriptor
 * looks up `get` and `set` on the descriptor, prototype chain included.
 */
export function dataDescriptor(value, writable, enumerable, configurable) {
    const descriptor = objectCreate(null);
    descriptor.value = value;
    descriptor.writable = writable;
    descriptor.enumerable = enumerable;
    descriptor.configurable = configurable;
    return descriptor;
}
/** Make `methods` of `from` own properties of `to` (the original functions). */
function copyMethods(to, from, methods) {
    for (let i = 0; i < methods.length; i++) {
        const descriptor = reflectGetOwnPropertyDescriptor(from, methods[i]);
        if (descriptor)
            reflectDefineProperty(to, methods[i], descriptor);
    }
}
/** A Map whose methods a program cannot replace. Never iterate it with for-of; use forEach. */
export class SafeMap extends Map {
}
copyMethods(SafeMap.prototype, Map.prototype, ['get', 'set', 'has', 'delete', 'clear', 'forEach', 'size']);
/** A Set whose methods a program cannot replace. Never iterate it with for-of; use forEach. */
export class SafeSet extends Set {
}
copyMethods(SafeSet.prototype, Set.prototype, ['add', 'has', 'delete', 'clear', 'forEach', 'size']);
export class SafeWeakMap extends WeakMap {
}
copyMethods(SafeWeakMap.prototype, WeakMap.prototype, ['get', 'set', 'has', 'delete']);
export class SafeWeakSet extends WeakSet {
}
copyMethods(SafeWeakSet.prototype, WeakSet.prototype, ['add', 'has', 'delete']);
/**
 * An array that inherits nothing: reading or writing past its end, which on
 * an ordinary array consults Array.prototype and Object.prototype (where a
 * program may have put accessors), touches only the list. It has no methods.
 */
export class SafeList extends Array {
}
reflectSetPrototypeOf(SafeList.prototype, null);
/**
 * The prototype of the interpreter's own generator objects: the generator
 * methods and `[Symbol.iterator]` as own properties, over nothing, so that
 * driving one (next(), and yield*, which looks up both) reaches no method a
 * program replaced on %GeneratorPrototype% or %IteratorPrototype%.
 */
export const SafeGeneratorPrototype = objectCreate(null);
/** The same, for the interpreter's own async generators. */
export const SafeAsyncGeneratorPrototype = objectCreate(null);
{
    const generatorPrototype = reflectGetPrototypeOf(function* () { }.prototype) ?? {};
    const asyncGeneratorPrototype = reflectGetPrototypeOf(async function* () { }.prototype) ?? {};
    copyMethods(SafeGeneratorPrototype, generatorPrototype, ['next', 'return', 'throw']);
    copyMethods(SafeGeneratorPrototype, reflectGetPrototypeOf(generatorPrototype) ?? {}, [Symbol.iterator]);
    copyMethods(SafeAsyncGeneratorPrototype, asyncGeneratorPrototype, ['next', 'return', 'throw']);
    copyMethods(SafeAsyncGeneratorPrototype, reflectGetPrototypeOf(asyncGeneratorPrototype) ?? {}, [Symbol.asyncIterator]);
}
/**
 * The prototype of the parser's regexps (parser-realm.ts): RegExp.prototype's
 * members as own properties, over nothing, so that what a regexp is asked
 * (its source, its flags, test, whose own reads of `exec` and of each flag
 * look here too) reaches no member a program replaced on RegExp.prototype.
 * Not `constructor`, nor @@split or @@matchAll, which search with a new
 * regexp of the realm's own (its species), whose `exec` is the realm's.
 */
export const SafeRegExpPrototype = objectCreate(null);
{
    const keys = Reflect.ownKeys(RegExp.prototype);
    const members = [];
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key !== 'constructor' && key !== Symbol.split && key !== Symbol.matchAll)
            members[members.length] = key;
    }
    copyMethods(SafeRegExpPrototype, RegExp.prototype, members);
}
export const GeneratorPrototypeNext = reflectGet(SafeGeneratorPrototype, 'next');
export const GeneratorPrototypeReturn = reflectGet(SafeGeneratorPrototype, 'return');
export const GeneratorPrototypeThrow = reflectGet(SafeGeneratorPrototype, 'throw');
const FunctionPrototypeCall = Function.prototype.call;
export const FunctionPrototypeBind = Function.prototype.bind;
/**
 * `fn` called with `this` as its first argument, as Node's primordials make
 * their `StringPrototypeSlice` (uncurryThis): a call through the captured
 * Function.prototype.call, no argument array made.
 */
function uncurryThis(fn) {
    return reflectApply(FunctionPrototypeBind, FunctionPrototypeCall, [fn]);
}
// Uncurried, as Node's lib/path.js calls them (posix-path.ts).
export const stringCharCodeAt = uncurryThis(String.prototype.charCodeAt);
export const stringSlice = uncurryThis(String.prototype.slice);
export const stringLastIndexOf = uncurryThis(String.prototype.lastIndexOf);
export const arrayJoin = uncurryThis(Array.prototype.join);
// Uncurried for the module resolver and Node's errors (esm-resolver.ts,
// package-map.ts, node-error.ts). Not split or replace: a string separator
// or pattern is asked its Symbol.split or Symbol.replace, which a program
// can put on String.prototype.
export const stringStartsWith = uncurryThis(String.prototype.startsWith);
export const stringEndsWith = uncurryThis(String.prototype.endsWith);
export const stringIncludes = uncurryThis(String.prototype.includes);
export const stringIndexOf = uncurryThis(String.prototype.indexOf);
export const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
export const arrayIncludes = uncurryThis(Array.prototype.includes);
export const arrayIndexOf = uncurryThis(Array.prototype.indexOf);
export const setForEach = uncurryThis(Set.prototype.forEach);
/** Array.prototype.sort of a SafeList, which inherits nothing it could read or write past its end. */
export const arraySort = uncurryThis(Array.prototype.sort);
/** RegExp.prototype.exec: RegExpBuiltinExec, which reads the regexp's own lastIndex and its flags' internal slots. */
export const regExpExec = uncurryThis(RegExp.prototype.exec);
const generatorPrototype = reflectGetPrototypeOf(function* () { }.prototype);
export const generatorNext = uncurryThis(reflectGet(generatorPrototype ?? {}, 'next'));
export const generatorThrow = uncurryThis(reflectGet(generatorPrototype ?? {}, 'throw'));
/** `new URL(input, base)` with the realm's URL. */
export function newURL(input, base) {
    if (URLConstructor === undefined)
        throw new TypeErrorConstructor('URL is not defined');
    return base === undefined ? new URLConstructor(input) : new URLConstructor(input, base);
}
/**
 * `fn`, a generator function of the runtime's own, made to create
 * generators that inherit SafeGeneratorPrototype: next(), and yield*,
 * which looks up the inner generator's [Symbol.iterator] and next, reach
 * no method a program replaced on %GeneratorPrototype%.
 */
export function safeGenerator(fn) {
    if (!reflectDefineProperty(fn, 'prototype', dataDescriptor(SafeGeneratorPrototype, true, false, false))) {
        throw new TypeErrorConstructor('Cannot redefine property: prototype');
    }
    return fn;
}
/** `object`'s own `key`, or undefined: a parsed package.json's field, which Node's reader takes only as the file has it (no inherited one). */
export function ownField(object, key) {
    return objectHasOwn(object, key) ? reflectGet(object, key) : undefined;
}
// The loader glue's own collections and objects (node-shims L3; design-guest-loader-primordials.md §8).
/** Map.prototype.get of a Map the glue did not make (the launch's tables on globalThis). */
export const mapGet = uncurryThis(Map.prototype.get);
export const MapConstructor = Map;
export const objectPreventExtensions = Object.preventExtensions;
export const symbolToStringTag = Symbol.toStringTag;
export const objectDefineProperty = Object.defineProperty;
export const arrayPush = uncurryThis(Array.prototype.push);
export const arraySplice = uncurryThis(Array.prototype.splice);
export const ObjectPrototypePropertyIsEnumerableOf = uncurryThis(Object.prototype.propertyIsEnumerable);
/** Once every promise in `list` has settled: Promise.allSettled's wait, without the list's iterator or the program's Promise.resolve and then. */
export function promiseSettled(list) {
    return new PromiseConstructor((resolve) => {
        let left = list.length;
        if (left === 0) {
            resolve();
            return;
        }
        const one = () => { if (--left === 0)
            resolve(); };
        for (let i = 0; i < list.length; i++)
            reflectApply(PromisePrototypeThen, reflectApply(PromiseResolve, PromiseConstructor, [list[i]]), [one, one]);
    });
}
/** What each promise in `list` fulfilled with, in its order, or the first rejection: Promise.all, on the same captures. */
export function promiseAll(list) {
    return new PromiseConstructor((resolve, reject) => {
        const values = new SafeList();
        let left = list.length;
        if (left === 0) {
            resolve(values);
            return;
        }
        for (let i = 0; i < list.length; i++) {
            const at = i;
            const one = (value) => {
                values[at] = value;
                if (--left === 0)
                    resolve(values);
            };
            reflectApply(PromisePrototypeThen, reflectApply(PromiseResolve, PromiseConstructor, [list[i]]), [one, reject]);
        }
    });
}
export const dateNow = Date.now;
export const mathMax = Math.max;
export const mathCeil = Math.ceil;
export const numberIsSafeInteger = Number.isSafeInteger;
/** A list copied with ArrayCreate and CreateDataProperty, never its species or a prototype's setters. */
export const arrayCopy = uncurryThis(Reflect.get(Array.prototype, 'toSpliced'));
/** TypedArray's byteLength accessor, reading only the view's internal slots. */
export const typedArrayByteLength = (() => {
    const prototype = reflectGetPrototypeOf(Uint8Array.prototype);
    const getter = reflectGetOwnPropertyDescriptor(prototype ?? {}, 'byteLength')?.get;
    if (getter === undefined)
        throw new TypeErrorConstructor('TypedArray.prototype.byteLength is not an accessor');
    return uncurryThis(getter);
})();
