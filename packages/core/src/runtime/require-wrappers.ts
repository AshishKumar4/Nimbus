/**
 * require-wrappers.ts — what a module's require wrappers load, read by the
 * supervisor's walk (require-resolver.ts) and kept by file revision
 * (require-resolution.ts requireFsOverBridge).
 */
import { tokenizer, tokTypes, type TokenType } from 'acorn';
import { programWrapperCalls } from '../interpreter/module-requests.js';
import { parseJavaScriptProgram } from './javascript-ast.js';

/**
 * What a module's require wrappers load: a function that passes its first
 * parameter to a require (the module's own, or one createRequire made, by any
 * name), or to its `.resolve`, loads what each of its calls names with a
 * string. @vitejs/plugin-vue loads the project's compiler so:
 *
 *   const _require = createRequire(import.meta.url);
 *   function tryRequire(id, from) {
 *     try { return from ? _require(_require.resolve(id, { paths: [from] })) : _require(id); } catch (e) {}
 *   }
 *   … tryRequire("vue/compiler-sfc", root) …
 *
 * No other grammar reads that call, and a Vue project's first `vite` and
 * `vite build` failed on what it loads. The calls are read by the analysis
 * the runtime's import() prefetch reads them with
 * (core/interpreter/module-requests.ts programWrapperCalls), over the parsed
 * module. Only a module whose tokens could hold one is parsed
 * (mayCallRequireWrapper): almost none do. The supervisor keeps what a
 * revision of a file answers (RequireFs.wrapperCalls), so a launch reads it
 * and only the first walk after a write pays.
 */
export function requireWrapperCalls(code: string): string[] {
  // `require` or `createRequire`, spelled without escapes, before any token is read.
  if (!code.includes('equire') || !mayCallRequireWrapper(code)) return [];
  // A module nested past the walk's stack names no load, as one acorn cannot parse.
  try {
    const program = parseJavaScriptProgram(code);
    return program === null ? [] : programWrapperCalls(program);
  } catch {
    return [];
  }
}

// The tokens mayCallRequireWrapper reads, by acorn's token type; any other is OTHER.
const OTHER = 0, NAME = 1, STRING = 2, BACKQUOTE = 3, TEMPLATE = 4, PAREN_L = 5, PAREN_R = 6, COMMA = 7,
  DOT = 8, QUESTION_DOT = 9, EQ = 10, ARROW = 11, STAR = 12, FUNCTION = 13, STATEMENT_END = 14;
const TOKEN_KINDS = new Map<TokenType, number>([
  [tokTypes.name, NAME], [tokTypes.string, STRING], [tokTypes.backQuote, BACKQUOTE], [tokTypes.template, TEMPLATE],
  [tokTypes.parenL, PAREN_L], [tokTypes.parenR, PAREN_R], [tokTypes.comma, COMMA], [tokTypes.dot, DOT],
  [tokTypes.questionDot, QUESTION_DOT], [tokTypes.eq, EQ], [tokTypes.arrow, ARROW], [tokTypes.star, STAR],
  [tokTypes._function, FUNCTION], [tokTypes.semi, STATEMENT_END], [tokTypes.braceL, STATEMENT_END],
  [tokTypes.braceR, STATEMENT_END],
]);

/** `source`'s tokens as acorn reads them (a module's, else a script's), each a kind and a name token's name; null if neither tokenizes. */
function tokensOf(source: string): { kinds: Uint8Array; names: Map<number, string>; length: number } | null {
  for (const sourceType of ['module', 'script'] as const) {
    let kinds = new Uint8Array(1024);
    const names = new Map<number, string>();
    let length = 0;
    try {
      const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
      for (let token = tokens.getToken(); token.type !== tokTypes.eof; token = tokens.getToken()) {
        if (length === kinds.length) { const grown = new Uint8Array(length * 2); grown.set(kinds); kinds = grown; }
        const kind = TOKEN_KINDS.get(token.type) ?? OTHER;
        // A name token's value (acorn's declarations leave it out), its escapes read.
        if (kind === NAME) names.set(length, String(Reflect.get(token, 'value')));
        kinds[length++] = kind;
      }
      return { kinds, names, length };
    } catch { /* the other source type */ }
  }
  return null;
}

