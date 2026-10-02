import { Error, append, arrayIsArray, charCodeAt, newSafeList, objectFreeze, objectKeys, reflectGet, reflectSetPrototypeOf } from './intrinsics.js';
/** The interpreter's copy of the tree at `root`. */
export function ownTree(root) {
    const copy = copyNode(root);
    // acorn's typings describe the copy: the same fields, each with the value acorn's held when read.
    return copy;
}
function refuse(what) {
    throw new Error(`interpreter: the parser produced ${what}`);
}
function copyNode(source) {
    if (typeof source !== 'object' || source === null || arrayIsArray(source))
        refuse('a node that is not an object');
    const copy = copyObject(source);
    if (copy.type === undefined)
        refuse('a node without a type');
    return copy;
}
/** A frozen copy of a node or a record, each field read once. */
function copyObject(source) {
    const keys = objectKeys(source);
    // Made to inherit nothing before it has a field, so no field is looked up or set through a
    // prototype. Not Object.create(null): V8 keeps those in dictionary mode, and the analysis and the
    // compiler read every node many times.
    const copy = {};
    reflectSetPrototypeOf(copy, null);
    let primitives = true;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = reflectGet(source, key);
        if (typeof value === 'function')
            refuse(`a function as ${key}`);
        if (typeof value !== 'object' || value === null) {
            copy[key] = value;
        }
        else {
            copy[key] = arrayIsArray(value) ? copyList(value) : copyObject(value);
            primitives = false;
        }
    }
    const type = copy.type;
    if (type === undefined) {
        // A record: a template element's { raw, cooked }, a literal's { pattern, flags }, or the RegExp
        // acorn made for a literal's `value`, which has no enumerable fields (the compiler uses `regex`).
        if (!primitives)
            refuse('a record holding an object');
    }
    else {
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
