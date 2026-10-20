import { isShellIdentifier } from './names.js';
import { DEFAULT_HOME } from '../../../constants.js';
import { characterAt, characterBounds, characterWidth, escapeGlob, expandGlob, fixedMatchLength, shellMatch, shellUnits } from '../utils/glob.js';
import { readAnsiCQuote, readBalancedCommand, readBracedExpansion } from './lexer.js';
/**
 * A parameter expansion that aborts the command it belongs to: `set -u` on an
 * unset parameter, or an explicit `${var:?message}`.
 */
export class ExpansionError extends Error {
}
const IFS_WHITESPACE = ' \t\n';
/**
 * Expand all words for a command's arguments: brace expansion, tilde,
 * parameter/arithmetic/command substitution, IFS field splitting, globbing.
 */
export async function expandWords(words, ctx) {
    const results = [];
    for (const word of words) {
        for (const braceExpandedWord of expandBraceWord(word)) {
            // Each field globbed as a pattern whose quoted characters match only
            // themselves: an unquoted expansion's `*` globs, a quoted one's does not.
            for (const field of splitFields(await expandParts(braceExpandedWord, ctx), ifsOf(ctx))) {
                if (field.pattern === null)
                    results.push(field.text);
                else
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
export async function expandPatternWord(parts, ctx) {
    const pieces = await expandParts(parts, ctx);
    return { value: joinPieces(pieces), pattern: patternOf(pieces) };
}
/**
 * `[[ =~ ]]`'s regex word expanded: an extended regular expression in which
 * each quoted character a regular expression reads specially is escaped, so
 * it matches only itself, and an unquoted expansion's characters stay the
 * expression's (bash's quote_string_for_globbing, QGLOB_REGEXP).
 */
export async function expandRegexWord(parts, ctx) {
    let ere = '';
    for (const piece of await expandParts(parts, ctx)) {
        if (piece.kind === 'break')
            ere += ' ';
        else
            ere += piece.literal ? piece.text.replace(/[.[\\()*+?{|^$]/g, '\\$&') : piece.text;
    }
    return ere;
}
/** `pieces` as a pattern: quoted characters escaped (escapeGlob). */
function patternOf(pieces) {
    let pattern = '';
    for (const piece of pieces) {
        if (piece.kind === 'break')
            pattern += ' ';
        else
            pattern += piece.literal ? escapeGlob(piece.text) : piece.text;
    }
    return pattern;
}
/**
 * Expand a single word (e.g., for redirect targets and assignments).
 * No field splitting and no glob expansion.
 */
export async function expandWord(parts, ctx) {
    return joinPieces(await expandParts(parts, ctx));
}
function expandBraceWord(parts) {
    let combinations = [[]];
    for (const part of parts) {
        if (part.commandSubstitution !== undefined || part.quoted !== 'none') {
            combinations = combinations.map((combo) => [...combo, part]);
            continue;
        }
        const expandedTexts = expandBraceText(part.text);
        const nextCombinations = [];
        for (const combo of combinations) {
            for (const text of expandedTexts) {
                nextCombinations.push([...combo, { text, quoted: 'none' }]);
            }
        }
        combinations = nextCombinations;
    }
    return combinations;
}
function expandBraceText(text) {
    const span = findBraceSpan(text);
    if (!span)
        return [text];
    const prefix = text.slice(0, span.start);
    const suffix = text.slice(span.end + 1);
    const results = [];
    for (const choice of splitBraceChoices(text.slice(span.start + 1, span.end))) {
        for (const expanded of expandBraceText(`${prefix}${choice}${suffix}`)) {
            results.push(expanded);
        }
    }
    return results;
}
function findBraceSpan(text) {
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
function findBraceEndWithTopLevelComma(text, start) {
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
function splitBraceChoices(inner) {
    const choices = [];
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
async function expandParts(parts, ctx) {
    const pieces = [];
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
            if (part.text === '')
                pieces.push({ kind: 'text', text: '', split: false, literal: true });
            else
                pieces.push(...await expandText(part.text, ctx, true));
            continue;
        }
        const home = tildeHome(part.text, ctx, pieces);
        // The home directory a tilde names is as if quoted: never split, never a pattern.
        if (home !== null)
            pieces.push({ kind: 'text', text: home, split: false, literal: true });
        pieces.push(...await expandText(home === null ? part.text : part.text.slice(1), ctx, false));
    }
    return pieces;
}
/** The home directory a leading `~` or `~/` of a word's first text names, or null. */
function tildeHome(text, ctx, preceding) {
    const atWordStart = !preceding.some((p) => p.kind === 'break' || p.text !== '');
    if (!atWordStart || !(text === '~' || text.startsWith('~/')))
        return null;
    return ctx.env['HOME'] ?? DEFAULT_HOME;
}
async function expandCommandSubstitution(command, ctx) {
    if (!ctx.executeCapture)
        return '';
    const { output, exitCode } = await ctx.executeCapture(command);
    ctx.lastSubstitutionExitCode = exitCode;
    return output.replace(/\n+$/, '');
}
/** Expand every `$…` in one run of text, keeping literal and expanded runs apart. */
async function expandText(text, ctx, quoted) {
    const pieces = [];
    let literal = '';
    const flush = () => {
        if (literal === '')
            return;
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
        }
        else {
            flush();
            pieces.push(...dollar.pieces);
        }
        i = dollar.end;
    }
    flush();
    return pieces;
}
async function expandDollar(text, pos, ctx, quoted) {
    const next = text[pos + 1];
    if (next === undefined)
        return { pieces: null, end: pos + 1 };
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
    if (name === null)
        return { pieces: null, end: pos + 1 };
    return { pieces: await expandParameter({ name }, ctx, quoted), end: pos + 1 + name.length };
}
/**
 * The parameter name directly after an unbraced `$`: an identifier, a single
 * digit (`$10` is `${1}0`), or one of the special parameters.
 */
function readParameterName(text, pos) {
    const match = /^(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]|[@*#?!$])/.exec(text.slice(pos));
    return match === null ? null : match[0];
}
function readArithmeticExpansion(text, pos) {
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
function isPositionalParameterName(name) {
    return /^[1-9][0-9]*$/.test(name);
}
async function resolveParameter(ref, ctx) {
    const { name, subscript } = ref;
    const positionals = ctx.positionals ?? [];
    if (name === '@' || name === '*')
        return { kind: 'list', values: positionals, star: name === '*' };
    if (name === '#')
        return { kind: 'scalar', value: String(positionals.length) };
    if (name === '?')
        return { kind: 'scalar', value: String(ctx.lastExitCode) };
    if (isPositionalParameterName(name)) {
        return { kind: 'scalar', value: positionals[Number.parseInt(name, 10) - 1] };
    }
    const array = ctx.arrays?.get(name);
    if (subscript === '@' || subscript === '*') {
        // A plain variable answers `${v[@]}` with its single value, as bash does.
        const values = array !== undefined
            ? array.filter((element) => element !== undefined)
            : ctx.env[name] === undefined ? [] : [ctx.env[name]];
        return { kind: 'list', values, star: subscript === '*' };
    }
    if (array === undefined) {
        const value = ctx.env[name];
        if (subscript === undefined)
            return { kind: 'scalar', value };
        return { kind: 'scalar', value: await evaluateSubscript(subscript, 1, ctx) === 0 ? value : undefined };
    }
    const index = subscript === undefined ? 0 : await evaluateSubscript(subscript, array.length, ctx);
    return { kind: 'scalar', value: array[index] };
}
/** A subscript is an arithmetic expression; a negative index counts from the end. */
export async function evaluateSubscript(subscript, length, ctx) {
    const index = subscriptArithmetic(await expandSubscript(subscript, ctx), ctx);
    return index < 0 ? length + index : index;
}
/** A subscript's text once its expansions (`$i`, `$(…)`) are done, before its arithmetic. */
export async function expandSubscript(subscript, ctx) {
    return joinPieces(await expandParameterWord(subscript, ctx, 'word'));
}
/** An expanded subscript's arithmetic, a blank one 0. */
export function subscriptArithmetic(expanded, ctx) {
    return expanded.trim() === '' ? 0 : evaluateArithmetic(expanded, ctx.env, ctx.positionals);
}
/** The indices `${!arr[@]}` reports: every index that holds a value. */
function arrayIndices(ref, ctx) {
    if (ref.subscript !== '@' && ref.subscript !== '*')
        return null;
    const array = ctx.arrays?.get(ref.name);
    if (array === undefined)
        return ctx.env[ref.name] === undefined ? [] : ['0'];
    const indices = [];
    array.forEach((element, index) => {
        if (element !== undefined)
            indices.push(String(index));
    });
    return indices;
}
/** `$0`, `$$` and `$!` are shell state; the rest must exist under `set -u`. */
function isNounsetChecked(name) {
    return name !== '0' && name !== '$' && name !== '!';
}
function requireSet(name, value, ctx) {
    if (value !== undefined)
        return value;
    if (ctx.options.nounset && isNounsetChecked(name)) {
        throw new ExpansionError(`${name}: unbound variable`);
    }
    return '';
}
async function expandParameter(ref, ctx, quoted) {
    const parameter = await resolveParameter(ref, ctx);
    if (parameter.kind === 'list')
        return listPieces(parameter.values, parameter.star, ctx, quoted);
    return [valuePiece(requireSet(ref.name, parameter.value, ctx), quoted)];
}
function valuePiece(text, quoted) {
    return { kind: 'text', text, split: !quoted, literal: quoted };
}
/**
 * `$*` joins the positional parameters with the first character of IFS; `$@`
 * keeps them as separate fields even inside double quotes.
 */
function listPieces(values, star, ctx, quoted) {
    if (star)
        return [valuePiece(values.join(characterAt(ctx.env['IFS'] ?? ' ', 0)), quoted)];
    const pieces = [];
    for (const value of values) {
        if (pieces.length > 0)
            pieces.push({ kind: 'break' });
        pieces.push(valuePiece(value, quoted));
    }
    return pieces;
}
// ─── ${...} ───
const DEFAULT_OPERATORS = new Set(['-', '=', '?', '+']);
async function expandBraced(inner, ctx, quoted) {
    if (inner === '')
        return [];
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
            if (indices !== null)
                return listPieces(indices, parameter.subscript === '*', ctx, quoted);
            const target = scalarOf(await resolveParameter(parameter, ctx), ctx);
            const indirect = parseParameterRef(target);
            if (indirect === null || indirect.rest !== '')
                return [valuePiece('', quoted)];
            if (parameter.rest === '')
                return (await expandParameter(indirect, ctx, quoted));
            return (await applyModifier(indirect, parameter.rest, ctx, quoted));
        }
    }
    const parameter = parseParameterRef(inner);
    if (parameter === null)
        return [valuePiece('', quoted)];
    if (parameter.rest === '')
        return (await expandParameter(parameter, ctx, quoted));
    return (await applyModifier(parameter, parameter.rest, ctx, quoted));
}
/**
 * Split `${name[subscript]<modifier>}` into its parameter and the modifier
 * tail. The subscript is kept as written — it is an arithmetic expression, or
 * `@` / `*` for the whole array — and evaluated when the value is read.
 */
function parseParameterRef(inner) {
    const match = /^(?:([a-zA-Z_][a-zA-Z0-9_]*)(\[([^[\]]*(?:\[[^\]]*\])?[^[\]]*)\])?|[0-9]+|[@*#?!$])/
        .exec(inner);
    if (match === null || match[0] === '')
        return null;
    const ref = {
        name: match[1] ?? match[0],
        rest: inner.slice(match[0].length),
    };
    if (match[3] !== undefined)
        ref.subscript = match[3];
    return ref;
}
async function applyModifier(ref, rest, ctx, quoted) {
    const colon = rest[0] === ':';
    const operator = colon ? rest[1] : rest[0];
    if (operator !== undefined && DEFAULT_OPERATORS.has(operator)) {
        return (await applyDefault(ref, operator, colon, rest.slice(colon ? 2 : 1), ctx, quoted));
    }
    if (colon)
        return (await applySlice(ref, rest.slice(1), ctx, quoted));
    if (rest[0] === '#' || rest[0] === '%')
        return (await applyTrim(ref, rest, ctx, quoted));
    if (rest[0] === '/')
        return (await applySubstitution(ref, rest.slice(1), ctx, quoted));
    if (rest[0] === '^' || rest[0] === ',')
        return (await applyCase(ref, rest, ctx, quoted));
    return [valuePiece('', quoted)];
}
/** `${p:-w}` `${p-w}` `${p:=w}` `${p=w}` `${p:?w}` `${p?w}` `${p:+w}` `${p+w}` */
async function applyDefault(ref, operator, colon, word, ctx, quoted) {
    const parameter = await resolveParameter(ref, ctx);
    const set = parameter.kind === 'list'
        ? parameter.values.length > 0
        : parameter.value !== undefined && (!colon || parameter.value !== '');
    if (operator === '+') {
        return set ? await operandPieces(word, ctx, quoted) : [valuePiece('', quoted)];
    }
    if (set)
        return parameterPieces(parameter, ctx, quoted);
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
async function operandPieces(word, ctx, quoted) {
    const mode = ctx.hereDocument === true ? 'heredoc' : quoted ? 'double' : 'word';
    const pieces = await expandParameterWord(word, ctx, mode);
    // An empty word inside double quotes is still the quoted empty field ("${u:-}").
    if (quoted && pieces.length === 0)
        return [valuePiece('', true)];
    if (quoted)
        return pieces.map((piece) => (piece.kind === 'break' ? piece : { ...piece, split: false, literal: true }));
    return pieces.map((piece) => (piece.kind === 'break' || piece.literal ? piece : { ...piece, split: true }));
}
/** `${p:offset}` and `${p:offset:length}` -- substring, or a slice of `$@`/`$*`. */
async function applySlice(ref, spec, ctx, quoted) {
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
function sliceRange(values, offset, length) {
    const start = offset < 0 ? Math.max(0, values.length + offset) : Math.min(offset, values.length);
    if (length === null)
        return values.slice(start);
    const end = length < 0 ? values.length + length : start + length;
    return values.slice(start, Math.max(start, end));
}
async function evaluateSliceIndex(text, ctx) {
    const expanded = joinPieces(await expandParameterWord(text, ctx, 'word'));
    if (expanded.trim() === '')
        return 0;
    return evaluateArithmetic(expanded, ctx.env, ctx.positionals);
}
function topLevelColon(spec) {
    let depth = 0;
    for (let i = 0; i < spec.length; i++) {
        if (spec[i] === '(')
            depth++;
        else if (spec[i] === ')')
            depth--;
        else if (spec[i] === ':' && depth === 0)
            return i;
    }
    return -1;
}
/** `${p#pat}` `${p##pat}` `${p%pat}` `${p%%pat}` -- strip a matching prefix/suffix. */
async function applyTrim(ref, rest, ctx, quoted) {
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
function boundsOf(s) {
    if (!SURROGATE.test(s))
        return { count: s.length + 1, at: (k) => k };
    const bounds = characterBounds(s);
    return { count: bounds.length, at: (k) => bounds[k] ?? s.length };
}
const SURROGATE = /[\uD800-\uDFFF]/;
/** The last IFS split on, and its characters: every word's split asks, and IFS seldom changes. */
let lastIfs = null;
function ifsCharacters(ifs) {
    // A string's iterator yields its code points: a pair whole, a lone surrogate alone.
    if (lastIfs?.ifs !== ifs)
        lastIfs = { ifs, characters: new Set(ifs) };
    return lastIfs.characters;
}
/** How many characters (code points) `s` holds: `${#x}`. */
function characterCount(s) {
    let count = 0;
    for (let i = 0; i < s.length; i += characterAt(s, i).length)
        count++;
    return count;
}
// Trims and substitutions cut a value only between its characters (code
// points), as bash does in a UTF-8 locale: never inside a surrogate pair.
// Each works in shellUnits: characters, or bytes when the value or the
// pattern holds a byte that is no character, its result decoded back.
function trimPrefix(text, pattern, longest) {
    const { value, matches, decode } = shellUnits(pattern, text);
    const { count, at } = boundsOf(value);
    for (let k = 0; k < count; k++) {
        const i = at(longest ? count - 1 - k : k);
        if (matches(value.slice(0, i)))
            return decode(value.slice(i));
    }
    return text;
}
function trimSuffix(text, pattern, longest) {
    const { value, matches, decode } = shellUnits(pattern, text);
    const { count, at } = boundsOf(value);
    for (let k = 0; k < count; k++) {
        const i = at(longest ? k : count - 1 - k);
        if (matches(value.slice(i)))
            return decode(value.slice(0, i));
    }
    return text;
}
/** `${p/pat/rep}` `${p//pat/rep}` `${p/#pat/rep}` `${p/%pat/rep}` */
async function applySubstitution(ref, rest, ctx, quoted) {
    const mode = rest[0] === '/' ? 'all' : rest[0] === '#' ? 'prefix' : rest[0] === '%' ? 'suffix' : 'first';
    const body = mode === 'first' ? rest : rest.slice(1);
    const cut = unescapedSlash(body);
    const pattern = await expandParameterPattern(cut === -1 ? body : body.slice(0, cut), ctx);
    const replacement = cut === -1 ? '' : joinPieces(await expandParameterWord(body.slice(cut + 1), ctx, 'word'));
    return (await mapParameter(ref, ctx, quoted, (value) => {
        if (mode === 'all')
            return replaceAll(value, pattern, replacement);
        if (mode === 'first')
            return replaceFirst(value, pattern, replacement);
        if (mode === 'prefix')
            return replaceAnchored(value, pattern, replacement, 'prefix');
        return replaceAnchored(value, pattern, replacement, 'suffix');
    }));
}
function unescapedSlash(text) {
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
            continue;
        }
        if (text[i] === '/')
            return i;
    }
    return -1;
}
function replaceAnchored(text, pattern, replacement, anchor) {
    const { value, matches, encode, decode } = shellUnits(pattern, text);
    const { count, at } = boundsOf(value);
    if (anchor === 'prefix') {
        for (let k = count - 1; k >= 0; k--) {
            const i = at(k);
            if (matches(value.slice(0, i)))
                return decode(encode(replacement) + value.slice(i));
        }
        return text;
    }
    for (let k = 0; k < count; k++) {
        const i = at(k);
        if (matches(value.slice(i)))
            return decode(value.slice(0, i) + encode(replacement));
    }
    return text;
}
/** `${p^pat}` `${p^^pat}` `${p,pat}` `${p,,pat}` -- case conversion. */
async function applyCase(ref, rest, ctx, quoted) {
    const operator = rest[0];
    const every = rest[1] === operator;
    const pattern = await expandParameterPattern(rest.slice(every ? 2 : 1), ctx);
    const convert = (c) => (operator === '^' ? c.toUpperCase() : c.toLowerCase());
    const matches = (c) => pattern === '' || shellMatch(pattern, c);
    return (await mapParameter(ref, ctx, quoted, (value) => {
        if (!every) {
            const first = characterAt(value, 0);
            return value === '' || !matches(first) ? value : convert(first) + value.slice(first.length);
        }
        return [...value].map((c) => (matches(c) ? convert(c) : c)).join('');
    }));
}
async function mapParameter(ref, ctx, quoted, transform) {
    const parameter = await resolveParameter(ref, ctx);
    if (parameter.kind === 'list') {
        return listPieces(parameter.values.map(transform), parameter.star, ctx, quoted);
    }
    return [valuePiece(transform(requireSet(ref.name, parameter.value, ctx)), quoted)];
}
function parameterPieces(parameter, ctx, quoted) {
    if (parameter.kind === 'list')
        return listPieces(parameter.values, parameter.star, ctx, quoted);
    return [valuePiece(parameter.value ?? '', quoted)];
}
function scalarOf(parameter, ctx) {
    if (parameter.kind === 'list')
        return parameter.values.join(characterAt(ctx.env['IFS'] ?? ' ', 0));
    return parameter.value ?? '';
}
/** The word inside `${p:-word}`, `${p#pattern}` and friends, expanded with quote removal, as pieces. */
async function expandParameterWord(word, ctx, mode) {
    if (word === '')
        return [];
    return (await expandParts(parameterWordParts(word, mode), ctx));
}
/** A pattern operand (`#`, `%`, `/`, `^`, `,`): its quoting read as a word's anywhere, its quoted characters escaped. */
async function expandParameterPattern(word, ctx) {
    return patternOf(await expandParameterWord(word, ctx, 'word'));
}
/** The operand word's parts, quoted as `mode` reads them. */
function parameterWordParts(word, mode) {
    const plain = mode !== 'word';
    const parts = [];
    let text = '';
    const flush = () => {
        if (text === '')
            return;
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
function ifsOf(ctx) {
    return ctx.env['IFS'] ?? IFS_WHITESPACE;
}
function joinPieces(pieces) {
    return pieces.map((p) => (p.kind === 'break' ? ' ' : p.text)).join('');
}
function splitFields(pieces, ifs) {
    const fields = [];
    let text = '';
    let eligible = [];
    let quoted = [];
    let literal = false;
    let started = false;
    const flush = () => {
        if (started)
            fields.push(...splitGroup(text, eligible, quoted, literal, ifs));
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
        if (piece.literal)
            literal = true;
        text += piece.text;
        for (let i = 0; i < piece.text.length; i++) {
            eligible.push(piece.split);
            quoted.push(piece.literal);
        }
    }
    flush();
    return fields;
}
function splitGroup(text, eligible, quoted, literal, ifs) {
    const keep = (fields) => (fields.length === 1 && fields[0]?.text === '' && !literal ? [] : fields);
    const field = (start, end) => {
        const value = text.slice(start, end);
        let globs = false;
        for (let i = start; i < end && !globs; i++)
            globs = !quoted[i] && (text[i] === '*' || text[i] === '?' || text[i] === '[');
        if (!globs)
            return { text: value, pattern: null };
        // The pattern, run by run: a quoted run escaped whole.
        let pattern = '';
        for (let i = start; i < end;) {
            let j = i + 1;
            while (j < end && quoted[j] === quoted[i])
                j++;
            pattern += quoted[i] ? escapeGlob(text.slice(i, j)) : text.slice(i, j);
            i = j;
        }
        return { text: value, pattern };
    };
    if (ifs === '')
        return keep([field(0, text.length)]);
    // IFS's characters, and the text's, are code points: 😀 in IFS splits at 😀 only, never at half of 😁.
    const isDelimiter = (i) => {
        if (eligible[i] !== true)
            return false;
        const unit = text.charCodeAt(i);
        // A surrogate is half of a character, or a byte kept as one: never matched by half of IFS's.
        return unit < 0xd800 || unit > 0xdfff ? ifs.includes(text.charAt(i)) : ifsCharacters(ifs).has(characterAt(text, i));
    };
    const isWhitespace = (i) => IFS_WHITESPACE.includes(text.charAt(i));
    const next = (i) => i + characterWidth(text, i);
    const previous = (i) => (i >= 2 && characterWidth(text, i - 2) === 2 ? i - 2 : i - 1);
    let start = 0;
    let end = text.length;
    while (start < end && isDelimiter(start) && isWhitespace(start))
        start = next(start);
    while (end > start && isDelimiter(previous(end)) && isWhitespace(previous(end)))
        end = previous(end);
    const fields = [];
    let from = start;
    let i = start;
    while (i < end) {
        if (!isDelimiter(i)) {
            i = next(i);
            continue;
        }
        const until = i;
        // One delimiter: a run of IFS whitespace around at most one other IFS char.
        while (i < end && isDelimiter(i) && isWhitespace(i))
            i = next(i);
        if (i < end && isDelimiter(i) && !isWhitespace(i))
            i = next(i);
        while (i < end && isDelimiter(i) && isWhitespace(i))
            i = next(i);
        fields.push(field(from, until));
        from = i;
        // A word ending in a delimiter has no trailing empty field.
        if (i >= end)
            return keep(fields);
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
function leftmostLongest(val, bounds, matches, from, fixed) {
    const { count, at } = bounds;
    for (let s = from; s < count; s++) {
        const start = at(s);
        if (fixed !== null) {
            if (s + fixed >= count)
                return null;
            if (matches(val.slice(start, at(s + fixed))))
                return [s, s + fixed];
            continue;
        }
        for (let e = count - 1; e >= s; e--) {
            if (matches(val.slice(start, at(e))))
                return [s, e];
        }
    }
    return null;
}
function replaceFirst(val, pattern, replacement) {
    return replaceMatches(val, pattern, replacement, false);
}
function replaceAll(val, pattern, replacement) {
    return replaceMatches(val, pattern, replacement, true);
}
/**
 * `${v/pat/rep}` (`all`: `${v//pat/rep}`), as bash's pat_subst: each match the
 * leftmost and longest from where the last ended; an empty pattern replaces
 * nothing; an empty match keeps the character after it, and ends the search
 * at the end of the value.
 */
function replaceMatches(text, pattern, replacement, all) {
    if (pattern === '')
        return text;
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
        if (match === null)
            break;
        const [start, end] = match;
        out += val.slice(at(i), at(start)) + encoded;
        i = end;
        if (start === end) {
            if (start >= last)
                break;
            out += val.slice(at(start), at(start + 1));
            i = start + 1;
        }
        if (!all || i >= last)
            break;
    }
    return units.decode(out + val.slice(at(i)));
}
// ─── Arithmetic evaluator ───
function evaluateArithmetic(expr, env, positionals) {
    const parser = new ArithParser(expr.trim(), env, positionals);
    const result = parser.parseExpression();
    return result;
}
class ArithParser {
    expr;
    pos = 0;
    env;
    positionals;
    constructor(expr, env, positionals) {
        this.expr = expr;
        this.env = env;
        this.positionals = positionals;
    }
    skipSpaces() {
        while (this.pos < this.expr.length && (this.expr[this.pos] === ' ' || this.expr[this.pos] === '\t')) {
            this.pos++;
        }
    }
    peek() {
        this.skipSpaces();
        return this.expr[this.pos] ?? '';
    }
    peekNext() {
        return this.expr[this.pos + 1] ?? '';
    }
    parseExpression() {
        return this.parseTernary();
    }
    parseTernary() {
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
    parseLogicalOr() {
        let left = this.parseLogicalAnd();
        while (true) {
            this.skipSpaces();
            if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '|' && this.expr[this.pos + 1] === '|') {
                this.pos += 2;
                const right = this.parseLogicalAnd();
                left = (left || right) ? 1 : 0;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseLogicalAnd() {
        let left = this.parseBitwiseOr();
        while (true) {
            this.skipSpaces();
            if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '&' && this.expr[this.pos + 1] === '&') {
                this.pos += 2;
                const right = this.parseBitwiseOr();
                left = (left && right) ? 1 : 0;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseBitwiseOr() {
        let left = this.parseBitwiseXor();
        while (true) {
            this.skipSpaces();
            if (this.expr[this.pos] === '|' && this.expr[this.pos + 1] !== '|') {
                this.pos++;
                const right = this.parseBitwiseXor();
                left = left | right;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseBitwiseXor() {
        let left = this.parseBitwiseAnd();
        while (true) {
            this.skipSpaces();
            if (this.expr[this.pos] === '^') {
                this.pos++;
                const right = this.parseBitwiseAnd();
                left = left ^ right;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseBitwiseAnd() {
        let left = this.parseEquality();
        while (true) {
            this.skipSpaces();
            if (this.expr[this.pos] === '&' && this.expr[this.pos + 1] !== '&') {
                this.pos++;
                const right = this.parseEquality();
                left = left & right;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseEquality() {
        let left = this.parseRelational();
        while (true) {
            this.skipSpaces();
            if (this.expr[this.pos] === '=' && this.expr[this.pos + 1] === '=') {
                this.pos += 2;
                const right = this.parseRelational();
                left = left === right ? 1 : 0;
            }
            else if (this.expr[this.pos] === '!' && this.expr[this.pos + 1] === '=') {
                this.pos += 2;
                const right = this.parseRelational();
                left = left !== right ? 1 : 0;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseRelational() {
        let left = this.parseShift();
        while (true) {
            this.skipSpaces();
            if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] === '=') {
                this.pos += 2;
                const right = this.parseShift();
                left = left <= right ? 1 : 0;
            }
            else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] === '=') {
                this.pos += 2;
                const right = this.parseShift();
                left = left >= right ? 1 : 0;
            }
            else if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] !== '<') {
                this.pos++;
                const right = this.parseShift();
                left = left < right ? 1 : 0;
            }
            else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] !== '>') {
                this.pos++;
                const right = this.parseShift();
                left = left > right ? 1 : 0;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseShift() {
        let left = this.parseAddition();
        while (true) {
            this.skipSpaces();
            if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] === '<') {
                this.pos += 2;
                const right = this.parseAddition();
                left = left << right;
            }
            else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] === '>') {
                this.pos += 2;
                const right = this.parseAddition();
                left = left >> right;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseAddition() {
        let left = this.parseMultiplication();
        while (true) {
            this.skipSpaces();
            const ch = this.peek();
            if (ch === '+' && this.peekNext() !== '+') {
                this.pos++;
                const right = this.parseMultiplication();
                left = left + right;
            }
            else if (ch === '-' && this.peekNext() !== '-') {
                this.pos++;
                const right = this.parseMultiplication();
                left = left - right;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseMultiplication() {
        let left = this.parseExponentiation();
        while (true) {
            this.skipSpaces();
            const ch = this.peek();
            if (ch === '*' && this.peekNext() !== '*') {
                this.pos++;
                const right = this.parseExponentiation();
                left = left * right;
            }
            else if (ch === '/') {
                this.pos++;
                const right = this.parseExponentiation();
                if (right === 0)
                    return 0;
                left = Math.trunc(left / right);
            }
            else if (ch === '%') {
                this.pos++;
                const right = this.parseExponentiation();
                if (right === 0)
                    return 0;
                left = left % right;
            }
            else {
                break;
            }
        }
        return left;
    }
    parseExponentiation() {
        const base = this.parseUnary();
        this.skipSpaces();
        if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '*' && this.expr[this.pos + 1] === '*') {
            this.pos += 2;
            const exp = this.parseExponentiation(); // right-associative
            return Math.pow(base, exp) | 0;
        }
        return base;
    }
    parseUnary() {
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
    parsePrimary() {
        this.skipSpaces();
        const ch = this.peek();
        // Parenthesized expression
        if (ch === '(') {
            this.pos++;
            const val = this.parseExpression();
            this.skipSpaces();
            if (this.peek() === ')')
                this.pos++;
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
            if (name)
                return this.getVar(name);
            return 0;
        }
        // Variable reference (possibly with post-increment)
        if (/[a-zA-Z_]/.test(ch)) {
            const name = this.readVarName();
            if (!name)
                return 0;
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
    readNumber() {
        let num = '';
        while (this.pos < this.expr.length && /[0-9]/.test(this.expr[this.pos])) {
            num += this.expr[this.pos];
            this.pos++;
        }
        return parseInt(num, 10) || 0;
    }
    readVarName() {
        let name = '';
        while (this.pos < this.expr.length && /[a-zA-Z0-9_]/.test(this.expr[this.pos])) {
            name += this.expr[this.pos];
            this.pos++;
        }
        return name || null;
    }
    getVar(name) {
        const val = this.getParameter(name);
        if (val === undefined)
            return 0;
        const n = parseInt(val, 10);
        return isNaN(n) ? 0 : n;
    }
    getParameter(name) {
        if (this.positionals !== undefined && isPositionalParameterName(name)) {
            return this.positionals[Number.parseInt(name, 10) - 1];
        }
        return this.env[name];
    }
}
