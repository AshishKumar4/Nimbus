/**
 * intrinsics.ts — the built-ins the interpreter calls, as primordials.ts
 * captured them at the launch's start, and the helpers built on them.
 *
 * A program shares the interpreter's realm and may replace built-ins, and
 * accessors on Object.prototype or Array.prototype answer any lookup that
 * reaches them. So no code of the interpreter reaches a built-in through a
 * path a program can change (tests/unit/interpreter-primordials.mjs checks):
 *
 *   - it calls built-ins only as captured here, and walks arrays with index
 *     loops (never for-of, spread or array destructuring, which call the
 *     array iterator);
 *   - its arrays have every element as an own property from the start
 *     (newList, copyList, frames copied from templates), so reading or
 *     writing an element never looks past the array; a list it grows is a
 *     SafeList, which inherits nothing;
 *   - its copies use `with` and `toSpliced`, which ignore Symbol.species;
 *   - its property descriptors inherit nothing;
 *   - its maps and sets are SafeMap, SafeSet, SafeWeakMap and SafeWeakSet,
 *     whose methods are own properties of their prototypes;
 *   - its generators inherit SafeGeneratorPrototype (safeGenerator).
 */
import * as primordials from './primordials.js';

export const reflectApply = primordials.reflectApply;
export const reflectConstruct = primordials.reflectConstruct;
export const reflectGet = primordials.reflectGet;
export const reflectSet = primordials.reflectSet;
export const reflectHas = primordials.reflectHas;
export const reflectOwnKeys = primordials.reflectOwnKeys;
export const reflectDefineProperty = primordials.reflectDefineProperty;
export const reflectDeleteProperty = primordials.reflectDeleteProperty;
export const reflectGetOwnPropertyDescriptor = primordials.reflectGetOwnPropertyDescriptor;
export const reflectGetPrototypeOf = primordials.reflectGetPrototypeOf;
export const reflectSetPrototypeOf = primordials.reflectSetPrototypeOf;
export const objectCreate = primordials.objectCreate;
export const objectKeys = primordials.objectKeys;
export const objectFreeze = primordials.objectFreeze;
export const objectAssign = primordials.objectAssign;
export const objectHasOwn = primordials.objectHasOwn;
export const objectGetOwnPropertyNames = primordials.objectGetOwnPropertyNames;
export const objectGetPrototypeOf = primordials.reflectGetPrototypeOf;
export const arrayIsArray = primordials.arrayIsArray;
export const symbolFor = primordials.symbolFor;
export const symbolIterator = primordials.symbolIterator;
export const symbolAsyncIterator = primordials.symbolAsyncIterator;
export const symbolUnscopables = primordials.symbolUnscopables;
export const stringOf = primordials.stringOf;
export const globalObject = primordials.globalObject;
export const registerSource = primordials.registerSource;
export const dataDescriptor = primordials.dataDescriptor;
export const ArrayValues = primordials.ArrayValues;
export const ArrayIteratorPrototype = primordials.ArrayIteratorPrototype;
export const ArrayIteratorNext = primordials.ArrayIteratorNext;
export const SafeGeneratorPrototype = primordials.SafeGeneratorPrototype;
export const SafeAsyncGeneratorPrototype = primordials.SafeAsyncGeneratorPrototype;
export const LAUNCH_PRIMORDIALS = primordials.LAUNCH_PRIMORDIALS;
export const BigInt = primordials.BigInt;
export const Error = primordials.Error;
export const RangeError = primordials.RangeError;
export const ReferenceError = primordials.ReferenceError;
export const RegExp = primordials.RegExp;
export const SyntaxError = primordials.SyntaxError;
export const TypeError = primordials.TypeError;
export const SafeMap = primordials.SafeMap;
export type SafeMap<K, V> = primordials.SafeMap<K, V>;
export const SafeSet = primordials.SafeSet;
export type SafeSet<T> = primordials.SafeSet<T>;
export const SafeWeakMap = primordials.SafeWeakMap;
export type SafeWeakMap<K extends WeakKey, V> = primordials.SafeWeakMap<K, V>;
export const SafeWeakSet = primordials.SafeWeakSet;
export type SafeWeakSet<T extends WeakKey> = primordials.SafeWeakSet<T>;
export const SafeList = primordials.SafeList;
export type SafeList<T> = primordials.SafeList<T>;

