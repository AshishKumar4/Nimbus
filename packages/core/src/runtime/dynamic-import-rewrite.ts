/**
 * Route a cell's import() to its process loader and bind import.meta to its
 * evaluation metadata. Use the maintained module lexer for whole-cell spans:
 * it handles strings, templates and regexp context without a full AST or a
 * runtime wasm compile. Acorn only checks individual import argument lists,
 * leading directives and escaped identifiers that can collide with a capture.
 */
import { Parser, parseExpressionAt, tokenizer, tokTypes } from 'acorn';
import type { Token, TokenType } from 'acorn';
import { full } from 'acorn-walk';
import { parse as moduleImports } from 'es-module-lexer/js';
import type { ImportSpecifier } from 'es-module-lexer/js';

export const DYNAMIC_IMPORT_HELPER = '__nimbusDynamicImport';

export function mayHaveDynamicImport(code: string): boolean {
  return /\bimport\s*(?:\(|\/[/*])/.test(code);
}

interface Edit { start: number; end: number; text: string }
interface ImportCall { start: number; end: number }

// The CSP/asm.js entry exports parse only; these are its documented t values.
const DYNAMIC_IMPORT_TYPE = 2;
const IMPORT_META_TYPE = 3;
/** Acorn's public tokenizer at a source offset, without copying the suffix. */
class OffsetTokens extends Parser {
  static at(code: string, start: number, expressionAllowed = true): OffsetTokens {
    // Acorn's startPos constructor counts all preceding lines even when
    // locations are off. These offset-only reads need no location bookkeeping.
    const tokens = new OffsetTokens({ ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }, code);
    Reflect.set(tokens, 'pos', start);
    Reflect.set(tokens, 'start', start);
    Reflect.set(tokens, 'end', start);
    Reflect.set(tokens, 'exprAllowed', expressionAllowed);
    return tokens;
  }
  take(): Token {
    return Reflect.apply(Reflect.get(Parser.prototype, 'getToken'), this, []);
  }
  raise(_position: number, message: string): never {
    // Narrow lexical probes are caught locally; the cell compiler owns user
    // diagnostics. Do not rescan a multi-MiB prefix just to label a probe.
    throw new SyntaxError(message);
  }
}

/**
 * The module lexer can confuse a method named import (especially with an
 * imported default argument) with a call, and a naked call followed by an ASI
 * block with a method. Select Acorn's full grammar for those ambiguous cells.
 * Tokenization only selects this path; it never decides what to rewrite.
 */
function needsFullGrammar(code: string, imports: readonly ImportSpecifier[]): boolean {
  for (const entry of imports) {
    if (entry.t === DYNAMIC_IMPORT_TYPE && OffsetTokens.at(code, entry.se, false).take().type === tokTypes.braceL) return true;
  }
  const recognized = new Set(imports.map(entry => entry.ss));
  const missing: number[] = [];
  for (const match of code.matchAll(/\bimport\s*(?:\(|\/[/*])/g)) {
    if (!recognized.has(match.index)) missing.push(match.index);
  }
  if (!missing.length) return false;
  try {
    const tokens = tokenizer(code, { ecmaVersion: 'latest', allowHashBang: true });
    let previous: TokenType = tokTypes.eof;
    let next = 0;
    for (;;) {
      const token = tokens.getToken();
      while (next < missing.length && missing[next] < token.start) next++;
      if (token.type === tokTypes.eof || next === missing.length) return false;
      // A slash token can itself be ambiguous after a keyword-named member.
      // Neither lexical scan is authoritative in that case; Acorn parses it.
      if (token.type === tokTypes.regexp && missing[next] < token.end) return true;
      if (token.type === tokTypes._import && missing[next] === token.start && previous !== tokTypes.dot && previous !== tokTypes.questionDot) {
        if (tokens.getToken().type === tokTypes.parenL) return true;
      }
      previous = token.type;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return true;
  }
}

/** Only the module lexer's method/ASI ambiguity needs a whole-cell AST. */
function rewriteWithFullGrammar(code: string, parentUrl: string, metadata: boolean): string {
  for (const sourceType of metadata ? ['module', 'script'] as const : ['script', 'module'] as const) {
    try {
      const ast = Parser.parse(code, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
      const edits: Edit[] = [];
      const metas: ImportCall[] = [];
      const names = new Set<string>();
      const call = DYNAMIC_IMPORT_HELPER + '(' + JSON.stringify(parentUrl) + ', ';
      full(ast, node => {
        if (node.type === 'ImportExpression') {
          const tokens = OffsetTokens.at(code, node.start);
          tokens.take();
          edits.push({ start: node.start, end: tokens.take().end, text: call });
        } else if (metadata && node.type === 'MetaProperty' && Reflect.get(node, 'meta').name === 'import') {
          metas.push({ start: node.start, end: node.end });
        } else if (metadata && node.type === 'Identifier') {
          const name: unknown = Reflect.get(node, 'name');
          if (typeof name === 'string' && name.startsWith(METADATA_BINDING)) names.add(name);
        }
      });
      if (!edits.length && !metas.length) return code;
      return applyEdits(code, edits, metas, names, metas.length ? afterDirectives(code) : 0);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return code;
}

const IDENTIFIER_PART = /[$_\p{ID_Continue}\u200c\u200d]/u;
const METADATA_BINDING = '__nimbusMetadataModule';

/**
 * Ordinary spellings can be excluded by raw membership, even in text. Only
 * unicode-escaped identifiers need decoding. Read those words with Acorn,
 * not an entire cell AST; names inside text may over-exclude safely.
 */
function escapedCaptureNames(code: string): Set<string> {
  const names = new Set<string>();
  for (let at = code.indexOf('\\u'); at !== -1; at = code.indexOf('\\u', at)) {
    let start = at;
    while (start > 0 && IDENTIFIER_PART.test(code[start - 1])) start--;
    try {
      const token = OffsetTokens.at(code, start).take();
      const value: unknown = Reflect.get(token, 'value');
      if (token.type === tokTypes.name && typeof value === 'string' && value.startsWith(METADATA_BINDING)) names.add(value);
      at = Math.max(at + 2, token.end);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A unicode escape in text need not be a legal identifier.
      at += 2;
    }
  }
  return names;
}

/** Keep the user's directive prologue in front of the metadata capture. */
function afterDirectives(code: string): number {
  const tokens = OffsetTokens.at(code, 0);
  let token = tokens.take();
  let insertion = token.start;
  while (token.type === tokTypes.string) {
    const expression = parseExpressionAt(code, token.start, { ecmaVersion: 'latest', sourceType: 'script' });
    if (expression.type !== 'Literal' || typeof Reflect.get(expression, 'value') !== 'string') break;
    do { token = tokens.take(); } while (token.start < expression.end);
    if (token.type === tokTypes.semi) {
      insertion = token.end;
      token = tokens.take();
      continue;
    }
    if (token.type !== tokTypes.eof && !/[\n\r\u2028\u2029]/.test(code.slice(expression.end, token.start))) break;
    insertion = expression.end;
  }
  return insertion;
}

/**
 * The lexer reports positions, not argument-count/spread validity. Validate
 * only each outer import call in a function context, never its surrounding
 * bundle. Both normal and generator contexts preserve contextual yield uses;
 * the enclosing cell's compiler still owns scope/strictness validation.
 */
function validImportArguments(fragment: string): boolean {
  for (const prefix of ['async function(){return ', 'async function*(){return ']) {
    try {
      parseExpressionAt(prefix + fragment + '\n}', 0, {
        ecmaVersion: 'latest', sourceType: 'script',
        allowImportExportEverywhere: true, allowSuperOutsideMethod: true,
        checkPrivateFields: false,
      });
      return true;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return false;
}

export function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata = false): string {
  const metadata = moduleMetadata && /\bimport\s*(?:\.|\/[/*])/.test(code);
  if (!mayHaveDynamicImport(code) && !metadata) return code;
  const call = DYNAMIC_IMPORT_HELPER + '(' + JSON.stringify(parentUrl) + ', ';
  const edits: Edit[] = [];
  const metas: ImportCall[] = [];
  let validatedEnd = -1;
  try {
    const [imports] = moduleImports(code);
    if (needsFullGrammar(code, imports)) return rewriteWithFullGrammar(code, parentUrl, metadata);
    for (const entry of imports) {
      if (entry.t === DYNAMIC_IMPORT_TYPE) {
        if (entry.ss >= validatedEnd) {
          if (!validImportArguments(code.slice(entry.ss, entry.se))) return code;
          validatedEnd = entry.se;
        }
        // d is the opening parenthesis; do not consume grouping in the arg.
        edits.push({ start: entry.ss, end: entry.d + 1, text: call });
      } else if (metadata && entry.t === IMPORT_META_TYPE) {
        metas.push({ start: entry.s, end: entry.e });
      }
    }
    if (!edits.length && !metas.length) return code;
    return applyEdits(code, edits, metas, metas.length ? escapedCaptureNames(code) : null, metas.length ? afterDirectives(code) : 0);
  } catch (error) {
    // Leave invalid JavaScript to the cell compiler, not unexpected failures.
    if (error instanceof SyntaxError || (error instanceof Error && typeof Reflect.get(error, 'idx') === 'number')) return code;
    throw error;
  }
}

function applyEdits(code: string, edits: Edit[], metas: ImportCall[], names: Set<string> | null, insertion: number): string {
  if (metas.length) {
    let binding = METADATA_BINDING;
    while (code.includes(binding) || names!.has(binding)) binding += '_';
    for (const meta of metas) edits.push({ ...meta, text: `${binding}.__nimbusImportMeta` });
    edits.push({ start: insertion, end: insertion, text: `\n"use strict";\nconst ${binding} = arguments[2];\n` });
  }
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
