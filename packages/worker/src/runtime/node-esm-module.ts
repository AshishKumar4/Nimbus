/**
 * The text of the node launch map's module of the native ES module host
 * (RUNTIME_NODE_ESM_MODULE, core _shared/commonjs-cell.ts): how the
 * registry links, evaluates, adopts and requires a launch's staged ES modules
 * (worker facets/esm-stage.ts). A `{ cjs }` module the shims require the
 * first time a program links, imports or requires an ES module
 * (node-shims.ts __nimbusEsmRuntime), so a CommonJS program never compiles
 * it: carried in the shims, it cost every launch's run 10 to 17 ms.
 *
 * Its functions are the host's; their state, and the built-ins they capture,
 * are the shims', made before any program code runs, and given to
 * createEsmRuntime once per launch with everything else of the shims' they
 * call. Staged as an asset beside the shims (scripts/bundle-node-shims.mjs).
 */

import { ESM_BUN_SCOPE, ESM_FACADE_DIR, ESM_TOP_LEVEL_AWAIT, ESM_TYPELESS } from '@nimbus-sh/core/runtime/native-esm.js';
import { RUNTIME_PARSER_MODULE } from '@nimbus-sh/core/_shared/commonjs-cell.js';

export function generateNodeEsmModule(): string {
  return `"use strict";
module.exports = { createEsmRuntime: function createEsmRuntime(__shims) {
const {
  __BufferMod, __ESM_ADOPTED, __ESM_BEGAN, __ESM_DONE, __ESM_FAILED, __ESM_LINKED,
  __ESM_STOPPED, __NIMBUS_BUNDLE_FILES, __NIMBUS_BUNDLE_URL, __NodeModule, __esmNamespaceOf, __esmNamespaces,
  __esmResolver, __loadModule, __moduleEvaluations, __nimbusArrowOf, __nimbusCodeCells, __nimbusColumnEdits,
  __nimbusCompiling, __nimbusDecorateSyntaxError, __nimbusDecorated, __nimbusEsm, __nimbusEsmAdopted, __nimbusEsmId,
  __nimbusEsmLoading, __nimbusEsmRecord, __nimbusEsmRecords, __nimbusEsmResolved, __nimbusEsmResyncs, __nimbusEsmStop,
  __nimbusEsmThen, __nimbusEsmUrl, __nimbusExplainCommonJSGlobalLike, __nimbusFileImportMeta, __nimbusGeneratedColumn, __nimbusModuleAtPath,
  __nimbusModuleRequests, __nimbusModuleSourceText, __nimbusReadBundleFile, __nimbusReflectApply, __nimbusRegistryRequire, __nimbusRuntimeModule,
  __nimbusTextOffset, __nimbusTrackOp, __nimbusTypelessWarned, __pathMod, __processMod, __readFileOr,
  builtins, nodeError,
} = __shims;
// The batch the meta instances evaluating now join: one evaluation's, which
// runs every meta instance it links in one synchronous turn, and ends with it.
let __nimbusEsmOpenBatch = null;
// The program's ES entry, imported: its evaluation is its job, and what
// escapes it is explained as Node's loader explains it.
let __nimbusEsmEntryKey = null;
// The map module of row \`id\` (worker facets/esm-stage.ts esmRowName): a
// staged module's cell's module, else its facade by id.
function __nimbusEsmName(id) {
  const row = __nimbusEsm.table[id];
  return row[0] === "module" ? __nimbusCodeCells.get(row[1])[1] : ${JSON.stringify(ESM_FACADE_DIR)} + id + ".js";
}
// What a module's meta instance hands it (native-esm.ts metaModuleSource):
// import.meta, its import(), the check its body opens with, and its
// registration; a facade, what it loads; a builtin's, its resync hook.
function __nimbusEsmEnter(metaUrl) {
  const id = Number(String(metaUrl).slice(String(metaUrl).lastIndexOf("?") + 1));
  const row = __nimbusEsm.table[id];
  const record = __nimbusEsmRecord(id);
  if (__nimbusEsmOpenBatch === null) {
    // An evaluation begins: the graphs it loads are loaded.
    for (const loaded of __nimbusEsmLoading.splice(0)) loaded();
    __nimbusEsmOpenBatch = { running: new Set(), stop: null, thrower: null };
    __nimbusReflectApply(__nimbusEsmThen, __nimbusEsmResolved, [() => { __nimbusEsmOpenBatch = null; }]);
  }
  record.batch = __nimbusEsmOpenBatch;
  record.state = __ESM_LINKED;
  const c = () => __nimbusEsmCheck(record);
  const r = (namespace) => {
    record.state = __ESM_DONE;
    record.namespace = namespace ?? null;
    record.batch.running.delete(record);
  };
  if (row[0] === "module") {
    const filename = "/" + row[1];
    const url = __nimbusEsmUrl(filename);
    // Compiled now, as Node's loader compiles it: its source map, where source maps are on.
    __nimbusCompiling(url, () => __nimbusEsmSourceText(id));
    const scope = { m: __nimbusFileImportMeta(filename, url, row[1] === __nimbusEsmEntryKey), i: (specifier, options) => globalThis.__nimbusDynamicImport(url, specifier, options), c, r };
    // Bun's scope binds require, __filename and __dirname too (native-esm.ts bunScopeNames).
    if (((row[3] ?? 0) & ${ESM_BUN_SCOPE}) !== 0) Object.assign(scope, { q: __NodeModule.createRequire(filename), f: filename, d: __pathMod.dirname(filename) });
    return scope;
  }
  if (row[0] === "commonjs") return { c, r, l: () => __loadModule(row[1], row[1], true) };
  return { c, r, l: () => builtins[row[1]], s: (resync) => { __nimbusEsmResyncs.push(resync); } };
}
// A body begins: unless an earlier body of its batch threw (Node's
// evaluation stops at the first error) or Nimbus cancelled the batch. A body
// that began and has not completed threw, or waits at a top-level await.
function __nimbusEsmCheck(record) {
  const batch = record.batch;
  if (batch.stop === null) {
    for (const began of batch.running) {
      if (__nimbusEsmSuspends(began)) continue;
      batch.stop = __nimbusEsmStop;
      batch.thrower = began;
      began.state = __ESM_FAILED;
      break;
    }
  }
  if (batch.stop !== null) {
    record.state = __ESM_STOPPED;
    throw batch.stop;
  }
  record.state = __ESM_BEGAN;
  batch.running.add(record);
}
// Whether a module's body awaits at its top level, as staging read it.
function __nimbusEsmSuspends(record) {
  const row = __nimbusEsm.table[record.id];
  return row[0] === "module" && ((row[3] ?? 0) & ${ESM_TOP_LEVEL_AWAIT}) !== 0;
}
// Whether a module of row \`id\`'s graph awaits at its top level: Node's
// require() refuses such a graph, evaluated or not.
function __nimbusEsmGraphAwaits(id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at < 0 || seen.has(at)) continue;
    seen.add(at);
    const row = __nimbusEsm.table[at];
    if (row[0] !== "module") continue;
    if (((row[3] ?? 0) & ${ESM_TOP_LEVEL_AWAIT}) !== 0) return true;
    for (const target of row[2]) stack.push(target);
  }
  return false;
}
// A staged module's text as it was before it was staged: what the
// interpreter evaluates when it adopts the module.
function __nimbusEsmSourceText(id) {
  const module = __nimbusModuleAtPath(__nimbusEsm.table[id][1]);
  const text = __nimbusModuleSourceText(module);
  if (text === null) throw new Error("Nimbus: cannot read the staged module " + __nimbusEsmName(id));
  return module.hashbang ? "#!" + text.slice(2) : text;
}
// Whether the registry cannot evaluate the module with Node's semantics:
// something its graph links to that the registry has not evaluated was
// evaluated by the interpreter instead, which the registry would evaluate
// again. (A module Nimbus stopped fails the registry's evaluation with
// Nimbus's own error, which hands the module to the interpreter then.)
function __nimbusEsmTainted(id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at < 0 || seen.has(at)) continue;
    seen.add(at);
    const record = __nimbusEsmRecords[at];
    if (record !== undefined) {
      if (record.state === __ESM_DONE) continue;
      if (record.state === __ESM_ADOPTED) return true;
    }
    const row = __nimbusEsm.table[at];
    if (row[0] === "module") for (const target of row[2]) stack.push(target);
  }
  return false;
}
// require() of a staged ES module, or an interpreted module's static import
// of one: its namespace once the registry evaluated it (Node's
// require(esm) shape for a require), null where the interpreter is to
// evaluate it (its record given up), else Node's refusal.
// Node's refusal of a require() whose graph has top-level await.
function __nimbusRequireAsync(parent, filename) {
  return nodeError(Error, "ERR_REQUIRE_ASYNC_MODULE", "require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.\\n  From " + (parent?.filename ?? "") + " \\n  Requiring " + filename + " ");
}
function __nimbusEsmRequire(id, required, parent = undefined) {
  const record = __nimbusEsmRecord(id);
  if (record.state === __ESM_DONE) {
    if (!required) return record.namespace;
    const filename = "/" + __nimbusEsm.table[id][1];
    if (__nimbusEsmGraphAwaits(id)) throw __nimbusRequireAsync(parent, filename);
    // Node's require(esm) leaves a Module in require.cache, and takes it again after a delete.
    if (record.module === undefined) {
      record.module = new __NodeModule(filename, null);
      record.module.filename = filename;
      record.module.paths = __NodeModule._nodeModulePaths(__pathMod.dirname(filename));
      record.module.exports = __nimbusEsmRequired(record);
      record.module.loaded = true;
    }
    __NodeModule._cache[filename] ??= record.module;
    return record.module.exports;
  }
  // Evaluated by the interpreter already: its result, its Module in require.cache again.
  if (record.state === __ESM_ADOPTED && record.module !== undefined && record.namespace !== null) {
    if (required) __NodeModule._cache[record.module.filename] ??= record.module;
    return required ? __nimbusEsmRequired(record) : record.module.exports;
  }
  // It threw: what it threw, once its evaluation's rejection said.
  if (record.state === __ESM_FAILED && record.error !== undefined) throw record.error.value;
  const filename = "/" + __nimbusEsm.table[id][1];
  // Evaluating, for an import: Node's ESM loader's refusal, naming the requirer.
  if (record.state === __ESM_BEGAN || (record.state === __ESM_ADOPTED && record.namespace === null && record.requirer === undefined)) {
    if (__nimbusEsmSuspends(record)) throw __nimbusRequireAsync(parent, filename);
    throw nodeError(Error, "ERR_REQUIRE_CYCLE_MODULE", "Cannot require() ES Module " + filename + " in a cycle." + (parent?.filename ? " (from " + parent.filename + ")" : "") + " A cycle involving require(esm) is not allowed to maintain invariants mandated by the ECMAScript specification. Try making at least part of the dependency in the graph lazily loaded.");
  }
  // Evaluating, for a require(): Node's CommonJS loader's, naming the require that began it.
  if (record.state === __ESM_ADOPTED && record.namespace === null) {
    throw nodeError(Error, "ERR_REQUIRE_CYCLE_MODULE", "Cannot require() ES Module " + filename + " in a cycle." + (record.requirer ? " (from " + record.requirer + ")" : ""));
  }
  // A require() refuses a graph with top-level await before any of it runs, as Node's does.
  if (required && record.state !== __ESM_ADOPTED) {
    for (const at of __nimbusEsmPending(id)) {
      if (__nimbusEsmSuspends(__nimbusEsmRecord(at))) throw __nimbusRequireAsync(parent, filename);
    }
  }
  // Linked into an evaluation that has not reached it: that evaluation is
  // cancelled (each body yet to begin stops), and the module is the interpreter's.
  if (record.state === __ESM_LINKED && record.batch.stop === null) record.batch.stop = __nimbusEsmStop;
  if (record.state !== __ESM_ADOPTED) {
    record.state = __ESM_ADOPTED;
    // Who began it, for a cycle's refusal: a require()'s module, or none for an import.
    record.requirer = required ? parent?.filename ?? "" : undefined;
    __nimbusEsmAdopted();
    // NIMBUS_DIAG_ESM=1: each adoption named on stderr, to count them in a workload.
    if (__processMod.env.NIMBUS_DIAG_ESM === "1") {
      try { __processMod.stderr.write("nimbus-esm: adopted /" + __nimbusEsm.table[id][1] + (required ? " (require)" : " (import)") + "\\n"); } catch {}
    }
  }
  return null;
}
// Node's require(esm): a module's "module.exports" export, else its
// namespace, which has no default export or names __esModule itself, else
// the namespace with __esModule true beside its names.
function __nimbusEsmRequired(record) {
  const namespace = record.namespace;
  if ("module.exports" in namespace) return namespace["module.exports"];
  if (!("default" in namespace) || "__esModule" in namespace) return namespace;
  if (record.required === undefined) {
    const facade = Object.create(null);
    for (const name of [...Object.keys(namespace), "__esModule"].sort()) {
      if (name === "__esModule") Object.defineProperty(facade, name, { value: true, enumerable: true, writable: true });
      else Object.defineProperty(facade, name, { enumerable: true, get: () => namespace[name] });
    }
    Object.defineProperty(facade, Symbol.toStringTag, { value: "Module" });
    record.required = Object.preventExtensions(facade);
  }
  return record.required;
}
// Node's warning as it loads a \`.js\` that is a module by its syntax alone
// under a package.json with no "type", once per package.json, naming the
// first such module it loads: \`id\`'s graph, in the order a load reaches
// it (each module, then the modules it imports, level by level).
function __nimbusEsmWarnTypeless(id) {
  const seen = new Set([id]);
  const queue = [id];
  for (let at = 0; at < queue.length; at++) {
    const row = __nimbusEsm.table[queue[at]];
    if (row[0] !== "module") continue;
    if (((row[3] ?? 0) & ${ESM_TYPELESS}) !== 0 && !__nimbusTypelessWarned.has(row[4])) {
      __nimbusTypelessWarned.add(row[4]);
      __processMod.emitWarning("Module type of " + __nimbusEsmUrl("/" + row[1]) + " is not specified and it doesn't parse as CommonJS.\\n"
        + "Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\\n"
        + "To eliminate this warning, add \\"type\\": \\"module\\" to " + row[4] + ".", { code: "MODULE_TYPELESS_PACKAGE_JSON" });
    }
    for (const target of row[2]) {
      if (target >= 0 && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
}
// The namespace of the staged module (or facade) \`id\`, evaluated by the
// registry where it can be; the one place Nimbus calls the registry's import().
async function __nimbusEsmImport(id) {
  const record = __nimbusEsmRecord(id);
  if (record.state === __ESM_DONE && record.namespace !== null) return record.namespace;
  const row = __nimbusEsm.table[id];
  if (row[0] === "module" && record.state === 0) __nimbusEsmWarnTypeless(id);
  if (row[0] === "module" && __nimbusEsmTainted(id)) return __nimbusEsmInterpret(id);
  let batch = null;
  try {
    // The program's own work while its graph loads, until its evaluation
    // begins (its first meta instance) or it settles: a host whose loading
    // reads keeps the process, as Node's loader keeps it while it reads;
    // a top-level await that never settles does not. Armed before the
    // import(), which may link and begin evaluating within the call.
    let loaded;
    __nimbusTrackOp(new Promise((resolve) => { loaded = resolve; }));
    __nimbusEsmLoading.push(loaded);
    const evaluation = import(__NIMBUS_BUNDLE_URL + __nimbusEsmName(id));
    // The evaluation it began, when it began within the call (workerd's).
    batch = __nimbusEsmOpenBatch;
    __nimbusReflectApply(__nimbusEsmThen, evaluation, [loaded, loaded]);
    return await evaluation;
  } catch (error) {
    // Its evaluation was cancelled or stopped short of a module (a require()
    // took a module of it; an earlier evaluation stopped at a sibling's
    // throw), or it links to a module the launch did not stage: the
    // interpreter's.
    if (row[0] === "module" && (error === __nimbusEsmStop || __nimbusEsmMissingOf(error)?.code === "ERR_NIMBUS_NOT_STAGED")) {
      return __nimbusEsmInterpret(id);
    }
    // The body that threw: one its evaluation began and did not complete
    // (marked already where a later body's check stopped). It keeps what it
    // threw, for a require() of it. A body suspended in its top-level await
    // is the thrower only where no other is.
    let thrower = null;
    for (const record of __nimbusEsmRecords) {
      if (record === undefined || (batch !== null && record.batch !== batch)) continue;
      if (record.state === __ESM_FAILED && record.error === undefined) thrower = record;
      else if (record.state === __ESM_BEGAN && thrower === null && !__nimbusEsmSuspends(record)) thrower = record;
    }
    if (thrower === null) {
      for (const record of __nimbusEsmRecords) {
        if (record !== undefined && (batch === null || record.batch === batch) && record.state === __ESM_BEGAN) thrower = record;
      }
    }
    if (thrower !== null) {
      thrower.state = __ESM_FAILED;
      thrower.batch?.running.delete(thrower);
      thrower.error = { value: error };
    }
    // Node's ModuleJob explains what escapes its evaluation by the job's own
    // module, the one imported: its URL and its top-level await.
    if (row[0] === "module") __nimbusExplainCommonJSGlobalLike(error, __nimbusEsmUrl("/" + row[1]), __nimbusEsmSuspends(__nimbusEsmRecord(id)));
    throw __nimbusEsmLinkError(error, id);
  }
}
// The interpreter's evaluation of staged module \`id\` (an adoption), as import() gives it.
async function __nimbusEsmInterpret(id) {
  const key = __nimbusEsm.table[id][1];
  const url = __nimbusEsmUrl("/" + key);
  const known = __esmNamespaces.get(url);
  if (known !== undefined) return known;
  const pending = (async () => {
    let exports;
    try {
      exports = __loadModule(key, key, false, undefined, true);
    } catch (e) {
      __nimbusExplainCommonJSGlobalLike(e, url, false);
      throw e;
    }
    const evaluation = __moduleEvaluations.get(key);
    if (evaluation !== undefined) {
      try { await evaluation; } catch (e) { __nimbusExplainCommonJSGlobalLike(e, url, true); throw e; }
    }
    // The registry's own namespace, where a static import found it evaluated.
    if (exports !== null && typeof exports === "object" && Object.getPrototypeOf(exports) === null && exports[Symbol.toStringTag] === "Module" && !("__esModule" in exports)) return exports;
    const names = exports && typeof exports === "object" ? Object.keys(exports).filter((name) => name !== "__esModule") : [];
    return __esmNamespaceOf(names, (name) => exports[name]);
  })();
  __esmNamespaces.set(url, pending);
  pending.then((namespace) => { __esmNamespaces.set(url, namespace); }, () => { __esmNamespaces.delete(url); });
  return pending;
}
// The refusal a link error names (a specifier staging refused), or null.
function __nimbusEsmMissingOf(error) {
  const message = error && typeof error.message === "string" ? error.message : "";
  const at = /nimbus\\/missing\\/(\\d+)\\.js/.exec(message);
  return at === null ? null : __nimbusEsm.missing[Number(at[1])] ?? null;
}
// What a failed evaluation of \`id\`'s graph rejects with, as Node's loader
// words it: a refused specifier's own error; a missing export named as the
// importing module wrote it, with its arrow; a module that does not
// compile, with its arrow; else the program's error as it threw it.
function __nimbusEsmLinkError(error, id) {
  const missing = __nimbusEsmMissingOf(error);
  if (missing !== null) {
    const Type = missing.name === "TypeError" ? TypeError : missing.name === "SyntaxError" ? SyntaxError : missing.name === "RangeError" ? RangeError : Error;
    const refused = missing.code ? nodeError(Type, missing.code, missing.message) : new Type(missing.message);
    if (missing.url !== undefined) refused.url = missing.url;
    return refused;
  }
  if (!(error instanceof SyntaxError) || __nimbusDecorated.has(error)) return error;
  try {
    const exported = /^The requested module '([^']*)' does not provide an export named '([^']*)'$/.exec(error.message);
    if (exported !== null) __nimbusEsmExportError(error, id, exported[1], exported[2]);
    else __nimbusEsmCompileError(error, id);
  } catch {}
  return error;
}
// Where the last \`name\` standing alone as an identifier is in \`text\`, or -1.
function __nimbusLastIdentifier(text, name) {
  const part = (c) => c !== undefined && (c === "$" || c === "_" || (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
  for (let at = text.lastIndexOf(name); at !== -1; at = at === 0 ? -1 : text.lastIndexOf(name, at - 1)) {
    if (!part(text[at - 1]) && !part(text[at + name.length])) return at;
  }
  return -1;
}
// The unevaluated modules of \`id\`'s graph, in link order.
function __nimbusEsmPending(id) {
  const seen = new Set();
  const order = [];
  const visit = (at) => {
    if (at < 0 || seen.has(at)) return;
    seen.add(at);
    const row = __nimbusEsm.table[at];
    const state = __nimbusEsmRecords[at]?.state;
    // Evaluated, or being evaluated by the interpreter: not this graph's to run.
    if (row[0] !== "module" || state === __ESM_DONE || state === __ESM_ADOPTED) return;
    order.push(at);
    for (const target of row[2]) visit(target);
  };
  visit(id);
  return order;
}
// A module of the graph that does not compile: the error's arrow is its.
function __nimbusEsmCompileError(error, id) {
  const { fatalLocation } = __nimbusRegistryRequire("./${RUNTIME_PARSER_MODULE}");
  for (const at of __nimbusEsmPending(id)) {
    const name = __nimbusEsmName(at);
    const text = __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + name, "utf8");
    if (fatalLocation(text, "module", -1) === null) continue;
    __nimbusDecorateSyntaxError(error, name);
    return;
  }
}
// A missing export, as Node words it for the specifier the importing module
// wrote (a CommonJS module's in Node's words for one), its arrow under the
// imported name.
function __nimbusEsmExportError(error, id, requested, name) {
  for (const at of __nimbusEsmPending(id)) {
    const module = __nimbusModuleAtPath(__nimbusEsm.table[at][1]);
    const staged = __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + module.name, "utf8");
    const quoted = JSON.stringify(requested);
    const offset = staged.indexOf(quoted, module.head);
    // As written: an edit's source text at the place its specifier is.
    let line = 1;
    let lineStart = 0;
    for (let i = staged.indexOf("\\n"); i !== -1 && i < offset; i = staged.indexOf("\\n", i + 1)) { line++; lineStart = i + 1; }
    let specifier = requested;
    // Where the specifier is in the module's source: before it, the imported name.
    let sourceColumn = -1;
    if (offset !== -1) {
      const column = offset - lineStart - (line === 1 ? module.head : 0);
      let delta = 0;
      for (const [, at, length, text] of __nimbusColumnEdits(module)?.get(line) ?? []) {
        if (at + delta === column && length === quoted.length) { specifier = text.slice(1, -1); sourceColumn = at; break; }
        delta += length - text.length;
      }
    } else if (!staged.includes("'" + requested + "'") && !staged.includes(JSON.stringify(requested))) {
      continue;
    }
    // The module the importer's specifier names, as the registry resolved it.
    let requestedUrl = null;
    try { requestedUrl = new URL(requested, __NIMBUS_BUNDLE_URL + module.name).href; } catch {}
    const target = __nimbusEsm.table[__nimbusEsm.table[at][2].find((t) => t >= 0 && __NIMBUS_BUNDLE_URL + __nimbusEsmName(t) === requestedUrl) ?? -1];
    if (target === undefined) continue;
    error.message = target[0] === "commonjs"
      ? "Named export '" + name + "' not found. The requested module '" + specifier + "' is a CommonJS module, which may not support all module.exports as named exports.\\nCommonJS modules can always be imported via the default export, for example using:\\n\\nimport pkg from '" + specifier + "';\\nconst { " + name + " } = pkg;\\n"
      : "The requested module '" + specifier + "' does not provide an export named '" + name + "'";
    // Node's arrow: the imported name, on the declaration's line.
    const source = __nimbusModuleSourceText(module);
    const end = sourceColumn === -1 ? source.length : __nimbusTextOffset(source, line, sourceColumn + 1);
    const before = source.slice(0, end);
    const found = __nimbusLastIdentifier(before, name);
    let arrow = null;
    if (found !== -1) {
      const at = found;
      const lineOf = before.slice(0, at).split(/\\r\\n|[\\n\\r\\u2028\\u2029]/);
      const fromLine = lineOf.length;
      const text = __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + module.name, "utf8");
      const generated = __nimbusTextOffset(text, fromLine, __nimbusGeneratedColumn(module, fromLine, lineOf[lineOf.length - 1].length + 1)) + (fromLine === 1 ? module.head : 0);
      arrow = __nimbusArrowOf(module, text, generated, generated + name.length);
    }
    // Its frames as they were, under the message as Node words it.
    const frames = typeof error.stack === "string" ? error.stack.split("\\n").filter((frame) => frame.startsWith("    at ")) : [];
    error.stack = (arrow === null ? "" : arrow) + "SyntaxError: " + error.message + (frames.length > 0 ? "\\n" + frames.join("\\n") : "");
    __nimbusDecorated.add(error);
    return;
  }
}
function __nimbusEsmRunEntry(key) {
  __nimbusEsmEntryKey = key;
  const id = __nimbusEsmId("module", key);
  const url = __nimbusEsmUrl("/" + key);
  return __nimbusEsmImport(id).then(() => undefined, (e) => {
    __nimbusExplainCommonJSGlobalLike(e, url, __nimbusEsmSuspends(__nimbusEsmRecord(id)));
    throw e;
  });
}
// What import() of a resolution gives: a staged module's (or facade's)
// namespace from the registry; a builtin's, a data: URL's, a JSON file's and
// a file the launch did not stage, made here, once per URL.
function __esmLoad(resolution) {
  const cached = __esmNamespaces.get(resolution.url);
  if (cached) return cached;
  let ns;
  if (resolution.format === "builtin") {
    const id = __nimbusEsmId("builtin", resolution.builtin);
    if (id !== -1) return __nimbusEsmImport(id);
    const mod = builtins[resolution.builtin];
    const names = new Set(mod && (typeof mod === "object" || typeof mod === "function") ? Object.keys(mod) : []);
    names.add("default");
    ns = __esmNamespaceOf(names, (name) => name === "default" ? mod : mod[name]);
  } else if (resolution.format === "data") {
    const url = new URL(resolution.url);
    const comma = url.pathname.indexOf(',');
    const header = url.pathname.slice(0, comma);
    const mediaType = header.split(';')[0].toLowerCase();
    const payload = url.pathname.slice(comma + 1);
    const text = header.split(';').includes('base64')
      ? __BufferMod.from(decodeURIComponent(payload), 'base64').toString('utf8') : decodeURIComponent(payload);
    if (mediaType === "application/json") {
      const value = JSON.parse(text);
      ns = __esmNamespaceOf(["default"], () => value);
    } else if (mediaType === "text/javascript" || mediaType === "application/javascript") {
      // A data URL produced at runtime is a module body, just like a written
      // file. It is staged by the same runtime-code service, retaining its URL
      // as the import base (relative imports from data URLs remain invalid).
      const cell = __nimbusRuntimeModule(resolution.url, text);
      const mod = { exports: {} };
      Object.defineProperty(mod, "__nimbusImportMeta", { value: {
        url: resolution.url,
        resolve: (id) => __nimbusImportMetaResolve(id, resolution.url),
      } });
      const requireData = (id) => {
        const resolved = __esmResolver.resolveSync(String(id), resolution.url);
        __esmResolver.assertLoadable(resolved);
        if (resolved.format === "builtin") return builtins[resolved.builtin];
        if (resolved.path) return __loadModule(resolved.path.replace(/^\\/+/, ""), resolved.url, false);
        throw nodeError(Error, "ERR_REQUIRE_ASYNC_MODULE", "Synchronous nested data-module import is unsupported");
      };
      let result;
      try {
        result = cell(mod.exports, requireData, mod, undefined, undefined);
      } catch (e) {
        __nimbusExplainCommonJSGlobalLike(e, resolution.url, false);
        throw e;
      }
      const namespace = () => __esmNamespaceOf(Object.keys(mod.exports).filter((n) => n !== "__esModule"), (n) => mod.exports[n]);
      if (result && typeof result.then === "function") {
        const pending = result.then(namespace, (error) => {
          __esmNamespaces.delete(resolution.url);
          __nimbusExplainCommonJSGlobalLike(error, resolution.url, true);
          throw error;
        });
        __esmNamespaces.set(resolution.url, pending);
        return pending;
      }
      ns = namespace();
    } else {
      throw nodeError(TypeError, "ERR_UNKNOWN_MODULE_FORMAT", "Unsupported data module MIME type: " + mediaType);
    }
  } else {
    const key = resolution.path.replace(/^\\/+/, "");
    // A query or a fragment is a module instance of its own: the interpreter's.
    const variant = resolution.url.includes("?") || resolution.url.includes("#");
    if (!variant) {
      const id = __nimbusEsmId("module", key);
      if (id !== -1) return __nimbusEsmImport(id);
      const facade = resolution.format === "json" ? __nimbusEsmId("json", key) : __nimbusEsmId("commonjs", key);
      if (facade !== -1) return __nimbusEsmImport(facade);
    }
    const esm = resolution.format === "module" || resolution.format === "detect";
    const evaluationKey = variant ? resolution.url : key;
    // An interpreted ES module links through its require(): the staged
    // modules it imports are the registry's to evaluate, first.
    if (esm) return __nimbusEsmLinkStaged(key, new Set()).then(() => __esmLoadInterpreted(resolution, key, evaluationKey, esm));
    return __esmLoadInterpreted(resolution, key, evaluationKey, esm);
  }
  __esmNamespaces.set(resolution.url, ns);
  return ns;
}
// Evaluate, in import order, the staged ES modules the interpreted module at
// \`key\` statically imports, and those its unstaged imports do, so the
// interpreter finds them evaluated rather than evaluating them itself.
async function __nimbusEsmLinkStaged(key, seen) {
  if (seen.has(key)) return;
  seen.add(key);
  const staged = __nimbusEsmId("module", key);
  const text = staged === -1 ? __readFileOr(key, null) : __nimbusEsmSourceText(staged);
  if (text === null) return;
  const parentUrl = __nimbusEsmUrl("/" + key);
  for (const request of __nimbusModuleRequests(key, text)) {
    if (request.kind !== "static") continue;
    let resolution;
    try { resolution = __esmResolver.resolveSync(request.specifier, parentUrl); } catch { continue; }
    if (!resolution.path) continue;
    const target = resolution.path.replace(/^\\/+/, "");
    const id = __nimbusEsmId("module", target);
    if (id === -1) await __nimbusEsmLinkStaged(target, seen);
    else if (__nimbusEsmRecord(id).state !== __ESM_DONE && !__nimbusEsmTainted(id)) {
      try { await __nimbusEsmImport(id); } catch {}
    }
  }
}
function __esmLoadInterpreted(resolution, key, evaluationKey, esm) {
  let ns;
  {
    // The import is the module's job: what escapes its evaluation is
    // explained as Node's loader explains it.
    let exports;
    try {
      exports = __loadModule(key, evaluationKey, !esm, undefined, esm);
    } catch (e) {
      __nimbusExplainCommonJSGlobalLike(e, resolution.url, false);
      throw e;
    }
    const namespace = () => {
      if (resolution.format === "json") return __esmNamespaceOf(["default"], () => exports);
      // An interpreted ES module's exports: its own names, live.
      if (exports && typeof exports === "object" && exports.__esModule === true) {
        return __esmNamespaceOf(Object.keys(exports).filter((name) => name !== "__esModule"), (name) => exports[name]);
      }
      // CommonJS: module.exports is the default, its names the named exports.
      const mod = exports;
      const names = new Set(mod && (typeof mod === "object" || typeof mod === "function") ? Object.keys(mod) : []);
      names.delete("default");
      names.add("default");
      return __esmNamespaceOf(names, (name) => name === "default" ? mod : mod[name]);
    };
    // A module with top-level await: the import resolves once its evaluation
    // completes, and rejects with what it throws.
    const evaluation = __moduleEvaluations.get(evaluationKey);
    if (evaluation !== undefined) {
      const pending = evaluation.then(namespace, (error) => {
        __esmNamespaces.delete(resolution.url);
        __nimbusExplainCommonJSGlobalLike(error, resolution.url, true);
        throw error;
      });
      __esmNamespaces.set(resolution.url, pending);
      return pending;
    }
    ns = namespace();
  }
  __esmNamespaces.set(resolution.url, ns);
  return ns;
}
return { __nimbusEsmEnter, __nimbusEsmSourceText, __nimbusEsmRequire, __nimbusEsmRequired, __nimbusEsmWarnTypeless, __nimbusEsmImport, __nimbusEsmRunEntry, __esmLoad };
} };
`;
}
