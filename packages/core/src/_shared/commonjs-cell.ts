/**
 * commonjs-cell.ts — how a node process's module cell reaches the guest as a
 * Worker Loader module that the guest's module registry compiles on first use.
 *
 * WHAT THE REGISTRY DOES, AND WHAT IT CANNOT
 * ──────────────────────────────────────────
 * Node guests run with `new_module_registry` (GUEST_COMPAT_FLAGS), whose
 * registry compiles a module when it is first required and not before, so a
 * cell the program never loads costs no compile and no heap
 * (workerd docs/reference/detail/new-module-registry.md, "Fully lazy").
 * That laziness is all Nimbus takes from it for a program's own modules. The
 * registry cannot load a Node program's graph itself, for four reasons of the
 * platform, each verified against workerd 1.20260928.1:
 *   - Resolution is URL resolution and nothing more. A `{ cjs }` module's own
 *     `require("lodash")` resolves to `file:///bundle/<dir>/lodash` and fails
 *     "Module not found": no node_modules walk, no package.json exports or
 *     main, no extension or index probing. Nimbus's resolver
 *     (require-resolver.ts, the shims' __resolveFrom) stays.
 *   - Every `file:` module lives under `file:///bundle/` (modules-new.c++
 *     normalizeModuleName / isValidBundleModuleUrl), so the registry's own
 *     `import.meta.url` could never be the VFS path a program hands to
 *     fileURLToPath. import.meta stays module metadata the shims supply.
 *   - A Worker Loader `{ cjs }` module takes no named exports
 *     (worker-loader.c++ extractSource), so an ES module could not import a
 *     CommonJS package's names from one. ESM stays lowered to CommonJS.
 *   - The map is fixed at load; a program writes and requires files the load
 *     never saw. See RUNTIME CODE below for those.
 * So every cell is CommonJS by the time it is wrapped here, and it is the
 * shims' `require` that asks the registry for it by the module name below.
 *
 * THE WRAPPER
 * ───────────
 * The module a cell becomes exports Node's module wrapper function, which the
 * shims call with their own exports, require, module, __filename and
 * __dirname:
 *
 *   module.exports = (function (exports, require, module, __filename, __dirname) {<"use strict";>{<cell>
 *   }});
 *
 * The cell sits in a BLOCK inside the function, not in the function body
 * itself, for one case: an ES module esbuild lowered to CommonJS keeps its own
 * top-level `const require = createRequire(import.meta.url)` (or `const
 * __dirname = …`), and a lexical declaration of a parameter's name in the
 * body is a SyntaxError. In a block it shadows the parameter instead, which is
 * what the module meant. `var` and function declarations still reach the
 * function scope and redeclare the parameter exactly as in Node's own
 * wrapper, and top-level `return` and `arguments` mean what they mean there.
 * A block is not a directive prologue, so a cell that opens with
 * "use strict" has the directive restated in the function body, where it
 * applies. The wrapper is on the cell's first line, so every stack frame
 * carries the cell's own line numbers, under the module's
 * `file:///bundle/vfs/<path>` name.
 *
 * RUNTIME CODE
 * ────────────
 * Code that first exists while the program runs — a file written and then
 * required (Vite's `.vite-temp/vite.config.ts.timestamp-*.mjs`), or text
 * handed to a Function constructor (a module runner's `new AsyncFunction`) —
 * cannot compile in the launch that produced it. The map is the only way code
 * reaches a Worker, and it cannot grow after load: Worker Loader builds it
 * once from the WorkerCode (workerd src/workerd/api/worker-loader.c++
 * extractSource), a dynamic worker runs with no module fallback
 * (src/workerd/server/server.c++ ~L5517-5521, `.moduleFallback = kj::none`,
 * `.isDynamic = true`, v1.20260928.1), the registry is immutable once built,
 * and `data:` modules are refused "due to dynamic eval restrictions"
 * (src/workerd/jsg/modules-new.c++ ~L2001-2007). Request-time `eval` and
 * `new Function` throw.
 *
 * So such code is staged for the NEXT launch of the same command. The guest
 * records it in a ledger that travels with the existing residency-miss report
 * (the one-shot envelope, the resident exit report); the supervisor keeps it
 * content-addressed for that command's bundle key; the next launch carries it
 * as `gen/<sha256>.js` modules, compiled on first use. A key is the SHA-256 of
 * the text (runtimeCodeKeySource), not of a path, so a file written under a
 * fresh name each run still converges. Text that changes every run (an edit,
 * then the module runner's transform of it) costs one relaunch per change.
 */
