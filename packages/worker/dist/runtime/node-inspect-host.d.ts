/**
 * Source of what Node's util.inspect (node-inspect-source.ts) is given in a
 * Worker in place of Node's internal modules and bindings:
 * `createNodeInspect(platform)`, which runs inspect.js and returns its
 * exports. generateShimsCode embeds this text (node-shims.ts,
 * "util.inspect"), and tests/unit/node-inspect-matches-node.mjs evaluates
 * the same text beside Node's own. A string, not a function's toString():
 * tsc and bun print function source differently (see
 * javascript-string-literal.ts).
 *
 * Node's own functions are ported: lib/internal/util.js join, removeColors
 * and isError; lib/internal/errors.js isStackOverflowError and the message
 * of ERR_INVALID_ARG_TYPE; lib/internal/validators.js validateObject and
 * validateString; src/node_i18n.cc GetStringWidth. Of the util binding, the
 * property and constructor-name readers are JavaScript, and every brand
 * check is intrinsic (util.types), never the prototype chain.
 *
 * THE BINDING. A promise's state and result, a proxy's target and handler,
 * a Map or Set iterator's and a weak collection's entries are V8 slots no
 * user-land JavaScript can read. Node's util binding reads them; here
 * `platform.slots` does, with its signatures (getPromiseDetails,
 * getProxyDetails, previewEntries), after the host's intrinsic brand check,
 * and hands inspect.js the slots' values, which it formats itself: one
 * formatter for every value. In workerd, platform.slots is
 * createWorkerdSlots (WORKERD_SLOTS_SOURCE); where Node runs this host (its
 * parity test), Node's own binding. Named limits (fine-print capabilities):
 * a proxy among a slot's values is a stand-in over its target and handler,
 * which no program code is ever handed: shown without showProxy, one whose
 * target has a custom inspect shows as unknown (Node calls the hook with the
 * proxy as this), and a proxy inside it is shown by its innermost target,
 * its traps not run; and a holder whose own Symbol.toStringTag is an accessor, or with
 * a proxy on its prototype chain, shows its slot as unknown, since reading
 * it would run that code once more than Node.
 *
 * `platform`: { util (the platform's node:util), slots, Buffer, url ({ URL,
 * pathToFileURL }), process, builtinModules, builtinObjects (Node's
 * NODE_BUILTIN_OBJECTS), eastAsianWide(code),
 * primordialsOf(primordials, globalThis), inspectOf(exports, require, module,
 * process, internalBinding, primordials) }, the last two running the
 * upstream sources.
 */
export declare const NODE_INSPECT_HOST_SOURCE: string;
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
//# sourceMappingURL=node-inspect-host.d.ts.map