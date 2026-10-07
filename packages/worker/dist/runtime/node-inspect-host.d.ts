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
 * property and constructor-name readers are JavaScript. What only V8's
 * internals read (a promise's state, a proxy's target, an iterator's or a
 * weak collection's entries), and the properties of a workerd API object
 * with no inspect method of its own (its prototype's kResourceTypeInspect,
 * workerd jsg/resource.h), are formatted by the platform's own inspect,
 * workerd's port of Node's, which reads them: inspect.js reaches every
 * object through getProxyDetails first and formats what that answers in the
 * value's place, through its inspect hook. So what such a value holds is
 * printed as workerd prints it (a symbol key bare, `Symbol(k)` for Node's
 * `[Symbol(k)]`), and with customInspect false it is printed with none of
 * those internals: a promise `<pending>`, an iterator's entries empty, a
 * proxy through its traps, where Node reads V8 there too.
 *
 * `platform`: { util (the platform's node:util), Buffer, url ({ URL,
 * pathToFileURL }), process, builtinModules, eastAsianWide(code),
 * primordialsOf(primordials, globalThis), inspectOf(exports, require, module,
 * process, internalBinding, primordials) }, the last two running the
 * upstream sources.
 */
export declare const NODE_INSPECT_HOST_SOURCE: string;
//# sourceMappingURL=node-inspect-host.d.ts.map