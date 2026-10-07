/**
 * The shell's variables as bash keeps them: a scalar in `env`, or an array
 * (sparse, by index) in `arrays`, never both; and the names `readonly`
 * protects. The Shell's builtins (declare, export, read, readonly) and the
 * interpreter's assignments write through these, so each rule is stated
 * once: a readonly name refuses, a plain assignment to an array lands on
 * its first element, a subscripted one promotes a scalar to an array, and
 * an array literal replaces whatever the name held.
 */
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
/** `name=(value …)` (`name+=(…)` appends to the array). False for a readonly name. */
export function assignArray(store, name, values, append = false) {
    if (store.readonlyNames.has(name))
        return false;
    const existing = append ? store.arrays.get(name) ?? [] : [];
    delete store.env[name];
    store.arrays.set(name, [...existing, ...values]);
    return true;
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
/** One variable's whole binding, so a scope can put it back exactly. */
export function saveVariable(store, name) {
    return { scalar: store.env[name], array: store.arrays.get(name) };
}
export function restoreVariable(store, name, saved) {
    if (saved.array === undefined)
        store.arrays.delete(name);
    else
        store.arrays.set(name, saved.array);
    if (saved.scalar === undefined)
        delete store.env[name];
    else
        store.env[name] = saved.scalar;
}
/** A copy of `arrays` whose arrays are copies too: what a subshell or a saved shell state holds. */
export function cloneArrays(arrays) {
    return new Map(Array.from(arrays, ([name, elements]) => [name, [...elements]]));
}
