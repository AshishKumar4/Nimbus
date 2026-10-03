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
const reflectApply = primordials.reflectApply;
const reflectConstruct = primordials.reflectConstruct;
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
const reflectGet = primordials.reflectGet;
const NumberPrototypeToString = primordials.NumberPrototypeToString;
const BigIntPrototypeToString = primordials.BigIntPrototypeToString;
const SafeList = primordials.SafeList;
const SafeListPrototype = SafeList.prototype;
// ── The built-ins acorn names ──
export const objectCreate = primordials.objectCreate;
export const objectKeys = primordials.objectKeys;
export const objectDefineProperties = primordials.objectDefineProperties;
export const objectHasOwn = primordials.objectHasOwn;
export { arrayIsArray };
export const stringFromCharCode = primordials.StringFromCharCode;
export const symbolIterator = primordials.symbolIterator;
export const String = primordials.stringOf;
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
export const ObjectPrototypeMethods = own({
    hasOwnProperty: primordials.ObjectPrototypeHasOwnProperty,
    toString: primordials.ObjectPrototypeToString,
});
function refuse(what) {
    throw new Error(`interpreter: the parser ${what}`);
}
// ── What acorn makes ──
/** An object literal's fields on an object that inherits nothing (made as V8 keeps fast: empty, then filled). */
export function own(fields) {
    const made = {};
    reflectSetPrototypeOf(made, null);
    return objectAssign(made, fields);
}
/** A list literal's elements, as a list that inherits nothing. */
export function list(...items) {
    const made = new SafeList();
    for (let i = 0; i < items.length; i++)
        made[i] = items[i];
    return made;
}
/**
 * A regexp acorn makes (a literal, or with RegExp), made to inherit only
 * RegExp.prototype's members as the launch captured them: whatever acorn reads
 * of it or calls on it, by any name, reaches nothing a program replaced.
 */
export function regexp(re) {
    reflectSetPrototypeOf(re, primordials.SafeRegExpPrototype);
    return re;
}
/**
 * The RegExp acorn names, called or constructed, under any name it is held
 * by: a regexp made by the launch's RegExp, made safe as `regexp` makes it.
 */
export function RegExp(pattern, flags) {
    return regexp(reflectConstruct(primordials.RegExp, [pattern, flags]));
}
/** A constructor of acorn's own and its instances' prototype, made to inherit nothing before any use. */
export function nullPrototypes(constructor) {
    reflectSetPrototypeOf(constructor, null);
    reflectSetPrototypeOf(constructor.prototype, null);
}
/** `target[key] = value` on an object made with a realm constructor (an error): defined, so no setter it inherits runs. */
export function define(target, key, value) {
    if (!reflectDefineProperty(target, key, dataDescriptor(value, true, true, true)))
        refuse(`could not set ${key}`);
    return value;
}
// ── The methods acorn calls, by name ──
/** Whether `value` is a list the interpreter or its parser made: only those have SafeList's prototype, which no program can reach. */
function isList(value) {
    return typeof value === 'object' && value !== null && reflectGetPrototypeOf(value) === SafeListPrototype;
}
function text(receiver, method) {
    return typeof receiver === 'string' ? receiver : refuse(`called ${method} on a ${typeof receiver}`);
}
function aList(receiver, method) {
    return isList(receiver) ? receiver : refuse(`called ${method} on something other than its own list`);
}
export function charCodeAt(receiver, index) {
    return reflectApply(StringPrototypeCharCodeAt, text(receiver, 'charCodeAt'), [index]);
}
export function charAt(receiver, index) {
    return reflectApply(StringPrototypeCharAt, text(receiver, 'charAt'), [index]);
}
export function substr(receiver, start, length) {
    return reflectApply(StringPrototypeSubstr, text(receiver, 'substr'), [start, length]);
}
/** A string's slice, or a new list of a list's elements from `start` to `end` (no species: it is acorn's). */
export function slice(receiver, start, end) {
    if (typeof receiver === 'string')
        return reflectApply(StringPrototypeSlice, receiver, [start, end]);
    const from = aList(receiver, 'slice');
    const length = from.length;
    const relative = (index, fallback) => {
        const n = index === undefined ? fallback : index;
        return n < 0 ? (n + length < 0 ? 0 : n + length) : (n > length ? length : n);
    };
    const out = new SafeList();
    const last = relative(end, length);
    for (let i = relative(start, 0); i < last; i++)
        out[out.length] = from[i];
    return out;
}
export function indexOf(receiver, search, from) {
    if (typeof receiver === 'string')
        return reflectApply(StringPrototypeIndexOf, receiver, [search, from]);
    return reflectApply(ArrayPrototypeIndexOf, aList(receiver, 'indexOf'), [search, from]);
}
export function lastIndexOf(receiver, search, from) {
    if (typeof receiver === 'string')
        return reflectApply(StringPrototypeLastIndexOf, receiver, [search, from]);
    // For a list, an undefined position is 0, not the end, as an absent one is.
    const list = aList(receiver, 'lastIndexOf');
    return reflectApply(ArrayPrototypeLastIndexOf, list, from === undefined ? [search] : [search, from]);
}
/** Array.prototype.push of one item (the rewrite refuses any other count), onto a list that inherits nothing. */
export function push(receiver, item) {
    const list = aList(receiver, 'push');
    list[list.length] = item;
    return list.length;
}
export function pop(receiver) {
    return reflectApply(ArrayPrototypePop, aList(receiver, 'pop'), []);
}
/** RegExp.prototype.exec, which reads nothing but the regexp's own lastIndex and internal slots. */
export function exec(receiver, input) {
    return reflectApply(RegExpPrototypeExec, receiver, [input]);
}
/** RegExp.prototype.test, without its lookup of `exec` on the regexp. */
export function test(receiver, input) {
    return exec(receiver, input) !== null;
}
function accessor(re, name) {
    const get = RegExpPrototypeAccessors[name];
    return typeof get === 'function' ? reflectApply(get, re, []) : refuse(`read RegExp.prototype.${name}`);
}
/** The flags of `re` from its own internal slots, in the order RegExp.prototype.flags gives them (one the engine lacks, never). */
function flagsOf(re) {
    const letters = FLAG_LETTERS;
    let flags = '';
    for (let i = 0; i < FLAG_NAMES.length; i++) {
        const name = FLAG_NAMES[i];
        if (typeof RegExpPrototypeAccessors[name] === 'function' && accessor(re, name) === true)
            flags += letters[name];
    }
    return flags;
}
const FLAG_NAMES = ['hasIndices', 'global', 'ignoreCase', 'multiline', 'dotAll', 'unicode', 'unicodeSets', 'sticky'];
const FLAG_LETTERS = own({ hasIndices: 'd', global: 'g', ignoreCase: 'i', multiline: 'm', dotAll: 's', unicode: 'u', unicodeSets: 'v', sticky: 'y' });
/**
 * Each match of `re` in `input` in turn, by exec from a lastIndex of 0: `re`
 * itself when it is global, as String.prototype.replace searches with it
 * (leaving its lastIndex 0), and otherwise a global copy, as split searches
 * with a copy and leaves `re` as it was.
 */
