/**
 * local-facet-host.ts — a facet that runs in the caller's own isolate.
 *
 * The {@link FacetHost} for every embedder that is not workerd. There is no
 * dynamic-worker substrate to reach for and no CSP forbidding a compile, so the
 * scope a facet needs is built where it is asked for: compile the wasm table,
 * evaluate the preamble once, and evaluate each submitted function inside it.
 *
 * The function is still SERIALIZED rather than called in place, and that is the
 * point rather than an accident of symmetry. A runner's facet function reads
 * names the preamble declares — `__wasiMakeImports`, `__bashBoot` — which exist
 * only in the scope the preamble was evaluated in; calling the original closure
 * would resolve them against this module instead and fail. Serializing also
 * keeps the contract honest: a closure reference that would break on workerd
 * breaks here too, in a unit test, rather than in production.
 *
 * `globalThis` inside a facet is the facet's own scope object, not the process
 * global. Preambles publish their entry points on it and runners read them back
 * from it, so two facets in one process must not see each other's — and the
 * process must not see either.
 */
import type { FacetHost } from './facet-host.js';
/**
 * Run facets in this isolate.
 *
 * `parking: 'none'` is the whole character of this host, and everything else
 * follows from it: the guest is entered on an ordinary stack, so no syscall may
 * suspend it, so {@link FacetHost.seedFilesystem} hands over the bytes rather
 * than a manifest to fetch them with, and the supervisor it mints serves only
 * the writes — which drain after the program returns, where a promise is free.
 *
 * The one thing a substrate with its own isolates gives that this cannot:
 * {@link FacetSubmitOptions.timeoutMs} is not honoured. A guest spinning
 * synchronously holds the only thread, so no timer fires until it is already
 * finished; racing one would return while the program ran on.
 */
export declare function localFacetHost(): FacetHost;
//# sourceMappingURL=local-facet-host.d.ts.map