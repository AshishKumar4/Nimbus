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
export const symbolIterator: typeof Symbol.iterator = Symbol.iterator;
export const symbolAsyncIterator: typeof Symbol.asyncIterator = Symbol.asyncIterator;
export const symbolUnscopables: typeof Symbol.unscopables = Symbol.unscopables;
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
export const ArrayIteratorPrototype: object = Reflect.getPrototypeOf([][Symbol.iterator]()) ?? {};
export const ArrayIteratorNext: unknown = Reflect.get(ArrayIteratorPrototype, 'next');
// ES2023's copying methods: they make their result with ArrayCreate, not the
// receiver's species, and fill it with own data properties, never [[Set]].
export const ArrayPrototypeWith: unknown = Reflect.get(Array.prototype, 'with');
export const ArrayPrototypeToSpliced: unknown = Reflect.get(Array.prototype, 'toSpliced');
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
export const RegExpPrototypeAccessors: { readonly [name: string]: unknown } = (() => {
  const accessors: { [name: string]: unknown } = objectCreate(null);
  const names = Object.getOwnPropertyNames(RegExp.prototype);
  for (let i = 0; i < names.length; i++) {
    const getter = Reflect.getOwnPropertyDescriptor(RegExp.prototype, names[i])?.get;
    if (getter !== undefined) accessors[names[i]] = getter;
  }
  return accessors;
})();
export const NumberPrototypeToString = Number.prototype.toString;
export const BigIntPrototypeToString = BigInt.prototype.toString;
export const ObjectPrototype: object = Object.prototype;
export const ObjectPrototypeHasOwnProperty = Object.prototype.hasOwnProperty;
export const ObjectPrototypeToString = Object.prototype.toString;
export const objectDefineProperties = Object.defineProperties;
export const parseIntOf = parseInt;
export const parseFloatOf = parseFloat;
export const SymbolConstructor = Symbol;
export const SymbolPrototypeDescription: unknown = Reflect.getOwnPropertyDescriptor(Symbol.prototype, 'description')?.get;
export const globalObject: typeof globalThis = globalThis;
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
let runtimeCaptureStackTrace: unknown = Reflect.get(Error, 'captureStackTrace');
export function captureStackTraceOf(): unknown {
  return runtimeCaptureStackTrace;
}
/** The runtime's own Error.captureStackTrace, installed before any program code (commonjs-cell). */
export function useCaptureStackTrace(capture: Function): void {
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
const URLConstructor: typeof URL | undefined = typeof URL === 'function' ? URL : undefined;
// The interpreter's modules import these under the globals' names, so their
// `new TypeError(...)` constructs the realm's own.
export {
  BigIntOf as BigInt, ErrorConstructor as Error, RangeErrorConstructor as RangeError,
  ReferenceErrorConstructor as ReferenceError, RegExpConstructor as RegExp, SyntaxErrorConstructor as SyntaxError,
  TypeErrorConstructor as TypeError, URIErrorConstructor as URIError, URLConstructor as URL,
};

/**
 * A data property descriptor that inherits nothing: ToPropertyDescriptor
 * looks up `get` and `set` on the descriptor, prototype chain included.
 */
export function dataDescriptor(value: unknown, writable: boolean, enumerable: boolean, configurable: boolean): PropertyDescriptor {
  const descriptor: PropertyDescriptor = objectCreate(null);
  descriptor.value = value;
  descriptor.writable = writable;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  return descriptor;
}

/** Make `methods` of `from` own properties of `to` (the original functions). */
function copyMethods(to: object, from: object, methods: readonly PropertyKey[]): void {
  for (let i = 0; i < methods.length; i++) {
    const descriptor = reflectGetOwnPropertyDescriptor(from, methods[i]);
    if (descriptor) reflectDefineProperty(to, methods[i], descriptor);
  }
}

/** A Map whose methods a program cannot replace. Never iterate it with for-of; use forEach. */
export class SafeMap<K, V> extends Map<K, V> {}
copyMethods(SafeMap.prototype, Map.prototype, ['get', 'set', 'has', 'delete', 'clear', 'forEach', 'size']);

/** A Set whose methods a program cannot replace. Never iterate it with for-of; use forEach. */
export class SafeSet<T> extends Set<T> {}
copyMethods(SafeSet.prototype, Set.prototype, ['add', 'has', 'delete', 'clear', 'forEach', 'size']);

export class SafeWeakMap<K extends WeakKey, V> extends WeakMap<K, V> {}
copyMethods(SafeWeakMap.prototype, WeakMap.prototype, ['get', 'set', 'has', 'delete']);

export class SafeWeakSet<T extends WeakKey> extends WeakSet<T> {}
copyMethods(SafeWeakSet.prototype, WeakSet.prototype, ['add', 'has', 'delete']);

/**
 * An array that inherits nothing: reading or writing past its end, which on
 * an ordinary array consults Array.prototype and Object.prototype (where a
 * program may have put accessors), touches only the list. It has no methods.
 */
export class SafeList<T> extends Array<T> {
  // Nominal: an ordinary array is not a SafeList.
  declare private readonly safeList: true;
}
reflectSetPrototypeOf(SafeList.prototype, null);

/**
 * The prototype of the interpreter's own generator objects: the generator
 * methods and `[Symbol.iterator]` as own properties, over nothing, so that
 * driving one (next(), and yield*, which looks up both) reaches no method a
 * program replaced on %GeneratorPrototype% or %IteratorPrototype%.
 */
export const SafeGeneratorPrototype: object = objectCreate(null);
/** The same, for the interpreter's own async generators. */
export const SafeAsyncGeneratorPrototype: object = objectCreate(null);
{
  const generatorPrototype: object = reflectGetPrototypeOf(function* () {}.prototype) ?? {};
  const asyncGeneratorPrototype: object = reflectGetPrototypeOf(async function* () {}.prototype) ?? {};
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
export const SafeRegExpPrototype: object = objectCreate(null);
{
  const keys = Reflect.ownKeys(RegExp.prototype);
  const members: PropertyKey[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key !== 'constructor' && key !== Symbol.split && key !== Symbol.matchAll) members[members.length] = key;
  }
  copyMethods(SafeRegExpPrototype, RegExp.prototype, members);
}
export const GeneratorPrototypeNext: unknown = reflectGet(SafeGeneratorPrototype, 'next');
export const GeneratorPrototypeReturn: unknown = reflectGet(SafeGeneratorPrototype, 'return');
export const GeneratorPrototypeThrow: unknown = reflectGet(SafeGeneratorPrototype, 'throw');

const FunctionPrototypeCall = Function.prototype.call;
export const FunctionPrototypeBind = Function.prototype.bind;
/**
 * `fn` called with `this` as its first argument, as Node's primordials make
 * their `StringPrototypeSlice` (uncurryThis): a call through the captured
 * Function.prototype.call, no argument array made.
 */
function uncurryThis(fn: Function) {
  return reflectApply(FunctionPrototypeBind, FunctionPrototypeCall, [fn]);
}
// Uncurried, as Node's lib/path.js calls them (posix-path.ts).
export const stringCharCodeAt: (text: string, index: number) => number = uncurryThis(String.prototype.charCodeAt);
export const stringSlice: (text: string, start?: number, end?: number) => string = uncurryThis(String.prototype.slice);
export const stringLastIndexOf: (text: string, search: string, position?: number) => number = uncurryThis(String.prototype.lastIndexOf);
export const arrayJoin: (list: readonly string[], separator: string) => string = uncurryThis(Array.prototype.join);
// Uncurried for the module resolver and Node's errors (esm-resolver.ts,
// package-map.ts, node-error.ts). Not split or replace: a string separator
// or pattern is asked its Symbol.split or Symbol.replace, which a program
// can put on String.prototype.
export const stringStartsWith: (text: string, search: string, position?: number) => boolean = uncurryThis(String.prototype.startsWith);
export const stringEndsWith: (text: string, search: string) => boolean = uncurryThis(String.prototype.endsWith);
export const stringIncludes: (text: string, search: string) => boolean = uncurryThis(String.prototype.includes);
export const stringIndexOf: (text: string, search: string, position?: number) => number = uncurryThis(String.prototype.indexOf);
export const stringToLowerCase: (text: string) => string = uncurryThis(String.prototype.toLowerCase);
export const arrayIncludes: <T>(list: readonly T[], value: T) => boolean = uncurryThis(Array.prototype.includes);
export const arrayIndexOf: <T>(list: readonly T[], value: T, from?: number) => number = uncurryThis(Array.prototype.indexOf);
export const setForEach: <T>(set: ReadonlySet<T>, each: (value: T) => void) => void = uncurryThis(Set.prototype.forEach);
/** Array.prototype.sort of a SafeList, which inherits nothing it could read or write past its end. */
export const arraySort: <T>(list: SafeList<T>, compare: (a: T, b: T) => number) => SafeList<T> = uncurryThis(Array.prototype.sort);
/** RegExp.prototype.exec: RegExpBuiltinExec, which reads the regexp's own lastIndex and its flags' internal slots. */
export const regExpExec: (pattern: RegExp, text: string) => RegExpExecArray | null = uncurryThis(RegExp.prototype.exec);
const generatorPrototype = reflectGetPrototypeOf(function* () {}.prototype);
export const generatorNext: <R>(it: Generator<unknown, R, unknown>, value?: unknown) => IteratorResult<unknown, R> = uncurryThis(reflectGet(generatorPrototype ?? {}, 'next'));
export const generatorThrow: <R>(it: Generator<unknown, R, unknown>, error: unknown) => IteratorResult<unknown, R> = uncurryThis(reflectGet(generatorPrototype ?? {}, 'throw'));

/** `new URL(input, base)` with the realm's URL. */
export function newURL(input: string, base?: string | URL): URL {
  if (URLConstructor === undefined) throw new TypeErrorConstructor('URL is not defined');
  return base === undefined ? new URLConstructor(input) : new URLConstructor(input, base);
}

/**
 * `fn`, a generator function of the runtime's own, made to create
 * generators that inherit SafeGeneratorPrototype: next(), and yield*,
 * which looks up the inner generator's [Symbol.iterator] and next, reach
 * no method a program replaced on %GeneratorPrototype%.
 */
export function safeGenerator<A extends unknown[], R>(fn: (...args: A) => Generator<unknown, R, unknown>): (...args: A) => Generator<unknown, R, unknown> {
  if (!reflectDefineProperty(fn, 'prototype', dataDescriptor(SafeGeneratorPrototype, true, false, false))) {
    throw new TypeErrorConstructor('Cannot redefine property: prototype');
  }
  return fn;
}

/** `object`'s own `key`, or undefined: a parsed package.json's field, which Node's reader takes only as the file has it (no inherited one). */
export function ownField(object: object, key: string): unknown {
  return objectHasOwn(object, key) ? reflectGet(object, key) : undefined;
}

// The loader glue's own collections and objects (node-shims L3; design-guest-loader-primordials.md §8).
/** Map.prototype.get of a Map the glue did not make (the launch's tables on globalThis). */
export const mapGet: <K, V>(map: Map<K, V>, key: K) => V | undefined = uncurryThis(Map.prototype.get);
export const MapConstructor = Map;
export const objectPreventExtensions = Object.preventExtensions;
export const symbolToStringTag: typeof Symbol.toStringTag = Symbol.toStringTag;
export const objectDefineProperty = Object.defineProperty;
export const arrayPush: <T>(list: T[], ...items: T[]) => number = uncurryThis(Array.prototype.push);
export const arraySplice: <T>(list: T[], start: number, deleteCount: number) => T[] = uncurryThis(Array.prototype.splice);
export const ObjectPrototypePropertyIsEnumerableOf: (object: object, key: PropertyKey) => boolean = uncurryThis(Object.prototype.propertyIsEnumerable);
/** Once every promise in `list` has settled: Promise.allSettled's wait, without the list's iterator or the program's Promise.resolve and then. */
export function promiseSettled<T>(list: ArrayLike<T>): Promise<void> {
  return new PromiseConstructor<void>((resolve) => {
    let left = list.length;
    if (left === 0) { resolve(); return; }
    const one = (): void => { if (--left === 0) resolve(); };
    for (let i = 0; i < list.length; i++) reflectApply(PromisePrototypeThen, reflectApply(PromiseResolve, PromiseConstructor, [list[i]]), [one, one]);
  });
}
/** What each promise in `list` fulfilled with, in its order, or the first rejection: Promise.all, on the same captures. */
export function promiseAll<T>(list: ArrayLike<T>): Promise<SafeList<Awaited<T>>> {
  return new PromiseConstructor<SafeList<Awaited<T>>>((resolve, reject) => {
    const values = new SafeList<Awaited<T>>();
    let left = list.length;
    if (left === 0) { resolve(values); return; }
    for (let i = 0; i < list.length; i++) {
      const at = i;
      const one = (value: Awaited<T>): void => {
        values[at] = value;
        if (--left === 0) resolve(values);
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
export const arrayCopy: <T>(list: ArrayLike<T>) => T[] = uncurryThis(Reflect.get(Array.prototype, 'toSpliced'));
/** TypedArray's byteLength accessor, reading only the view's internal slots. */
export const typedArrayByteLength: (view: Uint8Array) => number = (() => {
  const prototype = reflectGetPrototypeOf(Uint8Array.prototype);
  const getter = reflectGetOwnPropertyDescriptor(prototype ?? {}, 'byteLength')?.get;
  if (getter === undefined) throw new TypeErrorConstructor('TypedArray.prototype.byteLength is not an accessor');
  return uncurryThis(getter);
})();

const ProxyConstructor = Proxy;
export { ProxyConstructor as Proxy };
export const Uint8ArrayConstructor = Uint8Array;
export const ArrayBufferConstructor = ArrayBuffer;
// None in a realm with no TextEncoder (a test262 realm's), where nothing measures resident bytes.
const TextEncoderOf: typeof TextEncoder | undefined = typeof TextEncoder === 'function' ? TextEncoder : undefined;
const encode: ((encoder: TextEncoder, text: string) => Uint8Array) | undefined
  = TextEncoderOf === undefined ? undefined : uncurryThis(TextEncoderOf.prototype.encode);
const encodeInto: ((encoder: TextEncoder, text: string, destination: Uint8Array) => TextEncoderEncodeIntoResult) | undefined
  = TextEncoderOf === undefined ? undefined : uncurryThis(TextEncoderOf.prototype.encodeInto);
/** A TextEncoder of the realm's. */
export function newTextEncoder(): TextEncoder {
  if (TextEncoderOf === undefined) throw new TypeErrorConstructor('TextEncoder is not defined');
  return new TextEncoderOf();
}
/** `encoder.encode(text)`, by the realm's TextEncoder.prototype.encode. */
export function textEncoderEncode(encoder: TextEncoder, text: string): Uint8Array {
  if (encode === undefined) throw new TypeErrorConstructor('TextEncoder is not defined');
  return encode(encoder, text);
}
/** `encoder.encodeInto(text, destination)`, by the realm's TextEncoder.prototype.encodeInto. */
export function textEncoderEncodeInto(encoder: TextEncoder, text: string, destination: Uint8Array): TextEncoderEncodeIntoResult {
  if (encodeInto === undefined) throw new TypeErrorConstructor('TextEncoder is not defined');
  return encodeInto(encoder, text, destination);
}
export const mathFloor = Math.floor;
export const stringCodePointAt: (text: string, index: number) => number | undefined = uncurryThis(String.prototype.codePointAt);
export const typedArraySet: (view: Uint8Array, source: Uint8Array, offset?: number) => void = uncurryThis(Uint8Array.prototype.set);
export const typedArrayBuffer: (view: Uint8Array) => ArrayBufferLike = (() => {
  const prototype = reflectGetPrototypeOf(Uint8Array.prototype);
  const getter = reflectGetOwnPropertyDescriptor(prototype ?? {}, 'buffer')?.get;
  if (getter === undefined) throw new TypeErrorConstructor('TypedArray.prototype.buffer is not an accessor');
  return uncurryThis(getter);
})();
export const typedArrayByteOffset: (view: Uint8Array) => number = (() => {
  const prototype = reflectGetPrototypeOf(Uint8Array.prototype);
  const getter = reflectGetOwnPropertyDescriptor(prototype ?? {}, 'byteOffset')?.get;
  if (getter === undefined) throw new TypeErrorConstructor('TypedArray.prototype.byteOffset is not an accessor');
  return uncurryThis(getter);
})();
/** A backing buffer's length, whether ordinary or shared, through its own captured accessor. */
export const arrayBufferByteLength: (buffer: ArrayBufferLike) => number = (() => {
  const getter = reflectGetOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
  if (getter === undefined) throw new TypeErrorConstructor('ArrayBuffer.prototype.byteLength is not an accessor');
  const length = uncurryThis(getter);
  const sharedGetter = typeof SharedArrayBuffer === 'function' ? reflectGetOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get : undefined;
  const sharedLength = sharedGetter === undefined ? undefined : uncurryThis(sharedGetter);
  return (buffer: ArrayBufferLike): number => buffer instanceof ArrayBufferConstructor || sharedLength === undefined ? length(buffer) : sharedLength(buffer);
})();
/** Array.prototype.shift: unlike splice, it makes no array, so it consults no species. */
export const arrayShift: <T>(list: T[]) => T | undefined = uncurryThis(Array.prototype.shift);
const setValuesOf: <T>(set: ReadonlySet<T>) => SetIterator<T> = uncurryThis(Set.prototype.values);
const setIteratorNext: <T>(iterator: SetIterator<T>) => IteratorResult<T, undefined> = uncurryThis(reflectGet(reflectGetPrototypeOf(new Set<never>().values()) ?? {}, 'next'));
const mapValuesOf: <K, V>(map: ReadonlyMap<K, V>) => MapIterator<V> = uncurryThis(Map.prototype.values);
const mapIteratorNext: <V>(iterator: MapIterator<V>) => IteratorResult<V, undefined> = uncurryThis(reflectGet(reflectGetPrototypeOf(new Map<never, never>().values()) ?? {}, 'next'));
/** The first value of `map` that `test` holds of, or undefined: a walk that stops there, on the Map iterator as the launch found it. */
export function mapFind<K, V>(map: ReadonlyMap<K, V>, test: (value: V) => boolean): V | undefined {
  const iterator = mapValuesOf(map);
  for (let step = mapIteratorNext(iterator); !step.done; step = mapIteratorNext(iterator)) if (test(step.value)) return step.value;
  return undefined;
}
/** The first member of `set` that `test` holds of, or undefined: a walk that stops there, on the Set iterator as the launch found it. */
export function setFind<T>(set: ReadonlySet<T>, test: (value: T) => boolean): T | undefined {
  const iterator = setValuesOf(set);
  for (let step = setIteratorNext(iterator); !step.done; step = setIteratorNext(iterator)) if (test(step.value)) return step.value;
  return undefined;
}

// The process's filesystem (runtime/wasi/resident-filesystem.ts, its holder,
// decisions and client) and the resident store under it.
/** `record`'s own `key`, or undefined: an optional field read without the prototype chain, typed as its contract types it. */
export function ownValue<T extends object, K extends keyof T>(record: T, key: K): T[K] | undefined {
  return objectHasOwn(record, key) ? record[key] : undefined;
}
/** `promise.then(onFulfilled, onRejected)`, by the launch's Promise.prototype.then. */
export const promiseThen: <T, R1 = T, R2 = never>(
  promise: Promise<T>, onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null, onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
) => Promise<R1 | R2> = uncurryThis(Promise.prototype.then);
/** `Promise.resolve(value)`, of the launch's Promise. */
export const promiseResolve: {
  (): Promise<void>;
  <T>(value: T): Promise<Awaited<T>>;
} = reflectApply(FunctionPrototypeBind, PromiseResolve, [PromiseConstructor]);
/** `Promise.reject(reason)`, of the launch's Promise. */
export const promiseReject: <T = never>(reason?: unknown) => Promise<T> = reflectApply(FunctionPrototypeBind, PromiseReject, [PromiseConstructor]);
/** Settled as the first of `list` to settle: Promise.race, without the list's iterator or the program's Promise.resolve and then. */
export function promiseRace<T>(list: ArrayLike<T>): Promise<Awaited<T>> {
  return new PromiseConstructor<Awaited<T>>((resolve, reject) => {
    for (let i = 0; i < list.length; i++) reflectApply(PromisePrototypeThen, reflectApply(PromiseResolve, PromiseConstructor, [list[i]]), [resolve, reject]);
  });
}
/** `promise.finally(onFinally)`, as Promise.prototype.finally runs it (its turns too), on the captures. */
export function promiseFinally<T>(promise: Promise<T>, onFinally: () => unknown): Promise<T> {
  return promiseThen(
    promise,
    (value) => promiseThen(promiseResolve(onFinally()), () => value),
    (reason: unknown) => promiseThen(promiseResolve(onFinally()), (): never => { throw reason; }),
  );
}
/** The members of `set`, in its order: a SafeList, by SafeSet's forEach as the launch captured it. */
export function setList<T>(set: ReadonlySet<T>): SafeList<T> {
  const list = new SafeList<T>();
  setForEach(set, (value) => { list[list.length] = value; });
  return list;
}
const mapForEach: <K, V>(map: ReadonlyMap<K, V>, each: (value: V, key: K) => void) => void = uncurryThis(Map.prototype.forEach);
/** The values of `map`, in its order: a SafeList. */
export function mapValueList<K, V>(map: ReadonlyMap<K, V>): SafeList<V> {
  const list = new SafeList<V>();
  mapForEach(map, (value) => { list[list.length] = value; });
  return list;
}
/** The keys of `map`, in its order: a SafeList. */
export function mapKeyList<K, V>(map: ReadonlyMap<K, V>): SafeList<K> {
  const list = new SafeList<K>();
  mapForEach(map, (_value, key) => { list[list.length] = key; });
  return list;
}
export const arrayPop: <T>(list: T[]) => T | undefined = uncurryThis(Array.prototype.pop);
/** `text.split(separator)` for a separator that is a nonempty string, without asking it for Symbol.split: a SafeList. */
export function stringSplit(text: string, separator: string): SafeList<string> {
  const parts = new SafeList<string>();
  let from = 0;
  for (let at = stringIndexOf(text, separator); at >= 0; at = stringIndexOf(text, separator, from)) {
    parts[parts.length] = stringSlice(text, from, at);
    from = at + separator.length;
  }
  parts[parts.length] = stringSlice(text, from);
  return parts;
}
export const stringLocaleCompare: (text: string, other: string) => number = uncurryThis(String.prototype.localeCompare);
export const stringPadStart: (text: string, length: number, fill?: string) => string = uncurryThis(String.prototype.padStart);
export const mathTrunc = Math.trunc;
export const numberIsFinite = Number.isFinite;
export const typedArrayFill: (view: Uint8Array, value: number, start?: number, end?: number) => Uint8Array = uncurryThis(Uint8Array.prototype.fill);
/** A relative index into `length` items as subarray and slice take one: from the end where negative, within 0..length. */
function relativeIndex(at: number, length: number): number {
  const integer = at !== at ? 0 : mathTrunc(at);
  return integer < 0 ? mathMax(length + integer, 0) : mathMin(integer, length);
}
/** `bytes.subarray(start, end)` without the view's constructor or species: a view of the same buffer. */
export function bytesView(bytes: Uint8Array, start = 0, end?: number): Uint8Array {
  const length = typedArrayByteLength(bytes);
  const from = relativeIndex(start, length);
  const to = end === undefined ? length : relativeIndex(end, length);
  return new Uint8ArrayConstructor(typedArrayBuffer(bytes), typedArrayByteOffset(bytes) + from, to > from ? to - from : 0);
}
/** `bytes.slice(start, end)` without the view's constructor or species: a copy. */
export function bytesCopy(bytes: Uint8Array, start = 0, end?: number): Uint8Array {
  const view = bytesView(bytes, start, end);
  const copy = new Uint8ArrayConstructor(typedArrayByteLength(view));
  typedArraySet(copy, view);
  return copy;
}
