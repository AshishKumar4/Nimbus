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
export declare const StringPrototypeCharAt: (pos: number) => string;
export declare const StringPrototypeIndexOf: (searchString: string, position?: number) => number;
export declare const StringPrototypeSubstr: (from: number, length?: number) => string;
export declare const StringFromCharCode: (...codes: number[]) => string;
export declare const ArrayPrototypePop: () => any;
export declare const ArrayPrototypeIndexOf: (searchElement: any, fromIndex?: number) => number;
export declare const ArrayPrototypeLastIndexOf: (searchElement: any, fromIndex?: number) => number;
export declare const RegExpPrototypeExec: (string: string) => RegExpExecArray | null;
/** RegExp.prototype's accessors (source, global, unicode, ...), each reading the regexp's own internal slots. */
export declare const RegExpPrototypeAccessors: {
    readonly [name: string]: unknown;
};
export declare const NumberPrototypeToString: (radix?: number) => string;
export declare const BigIntPrototypeToString: (radix?: number) => string;
export declare const ObjectPrototype: object;
export declare const ObjectPrototypeHasOwnProperty: (v: PropertyKey) => boolean;
export declare const ObjectPrototypeToString: () => string;
export declare const objectDefineProperties: <T>(o: T, properties: PropertyDescriptorMap & ThisType<any>) => T;
export declare const parseIntOf: typeof parseInt;
export declare const parseFloatOf: typeof parseFloat;
export declare const SymbolConstructor: SymbolConstructor;
export declare const SymbolPrototypeDescription: unknown;
export declare const globalObject: typeof globalThis;
export declare const JSONParse: (text: string, reviver?: (this: any, key: string, value: any) => any) => any;
export declare const JSONStringify: {
    (value: any, replacer?: (this: any, key: string, value: any) => any, space?: string | number): string;
    (value: any, replacer?: (number | string)[] | null, space?: string | number): string;
};
export declare const decodeURIComponentOf: typeof decodeURIComponent;
export declare const encodeURIComponentOf: typeof encodeURIComponent;
export declare const NumberOf: NumberConstructor;
export declare const numberIsInteger: (number: unknown) => boolean;
export declare const objectIs: (value1: any, value2: any) => boolean;
export declare const objectIsExtensible: (o: any) => boolean;
export declare const mathAbs: (x: number) => number;
export declare const mathMin: (...values: number[]) => number;
export declare function captureStackTraceOf(): unknown;
/** The runtime's own Error.captureStackTrace, installed before any program code (commonjs-cell). */
export declare function useCaptureStackTrace(capture: Function): void;
declare const BigIntOf: BigIntConstructor;
declare const ErrorConstructor: ErrorConstructor;
declare const RangeErrorConstructor: RangeErrorConstructor;
declare const ReferenceErrorConstructor: ReferenceErrorConstructor;
declare const RegExpConstructor: RegExpConstructor;
declare const SyntaxErrorConstructor: SyntaxErrorConstructor;
declare const TypeErrorConstructor: TypeErrorConstructor;
declare const URIErrorConstructor: URIErrorConstructor;
declare const URLConstructor: typeof URL | undefined;
export { BigIntOf as BigInt, ErrorConstructor as Error, RangeErrorConstructor as RangeError, ReferenceErrorConstructor as ReferenceError, RegExpConstructor as RegExp, SyntaxErrorConstructor as SyntaxError, TypeErrorConstructor as TypeError, URIErrorConstructor as URIError, URLConstructor as URL, };
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
/**
 * The prototype of the parser's regexps (parser-realm.ts): RegExp.prototype's
 * members as own properties, over nothing, so that what a regexp is asked
 * (its source, its flags, test, whose own reads of `exec` and of each flag
 * look here too) reaches no member a program replaced on RegExp.prototype.
 * Not `constructor`, nor @@split or @@matchAll, which search with a new
 * regexp of the realm's own (its species), whose `exec` is the realm's.
 */
export declare const SafeRegExpPrototype: object;
export declare const GeneratorPrototypeNext: unknown;
export declare const GeneratorPrototypeReturn: unknown;
export declare const GeneratorPrototypeThrow: unknown;
export declare const FunctionPrototypeBind: (this: Function, thisArg: any, ...argArray: any[]) => any;
export declare const stringCharCodeAt: (text: string, index: number) => number;
export declare const stringSlice: (text: string, start?: number, end?: number) => string;
export declare const stringLastIndexOf: (text: string, search: string, position?: number) => number;
export declare const arrayJoin: (list: readonly string[], separator: string) => string;
export declare const stringStartsWith: (text: string, search: string, position?: number) => boolean;
export declare const stringEndsWith: (text: string, search: string) => boolean;
export declare const stringIncludes: (text: string, search: string) => boolean;
export declare const stringIndexOf: (text: string, search: string, position?: number) => number;
export declare const stringToLowerCase: (text: string) => string;
export declare const arrayIncludes: <T>(list: readonly T[], value: T) => boolean;
export declare const arrayIndexOf: <T>(list: readonly T[], value: T) => number;
export declare const setForEach: <T>(set: ReadonlySet<T>, each: (value: T) => void) => void;
/** Array.prototype.sort of a SafeList, which inherits nothing it could read or write past its end. */
export declare const arraySort: <T>(list: SafeList<T>, compare: (a: T, b: T) => number) => SafeList<T>;
/** RegExp.prototype.exec: RegExpBuiltinExec, which reads the regexp's own lastIndex and its flags' internal slots. */
export declare const regExpExec: (pattern: RegExp, text: string) => RegExpExecArray | null;
export declare const generatorNext: <R>(it: Generator<unknown, R, unknown>, value?: unknown) => IteratorResult<unknown, R>;
export declare const generatorThrow: <R>(it: Generator<unknown, R, unknown>, error: unknown) => IteratorResult<unknown, R>;
/** `new URL(input, base)` with the realm's URL. */
export declare function newURL(input: string, base?: string | URL): URL;
/**
 * `fn`, a generator function of the runtime's own, made to create
 * generators that inherit SafeGeneratorPrototype: next(), and yield*,
 * which looks up the inner generator's [Symbol.iterator] and next, reach
 * no method a program replaced on %GeneratorPrototype%.
 */
export declare function safeGenerator<A extends unknown[], R>(fn: (...args: A) => Generator<unknown, R, unknown>): (...args: A) => Generator<unknown, R, unknown>;
/** `object`'s own `key`, or undefined: a parsed package.json's field, which Node's reader takes only as the file has it (no inherited one). */
export declare function ownField(object: object, key: string): unknown;
/** Map.prototype.get of a Map the glue did not make (the launch's tables on globalThis). */
export declare const mapGet: <K, V>(map: Map<K, V>, key: K) => V | undefined;
export declare const MapConstructor: MapConstructor;
export declare const objectPreventExtensions: <T>(o: T) => T;
export declare const symbolToStringTag: typeof Symbol.toStringTag;
export declare const objectDefineProperty: <T>(o: T, p: PropertyKey, attributes: PropertyDescriptor & ThisType<any>) => T;
export declare const arrayPush: <T>(list: T[], ...items: T[]) => number;
export declare const arraySplice: <T>(list: T[], start: number, deleteCount: number) => T[];
export declare const ObjectPrototypePropertyIsEnumerableOf: (object: object, key: PropertyKey) => boolean;
//# sourceMappingURL=primordials.d.ts.map