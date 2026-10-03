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
 * inherits nothing; its constructors' prototypes inherit nothing. A method
 * here refuses a receiver acorn does not call it on rather than reach the
 * realm (tests/unit/interpreter-primordials.mjs checks the rewritten parser
 * for any other reach, tests/unit/interpreter-parser-realm.mjs runs it in a
 * realm whose built-ins all log their use).
 */
import * as primordials from './primordials.js';

const reflectApply = primordials.reflectApply;
const reflectGetPrototypeOf = primordials.reflectGetPrototypeOf;
const reflectSetPrototypeOf = primordials.reflectSetPrototypeOf;
const reflectDefineProperty = primordials.reflectDefineProperty;
const reflectSet = primordials.reflectSet;
const objectAssign = primordials.objectAssign;
const arrayIsArray = primordials.arrayIsArray;
const dataDescriptor = primordials.dataDescriptor;
const StringPrototypeCharAt = primordials.StringPrototypeCharAt;
const StringPrototypeCharCodeAt = primordials.StringPrototypeCharCodeAt;
const StringPrototypeIndexOf = primordials.StringPrototypeIndexOf;
const StringPrototypeLastIndexOf = primordials.StringPrototypeLastIndexOf;
const StringPrototypeSlice = primordials.StringPrototypeSlice;
const StringPrototypeSubstr = primordials.StringPrototypeSubstr;
const ArrayPrototypePop = primordials.ArrayPrototypePop;
const ArrayPrototypeIndexOf = primordials.ArrayPrototypeIndexOf;
const ArrayPrototypeLastIndexOf = primordials.ArrayPrototypeLastIndexOf;
const RegExpPrototypeExec = primordials.RegExpPrototypeExec;
const RegExpPrototypeAccessors = primordials.RegExpPrototypeAccessors;
const RegExpPrototype: object = primordials.RegExp.prototype;
const reflectGet = primordials.reflectGet;
const NumberPrototypeToString = primordials.NumberPrototypeToString;
const BigIntPrototypeToString = primordials.BigIntPrototypeToString;
const SafeList = primordials.SafeList;
type SafeList<T> = primordials.SafeList<T>;
const SafeListPrototype: object = SafeList.prototype;

// ── The built-ins acorn names ──

export const objectCreate = primordials.objectCreate;
export const objectKeys = primordials.objectKeys;
export const objectDefineProperties = primordials.objectDefineProperties;
export const objectHasOwn = primordials.objectHasOwn;
export { arrayIsArray };
export const stringFromCharCode = primordials.StringFromCharCode;
export const symbolIterator = primordials.symbolIterator;
export const String = primordials.stringOf;
export const RegExp = primordials.RegExp;
export const SyntaxError = primordials.SyntaxError;
export const Error = primordials.Error;
export const BigInt = primordials.BigInt;
export const parseInt = primordials.parseIntOf;
export const parseFloat = primordials.parseFloatOf;
export const Symbol = primordials.SymbolConstructor;
/** acorn warns on the console only for a missing ecmaVersion, which the interpreter always gives. */
export const console = undefined;
export const consoleWarn = undefined;
/**
 * What acorn reads of Object.prototype (`hasOwnProperty`, `toString`, for its
 * fallbacks when Object.hasOwn or Array.isArray is missing, which it never
 * calls): the methods as captured.
 */
export const ObjectPrototypeMethods: object = own({
  hasOwnProperty: primordials.ObjectPrototypeHasOwnProperty,
  toString: primordials.ObjectPrototypeToString,
});

function refuse(what: string): never {
  throw new Error(`interpreter: the parser ${what}`);
}

// ── What acorn makes ──

/** An object literal's fields on an object that inherits nothing (made as V8 keeps fast: empty, then filled). */
export function own<T extends object>(fields: T): T {
  const made = {};
  reflectSetPrototypeOf(made, null);
  return objectAssign(made, fields);
}

/** A list literal's elements, as a list that inherits nothing. */
export function list(...items: unknown[]): SafeList<unknown> {
  const made = new SafeList<unknown>();
  for (let i = 0; i < items.length; i++) made[i] = items[i];
  return made;
}

/** A constructor of acorn's own and its instances' prototype, made to inherit nothing before any use. */
export function nullPrototypes(constructor: Function): void {
  reflectSetPrototypeOf(constructor, null);
  reflectSetPrototypeOf(constructor.prototype, null);
}

/** `target[key] = value` on an object made with a realm constructor (an error): defined, so no setter it inherits runs. */
export function define(target: object, key: string, value: unknown): unknown {
  if (!reflectDefineProperty(target, key, dataDescriptor(value, true, true, true))) refuse(`could not set ${key}`);
  return value;
}

// ── The methods acorn calls, by name ──

