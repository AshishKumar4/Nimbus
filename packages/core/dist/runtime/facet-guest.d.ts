/**
 * A facet of the local facet host, inside the worker or process that is its
 * realm (local-facet-host.ts).
 *
 * The scope a facet needs is built here, in the realm's own globals: the
 * wasm table filled with the modules the host compiled, the preamble
 * evaluated once, and each submitted function evaluated inside it. A program
 * the facet runs that reaches JavaScript (Ruby's `js` bridge evaluates code
 * and reads any global) reaches this realm's, never the host's.
 *
 * The session capability crosses as calls (runtime/realm-guest.ts). On a
 * host that parks (JSPI) the supervisor's methods settle with the host's
 * answer, so a guest parks on them as on any syscall (in a process realm the
 * answer is waited for first, so the guest parks on a settled promise). On
 * one that cannot, they wait for the answer, holding this thread, as the
 * same-isolate supervisor answered at once; its synchronous view's methods
 * always wait.
 */
export {};
//# sourceMappingURL=facet-guest.d.ts.map