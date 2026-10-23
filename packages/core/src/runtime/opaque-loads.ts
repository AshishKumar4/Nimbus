/**
 * opaque-loads.ts — whether a module can load code the launch's walk does
 * not stage.
 *
 * A launch's walk (require-resolver.ts prefetchForRequire) follows the loads
 * a module names by a literal, as its patterns read them: `require("x")`,
 * `require.resolve("x")`, `import("x")`, `import … from "x"`,
 * `export … from "x"`. A load by a name the program computes
 * (`require(name)`, `import(path)`, `createRequire(...)(name)`, `bindings()`,
 * a plugin loader, code made from a string) is one the walk cannot follow,
 * and the launch guesses at it: the greedy pass (facets/manager.ts
 * greedyAddMainEntries) stages the main of each package the project can
 * reach. That guess is the cost of a launch in a project with node_modules
 * (verify/handoffs/ticket-launch-greedy-oversample-cost.md: 13 s of a
 * builtins-only `node -e` in a Next app). A closure in which no module can
 * make such a load gives the guess nothing to catch, so it is not made.
 *
 * A synchronous load the map lacks fails the run, so the answer is
 * conservative: a module is opaque unless its parse proves every load it
 * can make is one the walk follows. It is parsed (acorn, as Node would run
 * it: an ES module, else a CommonJS script); one that does not parse
 * (TypeScript, JSX, a syntax error) is opaque. Each of these makes it opaque:
 *   - `require` anywhere but as the callee of `require(<plain>)` or
 *     `require.resolve(<plain>)` with that one argument: a computed name, a
 *     second argument, `require` passed on, its cache or main read, and
 *     `x.require(...)` on another module, which resolves from that module;
 *   - `import(...)` other than `import(<plain>)` with no options;
 *   - a static import or export from a specifier that is not plain;
 *   - a name that loads or makes code by a computed name, as an identifier
 *     or a property: createRequire, getBuiltinModule, eval, Function, _load,
 *     bindings, vm, importScripts, __nimbusDynamicImport.
 * A plain specifier is a string or a template with no substitution, written
 * with no escape and no quote character, as the walk's patterns read one.
 */
import type { AnyNode, Expression, SpreadElement } from 'acorn';
import { forEachNode, parseJavaScriptProgram } from './javascript-ast.js';

const CODE_BY_NAME: ReadonlySet<string> = new Set([
  'createRequire', 'getBuiltinModule', 'eval', 'Function', '_load', 'bindings', 'vm', 'importScripts', '__nimbusDynamicImport',
]);
/** What a specifier the walk's patterns read may hold: no quote of any kind, no escape, no line break, no `$`. */
const PLAIN = /^[^'"`\\\n$]+$/;

/** Whether `node` is a specifier the walk reads as it is written. */
function plain(node: Expression | SpreadElement | undefined | null): boolean {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string' && PLAIN.test(node.value) && !(node.raw ?? '\\').includes('\\');
  if (node.type === 'TemplateLiteral') {
    const [only] = node.quasis;
    return node.expressions.length === 0 && node.quasis.length === 1 && only !== undefined && PLAIN.test(only.value.raw);
  }
  return false;
}

/** Whether `source` can load code the walk does not stage (see the header). */
export function hasOpaqueLoads(source: string): boolean {
  const program = parseJavaScriptProgram(source);
  if (program === null) return true;
  // The `require` identifiers that are the callee of a load the walk follows.
  const followed = new Set<AnyNode>();
  let opaque = false;
  forEachNode(program, (node) => {
    if (opaque) return;
    if (node.type === 'CallExpression' && node.arguments.length === 1 && plain(node.arguments[0])) {
      const callee = node.callee;
      if (callee.type === 'Identifier' && callee.name === 'require') followed.add(callee);
      if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'require'
        && callee.property.type === 'Identifier' && callee.property.name === 'resolve') followed.add(callee.object);
    }
    if (node.type === 'ImportExpression' && ((node.options ?? null) !== null || !plain(node.source))) opaque = true;
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') && !plain(node.source)) opaque = true;
    if (node.type === 'ExportNamedDeclaration' && node.source && !plain(node.source)) opaque = true;
  });
  if (opaque) return true;
  forEachNode(program, (node) => {
    if (opaque || node.type !== 'Identifier') return;
    if (CODE_BY_NAME.has(node.name) || (node.name === 'require' && !followed.has(node))) opaque = true;
  });
  return opaque;
}