/** Whether `value` is a list the interpreter or its parser made: only those have SafeList's prototype, which no program can reach. */
function isList(value: unknown): value is SafeList<unknown> {
  return typeof value === 'object' && value !== null && reflectGetPrototypeOf(value) === SafeListPrototype;
}

function text(receiver: unknown, method: string): string {
  return typeof receiver === 'string' ? receiver : refuse(`called ${method} on a ${typeof receiver}`);
}

function aList(receiver: unknown, method: string): SafeList<unknown> {
  return isList(receiver) ? receiver : refuse(`called ${method} on something other than its own list`);
}

export function charCodeAt(receiver: unknown, index: number): number {
  return reflectApply(StringPrototypeCharCodeAt, text(receiver, 'charCodeAt'), [index]);
}

export function charAt(receiver: unknown, index: number): string {
  return reflectApply(StringPrototypeCharAt, text(receiver, 'charAt'), [index]);
}

export function substr(receiver: unknown, start: number, length?: number): string {
  return reflectApply(StringPrototypeSubstr, text(receiver, 'substr'), [start, length]);
}

/** A string's slice, or a new list of a list's elements from `start` to `end` (no species: it is acorn's). */
export function slice(receiver: unknown, start?: number, end?: number): unknown {
  if (typeof receiver === 'string') return reflectApply(StringPrototypeSlice, receiver, [start, end]);
  const from = aList(receiver, 'slice');
  const length = from.length;
  const relative = (index: number | undefined, fallback: number): number => {
    const n = index === undefined ? fallback : index;
    return n < 0 ? (n + length < 0 ? 0 : n + length) : (n > length ? length : n);
  };
  const out = new SafeList<unknown>();
  const last = relative(end, length);
  for (let i = relative(start, 0); i < last; i++) out[out.length] = from[i];
  return out;
}

export function indexOf(receiver: unknown, search: unknown, from?: number): number {
  if (typeof receiver === 'string') return reflectApply(StringPrototypeIndexOf, receiver, [search, from]);
  return reflectApply(ArrayPrototypeIndexOf, aList(receiver, 'indexOf'), [search, from]);
}

export function lastIndexOf(receiver: unknown, search: unknown, from?: number): number {
  if (typeof receiver === 'string') return reflectApply(StringPrototypeLastIndexOf, receiver, [search, from]);
  // For a list, an undefined position is 0, not the end, as an absent one is.
  const list = aList(receiver, 'lastIndexOf');
  return reflectApply(ArrayPrototypeLastIndexOf, list, from === undefined ? [search] : [search, from]);
}

/** Array.prototype.push of one item (the rewrite refuses any other count), onto a list that inherits nothing. */
export function push(receiver: unknown, item: unknown): number {
  const list = aList(receiver, 'push');
  list[list.length] = item;
  return list.length;
}

export function pop(receiver: unknown): unknown {
  return reflectApply(ArrayPrototypePop, aList(receiver, 'pop'), []);
}

/** RegExp.prototype.exec, which reads nothing but the regexp's own lastIndex and internal slots. */
export function exec(receiver: unknown, input: string): RegExpExecArray | null {
  return reflectApply(RegExpPrototypeExec, receiver, [input]);
}

/** RegExp.prototype.test, without its lookup of `exec` on the regexp. */
export function test(receiver: unknown, input: string): boolean {
  return exec(receiver, input) !== null;
}

function accessor(re: unknown, name: string): unknown {
  const get = RegExpPrototypeAccessors[name];
  return typeof get === 'function' ? reflectApply(get, re, []) : refuse(`read RegExp.prototype.${name}`);
}

/** The flags of `re` from its own internal slots, in the order RegExp.prototype.flags gives them (one the engine lacks, never). */
function flagsOf(re: unknown): string {
  const letters: { readonly [name: string]: string } = FLAG_LETTERS;
  let flags = '';
  for (let i = 0; i < FLAG_NAMES.length; i++) {
    const name = FLAG_NAMES[i];
    if (typeof RegExpPrototypeAccessors[name] === 'function' && accessor(re, name) === true) flags += letters[name];
  }
  return flags;
}
const FLAG_NAMES = ['hasIndices', 'global', 'ignoreCase', 'multiline', 'dotAll', 'unicode', 'unicodeSets', 'sticky'] as const;
const FLAG_LETTERS = own({ hasIndices: 'd', global: 'g', ignoreCase: 'i', multiline: 'm', dotAll: 's', unicode: 'u', unicodeSets: 'v', sticky: 'y' });

/**
 * Each match of `re` in `input` in turn, by exec from a lastIndex of 0: `re`
 * itself when it is global, as String.prototype.replace searches with it
 * (leaving its lastIndex 0), and otherwise a global copy, as split searches
 * with a copy and leaves `re` as it was.
 */
