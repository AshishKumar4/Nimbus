/**
 * callable.ts — the opt-in that makes an actor method reachable over the
 * connection.
 *
 * RPC exposure is allowlist-only: a method a client can invoke by name is a
 * public surface, and an accidental one is a vulnerability. `callable()`
 * is the allowlist mark. The mechanism mirrors the Agents SDK exactly
 * (verified in `agents` 0.20.1 dist, `index.js:54,112-134`): a TC39
 * standard method decorator whose registry is a module-level
 * `WeakMap<Function, CallableMetadata>` keyed by the method's function
 * object. Keying by function makes the mark travel with the method through
 * inheritance and `this[name]` lookup, and costs nothing at class-definition
 * time.
 *
 * The decorator ignores its context argument, so plain-JS callers (tests,
 * codebases without decorator syntax) can mark a method directly:
 * `callable()(MyActor.prototype.greet)`.
 */
const registry = new WeakMap();
/**
 * Mark a method as callable over the connection. First mark wins; marking
 * the same function twice keeps the first metadata.
 */
export function callable(metadata = {}) {
    return function markCallable(target, _context) {
        if (!registry.has(target))
            registry.set(target, metadata);
        return target;
    };
}
/** True when the value is a function carrying the callable mark. */
export function isCallable(method) {
    return typeof method === 'function' && registry.has(method);
}
/** The mark's metadata, or undefined for an unmarked value. */
export function callableMetadata(method) {
    return typeof method === 'function' ? registry.get(method) : undefined;
}
/**
 * Every callable method reachable from an instance, by name, walking the
 * prototype chain. A subclass override without its own mark hides the
 * marked parent method — the override is what `this[name]` resolves to,
 * and it is unmarked.
 */
export function callableMethods(target) {
    const found = new Map();
    const shadowed = new Set();
    for (let proto = Object.getPrototypeOf(target); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor' || shadowed.has(name))
                continue;
            // Own descriptors only — reading `instance[name]` would run getters.
            shadowed.add(name);
            const metadata = callableMetadata(Object.getOwnPropertyDescriptor(proto, name)?.value);
            if (metadata !== undefined)
                found.set(name, metadata);
        }
    }
    return found;
}
