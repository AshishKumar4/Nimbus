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
 * __dirname. A cell of CommonJS runs as Node's own wrapper runs it, as the
 * function body:
 *
 *   module.exports = (function (exports, require, module, __filename, __dirname) {<cell>
 *   });
 *
 * An ES module lowered to CommonJS (esbuild, or the bounded rewrite of a large
 * bundle) is the one exception. As an ES module it could declare its own
 * top-level `const __dirname = …`, `class exports {}` or — kept by the
 * bounded rewrite — `const require = createRequire(import.meta.url)`, and a
 * lexical declaration of a parameter's name in a function body is a
 * SyntaxError. Such a cell sits in a BLOCK inside the function, where the
 * declaration shadows the parameter, which is what the module meant:
 *
 *   module.exports = (function (exports, require, module, __filename, __dirname) {<"use strict";>{<cell>
 *   }});
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
 * So such code is staged for the NEXT launch of the same command. The guest
 * records it in a ledger that travels with the existing residency-miss report
 * (the one-shot envelope, the resident exit report); the supervisor keeps it
 * content-addressed for that command's bundle key; the next launch carries it
 * as `gen/<sha256>.js` modules, compiled on first use. A key is the SHA-256 of
 * what decides the module (runtimeCodeKeySource): a constructor's arguments,
 * or a file's text together with its directory and extension, which decide
 * how it is lowered and what its relative imports mean — not its name, so a
 * file written under a fresh name each run still converges. Text that
 * changes every run (an edit, then the module runner's transform of it)
 * costs one relaunch per change.
 */
import { createHash } from 'node:crypto';
import { parse, tokenizer, tokTypes } from 'acorn';
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
function moduleNameUnder(dir, path) {
    let name = dir;
    for (const ch of path.replace(/^\/+/, '')) {
        const code = ch.codePointAt(0);
        if (code > 0x20 && code < 0x7f && !MODULE_NAME_ESCAPED.includes(ch)) {
            name += ch;
            continue;
        }
        for (const byte of new TextEncoder().encode(ch))
            name += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return name;
}
const MODULE_NAME_ESCAPED = '"#<>?`{}%\\';
/** The Worker Loader module name for the cell at VFS key `key` (a path without its leading slash). */
export function commonJsCellModuleName(key) {
    return moduleNameUnder(CELL_DIR, key);
}
/** The module name of a process's entry code, `filename` being the script's path or `[eval]`. */
export function commonJsEntryModuleName(filename) {
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
export function commonJsCellReadsBack(key) {
    return !/[%\\]/.test(key);
}
const WRAPPER_HEAD = 'module.exports = (function (exports, require, module, __filename, __dirname) {';
/**
 * Wrap a CommonJS cell as a `{ cjs }` module whose export is Node's module
 * wrapper function, in the given scope (THE WRAPPER). A leading shebang
 * becomes a line comment of the same length (Node strips it too; `#!` is not
 * valid inside a function).
 */
export function wrapCommonJsCell(cell, scope = 'function') {
    const hashbang = cell.charCodeAt(0) === 35 && cell.charCodeAt(1) === 33;
    const body = hashbang ? '//' + cell.slice(2) : cell;
    const head = scope === 'function'
        ? WRAPPER_HEAD
        : WRAPPER_HEAD + (opensWithUseStrict(body) ? '"use strict";' : '') + '{';
    const tail = scope === 'function' ? '\n});' : '\n}});';
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
export function declaresWrapperBinding(source) {
    if (!LEXICAL_WRAPPER_NAME.test(source))
        return false;
    if (source.length > WRAPPER_BINDING_PARSE_MAX)
        return true;
    let program;
    for (const sourceType of ['script', 'module']) {
        try {
            program = parse(source, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true, allowHashBang: true });
            break;
        }
        catch {
            // The other goal, then none.
        }
    }
    if (!program)
        return false;
    for (const statement of program.body) {
        if (statement.type === 'ClassDeclaration') {
            if (statement.id && WRAPPER_NAMES.has(statement.id.name))
                return true;
        }
        else if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
            for (const declarator of statement.declarations) {
                if (patternBinds(declarator.id))
                    return true;
            }
        }
    }
    return false;
}
/** Whether a binding pattern binds one of the wrapper's names. */
function patternBinds(node) {
    if (!node)
        return false;
    const n = node;
    switch (n.type) {
        case 'Identifier': return WRAPPER_NAMES.has(n.name);
        case 'ObjectPattern': return n.properties
            .some((p) => patternBinds((p.type === 'RestElement' ? p.argument : p.value)));
        case 'ArrayPattern': return n.elements.some((e) => patternBinds(e));
        case 'RestElement': return patternBinds(n.argument);
        case 'AssignmentPattern': return patternBinds(n.left);
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
export function opensWithUseStrict(source) {
    let tokens;
    let token;
    try {
        tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'script' });
        token = tokens.getToken();
    }
    catch {
        return false;
    }
    for (;;) {
        if (token.type !== tokTypes.string)
            return false;
        const raw = source.slice(token.start + 1, token.end - 1);
        let next;
        try {
            next = tokens.getToken();
        }
        catch {
            return false;
        }
        let directive;
        if (next.type === tokTypes.semi) {
            directive = true;
            try {
                next = tokens.getToken();
            }
            catch {
                return raw === 'use strict';
            }
        }
        else {
            directive = next.type === tokTypes.eof || next.type === tokTypes.braceR
                || (/[\n\r\u2028\u2029]/.test(source.slice(token.end, next.start)) && !CONTINUES_EXPRESSION.has(next.type));
        }
        if (!directive)
            return false;
        if (raw === 'use strict')
            return true;
        token = next;
    }
}
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
/** The constructors whose text a program can hand in at runtime. */
const RUNTIME_FUNCTION_HEADS = {
    function: 'function',
    async: 'async function',
    generator: 'function*',
    asyncGenerator: 'async function*',
};
/**
 * What of a file's path decides the module its text becomes: its directory
 * (the parent its relative imports and `import.meta.resolve` resolve
 * against) and its extension (how it is lowered: TypeScript, JSX, ESM or
 * CommonJS). Its name does not, so a file written under a fresh name each run
 * — Vite's `vite.config.ts.timestamp-<now>.mjs` — is the same module each time.
 * Self-contained: the guest embeds its source to compute the same key.
 */
export function runtimeModuleScope(path) {
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
}
/**
 * What a runtime-code key hashes: a constructor's arguments, or a file's
 * text with its runtimeModuleScope. The guest hashes the same string with the
 * same function (its sync node:crypto), so both sides name the same module.
 */
function runtimeCodeKeySource(entry) {
    return entry.kind === 'module'
        ? JSON.stringify(['module', ...runtimeModuleScope(entry.path), entry.text])
        : JSON.stringify([entry.kind, entry.params, entry.body]);
}
/** The key of a piece of runtime code: SHA-256 of runtimeCodeKeySource, hex. */
export function runtimeCodeKey(entry) {
    const digest = createHash('sha256').update(new TextEncoder().encode(runtimeCodeKeySource(entry))).digest();
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/**
 * What a piece of runtime code is charged against RUNTIME_CODE_MAX_BYTES:
 * everything it holds. A module keeps its path beside its text, and a data:
 * URL's path is the whole module again, so it is charged for both. The guest
 * ledger charges the same (__nimbusRuntimeCodeCompile).
 */
export function runtimeCodeCharge(entry) {
    return runtimeCodeKeySource(entry).length + (entry.kind === 'module' ? entry.path.length : 0) + RUNTIME_CODE_ENTRY_OVERHEAD;
}
/** The module name of the runtime code with key `key`. */
export function runtimeCodeModuleName(key) {
    return `gen/${key}.js`;
}
/** A ledger entry as the supervisor receives it: shape-checked, or null. */
export function parseRuntimeCodeEntry(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const v = value;
    if (v.kind === 'module') {
        return typeof v.path === 'string' && typeof v.text === 'string'
            ? { kind: 'module', path: v.path, text: v.text } : null;
    }
    if (typeof v.kind !== 'string' || !Object.hasOwn(RUNTIME_FUNCTION_HEADS, v.kind))
        return null;
    if (!Array.isArray(v.params) || !v.params.every((p) => typeof p === 'string') || typeof v.body !== 'string')
        return null;
    return { kind: v.kind, params: [...v.params], body: v.body };
}
/**
 * Why V8's constructor would refuse these arguments, or null when it would
 * build the function. V8 parses the parameters alone and requires them to end
 * where the list ends ("Arg string terminates parameters early"), the body
 * alone, and then the whole source, which must be exactly one function
 * literal ("Single function literal required"). Splicing unchecked text into
 * `(<head> anonymous(<params>\n) {\n<body>\n})` would otherwise let a body
 * such as `}, globalThis.x = 1, function () {` run code at module
 * evaluation that the constructor never would.
 */
export function runtimeFunctionSyntaxError(kind, params, body) {
    const head = `(${RUNTIME_FUNCTION_HEADS[kind]} anonymous(`;
    const paramText = params.join(',');
    const checks = [
        [`${head}${paramText}\n) {})`, `${head}${paramText}\n) `.length, true],
        [`${head}\n) {\n${body}\n})`, `${head}\n) `.length, false],
        [`${head}${paramText}\n) {\n${body}\n})`, `${head}${paramText}\n) `.length, false],
    ];
    for (const [text, bodyStart, emptyBody] of checks) {
        let program;
        try {
            program = parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
        }
        catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
        const [statement] = program.body;
        const fn = program.body.length === 1 && statement.type === 'ExpressionStatement' ? statement.expression : null;
        if (!fn || fn.type !== 'FunctionExpression' || fn.start !== 1 || fn.end !== text.length - 1
            || fn.body.start !== bodyStart || (emptyBody && fn.body.body.length !== 0)) {
            return emptyBody ? 'Arg string terminates parameters early' : 'Single function literal required';
        }
    }
    return null;
}
/**
 * The `{ cjs }` module text for a Function-constructor call: it exports the
 * function V8 builds for `new <Kind>Function(...params, body)` — named
 * `anonymous`, its source `<head> anonymous(<params>\n) {\n<body>\n}`, the body
 * from line 3 — or, for arguments the constructor refuses
 * (runtimeFunctionSyntaxError), throws the SyntaxError it would. A
 * constructor's function closes over the global scope, where a CommonJS
 * module's body would see workerd's five CommonJS names
 * (src/workerd/api/commonjs.h CommonJsModuleContext: require, module,
 * exports, __filename, __dirname), so an enclosing function rebinds those five
 * to the global object's.
 */
export function runtimeFunctionModule(kind, params, body) {
    const refused = runtimeFunctionSyntaxError(kind, params, body);
    if (refused !== null)
        return `throw new SyntaxError(${JSON.stringify(refused)});`;
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
 * next launch (`__nimbusRuntimeCode`, which the shims' async and generator
 * Function constructors, `vm.compileFunction`, `Module.prototype._compile`
 * and the loader of a file outside the map call).
 *
 * Expects COMMONJS_CELL_IMPORTS, a `__NIMBUS_CODE_CELLS` table of
 * CommonJsCellRow rows and a `__NIMBUS_RUNTIME_CODE` list of staged keys.
 */
export const COMMONJS_CELL_RUNTIME_SOURCE = `
const __nimbusRegistryRequire = __nimbusCreateRequire(import.meta.url);
const __nimbusCodeCells = new Map(__NIMBUS_CODE_CELLS.map((__row) => [__row[0], __row]));
// Where node:fs shows the map's modules: beside this main module, /bundle/.
const __NIMBUS_BUNDLE_FILES = decodeURIComponent(new URL("./", import.meta.url).pathname);
// The wrapper function of the cell at a VFS key, compiled by the registry the
// first time it is asked for; null when the launch's map has no such cell.
function __nimbusModuleCell(key) {
  const __row = __nimbusCodeCells.get(key);
  return __row ? __nimbusRegistryRequire("./" + __row[1]) : null;
}
// The entry's wrapper function. A SyntaxError from compiling it carries no
// location (the registry compiles on require, and V8 reports the requiring
// frame), so its stack leads with the file, as Node's report does.
function __nimbusEntryWrapper(name, filename) {
  try {
    return __nimbusRegistryRequire("./" + name);
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
const __nimbusFilesAcknowledged = new Set();
let __nimbusCodeSending = Promise.resolve();
// A server may catch a compile miss (SSR error page) and never exit. Persist
// new code independently of exit, in bounded batches, and acknowledge only
// after the session has committed it. Retain the ledger for the exit backstop.
function __nimbusFlushRuntimeCode(supervisor) {
  if (!supervisor || typeof supervisor.reportRuntimeCode !== 'function') return Promise.resolve();
  const send = __nimbusCodeSending.then(async () => {
    const entries = [...__nimbusRuntimeLedger].filter(([key]) => !__nimbusCodeAcknowledged.has(key));
    const files = [...new Set([...(globalThis.__nimbusModuleMisses || []), ...(globalThis.__nimbusVfsResidencyMisses || [])])]
      .filter((path) => !__nimbusFilesAcknowledged.has(path));
    const batches = Math.max(Math.ceil(entries.length / 32), Math.ceil(files.length / 128));
    for (let i = 0; i < batches; i++) {
      const batch = entries.slice(i * 32, (i + 1) * 32);
      const paths = files.slice(i * 128, (i + 1) * 128);
      await supervisor.reportRuntimeCode(batch.map(([, entry]) => entry), paths);
      for (const [key] of batch) __nimbusCodeAcknowledged.add(key);
      for (const path of paths) __nimbusFilesAcknowledged.add(path);
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
    : JSON.stringify([entry.kind, entry.params, entry.body]);
  return { source: __source, key: __nimbusCreateHash("sha256").update(__source).digest("hex") };
}
// This launch's module for the code, or undefined when it was not staged.
function __nimbusRuntimeCodeStaged(key) {
  return __nimbusRuntimeKeys.has(key) ? __nimbusRegistryRequire("./gen/" + key + ".js") : undefined;
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
function __nimbusRuntimeCodeCompile(entry, describe) {
  const __id = __nimbusRuntimeCodeKey(entry);
  const __staged = __nimbusRuntimeCodeStaged(__id.key);
  if (__staged !== undefined) return __staged;
  __nimbusRuntimeCodeRecord(__id, entry);
  const __err = new EvalError(describe + " was produced after this launch started, and a Worker compiles code only from the module map it was launched with. It is staged: the next launch of this command compiles it.");
  __err.code = "ERR_NIMBUS_CODE_NEXT_LAUNCH";
  __err.key = __id.key;
  throw __err;
}
// Plain Function constructor text refused in this launch, by key; staged only
// if the launch fails (stageFailedLaunch).
const __nimbusRefusedPlainCode = new Map();
let __nimbusRefusedPlainBytes = 0;
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
  // The plain Function constructor answers only what an earlier launch staged
  // and otherwise throws the native refusal. Code probes it (TypeBox's
  // CanEvaluate tries Function("null") and then compiles every check with
  // it), so a refused text is staged only when the launch fails: a probe
  // with a working fallback answers the same in every successful launch.
  plainFunction(params, body, refusal) {
    const __entry = { kind: "function", params: Array.from(params, String), body: String(body) };
    const __id = __nimbusRuntimeCodeKey(__entry);
    const __staged = __nimbusRuntimeCodeStaged(__id.key);
    if (__staged !== undefined) return __staged;
    // Held within the ledger's own bounds, which decide what is staged.
    if (
      !__nimbusRefusedPlainCode.has(__id.key)
      && __nimbusRefusedPlainCode.size < ${RUNTIME_CODE_MAX_ENTRIES}
      && __nimbusRefusedPlainBytes + __id.source.length <= ${RUNTIME_CODE_MAX_BYTES}
    ) {
      __nimbusRefusedPlainCode.set(__id.key, { id: __id, entry: __entry });
      __nimbusRefusedPlainBytes += __id.source.length;
    }
    throw refusal;
  },
  // A launch that failed — an uncaught error (depd, loaded by express 4's
  // body-parser, builds its deprecated wrappers with \`new Function\` as the
  // module loads) or a non-zero exit (serve 14 catches ajv's refusal and
  // exits 1) — stages the plain Function text it was refused. Returns the
  // line (no newline) the failure report adds, or "".
  stageFailedLaunch() {
    if (__nimbusRefusedPlainCode.size === 0) return "";
    for (const { id, entry } of __nimbusRefusedPlainCode.values()) __nimbusRuntimeCodeRecord(id, entry);
    const __count = __nimbusRefusedPlainCode.size;
    __nimbusRefusedPlainCode.clear();
    __nimbusRefusedPlainBytes = 0;
    return "Nimbus [ERR_NIMBUS_CODE_NEXT_LAUNCH]: " + __count + " text(s) handed to the Function constructor were produced after this launch started; they are staged, and the next launch of this command compiles them.";
  },
});
// What this launch could not compile, for the next launch of its command.
function __nimbusRuntimeCodeLedger() {
  return [...__nimbusRuntimeLedger.values()];
}
`;
