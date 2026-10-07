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
 * The module a cell becomes exports a function of the module's own
 * `Function` that returns Node's module wrapper function, which the shims
 * call with their own exports, require, module, __filename and __dirname. A
 * cell of CommonJS runs as Node's own wrapper runs it, as the function body:
 *
 *   module.exports = (function (Function) { return function (exports, require, module, __filename, __dirname) {<cell>
 *   }; });
 *
 * The module's `Function` is the Function constructor bound to the module's
 * URL (node-shims.ts, __nimbusCodeOrigin), which the guest passes when it
 * evaluates the cell: import() in code that constructor builds resolves
 * against this module, as Node resolves it against the module that called
 * the constructor (RUNTIME CODE). It is a closure binding, not a parameter
 * of the wrapper, so the wrapper's `arguments` are Node's five and a cell
 * may declare its own `Function` at its top level.
 *
 * An ES module lowered to CommonJS (esbuild, or the bounded rewrite of a large
 * bundle) is the one exception. As an ES module it could declare its own
 * top-level `const __dirname = …`, `class exports {}` or — kept by the
 * bounded rewrite — `const require = createRequire(import.meta.url)`, and a
 * lexical declaration of a parameter's name in a function body is a
 * SyntaxError. Such a cell sits in a BLOCK inside the function, where the
 * declaration shadows the parameter, which is what the module meant:
 *
 *   module.exports = (function (Function) { return function (exports, require, module, __filename, __dirname) {<"use strict";>{<cell>
 *   }}; });
 *
 * Only a lowered module gets the block, because the block is not a function
 * body: a top-level function declaration in it is lexical, so `var f; function
 * f() {}`, or a strict cell declaring one function twice, is a SyntaxError
 * there that Node's wrapper accepts. An ES module can never contain either
 * (both are early errors in module code), and a CommonJS file can never
 * declare a parameter's name lexically (Node rejects it), so each form is
 * exact for what it wraps. A block is not a directive prologue, so a lowered
 * cell that opens with "use strict" has the directive restated in the
 * function body, where it applies.
 *
 * The wrapper is on the cell's first line, so a stack frame carries the
 * cell's own line numbers under the module's `file:///bundle/vfs/<name>`
 * name; a column on the first line is shifted by the wrapper's head. A
 * SyntaxError in a cell carries no location of its own — the registry
 * compiles the module when it is required and V8 reports the requiring
 * frame — so the shims name the module in the message instead.
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
 * So such code runs twice over. In the launch that produced it, the guest's
 * interpreter runs it (core/interpreter: parsed and compiled once into
 * closures, sharing the program's realm and objects), loaded from the map the
 * first time any code needs it. And it is staged for the NEXT launch of the
 * same command, which compiles it natively: the guest records it in a ledger
 * that travels with the existing residency-miss report (the one-shot
 * envelope, the resident exit report); the supervisor keeps it
 * content-addressed for that command's bundle key; the next launch carries it
 * as `gen/<sha256>.js` modules, compiled on first use. A key is the SHA-256 of
 * what decides the module (runtimeCodeKeySource): a constructor's arguments,
 * or a file's text together with its directory and extension, which decide
 * how it is lowered and what its relative imports mean — not its name, so a
 * file written under a fresh name each run still converges. Text that
 * changes every run (an edit, then the module runner's transform of it) is
 * interpreted each time. Code the interpreter refuses (TypeScript or JSX
 * text, `using` declarations) still throws EvalError code
 * ERR_NIMBUS_CODE_NEXT_LAUNCH, and runs from the next launch on.
 *
 * A constructor's code has an ORIGIN: the import() its code calls and the
 * `Function` its code sees (node-shims.ts, __nimbusCodeOrigin). Node resolves
 * that import() against the module that called the constructor; here that is
 * the module whose own `Function` (THE WRAPPER) built the code, and code it
 * builds in turn keeps the origin. A staged constructor module is a factory
 * of the origin (runtimeFunctionModule), so one content-addressed module
 * serves every module that builds the same code. vm's code has an origin
 * whose import() Node refuses (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING), and
 * a constructor reached through a prototype (AsyncFunction) or globalThis is
 * no module's own, so its code's import() is refused by name
 * (ERR_NIMBUS_IMPORT_NO_IMPORTER).
 *
 * A process started with NIMBUS_RUNTIME_CODE=interpret interprets even code
 * an earlier launch staged: the same launch, natively or not, which is how
 * the interpreter's cost and behaviour are compared with V8's.
 */
import { createHash } from 'node:crypto';
import { parse, tokenizer, tokTypes, type Pattern, type Program, type Token } from 'acorn';
import {
  RUNTIME_FUNCTION_HEADS, expressionFunctionBody, runtimeFunctionSource, runtimeFunctionSyntaxError as syntaxErrorIn,
  type RuntimeFunctionKind, type ScriptExpression, scriptExpression, type SourceRealm,
} from './runtime-function-source.js';
import { INTERPRETER_UNSUPPORTED } from '../interpreter/unsupported-code.js';
import { routeDynamicImportsTo } from '../runtime/dynamic-import-rewrite.js';
import { moduleImporterUrl } from './module-importer.js';

export type { RuntimeFunctionKind } from './runtime-function-source.js';

/** This module's own built-ins, for the checks it shares with the interpreter. */
const REALM: SourceRealm = {
  SyntaxError,
  messageOf: (e) => (e instanceof Error ? e.message : String(e)),
  scriptOptions: { ecmaVersion: 'latest', sourceType: 'script' },
};

function isRuntimeFunctionKind(kind: string): kind is RuntimeFunctionKind {
  return Object.hasOwn(RUNTIME_FUNCTION_HEADS, kind);
}

/** Why V8's constructor would refuse these arguments, or null when it would build the function. */
export function runtimeFunctionSyntaxError(kind: RuntimeFunctionKind, params: readonly string[], body: string): string | null {
  return syntaxErrorIn(kind, params, body, REALM);
}

/** Directory under the guest's bundle root that holds a process's cells. */
const CELL_DIR = 'vfs/';
/**
 * Directory for the process's entry code. Apart from the cells because the
 * entry is the script as the runtime prepared it, which the same file's cell
 * need not be, and a file required by the program gets its own evaluation.
 */
const ENTRY_DIR = 'entry/';

/**
 * A path as a module name under `dir`, injectively and exactly as the
 * registry's URL parsing keeps it. A name is resolved as a URL path against
 * the bundle base, which drops tabs and newlines, trims trailing spaces and
 * controls, reads `\` as `/`, and ends the path at `?` or `#`, so two paths
 * could otherwise name one module (and a map holding both fails to load:
 * "already added to bundle"). Every character the WHATWG path
 * percent-encode set holds — C0 controls, space, `"`, `#`, `<`, `>`, `?`, `` ` ``,
 * `{`, `}` and everything above U+007E — is written as its UTF-8 escapes,
 * which the parser keeps as they are, and `%` and `\` with them, so no path
 * can spell another's escape. The shims require `./` + the name from the main
 * module at the bundle root; the same parse resolves both.
 */
function moduleNameUnder(dir: string, path: string): string {
  let name = dir;
  for (const ch of path.replace(/^\/+/, '')) {
    const code = ch.charCodeAt(0);
    if (code > 0x20 && code < 0x7f && !MODULE_NAME_ESCAPED.includes(ch)) {
      name += ch;
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) name += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return name;
}
const MODULE_NAME_ESCAPED = '"#<>?`{}%\\';

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
 * filesystem (workerd's node:fs view of the module map) under its module
 * name. workerd's lookup percent-decodes the path it is given and encodes it
 * again with the path set, which gives back every name moduleNameUnder
 * writes except an escaped `%` or `\`: a path carrying either names a
 * different file there, so its cell also travels as data.
 */
export function commonJsCellReadsBack(key: string): boolean {
  return !/[%\\]/.test(key);
}

/** How a cell is wrapped (THE WRAPPER): as Node's function body, or in a block. */
export type CommonJsCellScope = 'function' | 'block';

export interface WrappedCommonJsCell {
  /** The module text. */
  text: string;
  /** Characters of wrapper before the cell. */
  head: number;
  /** Characters of wrapper after the cell. */
  tail: number;
  /** The cell opened with a shebang, which the text carries as `//`. */
  hashbang: boolean;
}

const WRAPPER_HEAD = 'module.exports = (function (Function) { return function (exports, require, module, __filename, __dirname) {';

/**
 * Wrap a CommonJS cell as a `{ cjs }` module whose export, given the
 * module's `Function`, is Node's module wrapper function, in the given scope
 * (THE WRAPPER). A leading shebang becomes a line comment of the same length
 * (Node strips it too; `#!` is not valid inside a function).
 */
export function wrapCommonJsCell(cell: string, scope: CommonJsCellScope = 'function'): WrappedCommonJsCell {
  const hashbang = cell.charCodeAt(0) === 35 && cell.charCodeAt(1) === 33;
  const body = hashbang ? '//' + cell.slice(2) : cell;
  const head = scope === 'function'
    ? WRAPPER_HEAD
    : WRAPPER_HEAD + (opensWithUseStrict(body) ? '"use strict";' : '') + '{';
  const tail = scope === 'function' ? '\n}; });' : '\n}}; });';
  return { text: head + body + tail, head: head.length, tail: tail.length, hashbang };
}

const WRAPPER_NAMES = new Set(['exports', 'require', 'module', '__filename', '__dirname']);
/** Could the text declare a wrapper name lexically at all: the cheap test before a parse. */
const LEXICAL_WRAPPER_NAME = /\b(?:const|let|class)\b[\s\S]{0,4096}?\b(?:exports|require|module|__filename|__dirname)\b/;
/** Largest source declaresWrapperBinding parses; above it the answer is `true`. */
const WRAPPER_BINDING_PARSE_MAX = 2 * 1024 * 1024;

/**
 * Whether a script declares one of the wrapper's five names lexically at its
 * top level (`const`, `let` or `class`) — the one thing that needs the block
 * scope — for code whose provenance is unknown: an entry script as the
 * runtime prepared it, or runtime code. Parsed, not matched: a declaration
 * inside a string or template is not one. Parsed as a script, and failing
 * that as a module (a lowered module may still read `import.meta`); a source
 * that parses as neither gets `false` (its SyntaxError surfaces under either
 * scope), and one too large to parse cheaply gets `true`, the scope every
 * lowered module needs.
 */
export function declaresWrapperBinding(source: string): boolean {
  if (!LEXICAL_WRAPPER_NAME.test(source)) return false;
  if (source.length > WRAPPER_BINDING_PARSE_MAX) return true;
  let program: Program | undefined;
  for (const sourceType of ['script', 'module'] as const) {
    try {
      program = parse(source, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true, allowHashBang: true });
      break;
    } catch {
      // The other goal, then none.
    }
  }
  if (!program) return false;
  for (const statement of program.body) {
    if (statement.type === 'ClassDeclaration') {
      if (statement.id && WRAPPER_NAMES.has(statement.id.name)) return true;
    } else if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declarator of statement.declarations) {
        if (patternBinds(declarator.id)) return true;
      }
    }
  }
  return false;
}

