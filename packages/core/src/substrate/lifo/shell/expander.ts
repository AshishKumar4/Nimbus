import type { WordPart } from './types.js';
import { isShellIdentifier } from './names.js';
import { DEFAULT_HOME } from '../../../constants.js';
import type { ProcessView } from '../../../runtime/process-files.js';
import { escapeGlob, expandGlob, globMatch } from '../utils/glob.js';
import { readAnsiCQuote, readBalancedCommand, readBracedExpansion } from './lexer.js';
import type { ShellOptions } from './state.js';

export interface ExpandContext {
  env: Record<string, string>;
  /**
   * Indexed arrays, sparse: a hole is an index that was never assigned, which
   * `${arr[@]}` skips and `${!arr[@]}` omits. A name lives here or in `env`,
   * never both, so `$arr` and `${arr[0]}` have one answer.
   */
  arrays?: ReadonlyMap<string, readonly (string | undefined)[]>;
  positionals?: readonly string[];
  lastExitCode: number;
  cwd: string;
  vfs: ProcessView;
  options: ShellOptions;
  executeCapture?: (input: string) => Promise<CapturedCommand>;
  /**
   * Exit status of the most recent command substitution expanded through this
   * context, or undefined when there was none. A command made up only of
   * assignments — `out="$(cmd)"` — takes its own status from here, which is
   * what makes `out="$(cmd)" || die` and `set -e` see a failing `cmd`.
   */
  lastSubstitutionExitCode?: number;
  /**
   * Expanding a here-document's body, where `'` and `$'...'` are literal
   * text, inside a parameter's `-`, `+`, `=` and `?` words too.
   */
  hereDocument?: boolean;
}

export interface CapturedCommand {
  output: string;
  exitCode: number;
}

/**
 * A parameter expansion that aborts the command it belongs to: `set -u` on an
 * unset parameter, or an explicit `${var:?message}`.
 */
export class ExpansionError extends Error {}

const IFS_WHITESPACE = ' \t\n';

/**
 * One contribution to a word being expanded.
 *
 * `split` marks characters that came out of an unquoted expansion and are
 * therefore the only ones IFS field splitting may cut on; `literal` marks
 * characters that were inside quotes, which is what keeps an empty field
 * alive (`""` is an argument, an unquoted empty expansion is not).
 * `break` is the hard field boundary between the elements of `"$@"`.
 */
type Piece =
  | { kind: 'text'; text: string; split: boolean; literal: boolean }
  | { kind: 'break' };

/** A parameter is either a plain string or the positional-parameter list. */
type Parameter =
  | { kind: 'scalar'; value: string | undefined }
  /** `star` distinguishes `$*` / `${arr[*]}` from `$@` / `${arr[@]}`. */
  | { kind: 'list'; values: readonly string[]; star: boolean };

/** A parameter as written: a name, optionally subscripted by an array index. */
type ParameterRef = { name: string; subscript?: string };

/**
 * Expand all words for a command's arguments: brace expansion, tilde,
 * parameter/arithmetic/command substitution, IFS field splitting, globbing.
 */
export async function expandWords(words: WordPart[][], ctx: ExpandContext): Promise<string[]> {
  const results: string[] = [];

  for (const word of words) {
    for (const braceExpandedWord of expandBraceWord(word)) {
      // Each field globbed as a pattern whose quoted characters match only
      // themselves: an unquoted expansion's `*` globs, a quoted one's does not.
      for (const field of splitFields(await expandParts(braceExpandedWord, ctx), ifsOf(ctx))) {
        results.push(...await expandGlob(field.pattern, field.text, ctx.cwd, ctx.vfs));
      }
    }
  }

  return results;
}

/**
 * A pattern word (a case pattern, `[[ ]]`'s right-hand side) expanded, as its
 * value and as the pattern globMatch reads: each character that came from
 * quotes, a quoted part or a quoted expansion, escaped so it matches only
 * itself, and an unquoted expansion's characters left as pattern characters.
 */
export async function expandPatternWord(parts: WordPart[], ctx: ExpandContext): Promise<{ value: string; pattern: string }> {
  const pieces = await expandParts(parts, ctx);
  return { value: joinPieces(pieces), pattern: patternOf(pieces) };
}

/** `pieces` as a pattern: quoted characters escaped (escapeGlob). */
function patternOf(pieces: readonly Piece[]): string {
  let pattern = '';
  for (const piece of pieces) {
    if (piece.kind === 'break') pattern += ' ';
    else pattern += piece.literal ? escapeGlob(piece.text) : piece.text;
  }
  return pattern;
}

/**
 * Expand a single word (e.g., for redirect targets and assignments).
 * No field splitting and no glob expansion.
 */
export async function expandWord(parts: WordPart[], ctx: ExpandContext): Promise<string> {
  return joinPieces(await expandParts(parts, ctx));
}

function expandBraceWord(parts: WordPart[]): WordPart[][] {
  let combinations: WordPart[][] = [[]];

  for (const part of parts) {
    if (part.commandSubstitution !== undefined || part.quoted !== 'none') {
      combinations = combinations.map((combo) => [...combo, part]);
      continue;
    }

    const expandedTexts = expandBraceText(part.text);
    const nextCombinations: WordPart[][] = [];
    for (const combo of combinations) {
      for (const text of expandedTexts) {
        nextCombinations.push([...combo, { text, quoted: 'none' }]);
      }
    }
    combinations = nextCombinations;
  }

  return combinations;
}