function eachMatch(input: string, re: unknown, visit: (match: RegExpExecArray) => void): void {
  if (typeof re !== 'object' || re === null) refuse(`searched by a ${typeof re}`);
  let search = re;
  if (accessor(re, 'global') === true) {
    reflectSet(re, 'lastIndex', 0);
  } else {
    const source = accessor(re, 'source');
    search = new RegExp(typeof source === 'string' ? source : '', `${flagsOf(re)}g`);
  }
  for (;;) {
    const match = exec(search, input);
    if (match === null) return;
    // acorn's patterns never match empty text, which a global search would have to step past.
    if (match[0].length === 0) refuse('matched empty text');
    visit(match);
  }
}

/** String.prototype.replace of each match (or the first, without `g`) by a string with no `$` patterns. */
export function replace(receiver: unknown, re: unknown, replacement: unknown): string {
  const input = text(receiver, 'replace');
  if (typeof replacement !== 'string' || reflectApply(StringPrototypeIndexOf, replacement, ['$']) >= 0) refuse('replaced by a pattern');
  if (accessor(re, 'global') !== true) {
    const first = exec(re, input);
    if (first === null) return input;
    return reflectApply(StringPrototypeSlice, input, [0, first.index]) + replacement
      + reflectApply(StringPrototypeSlice, input, [first.index + first[0].length]);
  }
  let out = '';
  let at = 0;
  eachMatch(input, re, (match) => {
    out += reflectApply(StringPrototypeSlice, input, [at, match.index]) + replacement;
    at = match.index + match[0].length;
  });
  return out + reflectApply(StringPrototypeSlice, input, [at]);
}

/** String.prototype.split by a regexp: the text between matches, and each match's captures. */
export function split(receiver: unknown, re: unknown): SafeList<unknown> {
  const input = text(receiver, 'split');
  const out = new SafeList<unknown>();
  let at = 0;
  eachMatch(input, re, (match) => {
    out[out.length] = reflectApply(StringPrototypeSlice, input, [at, match.index]);
    for (let i = 1; i < match.length; i++) out[out.length] = match[i];
    at = match.index + match[0].length;
  });
  out[out.length] = reflectApply(StringPrototypeSlice, input, [at]);
  return out;
}

/** String.prototype.match by a regexp without `g`: its exec. */
export function match(receiver: unknown, re: unknown): RegExpExecArray | null {
  const input = text(receiver, 'match');
  if (accessor(re, 'global') === true) refuse('matched with a global regexp');
  return exec(re, input);
}

/** Function.prototype.call, of a function of acorn's own. */
export function call(receiver: unknown, thisArg: unknown, ...args: unknown[]): unknown {
  return typeof receiver === 'function' ? reflectApply(receiver, thisArg, args) : refuse(`called call on a ${typeof receiver}`);
}

/** A number's or bigint's toString. */
export function toString(receiver: unknown, radix?: number): string {
  if (typeof receiver === 'bigint') return reflectApply(BigIntPrototypeToString, receiver, [radix]);
  if (typeof receiver === 'number') return reflectApply(NumberPrototypeToString, receiver, [radix]);
  return refuse(`called toString on a ${typeof receiver}`);
}

/**
 * `receiver[key]`: a string's character, or undefined past its end, where a
 * string would look further, through String.prototype; any other object's
 * property (acorn's objects and lists inherit nothing).
 */
export function index(receiver: unknown, key: unknown): unknown {
  if (typeof receiver === 'string') {
    if (key === 'length') return receiver.length;
    return typeof key === 'number' && key >= 0 && key < receiver.length && key % 1 === 0
      ? reflectApply(StringPrototypeCharAt, receiver, [key]) : undefined;
  }
  if (typeof receiver !== 'object' || receiver === null || (typeof key !== 'string' && typeof key !== 'number')) {
    return refuse(`indexed a ${typeof receiver} by a ${typeof key}`);
  }
  return reflectGet(receiver, key);
}

/** Whether `value` is a regexp acorn made: one with the prototype regexps are made with, which no program can change on it. */
export function isRegExp(value: unknown): boolean {
  return typeof value === 'object' && value !== null && reflectGetPrototypeOf(value) === RegExpPrototype;
}

/**
 * `receiver.name` for a name a regexp answers through RegExp.prototype
 * (`source`, `flags`, `test`): a regexp's accessor, from its own slots (a
 * method of one is refused); any other object's field.
 */
export function field(receiver: unknown, name: string): unknown {
  if (typeof receiver !== 'object' || receiver === null) return refuse(`read ${name} of a ${typeof receiver}`);
  return isRegExp(receiver) ? accessor(receiver, name) : reflectGet(receiver, name);
}
