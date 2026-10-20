/**
 * The shell's variables as bash keeps them: a scalar in `env`, or an array
 * (sparse, by index) in `arrays`, never both; and the names `readonly`
 * protects. The Shell's builtins (declare, export, read, readonly) and the
 * interpreter's assignments write through these, so each rule is stated
 * once: a readonly name refuses, a plain assignment to an array lands on
 * its first element, a subscripted one promotes a scalar to an array, and
 * an array literal replaces whatever the name held.
 */
/** A variable dictionary: prototype names are ordinary variable names too. */
export function cloneEnv(source) {
    const env = { ...source };
    Object.setPrototypeOf(env, null);
    return env;
}
/** `name=value` (`name+=value` with `append`); on an array, its first element. False for a readonly name. */
export function assignVariable(store, name, value, append = false) {
    if (store.readonlyNames.has(name))
        return false;
    const array = store.arrays.get(name);
    if (array !== undefined)
        array[0] = append ? (array[0] ?? '') + value : value;
    else
        store.env[name] = append ? (store.env[name] ?? '') + value : value;
    return true;
}
/** `name=(…)`: `array` in place of whatever the name held. False for a readonly name. */
export function assignArray(store, name, array) {
    if (store.readonlyNames.has(name))
        return false;
    delete store.env[name];
    store.arrays.set(name, array);
    return true;
}
/** The highest index that holds a value, or -1: bash's array_max_index, past which `a+=(…)` goes on. */
export function lastIndex(array) {
    const end = array.length - 1;
    if (end < 0 || array[end] !== undefined)
        return end;
    // Past a removed last element: an array's own keys are its indices in order, the holes skipped, however high.
    let last = -1;
    for (const key of Object.keys(array))
        if (array[Number(key)] !== undefined)
            last = Number(key);
    return last;
}
/** The array behind a subscripted assignment, promoting a scalar to its element 0 if needed. */
export function arrayFor(store, name) {
    const existing = store.arrays.get(name);
    if (existing !== undefined)
        return existing;
    const scalar = store.env[name];
    const array = scalar === undefined ? [] : [scalar];
    delete store.env[name];
    store.arrays.set(name, array);
    return array;
}
/** One variable's whole binding, so a scope can put it back exactly: its array a copy, as what the scope does to it in place is not kept. */
export function saveVariable(store, name) {
    const array = store.arrays.get(name);
    return { scalar: store.env[name], array: array === undefined ? undefined : copyArray(array), exported: store.exportedNames.has(name), declared: store.declaredNames.has(name) };
}
/**
 * `name` bound again as `saved` holds it. `attributes`: its export mark and
 * declaredness too (a local's, at its function's return); a command's prefix
 * assignment gives back only its value (`x=1 export x` exports x).
 */
export function restoreVariable(store, name, saved, attributes = true) {
    if (saved.array === undefined)
        store.arrays.delete(name);
    else
        store.arrays.set(name, saved.array);
    if (saved.scalar === undefined)
        delete store.env[name];
    else
        store.env[name] = saved.scalar;
    if (!attributes)
        return;
    if (saved.exported)
        store.exportedNames.add(name);
    else
        store.exportedNames.delete(name);
    if (saved.declared)
        store.declaredNames.add(name);
    else
        store.declaredNames.delete(name);
}
/** A copy of `arrays` whose arrays are copies too: what a subshell or a saved shell state holds. */
export function cloneArrays(arrays) {
    return new Map(Array.from(arrays, ([name, elements]) => [name, copyArray(elements)]));
}
/** A copy of `array`, its holes kept, however high its last index. */
export function copyArray(array) {
    const copy = [];
    for (const key of Object.keys(array))
        copy[Number(key)] = array[Number(key)];
    return copy;
}
/** A subscript's arithmetic as an index of `array`: a negative one counts back from past its last value (still negative where that is before the first). */
export function arrayIndex(array, value) {
    return value < 0 ? lastIndex(array) + 1 + value : value;
}
/** `store`'s attributes (VariableAttributes). */
export function attributesOf(store) {
    const arrays = Object.create(null);
    for (const name of [...store.arrays.keys()].sort()) {
        const array = store.arrays.get(name) ?? [];
        const elements = [];
        for (const key of Object.keys(array)) {
            const value = array[Number(key)];
            if (value !== undefined)
                elements.push([Number(key), value]);
        }
        arrays[name] = elements;
    }
    return {
        exported: [...store.exportedNames].sort(),
        readonly: [...store.readonlyNames].sort(),
        declared: [...store.declaredNames].sort(),
        arrays,
    };
}
/**
 * `attributes` put back into `store`, whose `env` holds the scalars they were
 * saved with (`scalars`, those names) and maybe others besides (a
 * workspace's). Every name the saved state binds (a scalar, an array, a mark)
 * is as it was saved: its scalar only if it had one, exported only if it
 * was. Any other keeps its value and mark, but a mark without a value (a
 * declared name, an exported unset one) is only the saved state's: one a new
 * shell starts with (OLDPWD) and the saved shell unset goes.
 */
export function restoreAttributes(store, attributes, scalars) {
    const saved = new Set(scalars);
    const exported = new Set(attributes.exported);
    const bound = new Set([...saved, ...exported, ...attributes.readonly, ...attributes.declared, ...Object.keys(attributes.arrays)]);
    for (const name of bound) {
        if (!saved.has(name))
            delete store.env[name];
        if (exported.has(name))
            store.exportedNames.add(name);
        else
            store.exportedNames.delete(name);
    }
    for (const name of [...store.exportedNames]) {
        if (!bound.has(name) && store.env[name] === undefined && !store.arrays.has(name))
            store.exportedNames.delete(name);
    }
    store.declaredNames.clear();
    for (const name of attributes.declared)
        store.declaredNames.add(name);
    for (const name of attributes.readonly)
        store.readonlyNames.add(name);
    for (const [name, elements] of Object.entries(attributes.arrays)) {
        const array = [];
        for (const [index, value] of elements)
            array[index] = value;
        store.arrays.set(name, array);
    }
}
/**
 * A shell parameter the shell keeps among its variables (a positional one, `#`, `@`,
 * `*`, `?`, `$`, `!`, `-`): never a variable, so never exported (bash's are not in
 * the environment).
 */
export function isShellParameter(name) {
    return /^[0-9]+$/.test(name) || SHELL_PARAMETERS.has(name);
}
const SHELL_PARAMETERS = new Set(['#', '@', '*', '?', '$', '!', '-']);
/**
 * The environment a command gets: the exported variables' scalar values, in
 * the store's order (bash's export_env). An unexported variable, or an array,
 * is the shell's own.
 */
export function exportedEnvironment(store) {
    return Object.fromEntries(Object.entries(store.env).filter(([name]) => store.exportedNames.has(name)));
}
