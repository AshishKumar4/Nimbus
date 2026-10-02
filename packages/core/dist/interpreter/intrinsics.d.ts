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
export declare const reflectApply: typeof Reflect.apply;
export declare const reflectConstruct: typeof Reflect.construct;
export declare const reflectGet: typeof Reflect.get;
export declare const reflectSet: typeof Reflect.set;
export declare const reflectHas: typeof Reflect.has;
export declare const reflectOwnKeys: typeof Reflect.ownKeys;
export declare const reflectDefineProperty: typeof Reflect.defineProperty;
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
export declare const arrayIsArray: (arg: any) => arg is any[];
export declare const symbolFor: (key: string) => symbol;
export declare const objectGetPrototypeOf: (o: any) => any;
export declare const symbolIterator: typeof Symbol.iterator;
export declare const symbolAsyncIterator: typeof Symbol.asyncIterator;
export declare const symbolUnscopables: typeof Symbol.unscopables;
export declare const stringOf: StringConstructor;
/** `Symbol(description)`, as String(symbol) answers. */
export declare function symbolDescriptiveString(symbol: symbol): string;
/** Object.defineProperty: define the property, or throw. */
export declare function defineOrThrow(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void;
export declare function stringSlice(text: string, start: number, end?: number): string;
export declare function stringLastIndexOf(text: string, search: string, position?: number): number;
export declare function charCodeAt(text: string, index: number): number;
/** The elements of an array-like from `start` on, as a new array. */
export declare function arraySliceFrom<T>(list: ArrayLike<T>, start: number): T[];
/** `list` with `value` appended. */
export declare function append<T>(list: T[], value: T): void;
/** A new array of `list`'s elements and then `value`. */
export declare function withLast<T>(list: readonly T[], value: T): T[];
/** The index of the first element that passes `test`, or -1. */
export declare function indexWhere<T>(list: readonly T[], test: (item: T) => boolean): number;
/** Whether a UTF-16 code unit is JavaScript whitespace or a line terminator. */
export declare function isWhitespaceCode(c: number): boolean;
/** The offset of the first character at or after `position` that is not whitespace or a comment. */
export declare function skipTrivia(text: string, position: number): number;
export declare function contains(list: readonly unknown[], value: unknown): boolean;
/** `f` of each element, in a new array. */
export declare function mapList<T, R>(list: readonly T[], f: (item: T, index: number) => R): R[];
export declare function everyItem<T, S extends T>(list: readonly T[], test: (item: T) => item is S): list is readonly S[];
export declare function everyItem<T>(list: readonly T[], test: (item: T) => boolean): boolean;
export declare function someItem<T>(list: readonly T[], test: (item: T) => boolean): boolean;
/** A Map whose methods a program cannot replace. Never iterate it with for-of; use forEach. */
export declare class SafeMap<K, V> extends Map<K, V> {
}
/** A Set whose methods a program cannot replace. Never iterate it with for-of; use forEach. */
export declare class SafeSet<T> extends Set<T> {
}
export declare class SafeWeakMap<K extends WeakKey, V> extends WeakMap<K, V> {
}
export declare class SafeWeakSet<T extends WeakKey> extends WeakSet<T> {
}
//# sourceMappingURL=intrinsics.d.ts.map