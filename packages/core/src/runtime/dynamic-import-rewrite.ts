/**
 * Route a cell's import() to the process's ESM loader, and bind import.meta
 * to the evaluation's module metadata. Worker Loader only knows its module
 * map, not the process filesystem or package resolver.
 *
 * Acorn tokenizes the complete cell (strings, regexps, comments and template
 * quasis stay inert). Import calls are distinguished from members and method
 * definitions with the surrounding tokens and balanced parentheses. No AST
 * for the rest of the program is needed: building and walking a 4 MiB pi
 * chunk's entire tree just to edit a few import expressions exhausted the
 * transform guest's CPU budget. The registry still compiles/validates the
 * resulting code on first use; tokenization or delimiter errors leave the
 * original code intact for that compiler to diagnose.
 */
import { tokenizer, tokTypes, type Token } from 'acorn';

export const DYNAMIC_IMPORT_HELPER = '__nimbusDynamicImport';

/** Cheap rejection before tokenizing; comments may separate import and (. */
export function mayHaveDynamicImport(code: string): boolean {
  return /\bimport\s*(?:\(|\/[/*])/.test(code);
}

interface Edit { start: number; end: number; text: string }
interface ImportCall { start: number; end: number }

// A newline after a string literal only ends a directive when the following
// token cannot continue its expression (e.g. "use strict"\n[0] is not one).
const CONTINUES_EXPRESSION = new Set([
  tokTypes.parenL, tokTypes.bracketL, tokTypes.dot, tokTypes.questionDot, tokTypes.backQuote,
  tokTypes.comma, tokTypes.question, tokTypes.eq, tokTypes.assign, tokTypes.plusMin, tokTypes.modulo,
  tokTypes.star, tokTypes.slash, tokTypes.starstar, tokTypes.logicalOR, tokTypes.logicalAND,
  tokTypes.bitwiseOR, tokTypes.bitwiseXOR, tokTypes.bitwiseAND, tokTypes.equality, tokTypes.relational,
  tokTypes.bitShift, tokTypes.coalesce, tokTypes._in, tokTypes._instanceof,
]);

export function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata = false): string {
  const metadata = moduleMetadata && /\bimport\s*(?:\.|\/[/*])/.test(code);
  if (!mayHaveDynamicImport(code) && !metadata) return code;
  const edits: Edit[] = [];
  const metas: Array<{ start: number; end: number }> = [];
  const names = metadata ? new Set<string>() : null;
  const parens: Array<ImportCall | null> = [];
  const brackets: string[] = [];
  const call = `${DYNAMIC_IMPORT_HELPER}(${JSON.stringify(parentUrl)}, `;
  let previous: Token | undefined;
  let importToken: Token | undefined;
  let metaStart: Token | undefined;
  let closedImport: ImportCall | null = null;
  let directive: Token | undefined;
  let prologue = true;
  let insertion = -1;
  try {
    const tokens = tokenizer(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    for (;;) {
      const token = tokens.getToken();
      const type = token.type;
      if (insertion < 0) insertion = token.start;
      if (prologue) {
        if (directive) {
          if (type === tokTypes.semi) {
            insertion = token.end;
            directive = undefined;
          } else if (type === tokTypes.eof || (/[\r\n\u2028\u2029]/.test(code.slice(directive.end, token.start)) && !CONTINUES_EXPRESSION.has(type))) {
            insertion = directive.end;
            directive = type === tokTypes.string ? token : undefined;
            prologue = type === tokTypes.string;
          } else prologue = false;
        } else if (type === tokTypes.string) directive = token;
        else prologue = false;
      }
      // A method named import has a body immediately after its parameter
      // list. Calls nested in its default parameters are independent imports.
      if (closedImport) {
        if (type !== tokTypes.braceL) edits.push({ ...closedImport, text: call });
        closedImport = null;
      }
      if (metaStart) {
        if (type === tokTypes.name && code.slice(token.start, token.end) === 'meta') {
          metas.push({ start: metaStart.start, end: token.end });
        }
        metaStart = undefined;
      }
      if (type === tokTypes.name) names?.add(String(Reflect.get(token, "value")));
      if (type === tokTypes.parenL) {
        parens.push(importToken ? { start: importToken.start, end: token.end } : null);
        brackets.push('(');
      } else if (type === tokTypes.parenR) {
        if (brackets.pop() !== '(') return code;
        closedImport = parens.pop() ?? null;
      } else if (type === tokTypes.braceL || type === tokTypes.dollarBraceL) brackets.push('{');
      else if (type === tokTypes.braceR) { if (brackets.pop() !== '{') return code; }
      else if (type === tokTypes.bracketL) brackets.push('[');
      else if (type === tokTypes.bracketR) { if (brackets.pop() !== '[') return code; }
      if (metadata && importToken && type === tokTypes.dot) metaStart = importToken;
      const isKeyword = type === tokTypes._import && code.slice(token.start, token.end) === 'import';
      importToken = isKeyword && previous?.type !== tokTypes.dot && previous?.type !== tokTypes.questionDot ? token : undefined;
      previous = token;
      if (type === tokTypes.eof) break;
    }
  } catch {
    return code;
  }
  if (brackets.length || parens.length) return code;
  if (metas.length) {
    let binding = '__nimbusMetadataModule';
    while (names!.has(binding)) binding += '_';
    for (const meta of metas) edits.push({ ...meta, text: `${binding}.__nimbusImportMeta` });
    // Capture the actual wrapper argument, not a user binding named module.
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