import { createHash } from 'node:crypto';
import { tokenizer, tokTypes, type Token } from 'acorn';

/** Directory under the guest's bundle root that holds a process's cells. */
const CELL_DIR = 'vfs/';
/**
 * Directory for the process's entry code. Apart from the cells because the
 * entry is the script as the runtime prepared it, which the same file's cell
 * need not be, and a file required by the program gets its own evaluation.
 */
const ENTRY_DIR = 'entry/';

/** Closes the block, the function and the parenthesized expression. */
export const COMMONJS_CELL_TAIL = '\n}});';

/**
 * A path as a module name under `dir`: the path itself wherever the
 * registry's URL parsing keeps it. A name is resolved as a URL against the
 * bundle base, which percent-encodes what a path may not carry, strips a
 * `?query` and `#fragment`, and reads `\` as `/`. Those four characters are
 * therefore escaped, and `%` with them so no path can spell another's escape.
 * The shims require `./` + the name from the main module at the bundle root;
 * the same parse resolves both.
 */
function moduleNameUnder(dir: string, path: string): string {
  return dir + path.replace(/^\/+/, '').replace(/[%#?\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** The Worker Loader module name for the cell at VFS key `key` (a path without its leading slash). */
export function commonJsCellModuleName(key: string): string {
  return moduleNameUnder(CELL_DIR, key);
}

/** The module name of a process's entry code, `filename` being the script's path or `[eval]`. */
export function commonJsEntryModuleName(filename: string): string {
  return moduleNameUnder(ENTRY_DIR, filename);
}

/**
 * Whether the guest can read a cell's module text back from its bundle
 * filesystem (`/bundle/vfs/<path>`, workerd's node:fs view of the module map)
 * by the cell's own path. workerd's lookup percent-decodes the path it is
 * given and reads `\` as a separator, so a path carrying `%` or `\` names a
 * different file there; such a cell also travels as data.
 */
export function commonJsCellReadsBack(key: string): boolean {
  return !/[%\\]/.test(key);
}

export interface WrappedCommonJsCell {
  /** The module text. */
  text: string;
  /** Characters of wrapper before the cell. */
  head: number;
  /** The cell opened with a shebang, which the text carries as `//`. */
  hashbang: boolean;
}

/**
 * Wrap a CommonJS cell as a `{ cjs }` module whose export is Node's module
 * wrapper function. A leading shebang becomes a line comment of the same
 * length (Node strips it too; `#!` is not valid inside a function).
 */
export function wrapCommonJsCell(cell: string): WrappedCommonJsCell {
  const hashbang = cell.charCodeAt(0) === 35 && cell.charCodeAt(1) === 33;
  const body = hashbang ? '//' + cell.slice(2) : cell;
  const head = 'module.exports = (function (exports, require, module, __filename, __dirname) {'
    + (opensWithUseStrict(body) ? '"use strict";' : '') + '{';
  return { text: head + body + COMMONJS_CELL_TAIL, head: head.length, hashbang };
}

/** Tokens that continue an expression across a line break, so ASI does not end a directive there. */
const CONTINUES_EXPRESSION = new Set([
  tokTypes.parenL, tokTypes.bracketL, tokTypes.dot, tokTypes.questionDot, tokTypes.backQuote,
  tokTypes.comma, tokTypes.question, tokTypes.eq, tokTypes.assign, tokTypes.plusMin, tokTypes.modulo,
  tokTypes.star, tokTypes.slash, tokTypes.starstar, tokTypes.logicalOR, tokTypes.logicalAND,
  tokTypes.bitwiseOR, tokTypes.bitwiseXOR, tokTypes.bitwiseAND, tokTypes.equality, tokTypes.relational,
  tokTypes.bitShift, tokTypes.coalesce, tokTypes._in, tokTypes._instanceof,
]);

/**
 * Whether the source's directive prologue (ECMA-262 §11.2.1) holds a
 * "use strict" directive: its leading string-literal statements, one of which
 * is exactly `'use strict'` or `"use strict"`.
 */
export function opensWithUseStrict(source: string): boolean {
  let tokens: { getToken(): Token };
  let token: Token;
  try {
    tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'script' });
    token = tokens.getToken();
  } catch {
    return false;
  }
  for (;;) {
    if (token.type !== tokTypes.string) return false;
    const raw = source.slice(token.start + 1, token.end - 1);
    let next: Token;
    try { next = tokens.getToken(); } catch { return false; }
    let directive: boolean;
    if (next.type === tokTypes.semi) {
      directive = true;
      try { next = tokens.getToken(); } catch { return raw === 'use strict'; }
    } else {
      directive = next.type === tokTypes.eof || next.type === tokTypes.braceR
        || (/[\n\r\u2028\u2029]/.test(source.slice(token.end, next.start)) && !CONTINUES_EXPRESSION.has(next.type));
    }
    if (!directive) return false;
    if (raw === 'use strict') return true;
    token = next;
  }
}

/**
 * One row of the table a launch's main module carries for its cells:
 * `[key, moduleName, head, hashbang, adopt]`. `adopt` is 1 when the process's
 * store takes the cell's file content from the module text (read back from
 * the bundle filesystem) rather than from a data cell: the store's one copy
 * of that file, and the map's only.
 */
export type CommonJsCellRow = [key: string, moduleName: string, head: number, hashbang: 0 | 1, adopt: 0 | 1];

/** Bytes of runtime code one launch records, and the supervisor keeps. */
export const RUNTIME_CODE_MAX_BYTES = 8 * 1024 * 1024;

/** The constructors whose text a program can hand in at runtime. */
const RUNTIME_FUNCTION_HEADS = {
  function: 'function',
  async: 'async function',
  generator: 'function*',
  asyncGenerator: 'async function*',
} as const;
export type RuntimeFunctionKind = keyof typeof RUNTIME_FUNCTION_HEADS;

/** Code a launch could not compile, as its ledger reports it. */
export type RuntimeCodeEntry =
  | { kind: RuntimeFunctionKind; params: string[]; body: string }
  | { kind: 'module'; path: string; text: string };

/**
 * What a runtime-code key hashes: the constructor's arguments, or a file's
 * text. The guest hashes the same string with the same function (its sync
 * node:crypto), so both sides name the same module.
 */
function runtimeCodeKeySource(entry: RuntimeCodeEntry): string {
  return entry.kind === 'module'
    ? JSON.stringify(['module', entry.text])
    : JSON.stringify([entry.kind, entry.params, entry.body]);
}

/** The key of a piece of runtime code: SHA-256 of runtimeCodeKeySource, hex. */
export function runtimeCodeKey(entry: RuntimeCodeEntry): string {
  const digest = createHash('sha256').update(new TextEncoder().encode(runtimeCodeKeySource(entry))).digest();
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The module name of the runtime code with key `key`. */
export function runtimeCodeModuleName(key: string): string {
  return `gen/${key}.js`;
}

/** A ledger entry as the supervisor receives it: shape-checked, or null. */
export function parseRuntimeCodeEntry(value: unknown): RuntimeCodeEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'module') {
    return typeof v.path === 'string' && typeof v.text === 'string'
      ? { kind: 'module', path: v.path, text: v.text } : null;
  }
  if (typeof v.kind !== 'string' || !Object.hasOwn(RUNTIME_FUNCTION_HEADS, v.kind)) return null;
  if (!Array.isArray(v.params) || !v.params.every((p) => typeof p === 'string') || typeof v.body !== 'string') return null;
  return { kind: v.kind as RuntimeFunctionKind, params: [...v.params as string[]], body: v.body };
}