function expandBraceText(text: string): string[] {
  const span = findBraceSpan(text);
  if (!span) return [text];

  const prefix = text.slice(0, span.start);
  const suffix = text.slice(span.end + 1);
  const results: string[] = [];

  for (const choice of splitBraceChoices(text.slice(span.start + 1, span.end))) {
    for (const expanded of expandBraceText(`${prefix}${choice}${suffix}`)) {
      results.push(expanded);
    }
  }

  return results;
}

function findBraceSpan(text: string): { start: number; end: number } | null {
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '{') {
      i = readBalancedCommand(text, i + 2, '{', '}').end;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '(') {
      i = readBalancedCommand(text, i + 2, '(', ')').end;
      continue;
    }
    if (text[i] === '{') {
      const end = findBraceEndWithTopLevelComma(text, i);
      if (end !== null) {
        return { start: i, end };
      }
    }
    i++;
  }

  return null;
}

function findBraceEndWithTopLevelComma(text: string, start: number): number | null {
  let depth = 0;
  let hasTopLevelComma = false;

  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '{') {
      i = readBalancedCommand(text, i + 2, '{', '}').end - 1;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '(') {
      i = readBalancedCommand(text, i + 2, '(', ')').end - 1;
      continue;
    }
    if (text[i] === '{') {
      depth++;
      continue;
    }
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return hasTopLevelComma ? i : null;
      }
      continue;
    }
    if (text[i] === ',' && depth === 1) {
      hasTopLevelComma = true;
    }
  }

  return null;
}

function splitBraceChoices(inner: string): string[] {
  const choices: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      i++;
      continue;
    }
    if (inner[i] === '$' && inner[i + 1] === '{') {
      i = readBalancedCommand(inner, i + 2, '{', '}').end - 1;
      continue;
    }
    if (inner[i] === '$' && inner[i + 1] === '(') {
      i = readBalancedCommand(inner, i + 2, '(', ')').end - 1;
      continue;
    }
    if (inner[i] === '{') {
      depth++;
      continue;
    }
    if (inner[i] === '}') {
      depth--;
      continue;
    }
    if (inner[i] === ',' && depth === 0) {
      choices.push(inner.slice(start, i));
      start = i + 1;
    }
  }

  choices.push(inner.slice(start));
  return choices;
}

// ─── Word assembly ───

async function expandParts(parts: WordPart[], ctx: ExpandContext): Promise<Piece[]> {
  const pieces: Piece[] = [];

  for (const part of parts) {
    if (part.commandSubstitution !== undefined) {
      const output = await expandCommandSubstitution(part.commandSubstitution, ctx);
      pieces.push(valuePiece(output, part.quoted !== 'none'));
      continue;
    }

    if (part.quoted === 'single') {
      pieces.push({ kind: 'text', text: part.text, split: false, literal: true });
      continue;
    }

    if (part.quoted === 'double') {
      // `"$@"` with no positional parameters must vanish entirely, so only an
      // empty pair of quotes contributes the empty field that keeps `""` alive.
      if (part.text === '') pieces.push({ kind: 'text', text: '', split: false, literal: true });
      else pieces.push(...await expandText(part.text, ctx, true));
      continue;
    }

    pieces.push(...await expandText(tildeExpanded(part.text, ctx, pieces), ctx, false));
  }

  return pieces;
}

function tildeExpanded(text: string, ctx: ExpandContext, preceding: readonly Piece[]): string {
  const atWordStart = !preceding.some((p) => p.kind === 'break' || p.text !== '');
  if (!atWordStart || !text.startsWith('~')) return text;
  const home = ctx.env['HOME'] ?? DEFAULT_HOME;
  if (text === '~') return home;
  if (text.startsWith('~/')) return home + text.slice(1);
  return text;
}

async function expandCommandSubstitution(command: string, ctx: ExpandContext): Promise<string> {
  if (!ctx.executeCapture) return '';
  const { output, exitCode } = await ctx.executeCapture(command);
  ctx.lastSubstitutionExitCode = exitCode;
  return output.replace(/\n+$/, '');
}

/** Expand every `$…` in one run of text, keeping literal and expanded runs apart. */
async function expandText(text: string, ctx: ExpandContext, quoted: boolean): Promise<Piece[]> {
  const pieces: Piece[] = [];
  let literal = '';

  const flush = (): void => {
    if (literal === '') return;
    pieces.push({ kind: 'text', text: literal, split: false, literal: quoted });
    literal = '';
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] !== '$') {
      literal += text[i];
      i++;
      continue;
    }
    const dollar = await expandDollar(text, i, ctx, quoted);
    if (dollar.pieces === null) {
      literal += text.slice(i, dollar.end);
    } else {
      flush();
      pieces.push(...dollar.pieces);
    }
    i = dollar.end;
  }

  flush();
  return pieces;
}

async function expandDollar(
  text: string, pos: number, ctx: ExpandContext, quoted: boolean,
): Promise<{ pieces: Piece[] | null; end: number }> {
  const next = text[pos + 1];

  if (next === undefined) return { pieces: null, end: pos + 1 };

  // $((...)) -- arithmetic expansion
  if (next === '(' && text[pos + 2] === '(') {
    const arithmetic = readArithmeticExpansion(text, pos);
    const result = evaluateArithmetic(arithmetic.expression, ctx.env, ctx.positionals);
    return { pieces: [valuePiece(String(result), quoted)], end: arithmetic.end };
  }

  // Raw command substitution is handled by structured WordPart values emitted
  // by the lexer. This branch is retained only for caller-constructed WordPart
  // values that did not pass through the lexer.
  if (next === '(') {
    const end = readBalancedCommand(text, pos + 2, '(', ')').end;
    const output = await expandCommandSubstitution(text.slice(pos + 2, end - 1), ctx);
    return { pieces: [valuePiece(output, quoted)], end };
  }

  // ${...} -- braced parameter expansion
  if (next === '{') {
    const braced = readBracedExpansion(text, pos);
    return { pieces: await expandBraced(braced.inner, ctx, quoted), end: braced.end };
  }

  const name = readParameterName(text, pos + 1);
  if (name === null) return { pieces: null, end: pos + 1 };
  return { pieces: await expandParameter({ name }, ctx, quoted), end: pos + 1 + name.length };
}

