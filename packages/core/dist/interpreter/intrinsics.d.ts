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
export declare const reflectApply: typeof Reflect.apply;
export declare const reflectConstruct: typeof Reflect.construct;
export declare const reflectGet: typeof Reflect.get;
export declare const reflectSet: typeof Reflect.set;
export declare const reflectHas: typeof Reflect.has;
export declare const reflectOwnKeys: typeof Reflect.ownKeys;
export declare const reflectDefineProperty: typeof Reflect.defineProperty;
export declare const reflectDeleteProperty: typeof Reflect.deleteProperty;
export declare const reflectGetOwnPropertyDescriptor: typeof Reflect.getOwnPropertyDescriptor;
export declare const reflectGetPrototypeOf: typeof Reflect.getPrototypeOf;
export declare const reflectSetPrototypeOf: typeof Reflect.setPrototypeOf;
export declare const objectCreate: {
    (o: object | null): any;
    (o: object | null, properties: PropertyDescriptorMap & ThisType<any>): any;
};
export declare const objectKeys: {
    (o: object): string[];
    (o: {}): string[];
};
export declare const objectFreeze: {
    <T extends Function>(f: T): T;
    <T extends {
        [idx: string]: U | null | undefined | object;
    }, U extends string | bigint | number | boolean | symbol>(o: T): Readonly<T>;
    <T>(o: T): Readonly<T>;
};
export declare const objectHasOwn: (o: object, v: PropertyKey) => boolean;
export declare const objectGetOwnPropertyNames: (o: any) => string[];
export declare const objectGetPrototypeOf: typeof Reflect.getPrototypeOf;
export declare const arrayIsArray: (arg: any) => arg is any[];
export declare const symbolFor: (key: string) => symbol;
export declare const symbolIterator: symbol;
export declare const symbolAsyncIterator: symbol;
export declare const symbolUnscopables: symbol;
export declare const stringOf: StringConstructor;
export declare const globalObject: typeof globalThis;
export declare const registerSource: typeof primordials.registerSource;
export declare const dataDescriptor: typeof primordials.dataDescriptor;
export declare const ArrayValues: () => ArrayIterator<any>;
export declare const ArrayIteratorPrototype: object;
export declare const ArrayIteratorNext: unknown;
export declare const SafeGeneratorPrototype: object;
export declare const SafeAsyncGeneratorPrototype: object;
export declare const LAUNCH_PRIMORDIALS: object;
export declare const BigInt: BigIntConstructor;
export declare const Error: ErrorConstructor;
export declare const RangeError: RangeErrorConstructor;
export declare const ReferenceError: ReferenceErrorConstructor;
export declare const RegExp: RegExpConstructor;
export declare const SyntaxError: SyntaxErrorConstructor;
export declare const TypeError: TypeErrorConstructor;
export declare const SafeMap: typeof primordials.SafeMap;
export type SafeMap<K, V> = primordials.SafeMap<K, V>;
export declare const SafeSet: typeof primordials.SafeSet;
export type SafeSet<T> = primordials.SafeSet<T>;
export declare const SafeWeakMap: typeof primordials.SafeWeakMap;
export type SafeWeakMap<K extends WeakKey, V> = primordials.SafeWeakMap<K, V>;
export declare const SafeWeakSet: typeof primordials.SafeWeakSet;
export type SafeWeakSet<T extends WeakKey> = primordials.SafeWeakSet<T>;
export declare const SafeList: typeof primordials.SafeList;
export type SafeList<T> = primordials.SafeList<T>;
/** The realm's Object constructor, as a new.target-free constructor to test constructors with. */
export declare const ObjectConstructor: ObjectConstructor;
/** ToObject, for a value that is not null or undefined. */
export declare function toObject(value: unknown): object;
/** Whether `key` is an own enumerable property of `target` ([[GetOwnProperty]] once). */
export declare function isEnumerableOwn(target: object, key: PropertyKey): boolean;
/** `Symbol(description)`, as String(symbol) answers. */
export declare function symbolDescriptiveString(symbol: symbol): string;
/** A symbol's description. */
export declare function symbolDescription(symbol: symbol): string | undefined;
export declare function promiseResolve(value: unknown): Promise<unknown>;
export declare function promiseReject(reason: unknown): Promise<never>;
/** Resume one of the interpreter's own generators. */
export declare function resume<R>(it: Generator<unknown, R, unknown>, value: unknown): IteratorResult<unknown, R>;
/** Throw into one of the interpreter's own generators. */
export declare function resumeThrowing<R>(it: Generator<unknown, R, unknown>, error: unknown): IteratorResult<unknown, R>;
/**
 * `fn`, a generator function of the interpreter's own, made to create
 * generators that inherit SafeGeneratorPrototype.
 */
