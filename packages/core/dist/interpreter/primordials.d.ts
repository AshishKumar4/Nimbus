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
export declare const objectAssign: {
    <T extends {}, U>(target: T, source: U): T & U;
    <T extends {}, U, V>(target: T, source1: U, source2: V): T & U & V;
    <T extends {}, U, V, W>(target: T, source1: U, source2: V, source3: W): T & U & V & W;
    (target: object, ...sources: any[]): any;
};
export declare const objectHasOwn: (o: object, v: PropertyKey) => boolean;
export declare const objectGetOwnPropertyNames: (o: any) => string[];
export declare const arrayIsArray: (arg: any) => arg is any[];
export declare const symbolFor: (key: string) => symbol;
export declare const symbolIterator: typeof Symbol.iterator;
export declare const symbolAsyncIterator: typeof Symbol.asyncIterator;
export declare const symbolUnscopables: typeof Symbol.unscopables;
export declare const stringOf: StringConstructor;
/** ToObject, for a value that is not null or undefined. */
export declare const ObjectOf: ObjectConstructor;
export declare const PromiseConstructor: PromiseConstructor;
export declare const PromiseResolve: {
    (): Promise<void>;
    <T>(value: T): Promise<Awaited<T>>;
    <T>(value: T | PromiseLike<T>): Promise<Awaited<T>>;
};
export declare const PromiseReject: <T = never>(reason?: any) => Promise<T>;
export declare const PromisePrototypeThen: <TResult1 = any, TResult2 = never>(onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null | undefined, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined) => Promise<TResult1 | TResult2>;
export declare const ObjectPrototypePropertyIsEnumerable: (v: PropertyKey) => boolean;
export declare const ArrayConstructor: ArrayConstructor;
export declare const ArrayFrom: {
    <T>(arrayLike: ArrayLike<T>): T[];
    <T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
    <T>(iterable: Iterable<T> | ArrayLike<T>): T[];
    <T, U>(iterable: Iterable<T> | ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
};
export declare const ArrayValues: () => ArrayIterator<any>;
export declare const ArrayIteratorPrototype: object;
export declare const ArrayIteratorNext: unknown;
export declare const ArrayPrototypeWith: unknown;
export declare const ArrayPrototypeToSpliced: unknown;
export declare const StringPrototypeSlice: (start?: number, end?: number) => string;
export declare const StringPrototypeLastIndexOf: (searchString: string, position?: number) => number;
export declare const StringPrototypeCharCodeAt: (index: number) => number;
export declare const SymbolPrototypeToString: () => string;
export declare const SymbolPrototypeDescription: unknown;
export declare const globalObject: typeof globalThis;
declare const BigIntOf: BigIntConstructor;
declare const ErrorConstructor: ErrorConstructor;
declare const RangeErrorConstructor: RangeErrorConstructor;
declare const ReferenceErrorConstructor: ReferenceErrorConstructor;
declare const RegExpConstructor: RegExpConstructor;
declare const SyntaxErrorConstructor: SyntaxErrorConstructor;
declare const TypeErrorConstructor: TypeErrorConstructor;
export { BigIntOf as BigInt, ErrorConstructor as Error, RangeErrorConstructor as RangeError, ReferenceErrorConstructor as ReferenceError, RegExpConstructor as RegExp, SyntaxErrorConstructor as SyntaxError, TypeErrorConstructor as TypeError, };
/**
 * A data property descriptor that inherits nothing: ToPropertyDescriptor
 * looks up `get` and `set` on the descriptor, prototype chain included.
 */
export declare function dataDescriptor(value: unknown, writable: boolean, enumerable: boolean, configurable: boolean): PropertyDescriptor;
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
/**
 * An array that inherits nothing: reading or writing past its end, which on
 * an ordinary array consults Array.prototype and Object.prototype (where a
 * program may have put accessors), touches only the list. It has no methods.
 */
export declare class SafeList<T> extends Array<T> {
    private readonly safeList;
}
/**
 * The prototype of the interpreter's own generator objects: the generator
 * methods and `[Symbol.iterator]` as own properties, over nothing, so that
 * driving one (next(), and yield*, which looks up both) reaches no method a
 * program replaced on %GeneratorPrototype% or %IteratorPrototype%.
 */
export declare const SafeGeneratorPrototype: object;
/** The same, for the interpreter's own async generators. */
export declare const SafeAsyncGeneratorPrototype: object;
export declare const GeneratorPrototypeNext: unknown;
export declare const GeneratorPrototypeReturn: unknown;
export declare const GeneratorPrototypeThrow: unknown;
/** What Function.prototype.toString answers for `fn`: the source text it was compiled from. */
export declare function registerSource(fn: object, text: string): void;
/**
 * This module's identity: the interpreter checks that the module it loaded
 * is the one the launch loaded at its start, not a second evaluation.
 */
export declare const LAUNCH_PRIMORDIALS: object;
//# sourceMappingURL=primordials.d.ts.map