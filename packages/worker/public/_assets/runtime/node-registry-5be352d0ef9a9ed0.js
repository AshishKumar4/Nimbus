
const __nimbusRegistryRequire = __nimbusCreateRequire(import.meta.url);
// A bridged filesystem links only after its runner has installed the shims.
function __nimbusReadBundleFile(path, encoding) {
  return __nimbusRegistryRequire("node:fs").readFileSync(path, encoding);
}
// The built-ins the interpreter calls, captured now, before any program code
// runs (core interpreter/primordials.ts): the interpreter itself loads only
// when the program first produces code, by when it may have replaced them.
const {
  LAUNCH_PRIMORDIALS: __nimbusLaunchPrimordials,
  registerSource: __nimbusRegisterSource,
} = __nimbusRegistryRequire("./nimbus/interpreter-primordials.js");
const __nimbusCodeCells = new Map(__NIMBUS_CODE_CELLS.map((__row) => [__row[0], __row]));
// Where node:fs shows the map's modules: beside this main module, /bundle/.
const __NIMBUS_BUNDLE_FILES = decodeURIComponent(new URL("./", import.meta.url).pathname);
// The URL import() in the module at a path resolves against (moduleImporterUrl).
const __nimbusModuleImporterUrl = function moduleImporterUrl(path) {
    return path.startsWith('data:') ? 'data:text/javascript,' : 'file:///' + path.replace(/^\/+/, '');
};
// The wrapper function of the cell at a VFS key, compiled by the registry the
// first time it is asked for, with the module's own Function (THE WRAPPER);
// null when the launch's map has no such cell. A cell that does not compile
// leads its SyntaxError's stack with where.
function __nimbusModuleCell(key) {
  const __row = __nimbusCodeCells.get(key);
  if (!__row) return null;
  try {
    return __nimbusRegistryRequire("./" + __row[1])(globalThis.__nimbusCodeOrigin(__nimbusModuleImporterUrl(key)).Function);
  } catch (e) {
    __nimbusDecorateSyntaxError(e, __row[1]);
    throw e;
  }
}
// Whether the cell at a VFS key is an ES module the launch lowered (CommonJsCellRow).
function __nimbusModuleCellIsEsModule(key) {
  const __row = __nimbusCodeCells.get(key);
  return __row !== undefined && __row[6] === 1;
}
// The entry's wrapper function, with the Function of the entry's own URL,
// importer. A SyntaxError from compiling it carries no location (the
// registry compiles on require, and V8 reports the requiring frame), so its
// stack leads with where it is, as Node's does (__nimbusDecorateSyntaxError).
function __nimbusEntryWrapper(name, importer) {
  try {
    return __nimbusRegistryRequire("./" + name)(globalThis.__nimbusCodeOrigin(importer).Function);
  } catch (e) {
    __nimbusDecorateSyntaxError(e, name);
    throw e;
  }
}
// ── Frames, as Node names and places them ──
// The launch's entry: [moduleName, the name Node gives its frames' file (its
// path, an ES module's file: URL, [eval], [stdin], an ES module of -e or stdin
// [eval1] in the launch's directory), the wrapper's head, 1 for an ES module,
// the wrapper's tail].
const __nimbusStackEntry = typeof __NIMBUS_STACK_ENTRY === "undefined" ? null : __NIMBUS_STACK_ENTRY;
const __NIMBUS_BUNDLE_URL = new URL("./", import.meta.url).href;
let __nimbusCellsByName = null;
const __nimbusModules = new Map();
// A stack frame's module, by its URL in the map: the cell's VFS path (or the
// entry's name), whether it is an ES module, the wrapper's head on its first
// line, and whether its first line was a shebang. Null for a frame of
// anything else: this runner, the shims, a builtin.
function __nimbusFrameModule(url) {
  if (typeof url !== "string" || !url.startsWith(__NIMBUS_BUNDLE_URL)) return null;
  return __nimbusModuleNamed(url.slice(__NIMBUS_BUNDLE_URL.length));
}
// The module of the launch's cell at `path` (no leading slash), and the entry's; null for none.
let __nimbusCellsByPath = null;
function __nimbusModuleAtPath(path) {
  __nimbusCellsByPath ??= new Map(__NIMBUS_CODE_CELLS.map((row) => [row[0], row[1]]));
  const name = __nimbusCellsByPath.get(path);
  return name === undefined ? null : __nimbusModuleNamed(name);
}
function __nimbusEntryModule() {
  return __nimbusStackEntry === null ? null : __nimbusModuleNamed(__nimbusStackEntry[0]);
}
function __nimbusModuleNamed(name) {
  let module = __nimbusModules.get(name);
  if (module !== undefined) return module;
  if (__nimbusStackEntry !== null && name === __nimbusStackEntry[0]) {
    module = { name, path: null, file: __nimbusStackEntry[1], head: __nimbusStackEntry[2], tail: __nimbusStackEntry[4], esModule: __nimbusStackEntry[3] === 1, hashbang: false };
  } else {
    __nimbusCellsByName ??= new Map(__NIMBUS_CODE_CELLS.map((row) => [row[1], row]));
    const row = __nimbusCellsByName.get(name);
    if (row === undefined) return null;
    module = { name, path: "/" + row[0], file: null, head: row[2], tail: row[3], esModule: row[6] === 1, hashbang: row[4] === 1 };
  }
  __nimbusModules.set(name, module);
  return module;
}
function __nimbusFileUrl(path) {
  const url = new URL("file://");
  url.pathname = path;
  return url.href;
}
// What a module's file is called in a stack: its path, an ES module's file: URL.
function __nimbusFrameFile(module) {
  if (module.path === null) return module.file;
  module.frameFile ??= module.esModule ? __nimbusFileUrl(module.path) : module.path;
  return module.frameFile;
}
// A lowered ES module's edits that moved its columns, by line: [source column,
// generated length, source text, 1 for a call] (async-module-lowering.ts
// ColumnMap), read once from the module beside its own; null for none.
function __nimbusColumnEdits(module) {
  if (module.columns !== undefined) return module.columns;
  module.columns = null;
  if (!module.esModule) return null;
  let entries;
  try {
    entries = JSON.parse(__nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + module.name + ".columns", "utf8"));
  } catch {
    return null;
  }
  const columns = new Map();
  for (const entry of entries) {
    const line = columns.get(entry[0]) ?? [];
    line.push(entry);
    columns.set(entry[0], line);
  }
  module.columns = columns;
  return columns;
}
// A 1-based column of a module's line as its source has it, from where V8
// places it in the emit (a first line's past the wrapper's head).
function __nimbusSourceColumn(module, line, column) {
  const edits = __nimbusColumnEdits(module)?.get(line);
  if (edits === undefined) return column;
  let delta = 0;
  for (const [, at, length, text, call] of edits) {
    const start = at + delta;
    if (column - 1 < start) break;
    if (column - 1 < start + length || (call === 1 && column - 1 === start + length)) return at + 1;
    delta += length - text.length;
  }
  return column - delta;
}
// The inverse: where a source column of a module's line is in its emit.
function __nimbusGeneratedColumn(module, line, column) {
  const edits = __nimbusColumnEdits(module)?.get(line);
  if (edits === undefined) return column;
  let delta = 0;
  for (const [, at, length, text] of edits) {
    if (column - 1 < at) break;
    if (column - 1 < at + text.length) return at + delta + 1;
    delta += length - text.length;
  }
  return column + delta;
}
// A module's line as its source has it, from the emit's.
// A module's text as it was compiled, before any lowering: where Node reads
// its source map's URL from and measures its lines.
function __nimbusModuleSourceText(module) {
  if (module === null) return null;
  const text = __nimbusFrameModuleText(module);
  if (text === null) return null;
  const body = text.slice(module.head, text.length - module.tail);
  if (__nimbusColumnEdits(module) === null) return body;
  const parts = body.split(/(\r\n|[\n\r\u2028\u2029])/);
  for (let i = 0; i < parts.length; i += 2) parts[i] = __nimbusSourceLine(module, i / 2 + 1, parts[i]);
  return parts.join("");
}
function __nimbusSourceLine(module, line, emitted) {
  const edits = __nimbusColumnEdits(module)?.get(line);
  if (edits === undefined) return emitted;
  let source = "";
  let at = 0;
  let delta = 0;
  for (const [, column, length, text] of edits) {
    source += emitted.slice(at, column + delta) + text;
    at = column + delta + length;
    delta += length - text.length;
  }
  return source + emitted.slice(at);
}
let __nimbusModulesByFile = null;
// The module whose frames read `file` (__nimbusFrameFile), or null.
function __nimbusModuleOfFile(file) {
  if (__nimbusModulesByFile === null) {
    __nimbusModulesByFile = new Map();
    const add = (name) => {
      const module = __nimbusModuleNamed(name);
      if (module !== null) __nimbusModulesByFile.set(__nimbusFrameFile(module), module);
    };
    for (const row of __NIMBUS_CODE_CELLS) add(row[1]);
    if (__nimbusStackEntry !== null) add(__nimbusStackEntry[0]);
  }
  return __nimbusModulesByFile.get(file) ?? null;
}
// A frame in a module of the program: its place in the module's file, as
// Node's frame names it (a first line's column without the wrapper's head).
function __nimbusFrameLocation(site) {
  const fileName = site.getFileName();
  const module = __nimbusFrameModule(fileName);
  if (module === null) return null;
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  if (line === null || column === null) return null;
  const at = __nimbusSourceColumn(module, line, line === 1 ? column - module.head : column);
  return { from: fileName + ":" + line + ":" + column, module, file: __nimbusFrameFile(module), line, column: at };
}
function __nimbusFrameText(site, location) {
  const text = String(site);
  if (location === null) return text;
  const at = text.lastIndexOf(location.from);
  return at === -1 ? text : text.slice(0, at) + location.file + ":" + location.line + ":" + location.column + text.slice(at + location.from.length);
}
// A call site of the program's code as Node's reads: its file and place;
// anything else, V8's own.
class __NimbusCallSite {
  #site;
  #location;
  constructor(site, location) {
    this.#site = site;
    this.#location = location;
  }
  static of(site) {
    const location = __nimbusFrameLocation(site);
    if (location === null) return site;
    if (!__NimbusCallSite.delegates) {
      __NimbusCallSite.delegates = true;
      for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(site))) {
        if (name === "constructor" || Object.hasOwn(__NimbusCallSite.prototype, name) || typeof site[name] !== "function") continue;
        Object.defineProperty(__NimbusCallSite.prototype, name, {
          value: function (...args) { return this.#site[name](...args); }, writable: true, configurable: true,
        });
      }
    }
    return new __NimbusCallSite(site, location);
  }
  getFileName() { return this.#location.file; }
  getScriptNameOrSourceURL() { return this.#location.file; }
  getLineNumber() { return this.#location.line; }
  getColumnNumber() { return this.#location.column; }
  getEnclosingLineNumber() { return this.#site.getEnclosingLineNumber(); }
  getEnclosingColumnNumber() {
    const line = this.#site.getEnclosingLineNumber();
    const column = this.#site.getEnclosingColumnNumber();
    if (line === null || column === null) return column;
    return __nimbusSourceColumn(this.#location.module, line, line === 1 ? column - this.#location.module.head : column);
  }
  toString() { return __nimbusFrameText(this.#site, this.#location); }
}
// What a runtime's shims format a stack with instead (node --enable-source-maps): null to keep the hook's own.
let __nimbusStackFormatter = null;
// V8's call sites, the program's at their file's places, as Node's bindings
// read them natively: of the stack `holder` captured and nothing read yet,
// or, given `count`, of `count` frames captured now below `above`. The
// program's Error.prepareStackTrace, Error.stackTraceLimit and
// Error.captureStackTrace take no part, and Error's own properties are left
// as they were.
//
// Named limit: V8 hands JavaScript a stack's sites only through those two
// properties, so with either made non-configurable and non-writable there is
// none to read, and this answers [] (util.getCallSites [],
// isInsideNodeModules false, assert's message without its source
// expression) where Node's bindings read V8 directly. workerd's native
// node:util getCallSites ignores both, but drops every frame with no function
// name (an arrow, a module's top level), which Node keeps.
const __nimbusCaptureStackTrace = Error.captureStackTrace;
const __nimbusSites = (error, sites) => sites.map(__NimbusCallSite.of);
function __nimbusStackSites(holder, count, above) {
  const set = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(Error, name);
    if (descriptor === undefined || descriptor.configurable) {
      Object.defineProperty(Error, name, { value, writable: true, enumerable: name === "stackTraceLimit", configurable: true });
    } else if (descriptor.writable) {
      Error[name] = value;
    } else {
      throw new TypeError("Error." + name + " is locked");
    }
    return () => {
      if (descriptor === undefined) delete Error[name];
      else if (descriptor.configurable) Object.defineProperty(Error, name, descriptor);
      else Error[name] = descriptor.value;
    };
  };
  const restores = [];
  try {
    restores.push(set("prepareStackTrace", __nimbusSites));
    if (count !== undefined) {
      restores.push(set("stackTraceLimit", count));
      Reflect.apply(__nimbusCaptureStackTrace, Error, [holder, above]);
    }
    const sites = holder.stack;
    return Array.isArray(sites) ? sites : [];
  } catch {
    return [];
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}
function __nimbusUseStackFormatter(format) {
  __nimbusStackFormatter = format;
}
{
  let __userPrepare;
  const __apply = Reflect.apply;
  const __prepare = function prepareStackTrace(error, sites) {
    // As Node's prepareStackTraceCallback calls it: a method of Error.
    if (typeof __userPrepare === "function") return __apply(__userPrepare, globalThis.Error, [error, sites.map(__NimbusCallSite.of)]);
    let stack;
    try {
      stack = Error.prototype.toString.call(error);
    } catch {
      stack = "<error>";
    }
    const formatted = __nimbusStackFormatter === null ? null : __nimbusStackFormatter(error, stack, sites);
    if (formatted !== null) return formatted;
    for (const site of sites) stack += "\n    at " + __nimbusFrameText(site, __nimbusFrameLocation(site));
    return stack;
  };
  Object.defineProperty(Error, "prepareStackTrace", {
    get() { return __prepare; },
    // Restoring the hook a program read restores the default.
    set(value) { __userPrepare = value === __prepare ? undefined : value; },
    configurable: true,
  });
}
// A frame module's text as the registry compiled it, or null.
function __nimbusFrameModuleText(module) {
  try {
    return __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + module.name, "utf8");
  } catch {
    return null;
  }
}
// Where V8 would report a throw at offset `offset` of a module's text, or the
// syntax error that stops its compile (offset -1): the interpreter's parser
// (core interpreter fatalLocation), loaded only for a report.
function __nimbusFatalLocation(text, goal, offset) {
  try {
    return __nimbusRegistryRequire("./nimbus/interpreter.js").fatalLocation(text, goal, offset);
  } catch {
    return null;
  }
}
// What Node's stack carries for a module that does not compile: where
// (decorateErrorStack: the arrow, then the stack), so its report prints it
// once (node-shims.ts __nimbusFatalReport).
const __nimbusDecorated = new WeakSet();
function __nimbusDecorateSyntaxError(e, name) {
  if (!(e instanceof SyntaxError) || typeof e.stack !== "string" || __nimbusDecorated.has(e)) return;
  const arrow = typeof globalThis.__nimbusSyntaxErrorArrow === "function" ? globalThis.__nimbusSyntaxErrorArrow(__nimbusModuleNamed(name)) : null;
  if (arrow === null) return;
  e.stack = arrow + "\n" + e.stack;
  __nimbusDecorated.add(e);
}
// The cell's own text, read back from the module map under its module name.
function __nimbusModuleCellSource(row) {
  const __text = __nimbusReadBundleFile(__NIMBUS_BUNDLE_FILES + row[1], "utf8");
  const __cell = __text.slice(row[2], __text.length - row[3]);
  return row[4] ? "#!" + __cell.slice(2) : __cell;
}
// The data bundle, with every adopted cell added as a getter: the store reads
// each as it takes it, so no more than one cell's text is in hand at a time.
function __nimbusWithCodeCells(bundle) {
  for (const __row of __NIMBUS_CODE_CELLS) {
    if (!__row[5]) continue;
    Object.defineProperty(bundle, __row[0], { enumerable: true, configurable: true, get: () => __nimbusModuleCellSource(__row) });
  }
  return bundle;
}
// ── Runtime code (see RUNTIME CODE in commonjs-cell.ts) ──
const __nimbusRuntimeKeys = new Set(__NIMBUS_RUNTIME_CODE);
const __nimbusRuntimeLedger = new Map();
let __nimbusRuntimeLedgerBytes = 0;
let __nimbusRuntimeCodeReporter = null;
let __nimbusCodeNotifyQueued = false;
const __nimbusCodeAcknowledged = new Set();
const __nimbusModulesAcknowledged = new Set();
const __nimbusReadsAcknowledged = new Set();
let __nimbusCodeSending = Promise.resolve();
// A server may catch a compile miss (SSR error page) and never exit. Persist
// new code independently of exit, in bounded batches, and acknowledge only
// after the session has committed it. Retain the ledger for the exit backstop.
function __nimbusFlushRuntimeCode(supervisor) {
  if (!supervisor || typeof supervisor.reportRuntimeCode !== 'function') return Promise.resolve();
  const send = __nimbusCodeSending.then(async () => {
    // Let outstanding repairs land and retire the misses they proved absent
    // first: a path the authority does not have was the program's not-found
    // branch, not something the next launch should stage.
    if (typeof globalThis.__nimbusVfsResidencySettle === "function") {
      try { await globalThis.__nimbusVfsResidencySettle(); } catch {}
    }
    const entries = [...__nimbusRuntimeLedger].filter(([key]) => !__nimbusCodeAcknowledged.has(key));
    const modules = [...(globalThis.__nimbusModuleMisses || [])].filter((path) => !__nimbusModulesAcknowledged.has(path));
    const reads = [...(globalThis.__nimbusVfsResidencyMisses || [])].filter((path) => !__nimbusReadsAcknowledged.has(path));
    const batches = Math.max(Math.ceil(entries.length / 32), Math.ceil(modules.length / 128), Math.ceil(reads.length / 128));
    for (let i = 0; i < batches; i++) {
      const batch = entries.slice(i * 32, (i + 1) * 32);
      const executed = modules.slice(i * 128, (i + 1) * 128);
      const read = reads.slice(i * 128, (i + 1) * 128);
      await supervisor.reportRuntimeCode(batch.map(([, entry]) => entry), executed, read);
      for (const [key] of batch) __nimbusCodeAcknowledged.add(key);
      for (const path of executed) __nimbusModulesAcknowledged.add(path);
      for (const path of read) __nimbusReadsAcknowledged.add(path);
    }
  });
  __nimbusCodeSending = send.catch(() => undefined);
  return send;
}
function __nimbusNotifyRuntimeCode() {
  if (!__nimbusRuntimeCodeReporter || __nimbusCodeNotifyQueued) return;
  __nimbusCodeNotifyQueued = true;
  queueMicrotask(() => {
    __nimbusCodeNotifyQueued = false;
    // A failed report stays unacknowledged: startup/HTTP/exit flush retries it.
    __nimbusRuntimeCodeReporter().catch((error) => console.error("Nimbus: runtime code persistence failed", error));
  });
}
const __nimbusRuntimeModuleScope = function runtimeModuleScope(path) {
    // Inline JS modules all have an opaque import base. Their text identifies
    // compiled code; URL/fragment identity belongs to the evaluated namespace
    // and import.meta, not to another compiled copy of the same source.
    if (path.startsWith('data:'))
        return ['data:', '.mjs'];
    const p = path.replace(/^\/+/, '');
    const slash = p.lastIndexOf('/');
    const base = p.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    return [slash < 0 ? '' : p.slice(0, slash), dot > 0 ? base.slice(dot) : ''];
};
function __nimbusRuntimeCodeKey(entry) {
  const __source = entry.kind === "module"
    ? JSON.stringify(["module", ...__nimbusRuntimeModuleScope(entry.path), entry.text])
    : entry.kind === "expression"
      ? JSON.stringify(["expression", entry.code])
      : entry.kind === "wasm"
        ? JSON.stringify(["wasm", entry.bytes])
        : JSON.stringify([entry.kind, entry.params, entry.body]);
  return { source: __source, key: __nimbusCreateHash("sha256").update(__source).digest("hex") };
}
// This launch's module for the code, or undefined when it was not staged (or
// the process asked for the interpreter: RUNTIME CODE in commonjs-cell.ts).
function __nimbusRuntimeCodeStaged(key) {
  if (!__nimbusRuntimeKeys.has(key)) return undefined;
  const __env = globalThis.process && globalThis.process.env;
  if (__env && __env.NIMBUS_RUNTIME_CODE === "interpret") return undefined;
  return __nimbusRegistryRequire("./gen/" + key + ".js");
}
function __nimbusRuntimeCodeRecord({ source, key }, entry) {
  const __charge = source.length + (entry.kind === "module" ? entry.path.length : 0) + 512;
  if (
    !__nimbusRuntimeLedger.has(key)
    && __nimbusRuntimeLedger.size < 1024
    && __nimbusRuntimeLedgerBytes + __charge <= 8388608
  ) {
    __nimbusRuntimeLedger.set(key, entry);
    __nimbusRuntimeLedgerBytes += __charge;
    __nimbusNotifyRuntimeCode();
  }
}
// The interpreter (core/interpreter), from this launch's map, on first use:
// a program that produces no runtime code never compiles it.
let __nimbusInterpreter = null;
function __nimbusRuntimeInterpreter() {
  if (__nimbusInterpreter === null) {
    const { createInterpreter } = __nimbusRegistryRequire("./nimbus/interpreter.js");
    __nimbusInterpreter = createInterpreter(__nimbusRegistryRequire("./nimbus/interpreter-ops.js"), {
      dynamicImport: (parentUrl, specifier, options) => globalThis.__nimbusDynamicImport(parentUrl, specifier, options),
      primordials: __nimbusLaunchPrimordials,
    });
  }
  return __nimbusInterpreter;
}
// A staged module's code from an origin (runtimeFunctionModule): a module
// takes the origin's Function; a constructor's code takes its import() too,
// or the shape that reads the global Function for an origin without one,
// and a function whose import() calls were routed answers toString with the
// source it was built from.
function __nimbusRuntimeCodeStagedBuild(staged, kind, origin) {
  if (kind === "module") return staged(origin.Function);
  const fn = origin.Function === undefined && staged.unbound !== undefined
    ? staged.unbound(origin.import)
    : staged(origin.import, origin.Function);
  if (staged.source !== undefined && typeof fn === "function") __nimbusRegisterSource(fn, staged.source);
  return fn;
}
// The compiled code from its origin (RUNTIME CODE): this launch's module for
// it when an earlier launch staged it; otherwise recorded for the next
// launch and interpreted. A SyntaxError is what compiling it natively throws
// too.
function __nimbusRuntimeCodeCompile(entry, describe, origin) {
  const __id = __nimbusRuntimeCodeKey(entry);
  const __staged = __nimbusRuntimeCodeStaged(__id.key);
  if (__staged !== undefined) return __nimbusRuntimeCodeStagedBuild(__staged, entry.kind, origin);
  __nimbusRuntimeCodeRecord(__id, entry);
  const __interpreter = __nimbusRuntimeInterpreter();
  try {
    if (entry.kind === "module") return __interpreter.compileModule(entry.path, entry.text, origin);
    if (entry.kind === "expression") return __interpreter.compileExpression(entry.code, origin);
    return __interpreter.compileFunction(entry.kind, entry.params, entry.body, origin);
  } catch (e) {
    if (!e || e.code !== "ERR_NIMBUS_INTERPRETER_UNSUPPORTED") throw e;
    throw __nimbusNodeError(EvalError, "ERR_NIMBUS_CODE_NEXT_LAUNCH", describe + " was produced after this launch started, and a Worker compiles code only from the module map it was launched with; it is staged, and the next launch of this command compiles it. (" + e.message + ")", { key: __id.key });
  }
}
// The wrapper function of a file that is not one of the launch's cells, with
// its own Function and import() (THE WRAPPER).
function __nimbusRuntimeModule(path, text) {
  const __origin = globalThis.__nimbusCodeOrigin(__nimbusModuleImporterUrl(path));
  return __nimbusRuntimeCodeCompile({ kind: "module", path, text: String(text) }, "Module '/" + path + "'", __origin);
}
globalThis.__nimbusRuntimeCode = Object.freeze({
  // A constructor's code, from the origin the constructor carries (node-shims.ts).
  compileFunction(kind, params, body, origin) {
    if (!["function","async","generator","asyncGenerator"].includes(kind)) throw new TypeError("compileFunction: unknown kind " + String(kind));
    return __nimbusRuntimeCodeCompile({ kind, params: Array.from(params, String), body: String(body) }, "Code handed to the " + kind + " constructor", origin);
  },
  // vm.runInThisContext's code (node-shims): a function returning its value,
  // which node-shims calls with the global object as `this`, a script's own.
  compileExpression(code, origin) {
    return __nimbusRuntimeCodeCompile({ kind: "expression", code: String(code) }, "Code handed to vm.runInThisContext", origin);
  },
  compileModule(path, text) {
    return __nimbusRuntimeModule(String(path).replace(/^\/+/, ""), text);
  },
  // A wasm image the WebAssembly seam (node-shims) refused, for the next
  // launch to carry: whether it is recorded (not over the limit, and the
  // ledger had room).
  recordWasm(bytes) {
    const __view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (__view.byteLength > 1048576) return false;
    let __binary = "";
    for (let i = 0; i < __view.length; i += 0x8000) __binary += String.fromCharCode.apply(null, __view.subarray(i, i + 0x8000));
    const __entry = { kind: "wasm", bytes: btoa(__binary) };
    const __id = __nimbusRuntimeCodeKey(__entry);
    __nimbusRuntimeCodeRecord(__id, __entry);
    return __nimbusRuntimeLedger.has(__id.key);
  },
  // A line typed at the JavaScript REPL (core runtime/js-repl.ts): the async
  // function the interpreter's replLineBody makes of it, compiled as an
  // AsyncFunction constructor's is; null while more lines may complete it.
  compileReplLine(code) {
    const { replLineBody } = __nimbusRegistryRequire("./nimbus/interpreter.js");
    const __body = replLineBody(String(code));
    return __body === null ? null : __nimbusRuntimeCodeCompile({ kind: "async", params: [], body: __body }, "Code typed at the REPL", globalThis.__nimbusUnboundOrigin);
  },
});
// What this launch could not compile, for the next launch of its command.
function __nimbusRuntimeCodeLedger() {
  return [...__nimbusRuntimeLedger.values()];
}