function method(value: unknown, name: string): Function {
  if (typeof value !== 'function') throw new Error(`interpreter: the realm has no ${name}`);
  return value;
}
const ArrayFrom: Function = primordials.ArrayFrom;
const ArrayConstructor = primordials.ArrayConstructor;
const ArrayPrototypeWith = method(primordials.ArrayPrototypeWith, 'Array.prototype.with');
const ArrayPrototypeToSpliced = method(primordials.ArrayPrototypeToSpliced, 'Array.prototype.toSpliced');
const GeneratorPrototypeNext = method(primordials.GeneratorPrototypeNext, '%GeneratorPrototype%.next');
const GeneratorPrototypeThrow = method(primordials.GeneratorPrototypeThrow, '%GeneratorPrototype%.throw');
const SymbolPrototypeDescription = method(primordials.SymbolPrototypeDescription, 'Symbol.prototype.description');
const StringPrototypeSlice = primordials.StringPrototypeSlice;
const StringPrototypeLastIndexOf = primordials.StringPrototypeLastIndexOf;
const StringPrototypeCharCodeAt = primordials.StringPrototypeCharCodeAt;
const SymbolPrototypeToString = primordials.SymbolPrototypeToString;
const PromiseConstructor = primordials.PromiseConstructor;
const PromiseResolve = primordials.PromiseResolve;
const PromiseReject = primordials.PromiseReject;
const ObjectOf = primordials.ObjectOf;
const ObjectPrototypePropertyIsEnumerable = primordials.ObjectPrototypePropertyIsEnumerable;
/** The realm's Object constructor, as a new.target-free constructor to test constructors with. */
export const ObjectConstructor = primordials.ObjectOf;

/** ToObject, for a value that is not null or undefined. */
export function toObject(value: unknown): object {
  return ObjectOf(value);
}

/** Whether `key` is an own enumerable property of `target` ([[GetOwnProperty]] once). */
export function isEnumerableOwn(target: object, key: PropertyKey): boolean {
  return reflectApply(ObjectPrototypePropertyIsEnumerable, target, [key]);
}

/** `Symbol(description)`, as String(symbol) answers. */
export function symbolDescriptiveString(symbol: symbol): string {
  return reflectApply(SymbolPrototypeToString, symbol, []);
}

/** A symbol's description. */
export function symbolDescription(symbol: symbol): string | undefined {
  return reflectApply(SymbolPrototypeDescription, symbol, []);
}

export function promiseResolve(value: unknown): Promise<unknown> {
  return reflectApply(PromiseResolve, PromiseConstructor, [value]);
}

export function promiseReject(reason: unknown): Promise<never> {
  return reflectApply(PromiseReject, PromiseConstructor, [reason]);
}

/** Resume one of the interpreter's own generators. */
export function resume<R>(it: Generator<unknown, R, unknown>, value: unknown): IteratorResult<unknown, R> {
  return reflectApply(GeneratorPrototypeNext, it, [value]);
}

/** Throw into one of the interpreter's own generators. */
export function resumeThrowing<R>(it: Generator<unknown, R, unknown>, error: unknown): IteratorResult<unknown, R> {
  return reflectApply(GeneratorPrototypeThrow, it, [error]);
}

/**
 * `fn`, a generator function of the interpreter's own, made to create
 * generators that inherit SafeGeneratorPrototype.
 */
export function safeGenerator<A extends unknown[], R>(fn: (...args: A) => Generator<unknown, R, unknown>): (...args: A) => Generator<unknown, R, unknown> {
  defineOrThrow(fn, 'prototype', dataDescriptor(SafeGeneratorPrototype, true, false, false));
  return fn;
}

/** Object.defineProperty: define the property, or throw. */
export function defineOrThrow(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
  if (!reflectDefineProperty(target, key, descriptor)) throw new TypeError(`Cannot redefine property: ${stringOf(key)}`);
}

