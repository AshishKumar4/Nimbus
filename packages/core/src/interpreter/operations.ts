/**
 * operations.ts — the language's operations as compiled code performs them
 * on the program's values (calls, constructions, property definitions,
 * destructuring's checks), beside the operators of host-ops.ts.
 */
import type { NativeFunction } from './host-ops.js';
import {
  ObjectConstructor, type SafeList, SafeWeakMap, TypeError, accessorDescriptor, contains, copyList, createDataProperty,
  dataDescriptor, defineOrThrow, isEnumerableOwn, listOf, objectFreeze, reflectApply, reflectConstruct, reflectDeleteProperty,
  reflectGet, reflectHas, reflectOwnKeys, stringOf, symbolUnscopables, toObject,
} from './intrinsics.js';
import { Completion, type Signal, isObject, operators } from './runtime.js';

const constructors = new SafeWeakMap<Function, boolean>();
export function isConstructorValue(value: unknown): value is Function {
  if (typeof value !== 'function') return false;
  let known = constructors.get(value);
  if (known === undefined) {
    try {
      // Constructing with `value` as new.target succeeds only for a constructor.
      reflectConstruct(ObjectConstructor, [], value);
      known = true;
    } catch {
      known = false;
    }
    constructors.set(value, known);
  }
  return known;
}

export function toPropertyKey(value: unknown): PropertyKey {
  if (typeof value === 'string' || typeof value === 'symbol') return value;
  if (isObject(value)) return operators().propertyKey(value);
  return stringOf(value);
}

/** An array literal's array: `elements`, with no element at each index of `holes` (an elision). */
export function arrayWithHoles(elements: SafeList<unknown>, holes: SafeList<number>): unknown[] {
  const out = listOf(elements);
  for (let i = 0; i < holes.length; i++) reflectDeleteProperty(out, holes[i]);
  return out;
}

export function requireObjectCoercible(value: unknown): void {
  if (value === null || value === undefined) throw new TypeError(`Cannot destructure '${stringOf(value)}' as it is ${stringOf(value)}.`);
}

/** CopyDataProperties(target, source, excluded): an object rest or spread. */
export function copyDataProperties(target: object, source: unknown, excluded: readonly PropertyKey[] | null): void {
  if (source === null || source === undefined) return;
  const from = toObject(source);
  const keys = reflectOwnKeys(from);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (excluded && contains(excluded, key)) continue;
    if (isEnumerableOwn(from, key)) createDataProperty(target, key, reflectGet(from, key));
  }
}

export function defineMethod(target: object, key: PropertyKey, value: unknown, enumerable: boolean): void {
  defineOrThrow(target, key, dataDescriptor(value, true, enumerable, true));
}

export function defineAccessor(target: object, key: PropertyKey, kind: 'get' | 'set', fn: NativeFunction, enumerable: boolean): void {
  defineOrThrow(target, key, accessorDescriptor(kind, fn, enumerable, true));
}

export function templateObject(cooked: readonly (string | undefined)[], raw: readonly string[]): readonly (string | undefined)[] {
  const strings = copyList(cooked);
  defineOrThrow(strings, 'raw', dataDescriptor(objectFreeze(copyList(raw)), false, false, false));
  return objectFreeze(strings);
}

export function callValue(fn: unknown, thisArg: unknown, args: unknown[], text: string): unknown {
  if (typeof fn !== 'function') throw new TypeError(`${text} is not a function`);
  return reflectApply(fn, thisArg, args);
}

export function constructValue(fn: unknown, args: unknown[], text: string): unknown {
  if (typeof fn !== 'function') throw new TypeError(`${text} is not a constructor`);
  try {
    return reflectConstruct(fn, args);
  } catch (error) {
    // V8 names a non-constructor by its own source text; name it by the expression.
    if (error instanceof TypeError && !isConstructorValue(fn)) throw new TypeError(`${text} is not a constructor`);
    throw error;
  }
}

/** A key as an error message shows it, without converting an object key (which could run its code). */
export function keyText(key: unknown): string {
  return isObject(key) ? 'object' : stringOf(key);
}

/** The TypeError for reading `key` of null or undefined, before the key is converted. */
export function nullBase(base: null | undefined, key: unknown): TypeError {
  return new TypeError(`Cannot read properties of ${stringOf(base)} (reading '${keyText(key)}')`);
}

/** Whether `name` resolves on a `with` object (HasBinding of an object environment). */
export function withHas(target: unknown, name: string): target is object {
  if (!isObject(target) || !reflectHas(target, name)) return false;
  const unscopables: unknown = reflectGet(target, symbolUnscopables);
  return !(isObject(unscopables) && reflectGet(unscopables, name));
}

/** A key read and then written converts once, as the reference does. */
export function keyOnce(key: unknown): unknown {
  return typeof key === 'string' || typeof key === 'number' || typeof key === 'symbol' ? key : toPropertyKey(key);
}

/** A body's result as a completion signal: the completion, or undefined for a value. */
export function signalOf(value: unknown): Signal {
  return value instanceof Completion ? value : undefined;
}
