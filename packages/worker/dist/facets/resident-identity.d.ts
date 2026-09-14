/**
 * facets/resident-identity.ts — the derived identity of an ordinary resident.
 *
 * A durable application used to be whatever an embedder reserved a port for.
 * Under the universal model every resident has an identity from the moment
 * it is spawned, derived from what the user typed: the working directory
 * and the argv. Two spawns of `node server.js` from the same directory are
 * the same application — before, after and across a supervisor reset — and
 * that is what a lazily created reservation binds to.
 *
 * The environment is deliberately NOT an input: a rotated secret, a changed
 * `PORT`, a different `TERM` must not turn one application into another.
 *
 * The derived form is namespaced (`auto:`) so it can never collide with an
 * ordinary caller-chosen owner. Reservation policy is NOT inferred from
 * this prefix: the reservation's persisted explicit/derived kind determines
 * whether its first binder adopts an owner or must already match it.
 */
export declare const DERIVED_OWNER_PREFIX = "auto:";
/** `auto:` + the first 24 hex of sha256(cwd ++ NUL ++ argv.join(NUL)). */
export declare function deriveResidentOwner(cwd: string, argv: readonly string[]): Promise<string>;
export declare function isDerivedOwner(owner: string): boolean;
//# sourceMappingURL=resident-identity.d.ts.map