/**
 * The `{ cjs }` module text for a Function-constructor call: it exports the
 * function V8 builds for `new <Kind>Function(...params, body)` — named
 * `anonymous`, its source `<head> anonymous(<params>\n) {\n<body>\n}`, the body
 * from line 3. A constructor's function closes over the global scope, where a
 * CommonJS module's body would see workerd's five CommonJS names
 * (src/workerd/api/commonjs.h CommonJsModuleContext: require, module,
 * exports, __filename, __dirname), so an enclosing function rebinds those five
 * to the global object's.
 */
export function runtimeFunctionModule(kind: RuntimeFunctionKind, params: readonly string[], body: string): string {
  return 'module.exports = (function (require, module, exports, __filename, __dirname) { return ('
    + `${RUNTIME_FUNCTION_HEADS[kind]} anonymous(${params.join(',')}\n) {\n${body}\n}); })`
    + '(globalThis.require, globalThis.module, globalThis.exports, globalThis.__filename, globalThis.__dirname);';
}

/** The main module's imports the runtime below reads through. */
export const COMMONJS_CELL_IMPORTS = [
  'import { createRequire as __nimbusCreateRequire } from "node:module";',
  'import { readFileSync as __nimbusReadBundleFile } from "node:fs";',
  'import { createHash as __nimbusCreateHash } from "node:crypto";',
].join('\n');