/**
 * The parameter name directly after an unbraced `$`: an identifier, a single
 * digit (`$10` is `${1}0`), or one of the special parameters.
 */
function readParameterName(text: string, pos: number): string | null {
  const match = /^(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]|[@*#?!$])/.exec(text.slice(pos));
  return match === null ? null : match[0];
}

function readArithmeticExpansion(text: string, pos: number): { expression: string; end: number } {
  let i = pos + 3;
  let parenDepth = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
      i++;
      continue;
    }

    if (ch === ')') {
      if (parenDepth === 0 && text[i + 1] === ')') {
        return { expression: text.slice(pos + 3, i), end: i + 2 };
      }
      if (parenDepth > 0) {
        parenDepth--;
      }
      i++;
      continue;
    }

    i++;
  }

  return { expression: text.slice(pos + 3), end: text.length };
}

// ─── Parameters ───

function isPositionalParameterName(name: string): boolean {
  return /^[1-9][0-9]*$/.test(name);
}

async function resolveParameter(ref: ParameterRef, ctx: ExpandContext): Promise<Parameter> {
  const { name, subscript } = ref;
  const positionals = ctx.positionals ?? [];
  if (name === '@' || name === '*') return { kind: 'list', values: positionals, star: name === '*' };
  if (name === '#') return { kind: 'scalar', value: String(positionals.length) };
  if (name === '?') return { kind: 'scalar', value: String(ctx.lastExitCode) };
  if (isPositionalParameterName(name)) {
    return { kind: 'scalar', value: positionals[Number.parseInt(name, 10) - 1] };
  }

  const array = ctx.arrays?.get(name);
  if (subscript === '@' || subscript === '*') {
    // A plain variable answers `${v[@]}` with its single value, as bash does.
    const values = array !== undefined
      ? array.filter((element): element is string => element !== undefined)
      : ctx.env[name] === undefined ? [] : [ctx.env[name]];
    return { kind: 'list', values, star: subscript === '*' };
  }
  if (array === undefined) {
    const value = ctx.env[name];
    if (subscript === undefined) return { kind: 'scalar', value };
    return { kind: 'scalar', value: await evaluateSubscript(subscript, 1, ctx) === 0 ? value : undefined };
  }
  const index = subscript === undefined ? 0 : await evaluateSubscript(subscript, array.length, ctx);
  return { kind: 'scalar', value: array[index] };
}

/** A subscript is an arithmetic expression; a negative index counts from the end. */
export async function evaluateSubscript(
  subscript: string, length: number, ctx: ExpandContext,
): Promise<number> {
  const expanded = joinPieces(await expandParameterWord(subscript, ctx, 'word'));
  if (expanded.trim() === '') return 0;
  const index = evaluateArithmetic(expanded, ctx.env, ctx.positionals);
  return index < 0 ? length + index : index;
}

/** The indices `${!arr[@]}` reports: every index that holds a value. */
function arrayIndices(ref: ParameterRef, ctx: ExpandContext): readonly string[] | null {
  if (ref.subscript !== '@' && ref.subscript !== '*') return null;
  const array = ctx.arrays?.get(ref.name);
  if (array === undefined) return ctx.env[ref.name] === undefined ? [] : ['0'];
  const indices: string[] = [];
  array.forEach((element, index) => {
    if (element !== undefined) indices.push(String(index));
  });
  return indices;
}

/** `$0`, `$$` and `$!` are shell state; the rest must exist under `set -u`. */
function isNounsetChecked(name: string): boolean {
  return name !== '0' && name !== '$' && name !== '!';
}

function requireSet(name: string, value: string | undefined, ctx: ExpandContext): string {
  if (value !== undefined) return value;
  if (ctx.options.nounset && isNounsetChecked(name)) {
    throw new ExpansionError(`${name}: unbound variable`);
  }
  return '';
}

async function expandParameter(
  ref: ParameterRef, ctx: ExpandContext, quoted: boolean,
): Promise<Piece[]> {
  const parameter = await resolveParameter(ref, ctx);
  if (parameter.kind === 'list') return listPieces(parameter.values, parameter.star, ctx, quoted);
  return [valuePiece(requireSet(ref.name, parameter.value, ctx), quoted)];
}

function valuePiece(text: string, quoted: boolean): Piece {
  return { kind: 'text', text, split: !quoted, literal: quoted };
}

/**
 * `$*` joins the positional parameters with the first character of IFS; `$@`
 * keeps them as separate fields even inside double quotes.
 */
function listPieces(
  values: readonly string[], star: boolean, ctx: ExpandContext, quoted: boolean,
): Piece[] {
  if (star) return [valuePiece(values.join((ctx.env['IFS'] ?? ' ').slice(0, 1)), quoted)];
  const pieces: Piece[] = [];
  for (const value of values) {
    if (pieces.length > 0) pieces.push({ kind: 'break' });
    pieces.push(valuePiece(value, quoted));
  }
  return pieces;
}

// ─── ${...} ───

const DEFAULT_OPERATORS = new Set(['-', '=', '?', '+']);

