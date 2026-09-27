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
 * The same parse binds compiler-produced metadata references to the wrapper
 * module, using an identifier absent from every parsed scope. User bindings
 * named `module` cannot capture them; directives and five-argument CommonJS
 * wrappers are preserved.
 */
import { parse } from 'acorn';
import type { Node, Program, Identifier, MemberExpression } from 'acorn';
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
 * A cell's syntax tree. Sloppy script first, as the cell is compiled; then
 * module syntax, for what a transform left in (`import.meta`), which a
 * script may not contain.
 */
function parseCell(code: string): Program | null {
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
export function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata = false): string {
  const metadata = moduleMetadata && (code.includes('__nimbusModuleUrl') || code.includes('__nimbusImportMetaResolve'));
  if (!mayHaveDynamicImport(code) && !metadata) return code;
  const ast = parseCell(code);
  if (ast === null) return code;
  const spans: { start: number; end: number; text: string }[] = [];
  const metadataMembers: MemberExpression[] | null = metadata ? [] : null;
  const identifiers = metadata ? new Set<string>() : null;
  const call = `${DYNAMIC_IMPORT_HELPER}(${JSON.stringify(parentUrl)}, `;
  full(ast, (node) => {
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
    if (metadataMembers && node.type === 'MemberExpression') {
      const member = node as MemberExpression;
      if (!member.computed && member.property.type === 'Identifier'
        && (member.property.name === '__nimbusModuleUrl' || member.property.name === '__nimbusImportMetaResolve')) metadataMembers.push(member);
    }
  });
  if (metadataMembers?.length) {
    // `module` can be a user binding (or a nested function parameter).
    // Capture the actual wrapper module by position once, using a name no
    // parsed scope binds. No additional CommonJS argument or wrapper parse.
    let binding = '__nimbusMetadataModule';
    while (identifiers!.has(binding)) binding += '_';
    for (const member of metadataMembers) {
      const property = member.property as Identifier;
      spans.push({ start: member.start, end: member.end, text: `${binding}.${property.name}` });
    }
    let insertion = ast.body[0]?.start ?? 0;
    for (const statement of ast.body) {
      if (!('directive' in statement) || typeof statement.directive !== 'string') break;
      insertion = statement.end;
    }
    spans.push({ start: insertion, end: insertion, text: `\nconst ${binding} = arguments[2];\n` });
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