/**
 * The generated facet's side of the cells: resolve a VFS key to its module's
 * wrapper function, read a cell's text back for the process's store, and
 * answer runtime code from the launch's `gen/` modules or record it for the
 * next launch (`__nimbusRuntimeCode`, the API a module runner's seam calls).
 *
 * Expects COMMONJS_CELL_IMPORTS, a `__NIMBUS_CODE_CELLS` table of
 * CommonJsCellRow rows and a `__NIMBUS_RUNTIME_CODE` list of staged keys.
 */
export const COMMONJS_CELL_RUNTIME_SOURCE = `
const __nimbusRegistryRequire = __nimbusCreateRequire(import.meta.url);
const __nimbusCodeCells = new Map(__NIMBUS_CODE_CELLS.map((__row) => [__row[0], __row]));
const __NIMBUS_CELL_TAIL = ${JSON.stringify(COMMONJS_CELL_TAIL)};
// Where node:fs shows the map's modules: beside this main module, /bundle/.
const __NIMBUS_CELL_FILES = decodeURIComponent(new URL("./${CELL_DIR}", import.meta.url).pathname);
// The wrapper function of the cell at a VFS key, compiled by the registry the
// first time it is asked for; null when the launch's map has no such cell.
function __nimbusModuleCell(key) {
  const __row = __nimbusCodeCells.get(key);
  return __row ? __nimbusRegistryRequire("./" + __row[1]) : null;
}
// The cell's own text, read back from the module map by its path.
function __nimbusModuleCellSource(row) {
  const __text = __nimbusReadBundleFile(__NIMBUS_CELL_FILES + row[0], "utf8");
  const __cell = __text.slice(row[2], __text.length - __NIMBUS_CELL_TAIL.length);
  return row[3] ? "#!" + __cell.slice(2) : __cell;
}
// The data bundle, with every adopted cell added as a getter: the store reads
// each as it takes it, so no more than one cell's text is in hand at a time.
function __nimbusWithCodeCells(bundle) {
  for (const __row of __NIMBUS_CODE_CELLS) {
    if (!__row[4]) continue;
    Object.defineProperty(bundle, __row[0], { enumerable: true, configurable: true, get: () => __nimbusModuleCellSource(__row) });
  }
  return bundle;
}
// ── Runtime code (see RUNTIME CODE in commonjs-cell.ts) ──
const __nimbusRuntimeKeys = new Set(__NIMBUS_RUNTIME_CODE);
const __nimbusRuntimeLedger = new Map();
let __nimbusRuntimeLedgerBytes = 0;
function __nimbusRuntimeCodeCompile(entry, describe) {
  const __source = entry.kind === "module"
    ? JSON.stringify(["module", entry.text])
    : JSON.stringify([entry.kind, entry.params, entry.body]);
  const __key = __nimbusCreateHash("sha256").update(__source).digest("hex");
  if (__nimbusRuntimeKeys.has(__key)) return __nimbusRegistryRequire("./gen/" + __key + ".js");
  if (!__nimbusRuntimeLedger.has(__key) && __nimbusRuntimeLedgerBytes + __source.length <= ${RUNTIME_CODE_MAX_BYTES}) {
    __nimbusRuntimeLedger.set(__key, entry);
    __nimbusRuntimeLedgerBytes += __source.length;
  }
  const __err = new EvalError(describe + " was produced after this launch started, and a Worker compiles code only from the module map it was launched with. It is staged: the next launch of this command compiles it.");
  __err.code = "ERR_NIMBUS_CODE_NEXT_LAUNCH";
  __err.key = __key;
  throw __err;
}
// The wrapper function of a file that is not one of the launch's cells.
function __nimbusRuntimeModule(path, text) {
  return __nimbusRuntimeCodeCompile({ kind: "module", path, text: String(text) }, "Module '/" + path + "'");
}
globalThis.__nimbusRuntimeCode = Object.freeze({
  compileFunction(kind, params, body) {
    if (!${JSON.stringify(Object.keys(RUNTIME_FUNCTION_HEADS))}.includes(kind)) throw new TypeError("compileFunction: unknown kind " + String(kind));
    return __nimbusRuntimeCodeCompile({ kind, params: Array.from(params, String), body: String(body) }, "Code handed to the " + kind + " constructor");
  },
  compileModule(path, text) {
    return __nimbusRuntimeModule(String(path).replace(/^\\/+/, ""), text);
  },
});
// What this launch could not compile, for the next launch of its command.
function __nimbusRuntimeCodeLedger() {
  return [...__nimbusRuntimeLedger.values()];
}
`;
