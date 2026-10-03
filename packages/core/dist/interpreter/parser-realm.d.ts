/**
 * parser-realm.ts — what acorn reaches of the realm, as the interpreter
 * bundles it.
 *
 * acorn is a parser written in JavaScript: as published, it calls the realm's
 * built-ins (Array.prototype.push for every list it builds, String.prototype
 * methods on the text, RegExp.prototype.test) and its objects inherit from
 * Object.prototype and Array.prototype. A program shares that realm and may
 * have replaced any of them by the time the interpreter parses its code, so
 * the replacement would see the code being parsed and could change it: rename
 * an identifier to a binding the program cannot reach, drop a statement.
 * Natively, V8's parser reaches nothing a program can change.
 *
 * So the interpreter bundles acorn rewritten by its syntax tree
 * (worker scripts/acorn-primordials.mjs): every built-in it names is one of
 * these, as primordials.ts captured it at the launch's start; every method it
 * calls on a string, list, regular expression or function goes through the
 * function here of the method's name; every object and list it makes
 * inherits nothing, every regexp only RegExp.prototype's captured members;
 * its constructors' prototypes inherit nothing. A method
 * here refuses a receiver acorn does not call it on rather than reach the
 * realm (tests/unit/interpreter-primordials.mjs checks the rewritten parser
 * for any other reach, tests/unit/interpreter-parser-realm.mjs runs it in a
 * realm whose built-ins all log their use).
 */
import * as primordials from './primordials.js';
declare const arrayIsArray: (arg: any) => arg is any[];
declare const SafeList: typeof primordials.SafeList;
type SafeList<T> = primordials.SafeList<T>;
export declare const objectCreate: {
    (o: object | null): any;
    (o: object | null, properties: PropertyDescriptorMap & ThisType<any>): any;
};
export declare const objectKeys: {
    (o: object): string[];
    (o: {}): string[];
};
export declare const objectDefineProperties: <T>(o: T, properties: PropertyDescriptorMap & ThisType<any>) => T;
export declare const objectHasOwn: (o: object, v: PropertyKey) => boolean;
export { arrayIsArray };
export declare const stringFromCharCode: (...codes: number[]) => string;
export declare const symbolIterator: symbol;
export declare const String: StringConstructor;
export declare const RegExp: RegExpConstructor;
export declare const SyntaxError: SyntaxErrorConstructor;
export declare const Error: ErrorConstructor;
export declare const BigInt: BigIntConstructor;
export declare const parseInt: typeof globalThis.parseInt;
export declare const parseFloat: typeof globalThis.parseFloat;
export declare const Symbol: SymbolConstructor;
/** acorn warns on the console only for a missing ecmaVersion, which the interpreter always gives. */
export declare const console: undefined;
export declare const consoleWarn: undefined;
/**
 * What acorn reads of Object.prototype (`hasOwnProperty`, `toString`, for its
 * fallbacks when Object.hasOwn or Array.isArray is missing, which it never
 * calls): the methods as captured.
 */
export declare const ObjectPrototypeMethods: object;
/** An object literal's fields on an object that inherits nothing (made as V8 keeps fast: empty, then filled). */
export declare function own<T extends object>(fields: T): T;
/** A list literal's elements, as a list that inherits nothing. */
export declare function list(...items: unknown[]): SafeList<unknown>;
/**
 * A regexp acorn makes (a literal, or with RegExp), made to inherit only
 * RegExp.prototype's members as the launch captured them: whatever acorn reads
 * of it or calls on it, by any name, reaches nothing a program replaced.
 */
export declare function regexp<T extends object>(re: T): T;
/** A constructor of acorn's own and its instances' prototype, made to inherit nothing before any use. */
export declare function nullPrototypes(constructor: Function): void;
/** `target[key] = value` on an object made with a realm constructor (an error): defined, so no setter it inherits runs. */
export declare function define(target: object, key: string, value: unknown): unknown;
export declare function charCodeAt(receiver: unknown, index: number): number;
export declare function charAt(receiver: unknown, index: number): string;
export declare function substr(receiver: unknown, start: number, length?: number): string;
/** A string's slice, or a new list of a list's elements from `start` to `end` (no species: it is acorn's). */
export declare function slice(receiver: unknown, start?: number, end?: number): unknown;
export declare function indexOf(receiver: unknown, search: unknown, from?: number): number;
export declare function lastIndexOf(receiver: unknown, search: unknown, from?: number): number;
/** Array.prototype.push of one item (the rewrite refuses any other count), onto a list that inherits nothing. */
export declare function push(receiver: unknown, item: unknown): number;
export declare function pop(receiver: unknown): unknown;
/** RegExp.prototype.exec, which reads nothing but the regexp's own lastIndex and internal slots. */
export declare function exec(receiver: unknown, input: string): RegExpExecArray | null;
/** RegExp.prototype.test, without its lookup of `exec` on the regexp. */
export declare function test(receiver: unknown, input: string): boolean;
/** String.prototype.replace of each match (or the first, without `g`) by a string with no `$` patterns. */
export declare function replace(receiver: unknown, re: unknown, replacement: unknown): string;
/** String.prototype.split by a regexp: the text between matches, and each match's captures. */
export declare function split(receiver: unknown, re: unknown): SafeList<unknown>;
/** String.prototype.match by a regexp without `g`: its exec. */
export declare function match(receiver: unknown, re: unknown): RegExpExecArray | null;
/** Function.prototype.call, of a function of acorn's own. */
export declare function call(receiver: unknown, thisArg: unknown, ...args: unknown[]): unknown;
/** A number's or bigint's toString. */
export declare function toString(receiver: unknown, radix?: number): string;
/**
 * `receiver[key]`: a string's character, or undefined past its end, where a
 * string would look further, through String.prototype; any other object's
 * property (acorn's objects and lists inherit nothing, its regexps only
 * captured members).
 */
export declare function index(receiver: unknown, key: unknown): unknown;
//# sourceMappingURL=parser-realm.d.ts.map