export declare function safeGenerator<A extends unknown[], R>(fn: (...args: A) => Generator<unknown, R, unknown>): (...args: A) => Generator<unknown, R, unknown>;
/** Object.defineProperty: define the property, or throw. */
export declare function defineOrThrow(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void;
/** A descriptor of an accessor half, that inherits nothing. */
export declare function accessorDescriptor(kind: 'get' | 'set', fn: (this: unknown, ...args: unknown[]) => unknown, enumerable: boolean, configurable: boolean): PropertyDescriptor;
/** CreateDataPropertyOrThrow. */
export declare function createDataProperty(target: object, key: PropertyKey, value: unknown): void;
export declare function stringSlice(text: string, start: number, end?: number): string;
export declare function stringLastIndexOf(text: string, search: string, position?: number): number;
export declare function charCodeAt(text: string, index: number): number;
/** `f` of each index below `length`, as a new array whose elements are own properties. */
export declare function listOfLength<T>(length: number, f: (index: number) => T): T[];
/** A new array of `length` undefined elements, each an own property: writing one never looks past the array. */
export declare function newList(length: number): unknown[];
/** `f` of each element, in a new array. */
export declare function mapList<T, R>(list: ArrayLike<T>, f: (item: T, index: number) => R): R[];
/** A copy of an array-like as an ordinary array, without its species. */
export declare function copyList<T>(list: ArrayLike<T>): T[];
/** A copy of `list` with element `index` replaced by `value`. */
export declare function withElement<T>(list: readonly T[], index: number, value: T): T[];
/** The elements of an array-like from `start` on, as a new array. */
export declare function arraySliceFrom<T>(list: ArrayLike<T>, start: number): T[];
/** A new array of `first` and then `rest`'s elements. */
export declare function withFirst<T>(first: T, rest: ArrayLike<T>): T[];
/** A new array of `list`'s elements and then `value`. */
export declare function withLast<T>(list: ArrayLike<T>, value: T): T[];
/** A new, empty list to grow with append. */
export declare function newSafeList<T>(): SafeList<T>;
/** `list` with `value` appended. */
export declare function append<T>(list: SafeList<T>, value: T): void;
/** A SafeList's elements as an ordinary array. */
export declare function listOf<T>(list: SafeList<T>): T[];
/** The index of the first element that passes `test`, or -1. */
export declare function indexWhere<T>(list: ArrayLike<T>, test: (item: T) => boolean): number;
export declare function contains(list: ArrayLike<unknown>, value: unknown): boolean;
export declare function everyItem<T, S extends T>(list: readonly T[], test: (item: T) => item is S): list is readonly S[];
export declare function everyItem<T>(list: ArrayLike<T>, test: (item: T) => boolean): boolean;
export declare function someItem<T>(list: ArrayLike<T>, test: (item: T) => boolean): boolean;
/** Whether a UTF-16 code unit is JavaScript whitespace or a line terminator. */
export declare function isWhitespaceCode(c: number): boolean;
/** The offset of the first character at or after `position` that is not whitespace or a comment. */
export declare function skipTrivia(text: string, position: number): number;
//# sourceMappingURL=intrinsics.d.ts.map