/**
 * Whether `source` could call a require wrapper as the analysis reads one,
 * read from its tokens (names with their escapes read, strings, regular
 * expressions and comments told apart, as the parse tells them): a require
 * (`require`, or a name createRequire's value is assigned to) called with a
 * name first, maybe parenthesized, optional or through `.resolve`; a named
 * function (a declaration, or a function or arrow assigned to a name) whose
 * first parameter has that name; and a call of that function's name with a
 * string first. Each is implied by a wrapper call the analysis reads, so a
 * module it turns away has none, whatever its forms.
 */
export function mayCallRequireWrapper(source: string): boolean {
  const tokens = tokensOf(source);
  if (tokens === null) return false;
  const { kinds, names, length } = tokens;
  const kind = (i: number) => (i >= 0 && i < length ? kinds[i]! : OTHER);
  const member = (i: number) => kind(i) === DOT || kind(i) === QUESTION_DOT;
  // The requires: the module's own, and each name a createRequire is assigned to within its statement.
  const requires = new Set(['require']);
  for (const [at, name] of names) {
    if (name !== 'createRequire') continue;
    for (let i = at - 1; i > 0 && kind(i) !== STATEMENT_END; i--) {
      if (kind(i) === EQ && kind(i - 1) === NAME && !member(i - 2)) { requires.add(names.get(i - 1)!); break; }
    }
  }
  // Names a require is passed first: `r(x`, `(r)(x`, `r?.(x`, `r.resolve(x`, `r?.resolve((x)`.
  const params = new Set<string>();
  for (const [at, name] of names) {
    if (!requires.has(name) || member(at - 1)) continue;
    let i = at + 1;
    while (kind(i) === PAREN_R) i++;
    if (member(i) && names.get(i + 1) === 'resolve') { i += 2; while (kind(i) === PAREN_R) i++; }
    if (kind(i) === QUESTION_DOT) i++;
    if (kind(i) !== PAREN_L) continue;
    i++;
    while (kind(i) === PAREN_L) i++;
    if (kind(i) === NAME && (kind(i + 1) === COMMA || kind(i + 1) === PAREN_R)) params.add(names.get(i)!);
  }
  if (params.size === 0) return false;
  // The name `x` in `x = [(…] [async] …` ending just before `at`.
  const assignedBefore = (at: number): string | undefined => {
    let i = at;
    while (kind(i) === PAREN_L || (kind(i) === NAME && names.get(i) === 'async')) i--;
    return kind(i) === EQ && kind(i - 1) === NAME && !member(i - 2) ? names.get(i - 1) : undefined;
  };
  // Named functions with one of them first: `function f(x`, `function* f(x`,
  // `f = function (x`, `f = (async (x`, `f = x =>`.
  const candidates = new Set<string>();
  for (const [at, name] of names) {
    if (!params.has(name)) continue;
    let assigned: string | undefined;
    if (kind(at - 1) === PAREN_L) {
      const before = at - 2;
      const star = kind(before) === STAR ? 1 : 0;
      if (kind(before) === NAME && (kind(before - 1) === FUNCTION || (kind(before - 1) === STAR && kind(before - 2) === FUNCTION))) {
        candidates.add(names.get(before)!);
        assigned = assignedBefore(kind(before - 1) === STAR ? before - 3 : before - 2);
      } else if (kind(before - star) === FUNCTION) {
        assigned = assignedBefore(before - star - 1);
      } else {
        assigned = assignedBefore(before);
      }
    } else if (kind(at + 1) === ARROW) {
      assigned = assignedBefore(at - 1);
    }
    if (assigned !== undefined) candidates.add(assigned);
  }
  for (const name of requires) candidates.delete(name);
  if (candidates.size === 0) return false;
  // One of them called with a string first: `f('x'`, `(f)(('x')`, f?.(`x`.
  for (let at = 0; at < length; at++) {
    if (kind(at) !== PAREN_L) continue;
    let i = at + 1;
    while (kind(i) === PAREN_L) i++;
    if (kind(i) !== STRING && !(kind(i) === BACKQUOTE && (kind(i + 1) === BACKQUOTE || (kind(i + 1) === TEMPLATE && kind(i + 2) === BACKQUOTE)))) continue;
    let callee = at - 1;
    if (kind(callee) === QUESTION_DOT) callee--;
    while (kind(callee) === PAREN_R) callee--;
    if (kind(callee) === NAME && candidates.has(names.get(callee)!) && !member(callee - 1)) return true;
  }
  return false;
}
