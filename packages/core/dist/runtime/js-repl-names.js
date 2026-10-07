/**
 * js-repl-names.ts — what the JavaScript REPL program (js-repl.ts) and the
 * code it compiles each line to (interpreter/repl-line.ts) both name. Imports
 * nothing: the interpreter's bundle carries it.
 */
/** The global a line's `import()` calls: the REPL's import, which resolves as from its own module. */
export const REPL_IMPORT = '__nimbus_repl_import__';
