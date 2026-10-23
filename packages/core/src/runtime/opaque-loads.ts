/**
 * opaque-loads.ts — whether a module can load code by a name its text does
 * not spell out.
 *
 * A launch's walk (require-resolver.ts prefetchForRequire) follows the loads
 * a module names by a literal: `require("x")`, `require.resolve("x")`,
 * `import("x")`, `import … from "x"`. A load by a name the program computes
 * (`require(name)`, `import(path)`, `createRequire(...)(name)`, `bindings()`,
 * a plugin loader, code made from a string) is one the walk cannot follow,
 * and the launch guesses at it: the greedy pass (facets/manager.ts
 * greedyAddMainEntries) stages the main of each package the project can
 * reach. That guess is the cost of a launch in a project with node_modules
 * (verify/handoffs/ticket-launch-greedy-oversample-cost.md: 13 s of a
 * builtins-only `node -e` in a Next app). A closure in which no module can
 * make such a load gives the guess nothing to catch, so it is not made.
 *
 * The answer is conservative: a module is opaque unless its text, comments
 * blanked, proves every load it can make is literal. Each of these makes it
 * opaque:
 *   - `require` other than `require(<literal>)`, `require.resolve(<literal>)`
 *     or `module.require(<literal>)`: called with a computed name, passed on
 *     as a value, or its cache and main read (`require.cache`, `require.main`);
 *   - `import(` with anything but a literal first;
 *   - a name that loads or makes code by a computed name: createRequire,
 *     getBuiltinModule, eval, Function, _load, bindings, vm, importScripts,
 *     __nimbusDynamicImport;
 *   - a `\u` escape anywhere, since one can spell any of those names.
 * A literal is a quoted string, or a template with no substitution. A name
 * inside a string counts too; that only makes the answer more cautious.
 */
import { stripCommentsForImports } from './comment-strip.js';

const LITERAL = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60[^\x60\\$]*\x60)`;
/** What may follow a `require` that loads by a literal. */
const LITERAL_REQUIRE = new RegExp(String.raw`^\s*(?:\.\s*resolve\s*)?\(\s*${LITERAL}\s*[,)]`);
/** What may follow an `import(` that loads by a literal. */
const LITERAL_IMPORT = new RegExp(String.raw`^\s*${LITERAL}\s*[,)]`);
const REQUIRE = /\brequire\b/g;
const IMPORT_CALL = /\bimport\s*\(/g;
const CODE_BY_NAME = /\b(?:createRequire|getBuiltinModule|eval|Function|_load|bindings|vm|importScripts|__nimbusDynamicImport)\b|\\u/;

/** Whether `source` can load code by a name its text does not spell out (see the header). */
export function hasOpaqueLoads(source: string): boolean {
  const code = stripCommentsForImports(source);
  if (CODE_BY_NAME.test(code)) return true;
  for (const match of code.matchAll(REQUIRE)) {
    if (!LITERAL_REQUIRE.test(code.slice(match.index + match[0].length))) return true;
  }
  for (const match of code.matchAll(IMPORT_CALL)) {
    if (!LITERAL_IMPORT.test(code.slice(match.index + match[0].length))) return true;
  }
  return false;
}
