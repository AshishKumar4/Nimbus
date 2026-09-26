/**
 * Dynamic `import()` in a module cell.
 *
 * A cell is compiled with `new Function`, so an `import()` that survives into
 * it is the runtime's own: workerd resolves it against its module registry,
 * which holds none of the session's files. So `import('/abs/x.mjs')` from a
 * program failed with "No such module", and `import('node:http')` handed back
 * the platform's builtin rather than the process's shim. Each ImportExpression
 * becomes a call of the process's loader with the importing module's URL,
 * `__nimbusDynamicImport(parentUrl, specifier[, options])`, which resolves the
 * way Node's ESM loader does (node-shims.ts).
 *
 * The expressions are found by parsing (acorn), never by scanning text. The
 * parse runs where the ESM→CJS transform runs, in the esbuild facet (its
 * staged runner installs `__nimbusRewriteDynamicImports`), never in the
 * session's isolate, and the session caches the result by content.
 */
import { parse } from 'acorn';
import type { Node } from 'acorn';
import { simple } from 'acorn-walk';

/** The loader a rewritten `import()` calls (node-shims.ts). */
export const DYNAMIC_IMPORT_HELPER = '__nimbusDynamicImport';

/**
 * Whether `code` can hold an ImportExpression at all: one needs the keyword
 * `import` followed, past whitespace and comments, by `(`. A keyword cannot
 * be spelled with escapes, so a cell without this can be skipped unparsed;
 * one with it is decided by the parse.
 */
export function mayHaveDynamicImport(code: string): boolean {
  return /\bimport\s*(?:\(|\/[/*])/.test(code);
}

/**
 * A cell's syntax tree. Sloppy script first, as the cell is compiled; then
 * module syntax, for what a transform left in (`import.meta`), which a
 * script may not contain.
 */
function parseCell(code: string): Node | null {
  for (const sourceType of ['script', 'module'] as const) {
    try {
      return parse(code, {
        ecmaVersion: 'latest',
        sourceType,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowHashBang: true,
      });
    } catch {
      // The next grammar, or none.
    }
  }
  return null;
}

interface ImportExpressionNode extends Node {
  source: Node;
}

/**
 * `code` with each ImportExpression's `import(` replaced by
 * `__nimbusDynamicImport("<parentUrl>", `. The arguments stay as written, so
 * evaluation order and the options argument are the program's.
 *
 * A cell is a function body (it may `return` or `await` at its top level);
 * one acorn cannot parse is returned unchanged, for the compile to report.
 */
export function rewriteDynamicImports(code: string, parentUrl: string): string {
  if (!mayHaveDynamicImport(code)) return code;
  const ast = parseCell(code);
  if (ast === null) return code;
  const spans: { start: number; end: number }[] = [];
  simple(ast, {
    ImportExpression(node) {
      const expression = node as ImportExpressionNode;
      spans.push({ start: expression.start, end: expression.source.start });
    },
  });
  if (spans.length === 0) return code;
  spans.sort((a, b) => a.start - b.start);
  const call = `${DYNAMIC_IMPORT_HELPER}(${JSON.stringify(parentUrl)}, `;
  let out = '';
  let at = 0;
  for (const { start, end } of spans) {
    out += code.slice(at, start) + call;
    at = end;
  }
  return out + code.slice(at);
}
