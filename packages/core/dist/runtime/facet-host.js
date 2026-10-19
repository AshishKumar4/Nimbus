/**
 * facet-host.ts — where a program carrying compiled WebAssembly actually runs.
 *
 * Every WASM runtime Nimbus ships (bash, CPython, Ruby, clang, the generic
 * `wasm-runner`) has the same shape: a self-contained scheduler shipped as
 * SOURCE, a table of wasm modules that must be compiled before the scheduler
 * can reach them, and a function submitted into that scope with plain data and
 * back. Only the substrate underneath differs.
 *
 * On workerd that substrate is a dynamic worker: request-time
 * `WebAssembly.instantiate(bytes)` is refused by CSP, so the bytes ride inside
 * the loader's modules map and are compiled during the inner worker's
 * module-load phase — the one phase where wasm code generation is permitted.
 * Off workerd there is no such rule and the same scope is built in place
 * ({@link ./local-facet-host.ts}).
 *
 * NOT named after either. `Facet` is what Nimbus has always called this — one
 * program, its own module scope, its own wasm table — and the port is the
 * whole of what a runtime needs from it, so a runner cannot tell which
 * substrate answered and never asks.
 */
/** The key a request-shaped task's failure travels under, in the 500 its pool answers with. */
export const FACET_ERROR_KEY = '__nimbusFacetError';
/**
 * Set on what a request-shaped task throws when its own request body does
 * not parse: the entry it came through (task-body-error.ts) names the body.
 * A task compiled to run in a facet names it as this literal.
 */
export const TASK_BODY_FAILED = 'nimbusTaskBodyFailed';
/**
 * A request-shaped task's answer: its JSON, or its failure thrown with the
 * message its pool answered with.
 */
export async function facetAnswer(response) {
    const body = await response.json();
    if (response.ok)
        return body;
    const message = typeof body === 'object' && body !== null ? Reflect.get(body, FACET_ERROR_KEY) : undefined;
    throw new Error(typeof message === 'string' ? message : `the facet's task failed: HTTP ${response.status}`);
}