async function expandBraced(inner: string, ctx: ExpandContext, quoted: boolean): Promise<Piece[]> {
  if (inner === '') return [];

  // ${#param} -- string length, or element count for $@ / $* / ${arr[@]}
  if (inner.length > 1 && inner[0] === '#') {
    const parameter = parseParameterRef(inner.slice(1));
    if (parameter !== null && parameter.rest === '') {
      const resolved = await resolveParameter(parameter, ctx);
      const length = resolved.kind === 'list'
        ? resolved.values.length
        : requireSet(parameter.name, resolved.value, ctx).length;
      return [valuePiece(String(length), quoted)];
    }
  }

  // ${!param} -- the indices of an array, or the parameter this one names
  if (inner.length > 1 && inner[0] === '!') {
    const parameter = parseParameterRef(inner.slice(1));
    if (parameter !== null) {
      const indices = parameter.rest === '' ? arrayIndices(parameter, ctx) : null;
      if (indices !== null) return listPieces(indices, parameter.subscript === '*', ctx, quoted);
      const target = scalarOf(await resolveParameter(parameter, ctx), ctx);
      const indirect = parseParameterRef(target);
      if (indirect === null || indirect.rest !== '') return [valuePiece('', quoted)];
      if (parameter.rest === '') return (await expandParameter(indirect, ctx, quoted));
      return (await applyModifier(indirect, parameter.rest, ctx, quoted));
    }
  }

  const parameter = parseParameterRef(inner);
  if (parameter === null) return [valuePiece('', quoted)];
  if (parameter.rest === '') return (await expandParameter(parameter, ctx, quoted));
  return (await applyModifier(parameter, parameter.rest, ctx, quoted));
}

/**
 * Split `${name[subscript]<modifier>}` into its parameter and the modifier
 * tail. The subscript is kept as written — it is an arithmetic expression, or
 * `@` / `*` for the whole array — and evaluated when the value is read.
 */
function parseParameterRef(inner: string): (ParameterRef & { rest: string }) | null {
  const match = /^(?:([a-zA-Z_][a-zA-Z0-9_]*)(\[([^[\]]*(?:\[[^\]]*\])?[^[\]]*)\])?|[0-9]+|[@*#?!$])/
    .exec(inner);
  if (match === null || match[0] === '') return null;
  const ref: ParameterRef & { rest: string } = {
    name: match[1] ?? match[0],
    rest: inner.slice(match[0].length),
  };
  if (match[3] !== undefined) ref.subscript = match[3];
  return ref;
}

async function applyModifier(
  ref: ParameterRef, rest: string, ctx: ExpandContext, quoted: boolean,
): Promise<Piece[]> {
  const colon = rest[0] === ':';
  const operator = colon ? rest[1] : rest[0];

  if (operator !== undefined && DEFAULT_OPERATORS.has(operator)) {
    return (await applyDefault(ref, operator, colon, rest.slice(colon ? 2 : 1), ctx, quoted));
  }
  if (colon) return (await applySlice(ref, rest.slice(1), ctx, quoted));
  if (rest[0] === '#' || rest[0] === '%') return (await applyTrim(ref, rest, ctx, quoted));
  if (rest[0] === '/') return (await applySubstitution(ref, rest.slice(1), ctx, quoted));
  if (rest[0] === '^' || rest[0] === ',') return (await applyCase(ref, rest, ctx, quoted));
  return [valuePiece('', quoted)];
}

/** `${p:-w}` `${p-w}` `${p:=w}` `${p=w}` `${p:?w}` `${p?w}` `${p:+w}` `${p+w}` */
async function applyDefault(
  ref: ParameterRef,
  operator: string,
  colon: boolean,
  word: string,
  ctx: ExpandContext,
  quoted: boolean,
): Promise<Piece[]> {
  const parameter = await resolveParameter(ref, ctx);
  const set = parameter.kind === 'list'
    ? parameter.values.length > 0
    : parameter.value !== undefined && (!colon || parameter.value !== '');

  if (operator === '+') {
    return set ? await operandPieces(word, ctx, quoted) : [valuePiece('', quoted)];
  }
  if (set) return parameterPieces(parameter, ctx, quoted);

  const pieces = await operandPieces(word, ctx, quoted);
  const value = joinPieces(pieces);
  if (operator === '?') {
    throw new ExpansionError(`${ref.name}: ${value || 'parameter null or not set'}`);
  }
  if (operator === '=' && ref.subscript === undefined
    && isShellIdentifier(ref.name)) {
    ctx.env[ref.name] = value;
    // What `=` gives is the value assigned, split and globbed as an expansion's is.
    return [valuePiece(value, quoted)];
  }
  return pieces;
}

/**
 * A `-` or `+` word's expansion as the value it gives: inside double quotes
 * all of it is quoted; outside them its quoted characters stay one field and
 * match only themselves, and the rest, its plain text too, is split and
 * globbed as an expansion's result is (bash's parameter_brace_expand_rhs).
 */
async function operandPieces(word: string, ctx: ExpandContext, quoted: boolean): Promise<Piece[]> {
  const mode = ctx.hereDocument === true ? 'heredoc' : quoted ? 'double' : 'word';
  const pieces = await expandParameterWord(word, ctx, mode);
  if (quoted) return pieces.map((piece) => (piece.kind === 'break' ? piece : { ...piece, split: false, literal: true }));
  return pieces.map((piece) => (piece.kind === 'break' || piece.literal ? piece : { ...piece, split: true }));
}

/** `${p:offset}` and `${p:offset:length}` -- substring, or a slice of `$@`/`$*`. */
async function applySlice(
  ref: ParameterRef, spec: string, ctx: ExpandContext, quoted: boolean,
): Promise<Piece[]> {
  const separator = topLevelColon(spec);
  const offsetText = separator === -1 ? spec : spec.slice(0, separator);
  const lengthText = separator === -1 ? null : spec.slice(separator + 1);
  const offset = await evaluateSliceIndex(offsetText, ctx);
  const length = lengthText === null ? null : await evaluateSliceIndex(lengthText, ctx);

  const parameter = await resolveParameter(ref, ctx);
  if (parameter.kind === 'list') {
    // Positional slices are indexed from $0, so `${@:1}` is the whole list;
    // an array slice is indexed from its own first element.
    const all = ref.subscript === undefined
      ? [ctx.env['0'] ?? '', ...parameter.values]
      : parameter.values;
    return listPieces(sliceRange(all, offset, length), parameter.star, ctx, quoted);
  }
  const value = requireSet(ref.name, parameter.value, ctx);
  return [valuePiece(sliceRange([...value], offset, length).join(''), quoted)];
}

function sliceRange<T>(values: readonly T[], offset: number, length: number | null): T[] {
  const start = offset < 0 ? Math.max(0, values.length + offset) : Math.min(offset, values.length);
  if (length === null) return values.slice(start);
  const end = length < 0 ? values.length + length : start + length;
  return values.slice(start, Math.max(start, end));
}

async function evaluateSliceIndex(text: string, ctx: ExpandContext): Promise<number> {
  const expanded = joinPieces(await expandParameterWord(text, ctx, 'word'));
  if (expanded.trim() === '') return 0;
  return evaluateArithmetic(expanded, ctx.env, ctx.positionals);
}

function topLevelColon(spec: string): number {
  let depth = 0;
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] === '(') depth++;
    else if (spec[i] === ')') depth--;
    else if (spec[i] === ':' && depth === 0) return i;
  }
  return -1;
}

