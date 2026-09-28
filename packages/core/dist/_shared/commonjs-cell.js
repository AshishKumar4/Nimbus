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
 *     never saw.
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
 */
import { tokenizer, tokTypes } from 'acorn';
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
function moduleNameUnder(dir, path) {
    return dir + path.replace(/^\/+/, '').replace(/[%#?\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}
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
 * filesystem (`/bundle/vfs/<path>`, workerd's node:fs view of the module map)
 * by the cell's own path. workerd's lookup percent-decodes the path it is
 * given and reads `\` as a separator, so a path carrying `%` or `\` names a
 * different file there; such a cell also travels as data.
 */
export function commonJsCellReadsBack(key) {
    return !/[%\\]/.test(key);
}
/**
 * Wrap a CommonJS cell as a `{ cjs }` module whose export is Node's module
 * wrapper function. A leading shebang becomes a line comment of the same
 * length (Node strips it too; `#!` is not valid inside a function).
 */
export function wrapCommonJsCell(cell) {
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
/** The main module's imports the runtime below reads through. */
export const COMMONJS_CELL_IMPORTS = [
    'import { createRequire as __nimbusCreateRequire } from "node:module";',
    'import { readFileSync as __nimbusReadBundleFile } from "node:fs";',
].join('\n');
/**
 * The generated facet's side of the cells: resolve a VFS key to its module's
 * wrapper function, and read a cell's text back for the process's store.
 *
 * Expects COMMONJS_CELL_IMPORTS and a `__NIMBUS_CODE_CELLS` table of
 * CommonJsCellRow rows.
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
`;