/** Whether a binding pattern binds one of the wrapper's names. */
function patternBinds(node: Pattern | null | undefined): boolean {
  if (!node) return false;
  switch (node.type) {
    case 'Identifier': return WRAPPER_NAMES.has(node.name);
    case 'ObjectPattern': return node.properties.some((p) => patternBinds(p.type === 'RestElement' ? p.argument : p.value));
    case 'ArrayPattern': return node.elements.some((e) => patternBinds(e));
    case 'RestElement': return patternBinds(node.argument);
    case 'AssignmentPattern': return patternBinds(node.left);
    default: return false;
  }
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
 * `[key, moduleName, head, tail, hashbang, adopt]`. `adopt` is 1 when the
 * process's store takes the cell's file content from the module text (read
 * back from the bundle filesystem) rather than from a data cell: the store's
 * one copy of that file, and the map's only.
 */
export type CommonJsCellRow = [key: string, moduleName: string, head: number, tail: number, hashbang: 0 | 1, adopt: 0 | 1];

/** Bytes of runtime code one launch records, and the supervisor keeps. */
export const RUNTIME_CODE_MAX_BYTES = 8 * 1024 * 1024;
/** Pieces of runtime code one launch records, and the supervisor keeps. */
export const RUNTIME_CODE_MAX_ENTRIES = 1024;
/**
 * What each piece is charged beyond its text, against RUNTIME_CODE_MAX_BYTES:
 * its key, its bookkeeping, and the module it becomes. Without it a flood of
 * tiny pieces is nearly free by text and not at all by heap.
 */
export const RUNTIME_CODE_ENTRY_OVERHEAD = 512;

/** Code a launch could not compile, as its ledger reports it. */
export type RuntimeCodeEntry =
  | { kind: RuntimeFunctionKind; params: string[]; body: string }
  | { kind: 'module'; path: string; text: string }
  /** vm.runInThisContext's code: a script whose value is its one expression's (scriptExpression). */
  | { kind: 'expression'; code: string };

/**
 * What of a file's path decides the module its text becomes: its directory
 * (the parent its relative imports and `import.meta.resolve` resolve
 * against) and its extension (how it is lowered: TypeScript, JSX, ESM or
 * CommonJS). Its name does not, so a file written under a fresh name each run
 * — Vite's `vite.config.ts.timestamp-<now>.mjs` — is the same module each time.
 * Self-contained: the guest embeds its source to compute the same key.
 */
export function runtimeModuleScope(path: string): [dir: string, ext: string] {
  // Inline JS modules all have an opaque import base. Their text identifies
  // compiled code; URL/fragment identity belongs to the evaluated namespace
  // and import.meta, not to another compiled copy of the same source.
  if (path.startsWith('data:')) return ['data:', '.mjs'];
  const p = path.replace(/^\/+/, '');
  const slash = p.lastIndexOf('/');
  const base = p.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return [slash < 0 ? '' : p.slice(0, slash), dot > 0 ? base.slice(dot) : ''];
}

/**
 * What a runtime-code key hashes: a constructor's arguments, or a file's
 * text with its runtimeModuleScope. The guest hashes the same string with the
 * same function (its sync node:crypto), so both sides name the same module.
 */
function runtimeCodeKeySource(entry: RuntimeCodeEntry): string {
  if (entry.kind === 'module') return JSON.stringify(['module', ...runtimeModuleScope(entry.path), entry.text]);
  if (entry.kind === 'expression') return JSON.stringify(['expression', entry.code]);
  return JSON.stringify([entry.kind, entry.params, entry.body]);
}

/** The key of a piece of runtime code: SHA-256 of runtimeCodeKeySource, hex. */
export function runtimeCodeKey(entry: RuntimeCodeEntry): string {
  const digest = createHash('sha256').update(new TextEncoder().encode(runtimeCodeKeySource(entry))).digest();
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What a piece of runtime code is charged against RUNTIME_CODE_MAX_BYTES:
 * everything it holds. A module keeps its path beside its text, and a data:
 * URL's path is the whole module again, so it is charged for both. The guest
 * ledger charges the same (__nimbusRuntimeCodeCompile).
 */
export function runtimeCodeCharge(entry: RuntimeCodeEntry): number {
  return runtimeCodeKeySource(entry).length + (entry.kind === 'module' ? entry.path.length : 0) + RUNTIME_CODE_ENTRY_OVERHEAD;
}

/**
 * The module names, in every node launch's map, of the interpreter, the host
 * module it runs on, and its primordials, which it requires from beside it as
 * ./interpreter-primordials.js (worker scripts/interpreter-bundle.mjs).
 */
export const RUNTIME_INTERPRETER_MODULE = 'nimbus/interpreter.js';
export const RUNTIME_INTERPRETER_OPS_MODULE = 'nimbus/interpreter-ops.js';
export const RUNTIME_INTERPRETER_PRIMORDIALS_MODULE = 'nimbus/interpreter-primordials.js';

/** The module name of the runtime code with key `key`. */
export function runtimeCodeModuleName(key: string): string {
  return `gen/${key}.js`;
}

/** A ledger entry as the supervisor receives it: shape-checked, or null. */
export function parseRuntimeCodeEntry(value: unknown): RuntimeCodeEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v: { kind?: unknown; path?: unknown; text?: unknown; params?: unknown; body?: unknown; code?: unknown } = value;
  if (v.kind === 'module') {
    return typeof v.path === 'string' && typeof v.text === 'string'
      ? { kind: 'module', path: v.path, text: v.text } : null;
  }
  if (v.kind === 'expression') return typeof v.code === 'string' ? { kind: 'expression', code: v.code } : null;
  if (typeof v.kind !== 'string' || !isRuntimeFunctionKind(v.kind)) return null;
  if (!Array.isArray(v.params) || !v.params.every((p: unknown): p is string => typeof p === 'string') || typeof v.body !== 'string') return null;
  return { kind: v.kind, params: [...v.params], body: v.body };
}

/** The name a staged constructor module's code calls in place of import(): its origin's import(). */
const ORIGIN_IMPORT = '__nimbusOriginImport';

/**
 * The `{ cjs }` module text for a Function-constructor call: it exports a
 * factory of the code's origin (RUNTIME CODE), its import() and its
 * `Function`, that builds the function V8 builds for `new
 * <Kind>Function(...params, body)`. The function is named `anonymous`, its
 * source is `<head> anonymous(<params>\n) {\n<body>\n}` (the body from line
 * 3), and its import() calls are the origin's. For arguments the constructor
 * refuses (runtimeFunctionSyntaxError), the factory throws the SyntaxError
 * the constructor would. A constructor's function closes over the global
 * scope, where a CommonJS module's body would see workerd's five CommonJS
 * names (src/workerd/api/commonjs.h CommonJsModuleContext: require, module,
 * exports, __filename, __dirname), so an enclosing function rebinds those five
 * to the global object's.
 */
export function runtimeFunctionModule(kind: RuntimeFunctionKind, params: readonly string[], body: string): string {
  const refused = runtimeFunctionSyntaxError(kind, params, body);
  if (refused !== null) return `module.exports = function () { throw new SyntaxError(${JSON.stringify(refused)}); };`;
  return `module.exports = function (${ORIGIN_IMPORT}, Function) { return (function (require, module, exports, __filename, __dirname) { return (`
    + `${routeDynamicImportsTo(runtimeFunctionSource(kind, params, body), ORIGIN_IMPORT)}); })`
    + '(globalThis.require, globalThis.module, globalThis.exports, globalThis.__filename, globalThis.__dirname); };';
}

/**
 * The `{ cjs }` module text for vm.runInThisContext's code: a factory of its
 * origin, as a constructor's is (runtimeFunctionModule), of a function
 * returning the value of the one expression the script is (after its
 * directive prologue, which the function keeps), which node-shims calls
 * with the global object as `this`, a script's own. For code V8 refuses the
 * factory throws the SyntaxError V8 would, and for a script of another shape
 * the error the interpreter answers it with in the first launch.
 */
export function runtimeExpressionModule(code: string): string {
  let at: ScriptExpression | null;
  try {
    at = scriptExpression(code, REALM);
  } catch (e) {
    return `module.exports = function () { throw new SyntaxError(${JSON.stringify(REALM.messageOf(e))}); };`;
  }
  if (at === null) return `module.exports = function () { throw new Error(${JSON.stringify(VM_SCRIPT_UNSUPPORTED)}); };`;
  return runtimeFunctionModule('function', [], expressionFunctionBody(code.slice(0, at.prologueEnd), code.slice(at.start, at.end)));
}

/** Why a vm script that is not one expression does not run in a Worker. */
const VM_SCRIPT_UNSUPPORTED = 'vm.runInThisContext: a Worker runs code compiled after its launch only as one expression, whose value is the result';

/** The main module's imports the runtime below reads through. */
export const COMMONJS_CELL_IMPORTS = [
  'import { createRequire as __nimbusCreateRequire } from "node:module";',
  'import { readFileSync as __nimbusReadBundleFile } from "node:fs";',
  'import { createHash as __nimbusCreateHash } from "node:crypto";',
].join('\n');

/**
 * The generated facet's side of the cells: resolve a VFS key to its module's
 * wrapper function, read a cell's text back for the process's store, and
 * answer runtime code from the launch's `gen/` modules, or else record it for
 * the next launch and interpret it (`__nimbusRuntimeCode`, which the shims'
 * Function constructors, `vm.compileFunction`, `vm.runInThisContext`,
 * `Module.prototype._compile`, the loader of a file outside the map and the
 * REPL call).
 *
 * Expects COMMONJS_CELL_IMPORTS, a `__NIMBUS_CODE_CELLS` table of
 * CommonJsCellRow rows and a `__NIMBUS_RUNTIME_CODE` list of staged keys.
 */
export const COMMONJS_CELL_RUNTIME_SOURCE = `
const __nimbusRegistryRequire = __nimbusCreateRequire(import.meta.url);
// The built-ins the interpreter calls, captured now, before any program code
// runs (core interpreter/primordials.ts): the interpreter itself loads only
// when the program first produces code, by when it may have replaced them.
const { LAUNCH_PRIMORDIALS: __nimbusLaunchPrimordials } = __nimbusRegistryRequire("./${RUNTIME_INTERPRETER_PRIMORDIALS_MODULE}");
const __nimbusCodeCells = new Map(__NIMBUS_CODE_CELLS.map((__row) => [__row[0], __row]));
// Where node:fs shows the map's modules: beside this main module, /bundle/.
const __NIMBUS_BUNDLE_FILES = decodeURIComponent(new URL("./", import.meta.url).pathname);
// The URL import() in the module at a path resolves against (moduleImporterUrl).
const __nimbusModuleImporterUrl = ${moduleImporterUrl.toString()};
// The wrapper function of the cell at a VFS key, compiled by the registry the
// first time it is asked for, with the module's own Function (THE WRAPPER);
// null when the launch's map has no such cell.
function __nimbusModuleCell(key) {
  const __row = __nimbusCodeCells.get(key);
  return __row ? __nimbusRegistryRequire("./" + __row[1])(globalThis.__nimbusCodeOrigin(__nimbusModuleImporterUrl(key)).Function) : null;
}
// The entry's wrapper function, with the Function of the entry's own URL,
// importer. A SyntaxError from compiling it carries no location (the
// registry compiles on require, and V8 reports the requiring frame), so its
// stack leads with the file, as Node's report does.
function __nimbusEntryWrapper(name, filename, importer) {
  try {
    return __nimbusRegistryRequire("./" + name)(globalThis.__nimbusCodeOrigin(importer).Function);
  } catch (e) {
    if (e instanceof SyntaxError && typeof e.stack === "string") e.stack = filename + "\\n\\n" + e.stack;
    throw e;
  }
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
const __nimbusRuntimeModuleScope = ${runtimeModuleScope.toString()};
function __nimbusRuntimeCodeKey(entry) {
  const __source = entry.kind === "module"
    ? JSON.stringify(["module", ...__nimbusRuntimeModuleScope(entry.path), entry.text])
    : entry.kind === "expression"
      ? JSON.stringify(["expression", entry.code])
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
  const __charge = source.length + (entry.kind === "module" ? entry.path.length : 0) + ${RUNTIME_CODE_ENTRY_OVERHEAD};
  if (
    !__nimbusRuntimeLedger.has(key)
    && __nimbusRuntimeLedger.size < ${RUNTIME_CODE_MAX_ENTRIES}
    && __nimbusRuntimeLedgerBytes + __charge <= ${RUNTIME_CODE_MAX_BYTES}
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
    const { createInterpreter } = __nimbusRegistryRequire("./${RUNTIME_INTERPRETER_MODULE}");
    __nimbusInterpreter = createInterpreter(__nimbusRegistryRequire("./${RUNTIME_INTERPRETER_OPS_MODULE}"), {
      dynamicImport: (parentUrl, specifier, options) => globalThis.__nimbusDynamicImport(parentUrl, specifier, options),
      primordials: __nimbusLaunchPrimordials,
    });
  }
  return __nimbusInterpreter;
}
// The compiled code from its origin (RUNTIME CODE): this launch's module for
// it when an earlier launch staged it; otherwise recorded for the next
// launch and interpreted. A SyntaxError is what compiling it natively throws
// too.
function __nimbusRuntimeCodeCompile(entry, describe, origin) {
  const __id = __nimbusRuntimeCodeKey(entry);
  const __staged = __nimbusRuntimeCodeStaged(__id.key);
  if (__staged !== undefined) return entry.kind === "module" ? __staged(origin.Function) : __staged(origin.import, origin.Function);
  __nimbusRuntimeCodeRecord(__id, entry);
  const __interpreter = __nimbusRuntimeInterpreter();
  try {
    if (entry.kind === "module") return __interpreter.compileModule(entry.path, entry.text, origin);
    if (entry.kind === "expression") return __interpreter.compileExpression(entry.code, origin);
    return __interpreter.compileFunction(entry.kind, entry.params, entry.body, origin);
  } catch (e) {
    if (!e || e.code !== "${INTERPRETER_UNSUPPORTED}") throw e;
    const __err = new EvalError(describe + " was produced after this launch started, and a Worker compiles code only from the module map it was launched with; it is staged, and the next launch of this command compiles it. (" + e.message + ")");
    __err.code = "ERR_NIMBUS_CODE_NEXT_LAUNCH";
    __err.key = __id.key;
    throw __err;
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
    if (!${JSON.stringify(Object.keys(RUNTIME_FUNCTION_HEADS))}.includes(kind)) throw new TypeError("compileFunction: unknown kind " + String(kind));
    return __nimbusRuntimeCodeCompile({ kind, params: Array.from(params, String), body: String(body) }, "Code handed to the " + kind + " constructor", origin);
  },
  // vm.runInThisContext's code (node-shims): a function returning its value,
  // which node-shims calls with the global object as \`this\`, a script's own.
  compileExpression(code, origin) {
    return __nimbusRuntimeCodeCompile({ kind: "expression", code: String(code) }, "Code handed to vm.runInThisContext", origin);
  },
  compileModule(path, text) {
    return __nimbusRuntimeModule(String(path).replace(/^\\/+/, ""), text);
  },
  // A line typed at the JavaScript REPL (core runtime/js-repl.ts): the async
  // function the interpreter's replLineBody makes of it, compiled as an
  // AsyncFunction constructor's is; null while more lines may complete it.
  compileReplLine(code) {
    const { replLineBody } = __nimbusRegistryRequire("./${RUNTIME_INTERPRETER_MODULE}");
    const __body = replLineBody(String(code));
    return __body === null ? null : __nimbusRuntimeCodeCompile({ kind: "async", params: [], body: __body }, "Code typed at the REPL", globalThis.__nimbusUnboundOrigin);
  },
});
// What this launch could not compile, for the next launch of its command.
function __nimbusRuntimeCodeLedger() {
  return [...__nimbusRuntimeLedger.values()];
}
`;