/** `${p#pat}` `${p##pat}` `${p%pat}` `${p%%pat}` -- strip a matching prefix/suffix. */
async function applyTrim(
  ref: ParameterRef, rest: string, ctx: ExpandContext, quoted: boolean,
): Promise<Piece[]> {
  const operator = rest[0];
  const longest = rest[1] === operator;
  const pattern = await expandParameterPattern(rest.slice(longest ? 2 : 1), ctx);
  return (await mapParameter(ref, ctx, quoted, (value) => operator === '#'
    ? trimPrefix(value, pattern, longest)
    : trimSuffix(value, pattern, longest)));
}

function trimPrefix(value: string, pattern: string, longest: boolean): string {
  const bounds = longest
    ? range(value.length, -1, -1)
    : range(0, value.length + 1, 1);
  for (const i of bounds) {
    if (globMatch(pattern, value.slice(0, i))) return value.slice(i);
  }
  return value;
}

function trimSuffix(value: string, pattern: string, longest: boolean): string {
  const bounds = longest
    ? range(0, value.length + 1, 1)
    : range(value.length, -1, -1);
  for (const i of bounds) {
    if (globMatch(pattern, value.slice(i))) return value.slice(0, i);
  }
  return value;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let i = from; step > 0 ? i < to : i > to; i += step) out.push(i);
  return out;
}

/** `${p/pat/rep}` `${p//pat/rep}` `${p/#pat/rep}` `${p/%pat/rep}` */
async function applySubstitution(
  ref: ParameterRef, rest: string, ctx: ExpandContext, quoted: boolean,
): Promise<Piece[]> {
  const mode = rest[0] === '/' ? 'all' : rest[0] === '#' ? 'prefix' : rest[0] === '%' ? 'suffix' : 'first';
  const body = mode === 'first' ? rest : rest.slice(1);
  const cut = unescapedSlash(body);
  const pattern = await expandParameterPattern(cut === -1 ? body : body.slice(0, cut), ctx);
  const replacement = cut === -1 ? '' : joinPieces(await expandParameterWord(body.slice(cut + 1), ctx, 'word'));

  return (await mapParameter(ref, ctx, quoted, (value) => {
    if (mode === 'all') return replaceAll(value, pattern, replacement);
    if (mode === 'first') return replaceFirst(value, pattern, replacement);
    if (mode === 'prefix') return replaceAnchored(value, pattern, replacement, 'prefix');
    return replaceAnchored(value, pattern, replacement, 'suffix');
  }));
}

function unescapedSlash(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '/') return i;
  }
  return -1;
}

function replaceAnchored(
  value: string, pattern: string, replacement: string, anchor: 'prefix' | 'suffix',
): string {
  if (anchor === 'prefix') {
    for (let i = value.length; i >= 0; i--) {
      if (globMatch(pattern, value.slice(0, i))) return replacement + value.slice(i);
    }
    return value;
  }
  for (let i = 0; i <= value.length; i++) {
    if (globMatch(pattern, value.slice(i))) return value.slice(0, i) + replacement;
  }
  return value;
}

/** `${p^pat}` `${p^^pat}` `${p,pat}` `${p,,pat}` -- case conversion. */
async function applyCase(
  ref: ParameterRef, rest: string, ctx: ExpandContext, quoted: boolean,
): Promise<Piece[]> {
  const operator = rest[0];
  const every = rest[1] === operator;
  const pattern = await expandParameterPattern(rest.slice(every ? 2 : 1), ctx);
  const convert = (c: string): string => (operator === '^' ? c.toUpperCase() : c.toLowerCase());
  const matches = (c: string): boolean => pattern === '' || globMatch(pattern, c);

  return (await mapParameter(ref, ctx, quoted, (value) => {
    if (!every) {
      return value === '' || !matches(value[0]) ? value : convert(value[0]) + value.slice(1);
    }
    return [...value].map((c) => (matches(c) ? convert(c) : c)).join('');
  }));
}

