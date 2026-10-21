/**
 * runtime/node-builtins.ts — which specifiers name a Node builtin, as Node
 * 22.23.4's module.isBuiltin answers: every name in its builtin table
 * (node-builtin-exports.ts), with or without `node:`, but those it names
 * only with the scheme. The launch's dependency walk (require-resolver.ts),
 * ES module staging (worker facets/esm-stage.ts) and the process's own
 * require (worker runtime/node-shims.ts) decide by it, so a file the
 * process serves as a builtin is never walked, and one it loads is.
 */
import { NODE_BUILTIN_EXPORTS } from './node-builtin-exports.js';

/** Builtins Node names only with their scheme (module.isBuiltin('test') is false): its schemelessBlockList. */
export const NODE_SCHEME_ONLY_BUILTINS: readonly string[] = ['sea', 'sqlite', 'test', 'test/reporters'];

/** module.isBuiltin(specifier), by Node 22.23.4's builtin table. */
export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return Object.hasOwn(NODE_BUILTIN_EXPORTS, specifier.slice(5));
  return Object.hasOwn(NODE_BUILTIN_EXPORTS, specifier) && !NODE_SCHEME_ONLY_BUILTINS.includes(specifier);
}
