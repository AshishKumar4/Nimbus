import type { WordPart } from './types.js';
import { isShellIdentifier } from './names.js';
import { DEFAULT_HOME } from '../../../constants.js';
import type { ProcessView } from '../../../runtime/process-files.js';
import { characterAt, characterBounds, characterWidth, escapeGlob, expandGlob, fixedMatchLength, shellMatch, shellUnits } from '../utils/glob.js';
import { readAnsiCQuote, readBacktickSubstitution, readBalancedCommand, readBracedExpansion, readQuoted } from './lexer.js';
import type { ShellOptions } from './state.js';
import { arrayFor, arrayIndex, assignVariable, type ShellValues } from './variables.js';
import { DiscardSignal } from './discard.js';

export interface ExpandContext {
  env: Record<string, string>;
  /**
   * Indexed arrays, sparse: a hole is an index that was never assigned, which
   * `${arr[@]}` skips and `${!arr[@]}` omits. A name lives here or in `env`,
   * never both, so `$arr` and `${arr[0]}` have one answer.
   */
  arrays: Map<string, (string | undefined)[]>;
  /** The names `readonly` protects: arithmetic's assignments refuse them. */
  readonlyNames: ReadonlySet<string>;
  positionals?: readonly string[];
  /** Arithmetic's warnings (a bad array subscript) not yet reported (reportWarnings). */
  warnings: string[];
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
  /** Write `diagnostic` where the shell reports an error met expanding: its stderr then (bash writes before it discards). */
  report(diagnostic: string): Promise<void>;
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

/**
 * An arithmetic error (a constant past its base, a base out of range, a
 * variable whose value refers to itself without end): as bash's evalerror
 * words it, the expression to the end of the token in error, then why, then
 * the token. Met expanding, it is reported and the line discarded
 * (arithmeticValue); in `[[ ]]` it makes its comparison false.
 */
export class ArithmeticError extends Error {
  /** As a command (`((`, `let`, `[[`) reports it: after its name, as bash's evalerror does. */
  reportedBy(command: string): string {
    return `${command}: ${this.message}`;
  }
}

/** An arithmetic assignment to a readonly name (bash's err_readonly): its diagnostic is the name's alone, whoever reports it. */
export class ReadonlyArithmeticError extends ArithmeticError {
  override reportedBy(): string {
    return this.message;
  }
}

/**
 * An error in an array subscript's arithmetic: an expansion's (bash's
 * array_expand_index), its diagnostic its own, and the line discarded
 * whoever meets it (`((`, `let` and `[[` too).
 */
export class SubscriptArithmeticError extends ArithmeticError {
  override reportedBy(): string {
    return this.message;
  }
}

/** What arithmetic reads and writes: the shell's values, its positional parameters, and where its warnings go. */
export interface ArithmeticScope extends ShellValues {
  readonly positionals?: readonly string[];
  readonly warnings: string[];
}

/** Report `scope`'s pending warnings, in order (arithmetic's, which it cannot write as it goes). */
export async function reportWarnings(scope: ArithmeticScope, report: (diagnostic: string) => Promise<void>): Promise<void> {
  for (const warning of scope.warnings.splice(0)) await report(warning);
}

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
    for (const braceExpandedWord of expandBraceWord(word)) results.push(...await expandFields(braceExpandedWord, ctx));
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

/**
 * `[[ =~ ]]`'s regex word expanded: an extended regular expression in which
 * each quoted character a regular expression reads specially is escaped, so
 * it matches only itself, and an unquoted expansion's characters stay the
 * expression's (bash's quote_string_for_globbing, QGLOB_REGEXP).
 */
export async function expandRegexWord(parts: WordPart[], ctx: ExpandContext): Promise<string> {
  let ere = '';
  for (const piece of await expandParts(parts, ctx)) {
    if (piece.kind === 'break') ere += ' ';
    else ere += piece.literal ? piece.text.replace(/[.[\\()*+?{|^$]/g, '\\$&') : piece.text;
  }
  return ere;
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

/**
 * One brace-expanded word's fields: split, and each globbed as a pattern whose
 * quoted characters match only themselves (an unquoted expansion's `*` globs,
 * a quoted one's does not).
 */
export async function expandFields(word: WordPart[], ctx: ExpandContext): Promise<string[]> {
  const results: string[] = [];
  for (const field of splitFields(await expandParts(word, ctx), ifsOf(ctx))) {
    if (field.pattern === null) results.push(field.text);
    else results.push(...await expandGlob(field.pattern, field.text, ctx.cwd, ctx.vfs));
  }
  return results;
}

export function expandBraceWord(parts: WordPart[]): WordPart[][] {
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

    const home = tildeHome(part.text, ctx, pieces);
    // The home directory a tilde names is as if quoted: never split, never a pattern.
    if (home !== null) pieces.push({ kind: 'text', text: home, split: false, literal: true });
    pieces.push(...await expandText(home === null ? part.text : part.text.slice(1), ctx, false));
  }

  return pieces;
}

/** The home directory a leading `~` or `~/` of a word's first text names, or null. */
function tildeHome(text: string, ctx: ExpandContext, preceding: readonly Piece[]): string | null {
  const atWordStart = !preceding.some((p) => p.kind === 'break' || p.text !== '');
  if (!atWordStart || !(text === '~' || text.startsWith('~/'))) return null;
  return ctx.env['HOME'] ?? DEFAULT_HOME;
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
    // Its text expanded first, as bash's expand_arith_string does it (parameters,
    // substitutions, quotes removed); text with nothing to expand is evaluated in
    // place: a loop's $((i + 1)) awaits nothing unless it fails.
    const expression = ARITHMETIC_EXPANDS.test(arithmetic.expression) ? await expandArithmetic(arithmetic.expression, ctx) : arithmetic.expression;
    let result: number;
    try {
      result = arithmeticOf(expression, ctx);
    } catch (error) {
      return await discardArithmetic(error, ctx);
    }
    if (ctx.warnings.length > 0) await reportWarnings(ctx, ctx.report);
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
  if (subscript === undefined) return { kind: 'scalar', value: array === undefined ? ctx.env[name] : array[0] };
  // A scalar is an array of its one value. A subscript before the first is bad (bash's array_expand_index).
  const value = await arithmeticValue(await expandSubscript(subscript, ctx), ctx);
  const index = array === undefined ? value : arrayIndex(array, value);
  if (index < 0) {
    await ctx.report(`${name}: bad array subscript`);
    return { kind: 'scalar', value: undefined };
  }
  return { kind: 'scalar', value: array === undefined ? (index === 0 ? ctx.env[name] : undefined) : array[index] };
}

/**
 * Arithmetic text once its expansions are done, as bash's expand_arith_string
 * does them: as in double quotes (a single quote is the expression's, and an
 * error there), its double quotes removed.
 */
export async function expandArithmetic(text: string, ctx: ExpandContext): Promise<string> {
  return joinPieces(await expandParameterWord(text, ctx, 'double'));
}

/** A subscript's text once its expansions (`$i`, `$(…)`) are done, before its arithmetic. */
export async function expandSubscript(subscript: string, ctx: ExpandContext): Promise<string> {
  return joinPieces(await expandParameterWord(subscript, ctx, 'word'));
}

/** An expanded word's arithmetic (a subscript's, a `[[ -eq ]]` operand's, let's): a blank one is 0. Throws ArithmeticError. */
export function arithmeticOf(expanded: string, scope: ArithmeticScope): number {
  return expanded.trim() === '' ? 0 : evaluateArithmetic(expanded, scope);
}

/** arithmeticOf as an expansion meets it: an error is reported, and the rest of the line discarded (bash's evalerror). */
export async function arithmeticValue(expanded: string, ctx: ExpandContext): Promise<number> {
  let value: number;
  try {
    value = arithmeticOf(expanded, ctx);
  } catch (error) {
    return await discardArithmetic(error, ctx);
  }
  if (ctx.warnings.length > 0) await reportWarnings(ctx, ctx.report);
  return value;
}

/** An arithmetic error met expanding: reported, and the rest of the line discarded. Anything else is thrown as it is. */
async function discardArithmetic(error: unknown, ctx: ExpandContext): Promise<never> {
  if (!(error instanceof ArithmeticError)) throw error;
  await reportWarnings(ctx, ctx.report);
  await ctx.report(error.message);
  throw new DiscardSignal();
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
  if (star) return [valuePiece(values.join(characterAt(ctx.env['IFS'] ?? ' ', 0)), quoted)];
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
        : characterCount(requireSet(parameter.name, resolved.value, ctx));
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
  // An empty word inside double quotes is still the quoted empty field ("${u:-}").
  if (quoted && pieces.length === 0) return [valuePiece('', true)];
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
  return await arithmeticValue(joinPieces(await expandParameterWord(text, ctx, 'word')), ctx);
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

/**
 * Where `s`'s characters begin, and its end: index `k` of them is `at(k)`,
 * `count` of them. A value with no surrogate is its UTF-16 indices, read
 * without making the list.
 */
function boundsOf(s: string): { count: number; at: (k: number) => number } {
  if (!SURROGATE.test(s)) return { count: s.length + 1, at: (k) => k };
  const bounds = characterBounds(s);
  return { count: bounds.length, at: (k) => bounds[k] ?? s.length };
}

const SURROGATE = /[\uD800-\uDFFF]/;

/** The last IFS split on, and its characters: every word's split asks, and IFS seldom changes. */
let lastIfs: { ifs: string; characters: ReadonlySet<string> } | null = null;

function ifsCharacters(ifs: string): ReadonlySet<string> {
  // A string's iterator yields its code points: a pair whole, a lone surrogate alone.
  if (lastIfs?.ifs !== ifs) lastIfs = { ifs, characters: new Set(ifs) };
  return lastIfs.characters;
}

/** How many characters (code points) `s` holds: `${#x}`. */
function characterCount(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i += characterAt(s, i).length) count++;
  return count;
}

// Trims and substitutions cut a value only between its characters (code
// points), as bash does in a UTF-8 locale: never inside a surrogate pair.

// Each works in shellUnits: characters, or bytes when the value or the
// pattern holds a byte that is no character, its result decoded back.

function trimPrefix(text: string, pattern: string, longest: boolean): string {
  const { value, matches, decode } = shellUnits(pattern, text);
  const { count, at } = boundsOf(value);
  for (let k = 0; k < count; k++) {
    const i = at(longest ? count - 1 - k : k);
    if (matches(value.slice(0, i))) return decode(value.slice(i));
  }
  return text;
}

function trimSuffix(text: string, pattern: string, longest: boolean): string {
  const { value, matches, decode } = shellUnits(pattern, text);
  const { count, at } = boundsOf(value);
  for (let k = 0; k < count; k++) {
    const i = at(longest ? k : count - 1 - k);
    if (matches(value.slice(i))) return decode(value.slice(0, i));
  }
  return text;
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
  text: string, pattern: string, replacement: string, anchor: 'prefix' | 'suffix',
): string {
  const { value, matches, encode, decode } = shellUnits(pattern, text);
  const { count, at } = boundsOf(value);
  if (anchor === 'prefix') {
    for (let k = count - 1; k >= 0; k--) {
      const i = at(k);
      if (matches(value.slice(0, i))) return decode(encode(replacement) + value.slice(i));
    }
    return text;
  }
  for (let k = 0; k < count; k++) {
    const i = at(k);
    if (matches(value.slice(i))) return decode(value.slice(0, i) + encode(replacement));
  }
  return text;
}

/** `${p^pat}` `${p^^pat}` `${p,pat}` `${p,,pat}` -- case conversion. */
async function applyCase(
  ref: ParameterRef, rest: string, ctx: ExpandContext, quoted: boolean,
): Promise<Piece[]> {
  const operator = rest[0];
  const every = rest[1] === operator;
  const pattern = await expandParameterPattern(rest.slice(every ? 2 : 1), ctx);
  const convert = (c: string): string => (operator === '^' ? c.toUpperCase() : c.toLowerCase());

  const matches = (c: string): boolean => pattern === '' || shellMatch(pattern, c);

  return (await mapParameter(ref, ctx, quoted, (value) => {
    if (!every) {
      const first = characterAt(value, 0);
      return value === '' || !matches(first) ? value : convert(first) + value.slice(first.length);
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
  if (parameter.kind === 'list') return parameter.values.join(characterAt(ctx.env['IFS'] ?? ' ', 0));
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
    // A nested expansion is its own to expand, a substitution in it too (expandBraced).
    if (ch === '$' && word[i + 1] === '{') {
      const end = readBracedExpansion(word, i).end;
      text += word.slice(i, end);
      i = end;
      continue;
    }
    // A backquoted substitution, as a word's (readWord): one command substitution.
    if (ch === '`') {
      const subst = readBacktickSubstitution(word, i);
      if (subst.kind === 'command') {
        flush();
        parts.push({ text: subst.text, quoted: plain ? 'double' : 'none', commandSubstitution: subst.command });
        i = subst.end;
        continue;
      }
    }
    if ((ch === "'" && !plain) || ch === '"') {
      // Its close as the lexer finds it: a quote in a substitution inside it is the substitution's.
      const end = readQuoted(word, i, ch).end;
      const close = end > i + 1 && word[end - 1] === ch ? end - 1 : word.length;
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
/**
 * A field: its text, and the pattern pathname expansion reads (its quoted
 * characters escaped), or null when no unquoted character of it is a glob's.
 */
type Field = { text: string; pattern: string | null };

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
    const value = text.slice(start, end);
    let globs = false;
    for (let i = start; i < end && !globs; i++) globs = !quoted[i] && (text[i] === '*' || text[i] === '?' || text[i] === '[');
    if (!globs) return { text: value, pattern: null };
    // The pattern, run by run: a quoted run escaped whole.
    let pattern = '';
    for (let i = start; i < end;) {
      let j = i + 1;
      while (j < end && quoted[j] === quoted[i]) j++;
      pattern += quoted[i] ? escapeGlob(text.slice(i, j)) : text.slice(i, j);
      i = j;
    }
    return { text: value, pattern };
  };

  if (ifs === '') return keep([field(0, text.length)]);

  // IFS's characters, and the text's, are code points: 😀 in IFS splits at 😀 only, never at half of 😁.
  const isDelimiter = (i: number): boolean => {
    if (eligible[i] !== true) return false;
    const unit = text.charCodeAt(i);
    // A surrogate is half of a character, or a byte kept as one: never matched by half of IFS's.
    return unit < 0xd800 || unit > 0xdfff ? ifs.includes(text.charAt(i)) : ifsCharacters(ifs).has(characterAt(text, i));
  };
  const isWhitespace = (i: number): boolean => IFS_WHITESPACE.includes(text.charAt(i));
  const next = (i: number): number => i + characterWidth(text, i);
  const previous = (i: number): number => (i >= 2 && characterWidth(text, i - 2) === 2 ? i - 2 : i - 1);

  let start = 0;
  let end = text.length;
  while (start < end && isDelimiter(start) && isWhitespace(start)) start = next(start);
  while (end > start && isDelimiter(previous(end)) && isWhitespace(previous(end))) end = previous(end);

  const fields: Field[] = [];
  let from = start;
  let i = start;

  while (i < end) {
    if (!isDelimiter(i)) {
      i = next(i);
      continue;
    }
    const until = i;
    // One delimiter: a run of IFS whitespace around at most one other IFS char.
    while (i < end && isDelimiter(i) && isWhitespace(i)) i = next(i);
    if (i < end && isDelimiter(i) && !isWhitespace(i)) i = next(i);
    while (i < end && isDelimiter(i) && isWhitespace(i)) i = next(i);
    fields.push(field(from, until));
    from = i;
    // A word ending in a delimiter has no trailing empty field.
    if (i >= end) return keep(fields);
  }

  fields.push(field(from, end));
  return keep(fields);
}

// ─── Pattern replacement ───

/**
 * The leftmost match of `pattern` in `val` at `from` or after, the longest
 * there (bash's match_pattern, MATCH_ANY): [start, end], or null. A pattern of
 * fixed length (`fixed`, fixedMatchLength) is tried at that length only.
 */
function leftmostLongest(
  val: string, bounds: { count: number; at: (k: number) => number }, matches: (text: string) => boolean, from: number, fixed: number | null,
): [number, number] | null {
  const { count, at } = bounds;
  for (let s = from; s < count; s++) {
    const start = at(s);
    if (fixed !== null) {
      if (s + fixed >= count) return null;
      if (matches(val.slice(start, at(s + fixed)))) return [s, s + fixed];
      continue;
    }
    for (let e = count - 1; e >= s; e--) {
      if (matches(val.slice(start, at(e)))) return [s, e];
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
function replaceMatches(text: string, pattern: string, replacement: string, all: boolean): string {
  if (pattern === '') return text;
  const units = shellUnits(pattern, text);
  const val = units.value;
  const { matches } = units;
  // Its length in the same units as the value's bounds.
  const fixed = fixedMatchLength(units.pattern);
  const encoded = units.encode(replacement);
  // Matches start and end between characters: indices into the value's character bounds.
  const bounds = boundsOf(val);
  const last = bounds.count - 1;
  const { at } = bounds;
  let out = '';
  let i = 0;
  for (;;) {
    const match = leftmostLongest(val, bounds, matches, i, fixed);
    if (match === null) break;
    const [start, end] = match;
    out += val.slice(at(i), at(start)) + encoded;
    i = end;
    if (start === end) {
      if (start >= last) break;
      out += val.slice(at(start), at(start + 1));
      i = start + 1;
    }
    if (!all || i >= last) break;
  }
  return units.decode(out + val.slice(at(i)));
}

// ─── Arithmetic evaluator ───

function evaluateArithmetic(expr: string, scope: ArithmeticScope, depth = 0): number {
  // Its trailing blanks are its own, as bash's diagnostics quote the expression.
  const parser = new ArithParser(expr.trimStart(), scope, depth);
  const result = parser.parseExpression();
  parser.expectEnd();
  return result;
}

/** What an operand begins with: a number, a name or `(`. */
const OPERAND_START = /[0-9A-Za-z_(]/;

/** A subscript's `$name`, `${name}` and `$1`, which it expands as text. */
const SUBSCRIPT_NAME = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+)\}|([A-Za-z_][A-Za-z0-9_]*|[0-9]))/g;

/** Arithmetic text with something to expand before it is evaluated. */
const ARITHMETIC_EXPANDS = /[$`"'\\]/;

/** An arithmetic assignment's operators, the longest first. */
const ASSIGNMENT_OPERATORS = ['<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '='];

/** How deep a variable's value may refer on to another's (bash's MAX_EXPR_RECURSION_LEVEL). */
const MAX_ARITHMETIC_DEPTH = 1024;

/** A value that is a decimal integer as written: its expression's value is its number. */
const DECIMAL_INTEGER = /^\s*-?(?:0|[1-9][0-9]{0,14})\s*$/;

/** A number token's characters (bash's readtok): letters and digits, `#`, `@` and `_`. */
const NUMBER_CHARACTER = /[0-9A-Za-z#@_]/;

/**
 * An integer constant's value, as bash's strlong reads one: a leading 0 is
 * octal, 0x or 0X hexadecimal, `base#digits` any base from 2 to 64, whose
 * digits are 0-9, a-z, A-Z, `@` and `_` (to base 36 a letter's case is one
 * value); anything else decimal. Its errors are `why` (bash's evalerror).
 */
function integerConstant(text: string, error: (why: string) => ArithmeticError): number {
  let base = 10;
  let i = 0;
  let foundBase = false;
  if (text[0] === '0') {
    if (text.length === 1) return 0;
    i = 1;
    if (text[1] === 'x' || text[1] === 'X') {
      base = 16;
      i = 2;
    } else {
      base = 8;
    }
    foundBase = true;
  }
  let value = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '#') {
      if (foundBase) throw error('invalid number');
      if (value < 2 || value > 64) throw error('invalid arithmetic base');
      base = value;
      value = 0;
      foundBase = true;
      if (i + 1 >= text.length) throw error('invalid integer constant');
      continue;
    }
    const code = ch.charCodeAt(0);
    const digit = code <= 0x39 ? code - 0x30
      : code >= 0x61 ? code - 0x61 + 10
      : code >= 0x41 && code <= 0x5a ? code - 0x41 + (base <= 36 ? 10 : 36)
      : ch === '@' ? 62 : 63;
    if (digit >= base) throw error('value too great for base');
    value = value * base + digit;
  }
  return value;
}

class ArithParser {
  private expr: string;
  private pos = 0;
  private readonly scope: ArithmeticScope;
  /** How many variables' values this expression is evaluated inside. */
  private readonly depth: number;
  /** Inside a branch `&&`, `||` or `?:` skips (bash's noeval): read, its variables neither evaluated nor assigned. */
  private noeval = 0;

  constructor(expr: string, scope: ArithmeticScope, depth = 0) {
    this.expr = expr;
    this.scope = scope;
    this.depth = depth;
  }

  /** `parse`'s value, read without evaluation where `skip` (noeval). */
  private branch(skip: boolean, parse: () => number): number {
    if (!skip) return parse();
    this.noeval++;
    try {
      return parse();
    } finally {
      this.noeval--;
    }
  }

  private warn(diagnostic: string): void {
    if (this.noeval === 0) this.scope.warnings.push(diagnostic);
  }

  /**
   * A subscript's arithmetic, its quotes removed first (bash's
   * array_expand_index): null for `@`, `*` or an empty one, bad subscripts;
   * blank is 0. Its error is an expansion's, the line's (SubscriptArithmeticError).
   */
  private subscriptValue(text: string): number | null {
    const trimmed = text.trim();
    if (text === '' || trimmed === '@' || trimmed === '*') return null;
    if (this.noeval > 0 || trimmed === '') return 0;
    // Its original quotes removed as arithmetic's are (expandArithmetic), and its names expanded as
    // text, a value's characters its data; a backslash-quoted `$` is no name. Any other expansion
    // left in it (a value's subscript) is an operand error, not a guess.
    const expression = /["\\$]/.test(text)
      ? parameterWordParts(text, 'double').map((part) => (part.quoted === 'single' ? part.text : this.expandNames(part.text))).join('')
      : text;
    try {
      // Its own evaluation is a level deeper, as a value's is: a subscript naming itself ends.
      if (this.depth >= MAX_ARITHMETIC_DEPTH) {
        throw new ArithmeticError(`${expression}: expression recursion level exceeded (error token is "${expression}")`);
      }
      return evaluateArithmetic(expression, this.scope, this.depth + 1);
    } catch (error) {
      if (!(error instanceof ArithmeticError) || error instanceof SubscriptArithmeticError) throw error;
      throw new SubscriptArithmeticError(error.message);
    }
  }

  /** Where `name[text]` is read: an array's index counted back from past its last value, a scalar's 0 alone; null where bad, warned of. */
  private readIndex(name: string, text: string): number | null {
    const value = this.subscriptValue(text);
    if (value === null) {
      this.warn(`${name}[${text}]: bad array subscript`);
      return null;
    }
    const array = this.scope.arrays.get(name);
    const index = array === undefined ? value : arrayIndex(array, value);
    if (index < 0) {
      this.warn(`${name}: bad array subscript`);
      return null;
    }
    return index;
  }

  /** Where `name[text]` is written: a scalar is an array of its one value, an unset name an empty one; null where bad, warned of. */
  private writeIndex(name: string, text: string): number | null {
    const value = this.subscriptValue(text);
    const scalar = this.scope.env[name];
    const existing = this.scope.arrays.get(name) ?? (scalar === undefined ? [] : [scalar]);
    const index = value === null ? -1 : arrayIndex(existing, value);
    if (index < 0) {
      this.warn(`${name}[${text}]: bad array subscript`);
      return null;
    }
    return index;
  }

  /** `name`'s value (its element at `index`, where it has one; none where that is null) read as an expression. */
  private read(name: string, index?: number | null): number {
    if (this.noeval > 0 || index === null) return 0;
    if (index === undefined) return this.valueOf(name, this.getParameter(name));
    const array = this.scope.arrays.get(name);
    return this.valueOf(name, array === undefined ? (index === 0 ? this.scope.env[name] : undefined) : array[index]);
  }

  /**
   * `value` into `name` (its element at `index`, where it has one; nothing
   * where that is null, a bad subscript), as bash's expr_bind_variable binds
   * it: a readonly name refuses; an element promotes a scalar.
   */
  private store(name: string, index: number | null | undefined, value: number): void {
    if (this.noeval > 0 || index === null) return;
    if (this.scope.readonlyNames.has(name)) throw new ReadonlyArithmeticError(`${name}: readonly variable`);
    if (index === undefined) assignVariable(this.scope, name, String(value));
    else arrayFor(this.scope, name)[index] = String(value);
  }

  /** Where a read-then-write binds: the index its read found, or, where that was bad, its subscript found again (bash's expassign). */
  private bindIndex(name: string, subscript: string | undefined, index: number | null | undefined): number | null | undefined {
    return index === null && subscript !== undefined ? this.writeIndex(name, subscript) : index;
  }

  /** The `[subscript]` after a name, its text as written (read whole, its quotes and substitutions its own); none where none follows. */
  private readSubscript(): string | undefined {
    if (this.peek() !== '[') return undefined;
    const span = readBalancedCommand(this.expr, this.pos + 1, '[', ']');
    if (!span.closed) return undefined;
    this.pos = span.end;
    return span.body;
  }

  /** bash's syntax evalerror: the whole expression, `why`, and the rest from here, the token in error. */
  private syntaxError(why: string): ArithmeticError {
    return new ArithmeticError(`${this.expr}: ${why} (error token is "${this.expr.slice(this.pos)}")`);
  }

  /** Nothing left once the expression is read: an operand there is a second one, anything else no operator. */
  expectEnd(): void {
    this.skipSpaces();
    if (this.pos >= this.expr.length) return;
    throw this.syntaxError(OPERAND_START.test(this.peek()) ? 'syntax error in expression' : 'syntax error: invalid arithmetic operator');
  }

  /** bash's evalerror at the token from `start` to here: the expression through it, `why`, the token. */
  private error(why: string, start: number): ArithmeticError {
    return new ArithmeticError(`${this.expr.slice(0, this.pos)}: ${why} (error token is "${this.expr.slice(start, this.pos)}")`);
  }

  /** Blanks and newlines, as bash's arithmetic skips them (cr_whitespace). */
  private skipSpaces(): void {
    while (this.pos < this.expr.length && (this.expr[this.pos] === ' ' || this.expr[this.pos] === '\t' || this.expr[this.pos] === '\n' || this.expr[this.pos] === '\r')) {
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

  /** A comma list: each expression evaluated, the last's value its own. */
  parseExpression(): number {
    let value = this.parseTernary();
    while (this.peek() === ',') {
      this.pos++;
      value = this.parseTernary();
    }
    return value;
  }

  /** `left op right` for a compound assignment's operator (`+=`'s `+`); a division by 0 is an error at the right operand, from `start`. */
  private operate(op: string, left: number, right: number, start: number): number {
    if ((op === '/' || op === '%') && right === 0) return this.divisionByZero(start);
    switch (op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return Math.trunc(left / right);
      case '%': return left % right;
      case '<<': return left << right;
      case '>>': return left >> right;
      case '&': return left & right;
      case '^': return left ^ right;
      default: return left | right;
    }
  }

  /** bash's `division by 0`: the whole expression, and the right operand onward; under noeval the operand is 1 (expr.c). */
  private divisionByZero(start: number): number {
    if (this.noeval > 0) return 0;
    throw new ArithmeticError(`${this.expr}: division by 0 (error token is "${this.expr.slice(start)}")`);
  }

  private parseTernary(): number {
    const cond = this.parseLogicalOr();
    this.skipSpaces();
    if (this.peek() === '?') {
      this.pos++;
      const truePart = this.branch(cond === 0, () => this.parseExpression());
      this.skipSpaces();
      if (this.peek() === ':') {
        this.pos++;
        const falsePart = this.branch(cond !== 0, () => this.parseTernary());
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
        const right = this.branch(left !== 0, () => this.parseLogicalAnd());
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
        const right = this.branch(left === 0, () => this.parseBitwiseOr());
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
      } else if (ch === '/' || ch === '%') {
        this.pos++;
        this.skipSpaces();
        const start = this.pos;
        left = this.operate(ch, left, this.parseExponentiation(), start);
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

    // Pre-increment/decrement, before the unary signs they begin with
    if ((ch === '+' || ch === '-') && this.peekNext() === ch) {
      const start = this.pos;
      this.pos += 2;
      this.skipSpaces();
      const name = this.readVarName();
      if (name !== null) {
        const subscript = this.readSubscript();
        const index = subscript === undefined ? undefined : this.readIndex(name, subscript);
        const val = this.read(name, index) + (ch === '+' ? 1 : -1);
        this.store(name, this.bindIndex(name, subscript, index), val);
        return val;
      }
      this.pos = start;
    }

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

    // Variable reference (possibly with post-increment)
    if (/[a-zA-Z_]/.test(ch)) {
      const name = this.readVarName();
      if (name === null) return 0;
      const subscript = this.readSubscript();
      this.skipSpaces();

      // Post-increment/decrement: the element's index found once, for its read and its write.
      if (this.pos + 1 < this.expr.length && (this.expr[this.pos] === '+' || this.expr[this.pos] === '-') && this.expr[this.pos + 1] === this.expr[this.pos]) {
        const step = this.expr[this.pos] === '+' ? 1 : -1;
        this.pos += 2;
        const index = subscript === undefined ? undefined : this.readIndex(name, subscript);
        const val = this.read(name, index);
        this.store(name, this.bindIndex(name, subscript, index), val + step);
        return val;
      }

      // An assignment, `=` (not `==`) or a compound one (`+=`): its right side an
      // assignment's, which a comma ends, as bash's expr.c reads it.
      const operator = ASSIGNMENT_OPERATORS.find((op) => this.expr.startsWith(op, this.pos) && (op !== '=' || this.expr[this.pos + 1] !== '='));
      if (operator !== undefined) {
        this.pos += operator.length;
        this.skipSpaces();
        const start = this.pos;
        // `=`'s subscript is found once its right side has run; a compound one's
        // left value, and the index it is at, before (bash's readtok and expassign).
        if (operator === '=') {
          const right = this.parseTernary();
          this.store(name, subscript === undefined ? undefined : this.writeIndex(name, subscript), right);
          return right;
        }
        const index = subscript === undefined ? undefined : this.readIndex(name, subscript);
        const left = this.read(name, index);
        const val = this.operate(operator.slice(0, -1), left, this.parseTernary(), start);
        this.store(name, this.bindIndex(name, subscript, index), val);
        return val;
      }

      return this.read(name, subscript === undefined ? undefined : this.readIndex(name, subscript));
    }

    // Anything else where an operand is due is an error; the end of the text is 0.
    if (this.pos < this.expr.length) throw this.syntaxError('syntax error: operand expected');
    return 0;
  }

  private readNumber(): number {
    const start = this.pos;
    while (this.pos < this.expr.length && NUMBER_CHARACTER.test(this.expr[this.pos])) this.pos++;
    return integerConstant(this.expr.slice(start, this.pos), (why) => this.error(why, start));
  }

  private readVarName(): string | null {
    let name = '';
    while (this.pos < this.expr.length && /[a-zA-Z0-9_]/.test(this.expr[this.pos])) {
      name += this.expr[this.pos];
      this.pos++;
    }
    return name || null;
  }

  /** `name`'s value `val` read as an expression: unset or empty is 0. */
  private valueOf(name: string, val: string | undefined): number {
    if (val === undefined || val.trim() === '') return 0;
    // A decimal integer, the most a variable holds, is its value.
    if (DECIMAL_INTEGER.test(val)) return Number(val);
    if (this.depth >= MAX_ARITHMETIC_DEPTH) {
      throw new ArithmeticError(`${name}: expression recursion level exceeded (error token is "${name}")`);
    }
    return evaluateArithmetic(val, this.scope, this.depth + 1);
  }

  /** `text` with its `$name`, `${name}` and `$1` replaced by their values (unset, empty), as a subscript expands them. */
  private expandNames(text: string): string {
    return text.replace(SUBSCRIPT_NAME, (_, braced: string | undefined, bare: string | undefined) => this.getParameter(braced ?? bare ?? '') ?? '');
  }

  /** A name's value: a positional parameter's, a scalar's, or an array's first element. */
  private getParameter(name: string): string | undefined {
    if (this.scope.positionals !== undefined && isPositionalParameterName(name)) {
      return this.scope.positionals[Number.parseInt(name, 10) - 1];
    }
    return this.scope.env[name] ?? this.scope.arrays.get(name)?.[0];
  }
}