async function mapParameter(
  ref: ParameterRef, ctx: ExpandContext, quoted: boolean, transform: (value: string) => string,
): Promise<Piece[]> {
  const parameter = await resolveParameter(ref, ctx);
  if (parameter.kind === 'list') {
    return listPieces(parameter.values.map(transform), parameter.star, ctx, quoted);
  }
  return [valuePiece(transform(requireSet(ref.name, parameter.value, ctx)), quoted)];
}

function parameterPieces(parameter: Parameter, ctx: ExpandContext, quoted: boolean): Piece[] {
  if (parameter.kind === 'list') return listPieces(parameter.values, parameter.star, ctx, quoted);
  return [valuePiece(parameter.value ?? '', quoted)];
}

function scalarOf(parameter: Parameter, ctx: ExpandContext): string {
  if (parameter.kind === 'list') return parameter.values.join((ctx.env['IFS'] ?? ' ').slice(0, 1));
  return parameter.value ?? '';
}

/**
 * How a word inside `${…}` is quoted: as a word (`word`), as double-quoted text
 * (`double`: a `-`, `+`, `=` or `?` word inside "…", where `'` is literal and a
 * backslash quotes only `$`, `` ` ``, `"`, itself and a newline), or as a
 * here-document's body (`heredoc`: so, and `$'…'` and `"` before a backslash
 * literal too).
 */
type ParameterWordMode = 'word' | 'double' | 'heredoc';

/** The word inside `${p:-word}`, `${p#pattern}` and friends, expanded with quote removal, as pieces. */
async function expandParameterWord(word: string, ctx: ExpandContext, mode: ParameterWordMode): Promise<Piece[]> {
  if (word === '') return [];
  return (await expandParts(parameterWordParts(word, mode), ctx));
}

/** A pattern operand (`#`, `%`, `/`, `^`, `,`): its quoting read as a word's anywhere, its quoted characters escaped. */
async function expandParameterPattern(word: string, ctx: ExpandContext): Promise<string> {
  return patternOf(await expandParameterWord(word, ctx, 'word'));
}

/** The operand word's parts, quoted as `mode` reads them. */
function parameterWordParts(word: string, mode: ParameterWordMode): WordPart[] {
  const plain = mode !== 'word';
  const parts: WordPart[] = [];
  let text = '';
  const flush = (): void => {
    if (text === '') return;
    parts.push({ text, quoted: 'none' });
    text = '';
  };

  let i = 0;
  while (i < word.length) {
    const ch = word[i];
    // In double-quoted text a backslash quotes only $, `, ", itself and a newline (not ", in a here-document); before anything else it is text.
    if (ch === '\\' && i + 1 < word.length && (!plain || (mode === 'double' ? '$`"\\\n' : '$`\\\n').includes(word[i + 1]))) {
      flush();
      parts.push({ text: word[i + 1], quoted: 'single' });
      i += 2;
      continue;
    }
    if (ch === '$' && word[i + 1] === '$') {
      text += '$$';
      i += 2;
      continue;
    }
    if (mode !== 'heredoc' && ch === '$' && word[i + 1] === "'") {
      flush();
      const quoted = readAnsiCQuote(word, i);
      parts.push({ text: quoted.text, quoted: 'single' });
      i = quoted.end;
      continue;
    }
    if ((ch === "'" && !plain) || ch === '"') {
      const end = word.indexOf(ch, i + 1);
      const close = end === -1 ? word.length : end;
      flush();
      parts.push({ text: word.slice(i + 1, close), quoted: ch === "'" ? 'single' : 'double' });
      i = close + 1;
      continue;
    }
    if (ch === '$' && word[i + 1] === '(') {
      const end = readBalancedCommand(word, i + 2, '(', ')').end;
      text += word.slice(i, end);
      i = end;
      continue;
    }
    text += ch;
    i++;
  }

  flush();
  return parts;
}

// ─── Field splitting ───

function ifsOf(ctx: ExpandContext): string {
  return ctx.env['IFS'] ?? IFS_WHITESPACE;
}

function joinPieces(pieces: readonly Piece[]): string {
  return pieces.map((p) => (p.kind === 'break' ? ' ' : p.text)).join('');
}

/**
 * Cut the expanded word into fields on IFS. Only characters that came out of
 * an unquoted expansion are eligible delimiters, so literal text keeps its
 * IFS characters, and `"$@"` boundaries split regardless of IFS.
 */
/** A field: its text, and the pattern pathname expansion reads (its quoted characters escaped). */
type Field = { text: string; pattern: string };

function splitFields(pieces: readonly Piece[], ifs: string): Field[] {
  const fields: Field[] = [];
  let text = '';
  let eligible: boolean[] = [];
  let quoted: boolean[] = [];
  let literal = false;
  let started = false;

  const flush = (): void => {
    if (started) fields.push(...splitGroup(text, eligible, quoted, literal, ifs));
    text = '';
    eligible = [];
    quoted = [];
    literal = false;
    started = false;
  };

  for (const piece of pieces) {
    if (piece.kind === 'break') {
      flush();
      continue;
    }
    started = true;
    if (piece.literal) literal = true;
    text += piece.text;
    for (let i = 0; i < piece.text.length; i++) {
      eligible.push(piece.split);
      quoted.push(piece.literal);
    }
  }
  flush();

  return fields;
}

