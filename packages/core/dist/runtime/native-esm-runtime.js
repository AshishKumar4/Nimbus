/**
 * native-esm-runtime.ts — what a program's loader does with a staged ES
 * module (native-esm.ts) while the program runs: place a frame in its
 * source, and shape what require() of it returns. One implementation for
 * both loaders: lifo's imports it, and the worker's guest embeds it compiled
 * (scripts/compile-facet-bodies.mjs; commonjs-cell.ts frames, node-shims'
 * require(esm)).
 */
/**
 * A 1-based column of a staged module's line as its source has it, from
 * where the engine places it in the staged text (a first line's past the
 * head): `edits` are the line's ColumnMap entries, in order.
 */
export function sourceColumn(edits, column) {
    if (edits === undefined)
        return column;
    let delta = 0;
    // By index, not the array iterator: a stack is formatted after the program may have replaced it.
    for (let i = 0; i < edits.length; i++) {
        const at = edits[i][1], length = edits[i][2], text = edits[i][3], call = edits[i][4];
        const start = at + delta;
        if (column - 1 < start)
            break;
        if (column - 1 < start + length || (call === 1 && column - 1 === start + length))
            return at + 1;
        delta += length - text.length;
    }
    return column - delta;
}
/**
 * Node's require(esm) result (lib/internal/modules/cjs/loader.js
 * loadESMFromCJS): the module's "module.exports" export, else its namespace
 * when it has no default export or exports __esModule itself, else one
 * facade of it per module.
 */
export function requiredEsModule(record) {
    const { namespace } = record;
    if (Object.hasOwn(namespace, 'module.exports'))
        return Reflect.get(namespace, 'module.exports');
    if (!Object.hasOwn(namespace, 'default') || Object.hasOwn(namespace, '__esModule'))
        return namespace;
    return record.required ??= namespaceFacade(namespace);
}
/**
 * Node's facade (module_wrap createRequiredModuleFacade): a namespace of
 * `namespace`'s names, read live, and __esModule true. A namespace refuses
 * every write and reports each name as a writable, non-configurable data
 * property; a Proxy reports the same, where a map fixed at load has no
 * module to make it from. Its target keeps the values last read, which is
 * what an inspection of it shows.
 */
function namespaceFacade(namespace) {
    const target = Object.create(null);
    const value = (name) => name === '__esModule' ? true : Reflect.get(namespace, name);
    for (const name of [...Object.keys(namespace), '__esModule'].sort()) {
        Object.defineProperty(target, name, { value: value(name), writable: true, enumerable: true });
    }
    Object.defineProperty(target, Symbol.toStringTag, { value: 'Module' });
    Object.preventExtensions(target);
    const read = (name) => (target[name] = value(name));
    return new Proxy(target, {
        get: (_, key) => typeof key === 'string' && Object.hasOwn(target, key) ? read(key) : Reflect.get(target, key),
        getOwnPropertyDescriptor(_, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (descriptor !== undefined && typeof key === 'string')
                descriptor.value = read(key);
            return descriptor;
        },
        set: () => false,
        // A namespace's [[DefineOwnProperty]]: true only for what its property already is.
        defineProperty(_, key, descriptor) {
            if (typeof key === 'symbol')
                return Reflect.defineProperty(target, key, descriptor);
            if (!Object.hasOwn(target, key) || descriptor.configurable === true || descriptor.enumerable === false)
                return false;
            if ('get' in descriptor || 'set' in descriptor || descriptor.writable === false)
                return false;
            return !('value' in descriptor) || Object.is(descriptor.value, read(key));
        },
        deleteProperty: (_, key) => typeof key === 'symbol' ? Reflect.deleteProperty(target, key) : !Object.hasOwn(target, key),
    });
}
