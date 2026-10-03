/**
 * primordials.ts — the built-ins the interpreter calls, captured when a
 * launch starts, before any program code runs.
 *
 * The interpreter shares its realm with the program it runs and loads only
 * when the program first produces code its launch did not compile, by which
 * time the program may have replaced any built-in it can reach: a global
 * (`Array`, `TypeError`), a prototype method (`WeakMap.prototype.set`), the
 * array iterator. Had the interpreter captured them when it loads, such a
 * replacement would receive the interpreter's own objects (its environments,
 * the values of private fields), which no native code can reach. So the
 * launch's runtime loads this module first (RUNTIME CODE in
 * _shared/commonjs-cell.ts), and the interpreter (intrinsics.ts) reads its
 * built-ins only from here (tests/unit/interpreter-primordials.mjs checks).
 *
 * Every process of a launch evaluates this module, so it holds only the
 * captures, the collections and lists built on them, and the answer
 * Function.prototype.toString gives for interpreted functions, which is
 * installed now so that a program replacing toString wraps it as it would
 * the native one.
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
export const ObjectPrototypeHasOwnProperty = Object.prototype.hasOwnProperty;
export const ObjectPrototypeToString = Object.prototype.toString;
export const objectDefineProperties = Object.defineProperties;
export const parseIntOf = parseInt;
export const parseFloatOf = parseFloat;
export const SymbolConstructor = Symbol;
export const SymbolPrototypeDescription: unknown = Reflect.getOwnPropertyDescriptor(Symbol.prototype, 'description')?.get;
export const globalObject: typeof globalThis = globalThis;
const BigIntOf = BigInt;
const ErrorConstructor = Error;
const RangeErrorConstructor = RangeError;
const ReferenceErrorConstructor = ReferenceError;
const RegExpConstructor = RegExp;
const SyntaxErrorConstructor = SyntaxError;
const TypeErrorConstructor = TypeError;
// The interpreter's modules import these under the globals' names, so their
// `new TypeError(...)` constructs the realm's own.
export {
  BigIntOf as BigInt, ErrorConstructor as Error, RangeErrorConstructor as RangeError,
  ReferenceErrorConstructor as ReferenceError, RegExpConstructor as RegExp, SyntaxErrorConstructor as SyntaxError,
  TypeErrorConstructor as TypeError,
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
export const GeneratorPrototypeNext: unknown = reflectGet(SafeGeneratorPrototype, 'next');
export const GeneratorPrototypeReturn: unknown = reflectGet(SafeGeneratorPrototype, 'return');
export const GeneratorPrototypeThrow: unknown = reflectGet(SafeGeneratorPrototype, 'throw');

/** Source text of every interpreted function, for Function.prototype.toString. */
const sources = new SafeWeakMap<object, string>();

/** What Function.prototype.toString answers for `fn`: the source text it was compiled from. */
export function registerSource(fn: object, text: string): void {
  sources.set(fn, text);
}

{
  const native = Function.prototype.toString;
  const replacement = {
    toString(this: unknown): string {
      if (typeof this === 'function') {
        const source = sources.get(this);
        if (source !== undefined) return source;
      }
      return reflectApply(native, this, []);
    },
  }.toString;
  sources.set(replacement, 'function toString() { [native code] }');
  reflectDefineProperty(Function.prototype, 'toString', dataDescriptor(replacement, true, false, true));
}

/**
 * This module's identity: the interpreter checks that the module it loaded
 * is the one the launch loaded at its start, not a second evaluation.
 */
export const LAUNCH_PRIMORDIALS: object = objectFreeze(objectCreate(null));