function splitGroup(
  text: string, eligible: readonly boolean[], quoted: readonly boolean[], literal: boolean, ifs: string,
): Field[] {
  const keep = (fields: Field[]): Field[] =>
    (fields.length === 1 && fields[0]?.text === '' && !literal ? [] : fields);
  const field = (start: number, end: number): Field => {
    let pattern = '';
    for (let i = start; i < end; i++) pattern += quoted[i] ? escapeGlob(text[i] ?? '') : text[i];
    return { text: text.slice(start, end), pattern };
  };

  if (ifs === '') return keep([field(0, text.length)]);

  const isDelimiter = (i: number): boolean => eligible[i] && ifs.includes(text[i]);
  const isWhitespace = (i: number): boolean => IFS_WHITESPACE.includes(text[i]);

  let start = 0;
  let end = text.length;
  while (start < end && isDelimiter(start) && isWhitespace(start)) start++;
  while (end > start && isDelimiter(end - 1) && isWhitespace(end - 1)) end--;

  const fields: Field[] = [];
  let from = start;
  let i = start;

  while (i < end) {
    if (!isDelimiter(i)) {
      i++;
      continue;
    }
    const until = i;
    // One delimiter: a run of IFS whitespace around at most one other IFS char.
    while (i < end && isDelimiter(i) && isWhitespace(i)) i++;
    if (i < end && isDelimiter(i) && !isWhitespace(i)) i++;
    while (i < end && isDelimiter(i) && isWhitespace(i)) i++;
    fields.push(field(from, until));
    from = i;
    // A word ending in a delimiter has no trailing empty field.
    if (i >= end) return keep(fields);
  }

  fields.push(field(from, end));
  return keep(fields);
}

// ─── Pattern replacement ───

/** The leftmost match of `pattern` in `val` at `from` or after, the longest there (bash's match_pattern, MATCH_ANY): [start, end], or null. */
function leftmostLongest(val: string, pattern: string, from: number): [number, number] | null {
  for (let start = from; start <= val.length; start++) {
    for (let end = val.length; end >= start; end--) {
      if (globMatch(pattern, val.slice(start, end))) return [start, end];
    }
  }
  return null;
}

function replaceFirst(val: string, pattern: string, replacement: string): string {
  return replaceMatches(val, pattern, replacement, false);
}

function replaceAll(val: string, pattern: string, replacement: string): string {
  return replaceMatches(val, pattern, replacement, true);
}

/**
 * `${v/pat/rep}` (`all`: `${v//pat/rep}`), as bash's pat_subst: each match the
 * leftmost and longest from where the last ended; an empty pattern replaces
 * nothing; an empty match keeps the character after it, and ends the search
 * at the end of the value.
 */
function replaceMatches(val: string, pattern: string, replacement: string, all: boolean): string {
  if (pattern === '') return val;
  let out = '';
  let i = 0;
  for (;;) {
    const match = leftmostLongest(val, pattern, i);
    if (match === null) break;
    const [start, end] = match;
    out += val.slice(i, start) + replacement;
    i = end;
    if (start === end) {
      if (start >= val.length) break;
      out += val[start];
      i = start + 1;
    }
    if (!all || i >= val.length) break;
  }
  return out + val.slice(i);
}

// ─── Arithmetic evaluator ───

function evaluateArithmetic(expr: string, env: Record<string, string>, positionals?: readonly string[]): number {
  const parser = new ArithParser(expr.trim(), env, positionals);
  const result = parser.parseExpression();
  return result;
}

class ArithParser {
  private expr: string;
  private pos = 0;
  private env: Record<string, string>;
  private positionals?: readonly string[];

  constructor(expr: string, env: Record<string, string>, positionals?: readonly string[]) {
    this.expr = expr;
    this.env = env;
    this.positionals = positionals;
  }

  private skipSpaces(): void {
    while (this.pos < this.expr.length && (this.expr[this.pos] === ' ' || this.expr[this.pos] === '\t')) {
      this.pos++;
    }
  }

  private peek(): string {
    this.skipSpaces();
    return this.expr[this.pos] ?? '';
  }

  private peekNext(): string {
    return this.expr[this.pos + 1] ?? '';
  }

  parseExpression(): number {
    return this.parseTernary();
  }

  private parseTernary(): number {
    const cond = this.parseLogicalOr();
    this.skipSpaces();
    if (this.peek() === '?') {
      this.pos++;
      const truePart = this.parseTernary();
      this.skipSpaces();
      if (this.peek() === ':') {
        this.pos++;
        const falsePart = this.parseTernary();
        return cond ? truePart : falsePart;
      }
    }
    return cond;
  }

