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
 * user-land JavaScript can read. Only for those slots, the binding renders
 * the slot's content with the platform's inspect (workerd's port of Node's,
 * which reads them), under the options the slot is formatted with, and
 * hands inspect.js a value that prints as that text where Node's binding
 * result goes. Nothing else ever goes through the platform's inspect.
 * Named limits: what such a slot holds is printed by workerd's port (it
 * prints a symbol key bare, `Symbol(k)` for Node's `[Symbol(k)]`); and
 * `util.format('%s', proxy)` reads the proxy's toString as a built-in's.
 *
 * `platform`: { util (the platform's node:util), Buffer, url ({ URL,
 * pathToFileURL }), process, builtinModules, builtinObjects (Node's
 * NODE_BUILTIN_OBJECTS), eastAsianWide(code),
 * primordialsOf(primordials, globalThis), inspectOf(exports, require, module,
 * process, internalBinding, primordials) }, the last two running the
 * upstream sources.
 */
export declare const NODE_INSPECT_HOST_SOURCE: string;
//# sourceMappingURL=node-inspect-host.d.ts.map