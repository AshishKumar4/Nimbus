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
 */
import type { AnyNode } from 'acorn';
import { Error, append, arrayIsArray, charCodeAt, newSafeList, objectFreeze, objectKeys, reflectGet, reflectSetPrototypeOf } from './intrinsics.js';

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

function copyNode(source: unknown): Fields {
  if (typeof source !== 'object' || source === null || arrayIsArray(source)) refuse('a node that is not an object');
  const copy = copyObject(source);
  if (copy.type === undefined) refuse('a node without a type');
  return copy;
}

/** A frozen copy of a node or a record, each field read once. */
function copyObject(source: object): Fields {
  const keys = objectKeys(source);
  // Made to inherit nothing before it has a field, so no field is looked up or set through a
  // prototype. Not Object.create(null): V8 keeps those in dictionary mode, and the analysis and the
  // compiler read every node many times.
  const copy: { [key: string]: unknown } = {};
  reflectSetPrototypeOf(copy, null);
  let primitives = true;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value: unknown = reflectGet(source, key);
    if (typeof value === 'function') refuse(`a function as ${key}`);
    if (typeof value !== 'object' || value === null) {
      copy[key] = value;
    } else {
      copy[key] = arrayIsArray(value) ? copyList(value) : copyObject(value);
      primitives = false;
    }
  }
  const type = copy.type;
  if (type === undefined) {
    // A record: a template element's { raw, cooked }, a literal's { pattern, flags }, or the RegExp
    // acorn made for a literal's `value`, which has no enumerable fields (the compiler uses `regex`).
    if (!primitives) refuse('a record holding an object');
  } else {
    if (typeof type !== 'string' || typeof copy.start !== 'number' || typeof copy.end !== 'number') refuse('a node without a type and offsets');
    if (type === 'Identifier' || type === 'PrivateIdentifier') {
      const name = copy.name;
      if (typeof name !== 'string') refuse(`an ${type} without a name`);
      // The interpreter's own bindings ('%this', '*default*', '#field') have names no identifier can have.
      const first = charCodeAt(name, 0);
      if (type === 'Identifier' && (first === 0x25 || first === 0x2a || first === 0x23)) refuse(`the identifier ${name}`);
    }
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
