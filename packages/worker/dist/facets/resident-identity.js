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
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
export const DERIVED_OWNER_PREFIX = 'auto:';
/**
 * A launch's whole argv after the runtime's name: a node program's options
 * (its execArgv, `node -C development`) and then its own argv. What the user
 * typed, so what the process table lists and the identity is derived from:
 * `node -C development server.mjs` is not `node server.mjs`. The program's
 * `process.argv` is its own.
 */
export function launchArgv(opts) {
    return [...opts.execArgv ?? [], ...opts.argv ?? []];
}
/** `auto:` + the first 24 hex of sha256(cwd ++ NUL ++ argv.join(NUL)). */
export async function deriveResidentOwner(cwd, argv) {
    const hex = await sha256Hex(`${cwd}\0${argv.join('\0')}`);
    return `${DERIVED_OWNER_PREFIX}${hex.slice(0, 24)}`;
}