function eachMatch(input, re, visit) {
    if (typeof re !== 'object' || re === null)
        refuse(`searched by a ${typeof re}`);
    let search = re;
    if (accessor(re, 'global') === true) {
        reflectSet(re, 'lastIndex', 0);
    }
    else {
        const source = accessor(re, 'source');
        search = RegExp(typeof source === 'string' ? source : '', `${flagsOf(re)}g`);
    }
    for (;;) {
        const match = exec(search, input);
        if (match === null)
            return;
        // acorn's patterns never match empty text, which a global search would have to step past.
        if (match[0].length === 0)
            refuse('matched empty text');
        visit(match);
    }
}
/** String.prototype.replace of each match (or the first, without `g`) by a string with no `$` patterns. */
export function replace(receiver, re, replacement) {
    const input = text(receiver, 'replace');
    if (typeof replacement !== 'string' || reflectApply(StringPrototypeIndexOf, replacement, ['$']) >= 0)
        refuse('replaced by a pattern');
    if (accessor(re, 'global') !== true) {
        const first = exec(re, input);
        if (first === null)
            return input;
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
export function split(receiver, re) {
    const input = text(receiver, 'split');
    const out = new SafeList();
    let at = 0;
    eachMatch(input, re, (match) => {
        out[out.length] = reflectApply(StringPrototypeSlice, input, [at, match.index]);
        for (let i = 1; i < match.length; i++)
            out[out.length] = match[i];
        at = match.index + match[0].length;
    });
    out[out.length] = reflectApply(StringPrototypeSlice, input, [at]);
    return out;
}
/** String.prototype.match by a regexp without `g`: its exec. */
export function match(receiver, re) {
    const input = text(receiver, 'match');
    if (accessor(re, 'global') === true)
        refuse('matched with a global regexp');
    return exec(re, input);
}
/** Function.prototype.call, of a function of acorn's own. */
export function call(receiver, thisArg, ...args) {
    return typeof receiver === 'function' ? reflectApply(receiver, thisArg, args) : refuse(`called call on a ${typeof receiver}`);
}
/** A number's or bigint's toString. */
export function toString(receiver, radix) {
    if (typeof receiver === 'bigint')
        return reflectApply(BigIntPrototypeToString, receiver, [radix]);
    if (typeof receiver === 'number')
        return reflectApply(NumberPrototypeToString, receiver, [radix]);
    return refuse(`called toString on a ${typeof receiver}`);
}
/**
 * `receiver[key]`: a string's character, or undefined past its end, where a
 * string would look further, through String.prototype; any other object's
 * property (acorn's objects and lists inherit nothing, its regexps only
 * captured members).
 */
export function index(receiver, key) {
    if (typeof receiver === 'string') {
        if (key === 'length')
            return receiver.length;
        return typeof key === 'number' && key >= 0 && key < receiver.length && key % 1 === 0
            ? reflectApply(StringPrototypeCharAt, receiver, [key]) : undefined;
    }
    if (typeof receiver !== 'object' || receiver === null || (typeof key !== 'string' && typeof key !== 'number')) {
        return refuse(`indexed a ${typeof receiver} by a ${typeof key}`);
    }
    return reflectGet(receiver, key);
}