/** A descriptor of an accessor half, that inherits nothing. */
export function accessorDescriptor(
  kind: 'get' | 'set', fn: (this: unknown, ...args: unknown[]) => unknown, enumerable: boolean, configurable: boolean,
): PropertyDescriptor {
  const descriptor: PropertyDescriptor = objectCreate(null);
  if (kind === 'get') descriptor.get = fn; else descriptor.set = fn;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  return descriptor;
}

/** One descriptor object reused by createDataProperty: nothing between filling and reading it runs a program's code. */
const DATA = dataDescriptor(undefined, true, true, true);

/** CreateDataPropertyOrThrow. */
export function createDataProperty(target: object, key: PropertyKey, value: unknown): void {
  DATA.value = value;
  const ok = reflectDefineProperty(target, key, DATA);
  DATA.value = undefined;
  if (!ok) throw new TypeError(`Cannot redefine property: ${stringOf(key)}`);
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

// ── Lists ──

/** An array-like of `length` holes that inherits nothing, for Array.from. */
function lengthOnly(length: number): ArrayLike<unknown> {
  const like: { length: number } = objectCreate(null);
  like.length = length;
  return like;
}

/** `f` of each index below `length`, as a new array whose elements are own properties. */
export function listOfLength<T>(length: number, f: (index: number) => T): T[] {
  return reflectApply(ArrayFrom, ArrayConstructor, [lengthOnly(length), (_: unknown, index: number) => f(index)]);
}

/** A new array of `length` undefined elements, each an own property: writing one never looks past the array. */
export function newList(length: number): unknown[] {
  return reflectApply(ArrayFrom, ArrayConstructor, [lengthOnly(length)]);
}

/** `f` of each element, in a new array. */
export function mapList<T, R>(list: ArrayLike<T>, f: (item: T, index: number) => R): R[] {
  return listOfLength(list.length, (i) => f(list[i], i));
}

/** A copy of an array-like as an ordinary array, without its species. */
export function copyList<T>(list: ArrayLike<T>): T[] {
  return reflectApply(ArrayPrototypeToSpliced, list, []);
}

/** A copy of `list` with element `index` replaced by `value`. */
export function withElement<T>(list: readonly T[], index: number, value: T): T[] {
  return reflectApply(ArrayPrototypeWith, list, [index, value]);
}

/** The elements of an array-like from `start` on, as a new array. */
export function arraySliceFrom<T>(list: ArrayLike<T>, start: number): T[] {
  return reflectApply(ArrayPrototypeToSpliced, list, [0, start]);
}

/** A new array of `first` and then `rest`'s elements. */
export function withFirst<T>(first: T, rest: ArrayLike<T>): T[] {
  return reflectApply(ArrayPrototypeToSpliced, rest, [0, 0, first]);
}

/** A new array of `list`'s elements and then `value`. */
export function withLast<T>(list: ArrayLike<T>, value: T): T[] {
  return reflectApply(ArrayPrototypeToSpliced, list, [list.length, 0, value]);
}

/** A new, empty list to grow with append. */
export function newSafeList<T>(): SafeList<T> {
  return new SafeList<T>();
}

/** `list` with `value` appended. */
export function append<T>(list: SafeList<T>, value: T): void {
  list[list.length] = value;
}

/** A SafeList's elements as an ordinary array. */
export function listOf<T>(list: SafeList<T>): T[] {
  return copyList(list);
}

/** The index of the first element that passes `test`, or -1. */
export function indexWhere<T>(list: ArrayLike<T>, test: (item: T) => boolean): number {
  for (let i = 0; i < list.length; i++) if (test(list[i])) return i;
  return -1;
}

export function contains(list: ArrayLike<unknown>, value: unknown): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === value) return true;
  return false;
}

export function everyItem<T, S extends T>(list: readonly T[], test: (item: T) => item is S): list is readonly S[];
export function everyItem<T>(list: ArrayLike<T>, test: (item: T) => boolean): boolean;
export function everyItem<T>(list: ArrayLike<T>, test: (item: T) => boolean): boolean {
  for (let i = 0; i < list.length; i++) if (!test(list[i])) return false;
  return true;
}

export function someItem<T>(list: ArrayLike<T>, test: (item: T) => boolean): boolean {
  for (let i = 0; i < list.length; i++) if (test(list[i])) return true;
  return false;
}

// ── Text ──

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
