/**
 * intrinsics.ts — the built-ins the interpreter calls, captured when it loads.
 *
 * A program shares the interpreter's realm and may replace built-ins
 * (test262 replaces Array.prototype[Symbol.iterator]; a polyfill replaces
 * methods), and the interpreter compiles a function the first time it is
 * called, long after the program may have done so. So no code of the
 * interpreter reaches a built-in through a path a program can change: it
 * walks its arrays with index loops (never for-of, spread or array
 * destructuring, which call the array iterator), calls no method looked up on
 * Array.prototype or String.prototype at the time, and keeps its maps and
 * sets in SafeMap, SafeSet and SafeWeakMap, whose methods are own properties
 * of their prototypes, copied here from the originals.
 */

export const reflectApply = Reflect.apply;
export const reflectConstruct = Reflect.construct;
export const reflectGet = Reflect.get;
export const reflectSet = Reflect.set;
export const reflectHas = Reflect.has;
export const reflectOwnKeys = Reflect.ownKeys;
export const reflectDefineProperty = Reflect.defineProperty;
export const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
export const reflectGetPrototypeOf = Reflect.getPrototypeOf;
export const reflectSetPrototypeOf = Reflect.setPrototypeOf;
export const objectCreate = Object.create;
export const objectKeys = Object.keys;
export const objectFreeze = Object.freeze;
export const objectHasOwn = Object.hasOwn;
export const objectGetOwnPropertyNames = Object.getOwnPropertyNames;
export const arrayIsArray = Array.isArray;
export const symbolFor = Symbol.for;
export const objectGetPrototypeOf = Object.getPrototypeOf;
export const symbolIterator: typeof Symbol.iterator = Symbol.iterator;
export const symbolAsyncIterator: typeof Symbol.asyncIterator = Symbol.asyncIterator;
export const symbolUnscopables: typeof Symbol.unscopables = Symbol.unscopables;
export const stringOf = String;
const SymbolPrototypeToString = Symbol.prototype.toString;

const StringPrototypeSlice = String.prototype.slice;
const StringPrototypeLastIndexOf = String.prototype.lastIndexOf;
const StringPrototypeCharCodeAt = String.prototype.charCodeAt;
const ArrayPrototypeSlice = Array.prototype.slice;

/** `Symbol(description)`, as String(symbol) answers. */
export function symbolDescriptiveString(symbol: symbol): string {
  return reflectApply(SymbolPrototypeToString, symbol, []);
}

/** Object.defineProperty: define the property, or throw. */
export function defineOrThrow(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
  if (!reflectDefineProperty(target, key, descriptor)) throw new TypeError(`Cannot redefine property: ${stringOf(key)}`);
}

export function stringSlice(text: string, start: number, end?: number): string {
  return reflectApply(StringPrototypeSlice, text, [start, end]);
}

export function stringLastIndexOf(text: string, search: string, position?: number): number {
  return reflectApply(StringPrototypeLastIndexOf, text, [search, position]);
}

export function charCodeAt(text: string, index: number): number {
  return reflectApply(StringPrototypeCharCodeAt, text, [index]);
}

/** The elements of an array-like from `start` on, as a new array. */
export function arraySliceFrom<T>(list: ArrayLike<T>, start: number): T[] {
  return reflectApply(ArrayPrototypeSlice, list, [start]);
}

/** `list` with `value` appended. */
export function append<T>(list: T[], value: T): void {
  list[list.length] = value;
}

/** A new array of `list`'s elements and then `value`. */
export function withLast<T>(list: readonly T[], value: T): T[] {
  const out = mapList(list, (item) => item);
  append(out, value);
  return out;
}

/** The index of the first element that passes `test`, or -1. */
export function indexWhere<T>(list: readonly T[], test: (item: T) => boolean): number {
  for (let i = 0; i < list.length; i++) if (test(list[i])) return i;
  return -1;
}

/** Whether a UTF-16 code unit is JavaScript whitespace or a line terminator. */
export function isWhitespaceCode(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** The offset of the first character at or after `position` that is not whitespace or a comment. */
export function skipTrivia(text: string, position: number): number {
  let i = position;
  while (i < text.length) {
    const c = charCodeAt(text, i);
    if (isWhitespaceCode(c)) {
      i++;
    } else if (c === 0x2f && charCodeAt(text, i + 1) === 0x2f) {
      while (i < text.length && charCodeAt(text, i) !== 0x0a && charCodeAt(text, i) !== 0x0d) i++;
    } else if (c === 0x2f && charCodeAt(text, i + 1) === 0x2a) {
      i += 2;
      while (i < text.length && !(charCodeAt(text, i) === 0x2a && charCodeAt(text, i + 1) === 0x2f)) i++;
      i += 2;
    } else {
      return i;
    }
  }
  return i;
}

export function contains(list: readonly unknown[], value: unknown): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === value) return true;
  return false;
}

/** `f` of each element, in a new array. */
export function mapList<T, R>(list: readonly T[], f: (item: T, index: number) => R): R[] {
  const out = new Array<R>(list.length);
  for (let i = 0; i < list.length; i++) out[i] = f(list[i], i);
  return out;
}

export function everyItem<T, S extends T>(list: readonly T[], test: (item: T) => item is S): list is readonly S[];
export function everyItem<T>(list: readonly T[], test: (item: T) => boolean): boolean;
export function everyItem<T>(list: readonly T[], test: (item: T) => boolean): boolean {
  for (let i = 0; i < list.length; i++) if (!test(list[i])) return false;
  return true;
}

export function someItem<T>(list: readonly T[], test: (item: T) => boolean): boolean {
  for (let i = 0; i < list.length; i++) if (test(list[i])) return true;
  return false;
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
