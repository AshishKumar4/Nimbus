export declare const NODE_LIB_HOST_SOURCE: string;
/**
 * Source of `createWorkerdSlots(util)`: Node's util binding's V8 slot
 * readers (getPromiseDetails, getProxyDetails, previewEntries) over
 * workerd's node:util, whose inspect reads those slots and no other
 * workerd API does. A read runs workerd's inspect on the value with
 * customInspect and getters off, and takes each value it formats one level
 * in as the formatter reaches it, in order: an object at the cycle check
 * every object passes (`ctx.seen.includes(value)`), which answers it seen so
 * none of it is formatted, a primitive at `stylize`, as the literal it is
 * handed decodes. Of what it
 * renders, only workerd's own marks are read: a proxy past the depth
 * (`Proxy [Array]`), a revoked one (`<Revoked Proxy>`), a promise's
 * state, and whether an iterator's entries are key-value pairs (its brace,
 * `[Map Entries] {`).
 *
 * A proxy among a slot's values is read the same way, its target and
 * handler a level deeper, and handed over as a stand-in over its target
 * with none of the program's traps, which getProxyDetails unwraps whenever
 * inspect.js meets it, so no program code is handed one. A holder workerd
 * could not format without running program code (formatsInertly) is not
 * read: its slot shows as unknown.
 */
export declare const WORKERD_SLOTS_SOURCE: string;
//# sourceMappingURL=node-lib-host.d.ts.map