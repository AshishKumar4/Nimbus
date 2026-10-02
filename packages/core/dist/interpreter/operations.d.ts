/**
 * operations.ts — the language's operations as compiled code performs them
 * on the program's values (calls, constructions, property definitions,
 * destructuring's checks), beside the operators of host-ops.ts.
 */
import type { NativeFunction } from './host-ops.js';
import { type SafeList } from './intrinsics.js';
import { type Signal } from './runtime.js';
export declare function isConstructorValue(value: unknown): value is Function;
export declare function toPropertyKey(value: unknown): PropertyKey;
/** An array literal's array: `elements`, with no element at each index of `holes` (an elision). */
export declare function arrayWithHoles(elements: SafeList<unknown>, holes: SafeList<number>): unknown[];
export declare function requireObjectCoercible(value: unknown): void;
/** CopyDataProperties(target, source, excluded): an object rest or spread. */
export declare function copyDataProperties(target: object, source: unknown, excluded: readonly PropertyKey[] | null): void;
export declare function defineMethod(target: object, key: PropertyKey, value: unknown, enumerable: boolean): void;
export declare function defineAccessor(target: object, key: PropertyKey, kind: 'get' | 'set', fn: NativeFunction, enumerable: boolean): void;
export declare function templateObject(cooked: readonly (string | undefined)[], raw: readonly string[]): readonly (string | undefined)[];
export declare function callValue(fn: unknown, thisArg: unknown, args: unknown[], text: string): unknown;
export declare function constructValue(fn: unknown, args: unknown[], text: string): unknown;
/** A key as an error message shows it, without converting an object key (which could run its code). */
export declare function keyText(key: unknown): string;
/** The TypeError for reading `key` of null or undefined, before the key is converted. */
export declare function nullBase(base: null | undefined, key: unknown): TypeError;
/** Whether `name` resolves on a `with` object (HasBinding of an object environment). */
export declare function withHas(target: unknown, name: string): target is object;
/** A key read and then written converts once, as the reference does. */
export declare function keyOnce(key: unknown): unknown;
/** A body's result as a completion signal: the completion, or undefined for a value. */
export declare function signalOf(value: unknown): Signal;
//# sourceMappingURL=operations.d.ts.map