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
export interface CallableMetadata {
    /** What the method does, for surface listings. */
    description?: string;
    /**
     * A streaming method receives a {@link import('./rpc.js').StreamingResponse}
     * as its FIRST argument, ahead of the caller's own, and replies through it.
     * Its return value is discarded.
     */
    streaming?: boolean;
}
/**
 * Mark a method as callable over the connection. First mark wins; marking
 * the same function twice keeps the first metadata.
 */
export declare function callable(metadata?: CallableMetadata): <This, Args extends unknown[], Return>(target: (this: This, ...args: Args) => Return, _context?: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>) => (this: This, ...args: Args) => Return;
/** True when the value is a function carrying the callable mark. */
export declare function isCallable(method: unknown): boolean;
/** The mark's metadata, or undefined for an unmarked value. */
export declare function callableMetadata(method: unknown): CallableMetadata | undefined;
/**
 * Every callable method reachable from an instance, by name, walking the
 * prototype chain. A subclass override without its own mark hides the
 * marked parent method — the override is what `this[name]` resolves to,
 * and it is unmarked.
 */
export declare function callableMethods(target: object): Map<string, CallableMetadata>;
//# sourceMappingURL=callable.d.ts.map