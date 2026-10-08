/**
 * Source of what Node's own modules (node-lib-source.ts) are given in a
 * Worker in place of Node's internal modules and bindings:
 * `createNodeLib(platform)`, whose `require(id)` runs a module of Node's
 * library once, the first time it is asked for, and returns its exports.
 * generateShimsCode embeds this text (node-shims.ts, "Node's library"), and
 * tests/unit/node-inspect-matches-node.mjs evaluates the same text beside
 * Node's own. A string, not a function's toString(): tsc and bun print
 * function source differently (see javascript-string-literal.ts).
 *
 * What Node's modules require of its internals that is not itself one of
 * them is ported here: lib/internal/util.js join, removeColors, isError,
 * deprecate, setOwnProperty and normalizeEncoding; lib/internal/errors.js
 * codes (core _shared/node-error.ts nodeErrorCodes, Node's messages),
 * hideStackFrames, isErrorStackTraceLimitWritable and isStackOverflowError;
 * lib/internal/url.js isURL; lib/internal/util/types.js's typed-array
 * checks; src/node_i18n.cc GetStringWidth; and the bindings below. The
 * errors are the shims' (node-error.ts), which the text calls by name. Of
 * the util binding, the property and constructor-name readers are
 * JavaScript, and every brand check is intrinsic (util.types), never the
 * prototype chain.
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
 * its traps not run; and a holder whose class has its own instanceof check
 * or a name getter, whose own Symbol.toStringTag is an accessor, or with
 * a proxy on its prototype chain, shows its slot as unknown, since reading
 * it would run that code once more than Node.
 *
 * `platform`: { util (the platform's node:util), slots, Buffer, url ({ URL,
 * pathToFileURL }), process, builtinModules, builtinObjects (Node's
 * NODE_BUILTIN_OBJECTS), eastAsianWide(code), signals (os.constants.signals),
 * insideNodeModules() (whether the caller's code is a package's),
 * errorSourcePositions(error) (where V8 places the frame an error was
 * captured at: { sourceLine, scriptResourceName, lineNumber, startColumn },
 * or undefined), tokenizer(code, options) (acorn's), sourceMaps
 * ({ getSourceMapsSupport, findSourceMap, getSourceLine }), colorDepth()
 * (internal/tty getColorDepth), primordialsOf(primordials, globalThis), and
 * sources: { [id]: (exports, require, module, process, internalBinding,
 * primordials) => void } }, the last two running the upstream text.
 */
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