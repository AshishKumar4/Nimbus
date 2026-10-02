import { BigInt, Error, append, arrayIsArray, charCodeAt, newSafeList, objectFreeze, objectKeys, reflectGet, reflectSetPrototypeOf, } from './intrinsics.js';
/** The interpreter's copy of the tree at `root`. */
export function ownTree(root) {
    const copy = copyNode(root);
    // acorn's typings describe the copy: the same fields, each with the value acorn's held when read.
    return copy;
}
function refuse(what) {
    throw new Error(`interpreter: the parser produced ${what}`);
}
/** An object made to inherit nothing before it has a field, so that no field is looked up or set through a prototype. */
function bare() {
    // Not Object.create(null): V8 keeps those in dictionary mode, and the analysis and the compiler read
    // every node many times.
    const copy = {};
    reflectSetPrototypeOf(copy, null);
    return copy;
}
/** A frozen copy of a node, each field read once. */
function copyNode(source) {
    if (typeof source !== 'object' || source === null || arrayIsArray(source))
        refuse('a node that is not an object');
    const keys = objectKeys(source);
    const copy = bare();
    // acorn gives an import or export specifier's two names one node when they are the same name.
    let previous = null;
    let previousCopy = null;
    let objectValue = false;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = reflectGet(source, key);
        if (typeof value === 'function')
            refuse(`a function as ${key}`);
        if (typeof value !== 'object' || value === null) {
            copy[key] = value;
            continue;
        }
        // acorn sets a node's type before any other field.
        const type = copy.type;
        if (typeof type !== 'string')
            refuse(`${key} before a node's type`);
        if (type === 'Literal' && key === 'value') {
            copy[key] = null;
            objectValue = true;
        }
        else if ((type === 'TemplateElement' && key === 'value') || (type === 'Literal' && key === 'regex')) {
            copy[key] = copyRecord(value);
        }
        else {
            if (value !== previous) {
                previousCopy = arrayIsArray(value) ? copyList(value) : copyNode(value);
                previous = value;
            }
            copy[key] = previousCopy;
        }
    }
    const type = copy.type;
    if (typeof type !== 'string' || typeof copy.start !== 'number' || typeof copy.end !== 'number')
        refuse('a node without a type and offsets');
    if (type === 'Identifier' || type === 'PrivateIdentifier') {
        const name = copy.name;
        if (typeof name !== 'string')
            refuse(`an ${type} without a name`);
        // The interpreter's own bindings ('%this', '*default*', '#field') have names no identifier can have.
        const first = charCodeAt(name, 0);
        if (type === 'Identifier' && (first === 0x25 || first === 0x2a || first === 0x23))
            refuse(`the identifier ${name}`);
    }
    else if (type === 'Literal') {
        if (typeof copy.bigint === 'string')
            copy.value = BigInt(copy.bigint);
        else if (objectValue && copy.regex === undefined)
            refuse('a literal whose value is an object');
    }
    return objectFreeze(copy);
}
/** A frozen copy of a record of primitives: a template element's { raw, cooked }, a literal's { pattern, flags }. */
function copyRecord(source) {
    const keys = objectKeys(source);
    const copy = bare();
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = reflectGet(source, key);
        if ((typeof value === 'object' && value !== null) || typeof value === 'function')
            refuse(`a record holding an object as ${key}`);
        copy[key] = value;
    }
    return objectFreeze(copy);
}
/** A frozen copy of a list of nodes (null for an elision), which inherits nothing. */
function copyList(source) {
    const length = source.length;
    if (typeof length !== 'number')
        refuse('a list without a length');
    const list = newSafeList();
    for (let i = 0; i < length; i++) {
        const item = reflectGet(source, i);
        append(list, item === null ? null : copyNode(item));
    }
    return objectFreeze(list);
}
