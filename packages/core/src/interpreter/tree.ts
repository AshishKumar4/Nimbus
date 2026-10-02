/**
 * tree.ts — the interpreter's own copy of the tree acorn parses.
 *
 * acorn builds its tree with the realm's built-ins: each node it makes is
 * pushed onto an array with Array.prototype.push. By the time the
 * interpreter parses, a program may have replaced that (the interpreter
 * loads on the first code a launch did not compile), and the replacement
 * receives acorn's nodes as they are built. It can make a field an accessor
 * that answers each read differently: an identifier's name that passes the
 * check refusing the interpreter's own binding names, then names one of them
 * when read again to be resolved. The analysis and the compiler read a node's
 * fields many times, so they read only this copy (Owned): each field of
 * acorn's tree is read here exactly once, and kept as a primitive, a node of
 * the copy, a list of those, or a record of primitives (a template element's
 * `value`, a regular expression literal's `regex`). Every object of the copy
 * is frozen and inherits nothing, and no program code ever receives one.
 *
 * A literal's `value` is the one object acorn makes with a built-in a program
 * can replace (a RegExp, or a bigint through BigInt), so it is not copied: a
 * regular expression's is null (the compiler builds one from `regex` each
 * time it runs), and a bigint's is made again from its `bigint` text.
 */
import type { AnyNode } from 'acorn';
import {
  BigInt, Error, append, arrayIsArray, charCodeAt, newSafeList, objectFreeze, objectKeys, reflectGet, reflectSetPrototypeOf,
} from './intrinsics.js';

declare const owned: unique symbol;
/** A node of a tree ownTree made: what the analysis takes. Its descendants are owned too. */
export type Owned<T extends AnyNode> = T & { readonly [owned]: true };

/** The fields of a node or record of the copy. */
type Fields = { readonly [key: string]: unknown };

/** The interpreter's copy of the tree at `root`. */
export function ownTree<T extends AnyNode>(root: T): Owned<T> {
  const copy = copyNode(root);
  // acorn's typings describe the copy: the same fields, each with the value acorn's held when read.
  return copy as unknown as Owned<T>;
}

function refuse(what: string): never {
  throw new Error(`interpreter: the parser produced ${what}`);
}

/** An object made to inherit nothing before it has a field, so that no field is looked up or set through a prototype. */
function bare(): { [key: string]: unknown } {
  // Not Object.create(null): V8 keeps those in dictionary mode, and the analysis and the compiler read
  // every node many times.
  const copy: { [key: string]: unknown } = {};
  reflectSetPrototypeOf(copy, null);
  return copy;
}

/** A frozen copy of a node, each field read once. */
function copyNode(source: unknown): Fields {
  if (typeof source !== 'object' || source === null || arrayIsArray(source)) refuse('a node that is not an object');
  const keys = objectKeys(source);
  const copy = bare();
  // acorn gives an import or export specifier's two names one node when they are the same name.
  let previous: object | null = null;
  let previousCopy: unknown = null;
  let objectValue = false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value: unknown = reflectGet(source, key);
    if (typeof value === 'function') refuse(`a function as ${key}`);
    if (typeof value !== 'object' || value === null) {
      copy[key] = value;
      continue;
    }
    // acorn sets a node's type before any other field.
    const type = copy.type;
    if (typeof type !== 'string') refuse(`${key} before a node's type`);
    if (type === 'Literal' && key === 'value') {
      copy[key] = null;
      objectValue = true;
    } else if ((type === 'TemplateElement' && key === 'value') || (type === 'Literal' && key === 'regex')) {
      copy[key] = copyRecord(value);
    } else {
      if (value !== previous) {
        previousCopy = arrayIsArray(value) ? copyList(value) : copyNode(value);
        previous = value;
      }
      copy[key] = previousCopy;
    }
  }
  const type = copy.type;
  if (typeof type !== 'string' || typeof copy.start !== 'number' || typeof copy.end !== 'number') refuse('a node without a type and offsets');
  if (type === 'Identifier' || type === 'PrivateIdentifier') {
    const name = copy.name;
    if (typeof name !== 'string') refuse(`an ${type} without a name`);
    // The interpreter's own bindings ('%this', '*default*', '#field') have names no identifier can have.
    const first = charCodeAt(name, 0);
    if (type === 'Identifier' && (first === 0x25 || first === 0x2a || first === 0x23)) refuse(`the identifier ${name}`);
  } else if (type === 'Literal') {
    if (typeof copy.bigint === 'string') copy.value = BigInt(copy.bigint);
    else if (objectValue && copy.regex === undefined) refuse('a literal whose value is an object');
  }
  return objectFreeze(copy);
}

/** A frozen copy of a record of primitives: a template element's { raw, cooked }, a literal's { pattern, flags }. */
function copyRecord(source: object): Fields {
  const keys = objectKeys(source);
  const copy = bare();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value: unknown = reflectGet(source, key);
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') refuse(`a record holding an object as ${key}`);
    copy[key] = value;
  }
  return objectFreeze(copy);
}

/** A frozen copy of a list of nodes (null for an elision), which inherits nothing. */
function copyList(source: readonly unknown[]): readonly (Fields | null)[] {
  const length: unknown = source.length;
  if (typeof length !== 'number') refuse('a list without a length');
  const list = newSafeList<Fields | null>();
  for (let i = 0; i < length; i++) {
    const item: unknown = reflectGet(source, i);
    append(list, item === null ? null : copyNode(item));
  }
  return objectFreeze(list);
}
