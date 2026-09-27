/**
 * Dynamic `import()` and evaluation metadata in a module cell.
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
 * The same parse binds actual import.meta references to the wrapper
 * module, using an identifier absent from every parsed scope. User bindings
 * named `module` cannot capture them; directives and five-argument CommonJS
 * wrappers are preserved.
 */
import { Parser } from 'acorn';
import type { Node, Program, Identifier, MetaProperty } from 'acorn';
import { full } from 'acorn-walk';

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
 * Parse with acorn's grammar and scope/export checks, visiting each complete
 * top-level statement before dropping its tree. A bundled 4 MiB module can
 * otherwise retain hundreds of thousands of AST nodes alongside esbuild's
 * wasm heap. Nested statements remain intact until their enclosing root has
 * parsed; only acorn's Program body is reduced to positions and directives.
 */
function parseCell(code: string, moduleFirst: boolean, visit: (node: Node) => void, reset: () => void): Program | null {
  const StreamingParser = Parser.extend(Base => {
    const parseStatement = Reflect.get(Base.prototype, 'parseStatement');
    if (typeof parseStatement !== 'function') throw new Error('Acorn statement parser unavailable');
    return class extends Base {
      parseStatement(context: unknown, topLevel: boolean, exports: unknown): Node {
        const node: Node = Reflect.apply(parseStatement, this, [context, topLevel, exports]);
        if (!topLevel) return node;
        full(node, visit);
        // adaptDirectivePrologue still sees literal expression statements.
        // Keeping these small nodes preserves insertion after "use strict".
        if (node.type === 'ExpressionStatement') {
          const expression = Reflect.get(node, 'expression');
          if (expression?.type === 'Literal' && typeof expression.value === 'string') return node;
        }
        return { type: 'EmptyStatement', start: node.start, end: node.end };
      }
    };
  });
  const grammars = moduleFirst ? ['module', 'script'] as const : ['script', 'module'] as const;
  for (const sourceType of grammars) {
    reset();
    try {
      return StreamingParser.parse(code, {
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
export function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata = false): string {
  const metadata = moduleMetadata && code.includes('import');
  if (!mayHaveDynamicImport(code) && !metadata) return code;
  const spans: { start: number; end: number; text: string }[] = [];
  const metadataSpans: { start: number; end: number }[] | null = metadata ? [] : null;
  const identifiers = metadata ? new Set<string>() : null;
  const call = `${DYNAMIC_IMPORT_HELPER}(${JSON.stringify(parentUrl)}, `;
  const ast = parseCell(code, metadata, (node) => {
    // These tags identify acorn's concrete node types, including escaped
    // identifiers and bindings in nested scopes.
    if (identifiers && node.type === 'Identifier') {
      const identifier = node as Identifier;
      identifiers.add(identifier.name);
    }
    if (node.type === 'ImportExpression') {
      const expression = node as ImportExpressionNode;
      spans.push({ start: expression.start, end: expression.source.start, text: call });
    }
    if (metadataSpans && node.type === 'MetaProperty') {
      const meta = node as MetaProperty;
      if (meta.meta.name === 'import' && meta.property.name === 'meta') metadataSpans.push({ start: meta.start, end: meta.end });
    }
  }, () => {
    spans.length = 0;
    if (metadataSpans) metadataSpans.length = 0;
    identifiers?.clear();
  });
  if (ast === null) return code;
  if (metadataSpans?.length) {
    // `module` can be a user binding (or a nested function parameter).
    // Capture the actual wrapper module by position once, using a name no
    // parsed scope binds. No additional CommonJS argument or wrapper parse.
    let binding = '__nimbusMetadataModule';
    while (identifiers!.has(binding)) binding += '_';
    for (const meta of metadataSpans) {
      spans.push({ start: meta.start, end: meta.end, text: `${binding}.__nimbusImportMeta` });
    }
    let insertion = ast.body[0]?.start ?? 0;
    for (const statement of ast.body) {
      if (!('directive' in statement) || typeof statement.directive !== 'string') break;
      insertion = statement.end;
    }
    // ESM is strict even when the intermediate ESM printer removed an
    // explicit directive as redundant. Carry it into the CJS function body.
    spans.push({ start: insertion, end: insertion, text: `\n"use strict";\nconst ${binding} = arguments[2];\n` });
  }
  if (spans.length === 0) return code;
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let at = 0;
  for (const { start, end, text } of spans) {
    out += code.slice(at, start) + text;
    at = end;
  }
  return out + code.slice(at);
}