  private parseLogicalOr(): number {
    let left = this.parseLogicalAnd();
    while (true) {
      this.skipSpaces();
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '|' && this.expr[this.pos + 1] === '|') {
        this.pos += 2;
        const right = this.parseLogicalAnd();
        left = (left || right) ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseLogicalAnd(): number {
    let left = this.parseBitwiseOr();
    while (true) {
      this.skipSpaces();
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '&' && this.expr[this.pos + 1] === '&') {
        this.pos += 2;
        const right = this.parseBitwiseOr();
        left = (left && right) ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseBitwiseOr(): number {
    let left = this.parseBitwiseXor();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '|' && this.expr[this.pos + 1] !== '|') {
        this.pos++;
        const right = this.parseBitwiseXor();
        left = left | right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseBitwiseXor(): number {
    let left = this.parseBitwiseAnd();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '^') {
        this.pos++;
        const right = this.parseBitwiseAnd();
        left = left ^ right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseBitwiseAnd(): number {
    let left = this.parseEquality();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '&' && this.expr[this.pos + 1] !== '&') {
        this.pos++;
        const right = this.parseEquality();
        left = left & right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseEquality(): number {
    let left = this.parseRelational();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '=' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseRelational();
        left = left === right ? 1 : 0;
      } else if (this.expr[this.pos] === '!' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseRelational();
        left = left !== right ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseRelational(): number {
    let left = this.parseShift();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseShift();
        left = left <= right ? 1 : 0;
      } else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseShift();
        left = left >= right ? 1 : 0;
      } else if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] !== '<') {
        this.pos++;
        const right = this.parseShift();
        left = left < right ? 1 : 0;
      } else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] !== '>') {
        this.pos++;
        const right = this.parseShift();
        left = left > right ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseShift(): number {
    let left = this.parseAddition();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] === '<') {
        this.pos += 2;
        const right = this.parseAddition();
        left = left << right;
      } else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] === '>') {
        this.pos += 2;
        const right = this.parseAddition();
        left = left >> right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseAddition(): number {
    let left = this.parseMultiplication();
    while (true) {
      this.skipSpaces();
      const ch = this.peek();
      if (ch === '+' && this.peekNext() !== '+') {
        this.pos++;
        const right = this.parseMultiplication();
        left = left + right;
      } else if (ch === '-' && this.peekNext() !== '-') {
        this.pos++;
        const right = this.parseMultiplication();
        left = left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseMultiplication(): number {
    let left = this.parseExponentiation();
    while (true) {
      this.skipSpaces();
      const ch = this.peek();
      if (ch === '*' && this.peekNext() !== '*') {
        this.pos++;
        const right = this.parseExponentiation();
        left = left * right;
      } else if (ch === '/' ) {
        this.pos++;
        const right = this.parseExponentiation();
        if (right === 0) return 0;
        left = Math.trunc(left / right);
      } else if (ch === '%') {
        this.pos++;
        const right = this.parseExponentiation();
        if (right === 0) return 0;
        left = left % right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseExponentiation(): number {
    const base = this.parseUnary();
    this.skipSpaces();
    if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '*' && this.expr[this.pos + 1] === '*') {
      this.pos += 2;
      const exp = this.parseExponentiation(); // right-associative
      return Math.pow(base, exp) | 0;
    }
    return base;
  }

  private parseUnary(): number {
    this.skipSpaces();
    const ch = this.peek();

    if (ch === '!') {
      this.pos++;
      const val = this.parseUnary();
      return val ? 0 : 1;
    }
    if (ch === '~') {
      this.pos++;
      const val = this.parseUnary();
      return ~val;
    }
    if (ch === '-') {
      this.pos++;
      const val = this.parseUnary();
      return -val;
    }
    if (ch === '+') {
      this.pos++;
      return this.parseUnary();
    }

    // Pre-increment/decrement
    if (ch === '+' && this.peekNext() === '+') {
      this.pos += 2;
      this.skipSpaces();
      const name = this.readVarName();
      if (name) {
        const val = this.getVar(name) + 1;
        this.env[name] = String(val);
        return val;
      }
    }
    if (ch === '-' && this.peekNext() === '-') {
      this.pos += 2;
      this.skipSpaces();
      const name = this.readVarName();
      if (name) {
        const val = this.getVar(name) - 1;
        this.env[name] = String(val);
        return val;
      }
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipSpaces();
    const ch = this.peek();

    // Parenthesized expression
    if (ch === '(') {
      this.pos++;
      const val = this.parseExpression();
      this.skipSpaces();
      if (this.peek() === ')') this.pos++;
      return val;
    }

    // Number literal
    if (/[0-9]/.test(ch)) {
      return this.readNumber();
    }

    // $VAR reference -- skip the $ and read variable name
    if (ch === '$') {
      this.pos++;
      this.skipSpaces();
      const name = this.readVarName();
      if (name) return this.getVar(name);
      return 0;
    }

    // Variable reference (possibly with post-increment)
    if (/[a-zA-Z_]/.test(ch)) {
      const name = this.readVarName();
      if (!name) return 0;
      this.skipSpaces();

      // Post-increment/decrement
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '+' && this.expr[this.pos + 1] === '+') {
        this.pos += 2;
        const val = this.getVar(name);
        this.env[name] = String(val + 1);
        return val;
      }
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '-' && this.expr[this.pos + 1] === '-') {
        this.pos += 2;
        const val = this.getVar(name);
        this.env[name] = String(val - 1);
        return val;
      }

      // Assignment within arithmetic (but not == comparison)
      if (this.expr[this.pos] === '=' && this.expr[this.pos + 1] !== '=') {
        this.pos++;
        const val = this.parseExpression();
        this.env[name] = String(val);
        return val;
      }

      return this.getVar(name);
    }

    return 0;
  }

  private readNumber(): number {
    let num = '';
    while (this.pos < this.expr.length && /[0-9]/.test(this.expr[this.pos])) {
      num += this.expr[this.pos];
      this.pos++;
    }
    return parseInt(num, 10) || 0;
  }

  private readVarName(): string | null {
    let name = '';
    while (this.pos < this.expr.length && /[a-zA-Z0-9_]/.test(this.expr[this.pos])) {
      name += this.expr[this.pos];
      this.pos++;
    }
    return name || null;
  }

  private getVar(name: string): number {
    const val = this.getParameter(name);
    if (val === undefined) return 0;
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }

  private getParameter(name: string): string | undefined {
    if (this.positionals !== undefined && isPositionalParameterName(name)) {
      return this.positionals[Number.parseInt(name, 10) - 1];
    }
    return this.env[name];
  }
}
