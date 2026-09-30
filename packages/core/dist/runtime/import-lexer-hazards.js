/**
 * Where es-module-lexer's reading of a cell can differ from the grammar's,
 * for dynamic-import-rewrite.ts to check: the `/`s it can read as the wrong
 * one of a division and a regex, and the HTML-like comments it reads as code.
 * With the scanning both modules share: lines, whitespace and comments, and
 * where a parenthesis closes. Nothing here parses; spans are found by
 * patterns and by Acorn's tokenizer over a window.
 */
import { tokenizer, tokTypes } from 'acorn';
/** An import() call or import.meta, or import and a comment before either. */
export const IMPORT_SYNTAX = /\bimport\s*(?:[(.]|\/[/*])/;
const IMPORT_SYNTAX_ALL = new RegExp(IMPORT_SYNTAX.source, 'g');
const LINE_END = /[\n\r\u2028\u2029]/g;
/** Where the line `at` is on ends: its line break, or the text's end. */
export function lineEnd(text, at) {
    LINE_END.lastIndex = at;
    return LINE_END.exec(text)?.index ?? text.length;
}
/** The index of the first of the ascending `positions` at or after `at`. */
function firstAtOrAfter(positions, at) {
    let low = 0;
    let high = positions.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (positions[middle] < at)
            low = middle + 1;
        else
            high = middle;
    }
    return low;
}
/** Where a cell's lines start and end, for lines that can run to megabytes. */
export class Lines {
    source;
    breaks;
    constructor(source) {
        this.source = source;
        this.breaks = Array.from(source.matchAll(/[\n\r\u2028\u2029]/g), (found) => found.index);
    }
    /** The line break ending the line `at` is on, or the cell's end. */
    endOf(at) {
        return this.breaks[firstAtOrAfter(this.breaks, at)] ?? this.source.length;
    }
    /** Where the line `at` is on starts. */
    startOf(at) {
        const before = firstAtOrAfter(this.breaks, at) - 1;
        return before < 0 ? 0 : this.breaks[before] + 1;
    }
}
/** Past whitespace and comments from `at`, and whether a line ended there. */
export function skipTrivia(source, at) {
    let newline = false;
    for (;;) {
        const ch = source[at];
        if (ch === '/' && source[at + 1] === '/') {
            at = lineEnd(source, at);
            continue;
        }
        if (ch === '/' && source[at + 1] === '*') {
            const close = source.indexOf('*/', at + 2);
            if (close < 0)
                return { at: source.length, newline };
            if (/[\n\r\u2028\u2029]/.test(source.slice(at, close)))
                newline = true;
            at = close + 2;
            continue;
        }
        if (ch !== undefined && /\s/.test(ch)) {
            if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029')
                newline = true;
            at++;
            continue;
        }
        return { at, newline };
    }
}
/**
 * Just past the `)` that closes the `(` at `open`, from Acorn's tokens over a
 * window from it that doubles until the parentheses balance; null if they
 * never do.
 */
export function parenthesisEnd(source, open) {
    for (let window = 1024;; window *= 2) {
        try {
            const tokens = tokenizer(source.slice(open, open + window), { ecmaVersion: 'latest' });
            let depth = 0;
            for (let token = tokens.getToken(); token.type !== tokTypes.eof; token = tokens.getToken()) {
                if (token.type === tokTypes.parenL)
                    depth++;
                else if (token.type === tokTypes.parenR && --depth === 0)
                    return open + token.end;
            }
        }
        catch (error) {
            // A window can end inside a token.
            if (!(error instanceof SyntaxError))
                throw error;
        }
        if (open + window >= source.length)
            return null;
    }
}
/**
 * What can precede a `/` es-module-lexer reads differently from the grammar.
 * It reads division after `}` (a block's or an expression's), after `++` or
 * `--` (postfix, or prefix after a line break), and after extends, of or
 * default; and a regex after yield or await (identifiers, in a script), and
 * after a keyword it takes for one that is a member name past whitespace or a
 * comment (`x.\nreturn`). A member name right after its dot (`x.of`) is read
 * right. Only what whitespace, a comment or a `/` follows is matched; the
 * whitespace and comments are skipped by skipTrivia, not by the pattern.
 */
const BEFORE_AMBIGUOUS_SLASH = /(?:\}|\+\+|--|(?<![\w$.\\])(?:extends|of|default|yield|await))(?=[\s/])|\.(?=\s|\/[/*])/g;
/** The keywords es-module-lexer reads a regex after, as member names. */
const MEMBER_KEYWORD = /^(?:case|debugger|delete|do|else|in|instanceof|new|return|throw|typeof|void|yield|await)(?![\w$])/;
/**
 * Statement heads whose `)` es-module-lexer reads a division after, where a
 * regex can follow: `with (…)` and `for await (…)`. (It reads `if`, `for` and
 * `while` heads right.)
 */
const PARENTHESIZED_HEAD = /(?<![\w$.\\])(?:with|for\s+await)\s*\(/g;
/**
 * The possibly misread `/`s that matter, for the caller to check whether they
 * are in code at all. One matters when the text it would open as a regex, to
 * its closing `/` or its line's end, holds import syntax; or when that text
 * holds a quote and import syntax follows on its line, since a quote read the
 * other way opens a string that runs to that line's end. Most such `/`s are
 * no code, though, and stand in text read right: a template's (`${dir}/`), or
 * a regex's, closing one after a quantifier (`/a{4}/`). Ascending.
 */
export function ambiguousSlashes(source, lines) {
    let imports = null;
    const matters = (slash) => {
        if (source[slash] !== '/' || source[slash + 1] === '/' || source[slash + 1] === '*')
            return false;
        const body = regexBody(source, slash);
        if (IMPORT_SYNTAX.test(body))
            return true;
        if (!/['"`]/.test(body))
            return false;
        imports ??= Array.from(source.matchAll(IMPORT_SYNTAX_ALL), (found) => found.index);
        const next = imports[firstAtOrAfter(imports, slash)];
        return next !== undefined && next < lines.endOf(slash);
    };
    const slashes = [];
    for (const match of source.matchAll(BEFORE_AMBIGUOUS_SLASH)) {
        let after = match.index + match[0].length;
        if (match[0] === '.') {
            const name = skipTrivia(source, after).at;
            const keyword = MEMBER_KEYWORD.exec(source.slice(name, name + 11));
            if (keyword === null)
                continue;
            after = name + keyword[0].length;
        }
        const slash = skipTrivia(source, after).at;
        if (matters(slash))
            slashes.push(slash);
    }
    for (const match of source.matchAll(PARENTHESIZED_HEAD)) {
        const end = parenthesisEnd(source, match.index + match[0].length - 1);
        if (end === null)
            continue;
        const slash = skipTrivia(source, end).at;
        if (matters(slash))
            slashes.push(slash);
    }
    return slashes.sort((a, b) => a - b);
}
/** The text a regex opened by the `/` at `slash` would hold. */
function regexBody(source, slash) {
    let inClass = false;
    for (let at = slash + 1; at < source.length; at++) {
        const ch = source[at];
        if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029')
            return source.slice(slash + 1, at);
        if (ch === '\\')
            at++;
        else if (ch === '[')
            inClass = true;
        else if (ch === ']')
            inClass = false;
        else if (ch === '/' && !inClass)
            return source.slice(slash + 1, at);
    }
    return source.slice(slash + 1);
}
/**
 * Where an HTML-like comment may open, which a script's grammar reads as a
 * comment and es-module-lexer as code: `<!--` anywhere, and `-->` opening a
 * line (elsewhere `-->` is `--` and `>`). Ascending.
 */
export function htmlComments(source, lines) {
    const spots = [];
    for (const match of source.matchAll(/<!--|-->/g)) {
        const at = match.index;
        if (match[0] === '-->') {
            let before = at;
            while (before > 0 && (source[before - 1] === ' ' || source[before - 1] === '\t'))
                before--;
            if (before !== lines.startOf(at))
                continue;
        }
        spots.push(at);
    }
    return spots;
}
