/**
 * Route a cell's import() to the process's ESM loader and bind import.meta to
 * its evaluation metadata. Worker Loader does not resolve VFS packages.
 *
 * The common path uses Acorn tokens without retaining a large bundle's AST.
 * Tokenization alone cannot disambiguate every valid JavaScript program:
 * keyword-named member calls can change slash context, and a brace after an
 * import can be an ASI-separated block rather than a method body. Those
 * cases, and tokenizer failures, use Acorn's parser with script/module goals.
 * Only failure of both grammars leaves the original code for the compiler
 * to diagnose. Plain CommonJS is never lexed under module strictness.
 */
import { Parser, tokenizer, tokTypes, type Token, type Node, type Program } from 'acorn';
import { full } from 'acorn-walk';

export const DYNAMIC_IMPORT_HELPER = '__nimbusDynamicImport';

export function mayHaveDynamicImport(code: string): boolean {
  return /\bimport\s*(?:\(|\/[/*])/.test(code);
}

interface Edit { start: number; end: number; text: string }
interface ImportCall { start: number; end: number }

const CONTINUES_EXPRESSION = new Set([
  tokTypes.parenL, tokTypes.bracketL, tokTypes.dot, tokTypes.questionDot, tokTypes.backQuote,
  tokTypes.comma, tokTypes.question, tokTypes.eq, tokTypes.assign, tokTypes.plusMin, tokTypes.modulo,
  tokTypes.star, tokTypes.slash, tokTypes.starstar, tokTypes.logicalOR, tokTypes.logicalAND,
  tokTypes.bitwiseOR, tokTypes.bitwiseXOR, tokTypes.bitwiseAND, tokTypes.equality, tokTypes.relational,
  tokTypes.bitShift, tokTypes.coalesce, tokTypes._in, tokTypes._instanceof,
]);
const LINE_BREAK = /[\r\n\u2028\u2029]/;

export function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata = false): string {
  const metadata = moduleMetadata && /\bimport\s*(?:\.|\/[/*])/.test(code);
  if (!mayHaveDynamicImport(code) && !metadata) return code;
  const edits: Edit[] = [];
  const metas: ImportCall[] = [];
  const names = metadata ? new Set<string>() : null;
  const parens: Array<ImportCall | 'member-keyword' | null> = [];
  const brackets: string[] = [];
  const call = `${DYNAMIC_IMPORT_HELPER}(${JSON.stringify(parentUrl)}, `;
  const fallback = () => rewriteWithParser(code, call, metadata);
  let previous: Token | undefined;
  let memberKeyword = false;
  let ambiguousSlash = false;
  let importToken: Token | undefined;
  let metaStart: Token | undefined;
  let closedImport: ImportCall | null = null;
  let directive: Token | undefined;
  let prologue = true;
  let insertion = -1;
  try {
    const tokens = tokenizer(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    for (;;) {
      const token = tokens.getToken();
      const type = token.type;
      // A successful tokenization can still mistake division after api.if()
      // for a regex and hide an import in the apparent regex body. Parse that
      // context as well as cases where the mistaken regex simply throws.
      if ((ambiguousSlash || memberKeyword) && type === tokTypes.regexp) return fallback();
      ambiguousSlash = false;
      if (insertion < 0) insertion = token.start;
      if (prologue) {
        if (directive) {
          if (type === tokTypes.semi) {
            insertion = token.end;
            directive = undefined;
          } else if (type === tokTypes.eof || (LINE_BREAK.test(code.slice(directive.end, token.start)) && !CONTINUES_EXPRESSION.has(type))) {
            insertion = directive.end;
            directive = type === tokTypes.string ? token : undefined;
            prologue = type === tokTypes.string;
          } else prologue = false;
        } else if (type === tokTypes.string) directive = token;
        else prologue = false;
      }
      if (closedImport) {
        // Only the grammar knows whether this brace is a method body, an
        // ASI-separated statement, or e.g. a class body after extends.
        if (type === tokTypes.braceL) return fallback();
        edits.push({ ...closedImport, text: call });
        closedImport = null;
      }
      if (metaStart) {
        if (type === tokTypes.name && code.slice(token.start, token.end) === 'meta') {
          metas.push({ start: metaStart.start, end: token.end });
        }
        metaStart = undefined;
      }
      if (type === tokTypes.name) names?.add(String(Reflect.get(token, 'value')));
      if (type === tokTypes.parenL) {
        parens.push(importToken ? { start: importToken.start, end: token.end } : memberKeyword ? 'member-keyword' : null);
        brackets.push('(');
      } else if (type === tokTypes.parenR) {
        if (brackets.pop() !== '(') return fallback();
        const frame = parens.pop();
        if (frame === 'member-keyword') ambiguousSlash = true;
        else closedImport = frame ?? null;
      } else if (type === tokTypes.braceL || type === tokTypes.dollarBraceL) brackets.push('{');
      else if (type === tokTypes.braceR) { if (brackets.pop() !== '{') return fallback(); }
      else if (type === tokTypes.bracketL) brackets.push('[');
      else if (type === tokTypes.bracketR) { if (brackets.pop() !== '[') return fallback(); }
      if (metadata && importToken && type === tokTypes.dot) metaStart = importToken;
      const member = previous?.type === tokTypes.dot || previous?.type === tokTypes.questionDot;
      memberKeyword = member && typeof Reflect.get(type, 'keyword') === 'string';
      const isKeyword = type === tokTypes._import && code.slice(token.start, token.end) === 'import';
      importToken = isKeyword && !member ? token : undefined;
      previous = token;
      if (type === tokTypes.eof) break;
    }
  } catch {
    return fallback();
  }
  if (brackets.length || parens.length) return fallback();
  return applyEdits(code, edits, metas, names, insertion);
}

/** Parser-informed fallback; discard completed top-level trees as before. */
function rewriteWithParser(code: string, call: string, metadata: boolean): string {
  const edits: Edit[] = [];
  const metas: ImportCall[] = [];
  const names = metadata ? new Set<string>() : null;
  const visit = (node: Node): void => {
    if (node.type === 'ImportExpression') {
      const source = Reflect.get(node, 'source') as Node;
      edits.push({ start: node.start, end: source.start, text: call });
    } else if (metadata && node.type === 'MetaProperty') {
      if (Reflect.get(node, 'meta').name === 'import' && Reflect.get(node, 'property').name === 'meta') {
        metas.push({ start: node.start, end: node.end });
      }
    } else if (metadata && node.type === 'Identifier') names!.add(Reflect.get(node, 'name'));
  };
  const StreamingParser = Parser.extend(Base => {
    const parseStatement = Reflect.get(Base.prototype, 'parseStatement');
    return class extends Base {
      parseStatement(context: unknown, topLevel: boolean, exports: unknown): Node {
        const node: Node = Reflect.apply(parseStatement, this, [context, topLevel, exports]);
        if (!topLevel) return node;
        full(node, visit);
        if (node.type === 'ExpressionStatement') {
          const expression = Reflect.get(node, 'expression');
          if (expression?.type === 'Literal' && typeof expression.value === 'string') return node;
        }
        return { type: 'EmptyStatement', start: node.start, end: node.end };
      }
    };
  });
  for (const sourceType of metadata ? ['module', 'script'] as const : ['script', 'module'] as const) {
    edits.length = 0; metas.length = 0; names?.clear();
    let program: Program;
    try {
      program = StreamingParser.parse(code, {
        ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true, allowHashBang: true,
      });
    } catch { continue; }
    let insertion = program.body[0]?.start ?? code.length;
    for (const statement of program.body) {
      if (typeof Reflect.get(statement, 'directive') !== 'string') break;
      insertion = statement.end;
    }
    return applyEdits(code, edits, metas, names, insertion);
  }
  return code;
}

function applyEdits(code: string, edits: Edit[], metas: ImportCall[], names: Set<string> | null, insertion: number): string {
  if (metas.length) {
    let binding = '__nimbusMetadataModule';
    while (names!.has(binding)) binding += '_';
    for (const meta of metas) edits.push({ ...meta, text: `${binding}.__nimbusImportMeta` });
    edits.push({ start: insertion, end: insertion, text: `\n"use strict";\nconst ${binding} = arguments[2];\n` });
  }
  if (!edits.length) return code;
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: string[] = [];
  let at = 0;
  for (const { start, end, text } of edits) {
    parts.push(code.slice(at, start), text);
    at = end;
  }
  parts.push(code.slice(at));
  return parts.join('');
}
