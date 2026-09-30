/**
 * Route a cell's import() to its process loader and bind import.meta to its
 * evaluation metadata.
 *
 * es-module-lexer (module-lexer.ts) finds both in one linear pass with no
 * AST: it skips comments, strings and templates exactly, and reads a `/` as
 * a regex or a division from the token before it. Where that reading can
 * differ from the grammar's, Acorn's parser decides the cell instead
 * (rewriteWithGrammar, which streams: it drops each completed top-level
 * statement). That is when:
 * - the lexer cannot lex the cell;
 * - a `/` in code it may have misread (import-lexer-hazards.ts) could open a
 *   regex that holds import syntax, or a quote with import syntax later on
 *   its line;
 * - an HTML-like comment sits in code, which the lexer reads as code;
 * - an import() follows `new`, or has arguments Acorn rejects;
 * - an `import(...)` followed by `{` on a later line reads both as a method
 *   and as a call before a block;
 * - the lexer passed over an `import(` in code that is not a member call and
 *   is not followed by `{`.
 * Otherwise Acorn only reads small spans: one call's arguments, the braces
 * around an `import(...)` whose `{` is on the next line, the leading
 * directives, and unicode-escaped words that could collide with the metadata
 * capture's name.
 */
import { Parser, parseExpressionAt, tokenizer, tokTypes } from 'acorn';
import { createModuleLexer } from './module-lexer.js';
import { ambiguousSlashes, htmlComments, lineEnd, Lines, parenthesisEnd, skipTrivia } from './import-lexer-hazards.js';
export const DYNAMIC_IMPORT_HELPER = '__nimbusDynamicImport';
export function mayHaveDynamicImport(code) {
    return /\bimport\s*(?:\(|\/[/*])/.test(code);
}
/** es-module-lexer's `t` for an import() call and for import.meta. */
const DYNAMIC_IMPORT = 2;
const IMPORT_META = 3;
const METADATA_BINDING = '__nimbusMetadataModule';
const IDENTIFIER_PART = /[$_\p{ID_Continue}\u200c\u200d]/u;
/**
 * A source of this many characters fits the lexer's initial 1 MiB scratch
 * buffer. A longer one grows it, to 2 bytes per character plus 512 KiB
 * rounded up to a power of two, and the lexer that grew is dropped once that
 * source is lexed, so a 3.8M-character bundle does not leave 8 MiB behind.
 */
const RETAINED_LEXER_CHARS = 256 * 1024;
let moduleLexer = null;
function lexImports(source) {
    const lex = moduleLexer ??= createModuleLexer();
    if (source.length > RETAINED_LEXER_CHARS)
        moduleLexer = null;
    return lex(source)[0];
}
function isLexerError(error) {
    return error instanceof Error && typeof Reflect.get(error, 'idx') === 'number';
}
export function rewriteDynamicImports(code, parentUrl, moduleMetadata = false) {
    const metadata = moduleMetadata && /\bimport\s*(?:\.|\/[/*])/.test(code);
    if (!mayHaveDynamicImport(code) && !metadata)
        return code;
    let lexed;
    try {
        lexed = rewriteFromLexer(code, parentUrl, metadata);
    }
    catch (error) {
        // A lexing or a probe that cannot finish settles nothing; the grammar decides.
        if (!(isLexerError(error) || error instanceof SyntaxError || error instanceof RangeError))
            throw error;
        lexed = null;
    }
    return lexed ?? rewriteWithGrammar(code, parentUrl, metadata);
}
/** The cell rewritten from the lexer's reading, or null where only the grammar can decide. */
function rewriteFromLexer(code, parentUrl, metadata) {
    // The lexer reads a hashbang line as code. Blank it: lengths, and so
    // every position, stay the cell's.
    const hashbang = code.startsWith('#!') ? lineEnd(code, 0) : 0;
    const source = hashbang ? ' '.repeat(hashbang) + code.slice(hashbang) : code;
    const imports = lexImports(source);
    const lines = new Lines(source);
    const passed = passedOver(source, imports, [...ambiguousSlashes(source, lines), ...htmlComments(source, lines)]);
    if (passed === null)
        return null;
    const calls = [];
    const metas = [];
    for (const entry of imports) {
        if (entry.t === DYNAMIC_IMPORT)
            calls.push({ ss: entry.ss, se: entry.se, d: entry.d, lexed: true });
        else if (metadata && entry.t === IMPORT_META)
            metas.push({ start: entry.s, end: entry.e });
    }
    for (const at of passed) {
        const open = skipTrivia(source, at + 'import'.length).at;
        const end = source[open] === '(' ? parenthesisEnd(source, open) : null;
        if (end === null)
            return null;
        calls.push({ ss: at, se: end, d: open, lexed: false });
    }
    calls.sort((a, b) => a.ss - b.ss);
    const call = DYNAMIC_IMPORT_HELPER + '(' + JSON.stringify(parentUrl) + ', ';
    const edits = [];
    let validatedEnd = -1;
    for (const site of calls) {
        // Inside arguments Acorn has already accepted: an import() there is one.
        if (site.ss >= validatedEnd) {
            const shape = callShape(source, site);
            if (shape === null)
                return null;
            if (shape === 'method')
                continue;
            if (!validImportArguments(source.slice(site.ss, site.se)))
                return null;
            validatedEnd = site.se;
        }
        // d is the opening parenthesis; do not consume grouping in the argument.
        edits.push({ start: site.ss, end: site.d + 1, text: call });
    }
    if (!edits.length && !metas.length)
        return code;
    if (!metas.length)
        return applyEdits(code, edits, metas, null, 0);
    return applyEdits(code, edits, metas, escapedCaptureNames(code), afterDirectives(code));
}
/** Marks the lexer reports only where it reads the marked spot as code. */
const CODE_MARK = ' import.meta ';
/**
 * Where the lexer passed over an `import(` in code, the positions of those
 * `import`s; null where one of the `hazards`, a spot only the grammar reads
 * right, is in code. A member call (`x.import(`, `x?.import(`) is no import.
 * Any other `import(` the lexer did not report is in a comment, a string, a
 * template or a regex, or it is a method or a call followed by `{`, which the
 * lexer drops. One more lexing of the cell, with a mark before each spot,
 * tells which the lexer reads as code: a mark is only reported there. Marks
 * in text change nothing the lexer reads; the first reported before a hazard
 * can (a slash after it becomes a division), but that one already settles it.
 */
function passedOver(source, imports, hazards) {
    const reported = new Set();
    for (const entry of imports)
        if (entry.t === DYNAMIC_IMPORT)
            reported.add(entry.ss);
    const marks = hazards.map((at) => ({ at, call: false }));
    for (const match of source.matchAll(/\bimport\s*(?:\(|\/[/*])/g)) {
        if (!reported.has(match.index) && !isMemberName(source, match.index))
            marks.push({ at: match.index, call: true });
    }
    if (!marks.length)
        return [];
    marks.sort((a, b) => a.at - b.at);
    const parts = [];
    let from = 0;
    for (const { at } of marks) {
        parts.push(source.slice(from, at), CODE_MARK);
        from = at;
    }
    parts.push(source.slice(from));
    const code = new Set();
    for (const entry of lexImports(parts.join('')))
        if (entry.t === IMPORT_META)
            code.add(entry.s);
    const passed = [];
    for (const [index, { at, call }] of marks.entries()) {
        // The mark's `import` in the probe: after the marks before it, and a space.
        if (!code.has(at + index * CODE_MARK.length + 1))
            continue;
        if (!call)
            return null;
        passed.push(at);
    }
    return passed;
}
/** `x.import` and `x?.import`, though not `...import`. */
function isMemberName(source, at) {
    let before = at;
    while (before > 0 && /\s/.test(source[before - 1]))
        before--;
    return source[before - 1] === '.' && source[before - 2] !== '.';
}
/** `new` right before `at`, across whitespace and comments. */
function afterNew(source, at) {
    return /(?:^|[^\w$.\\])new(?:\s|\/\*[^]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*$/.test(source.slice(Math.max(0, at - 256), at));
}
/**
 * What an `import(...)` is: a call; a method named import, when `{` follows
 * on its line (a call cannot be followed by one there); or, when `{` follows on
 * a later line, whichever the braces around it allow. Null where only the
 * grammar can say: after `new`, for an `import(` the lexer passed over that
 * no `{` follows, and where those braces read both ways.
 */
function callShape(source, site) {
    if (afterNew(source, site.ss))
        return null;
    const next = skipTrivia(source, site.se);
    if (source[next.at] !== '{')
        return site.lexed ? 'call' : null;
    if (!next.newline)
        return 'method';
    const rest = source.slice(site.ss);
    // A method's braces are a class body or an object; a call's, statements.
    const member = closes('(class{', rest, 'ClassBody') || closes('({', rest, 'ObjectExpression');
    if (!member)
        return 'call';
    return closes('(function(){', rest, 'BlockStatement') || closes('(async function*(){', rest, 'BlockStatement') ? null : 'method';
}
// Acorn's own productions, which the parsers below extend.
const PARSE_STATEMENT = Reflect.get(Parser.prototype, 'parseStatement');
const PARSE_DYNAMIC_IMPORT = Reflect.get(Parser.prototype, 'parseDynamicImport');
const PARSE_IMPORT_META = Reflect.get(Parser.prototype, 'parseImportMeta');
const PARSE_IDENT = Reflect.get(Parser.prototype, 'parseIdent');
const FINISH_NODE = Reflect.get(Parser.prototype, 'finishNode');
class ContainerClosed extends Error {
}
/** Acorn, stopped as it finishes the `containerType` node at `containerStart`. */
class ContainerParser extends Parser {
    containerType;
    containerStart;
    constructor(options, input, containerType, containerStart) {
        super(options, input);
        this.containerType = containerType;
        this.containerStart = containerStart;
    }
    finishNode(node, type) {
        const finished = Reflect.apply(FINISH_NODE, this, [node, type]);
        if (type === this.containerType && node.start === this.containerStart)
            throw new ContainerClosed();
        return finished;
    }
}
/**
 * Whether `rest`, opened by `prefix` (ending in `{`), parses as a `type` node
 * up to the brace that closes it. Only the braces are parsed: Acorn is
 * stopped as it finishes that node.
 */
function closes(prefix, rest, type) {
    for (const sourceType of ['script', 'module']) {
        try {
            new ContainerParser({
                ecmaVersion: 'latest', sourceType, allowAwaitOutsideFunction: true,
                allowSuperOutsideMethod: true, checkPrivateFields: false,
            }, prefix + rest, type, prefix.length - 1).parse();
        }
        catch (error) {
            if (error instanceof ContainerClosed)
                return true;
            if (!(error instanceof SyntaxError))
                throw error;
        }
    }
    return false;
}
/**
 * The lexer reports positions, not argument-count/spread validity. Validate
 * only each outer import call in a function context, never its surrounding
 * bundle. Both normal and generator contexts preserve contextual yield uses;
 * the enclosing cell's compiler still owns scope/strictness validation.
 */
function validImportArguments(fragment) {
    for (const prefix of ['async function(){return ', 'async function*(){return ']) {
        try {
            parseExpressionAt(prefix + fragment + '\n}', 0, {
                ecmaVersion: 'latest', sourceType: 'script',
                allowImportExportEverywhere: true, allowSuperOutsideMethod: true,
                checkPrivateFields: false,
            });
            return true;
        }
        catch (error) {
            if (!(error instanceof SyntaxError))
                throw error;
        }
    }
    return false;
}
/**
 * Ordinary spellings are excluded by raw membership, even in text. Only
 * unicode-escaped words need decoding, each alone; a word in text may
 * over-exclude, which is safe.
 */
function escapedCaptureNames(code) {
    const names = new Set();
    for (let at = code.indexOf('\\u'); at !== -1; at = code.indexOf('\\u', at)) {
        let start = at;
        while (start > 0 && IDENTIFIER_PART.test(code[start - 1]))
            start--;
        let end = at;
        while (end < code.length) {
            if (code[end] === '\\' && code[end + 1] === 'u') {
                // \uXXXX, or \u{...} of at most six hex digits.
                const close = code[end + 2] === '{' ? code.indexOf('}', end + 3) : end + 5;
                if (close < 0 || close > end + 9)
                    break;
                end = close + 1;
            }
            else if (IDENTIFIER_PART.test(code[end])) {
                end++;
            }
            else {
                break;
            }
        }
        try {
            const token = tokenizer(code.slice(start, end), { ecmaVersion: 'latest' }).getToken();
            const value = Reflect.get(token, 'value');
            if (token.type === tokTypes.name && typeof value === 'string' && value.startsWith(METADATA_BINDING))
                names.add(value);
        }
        catch (error) {
            // A unicode escape in text need not spell a legal word.
            if (!(error instanceof SyntaxError))
                throw error;
        }
        at = Math.max(at + 2, end);
    }
    return names;
}
/** Keep the user's directive prologue, and a hashbang, in front of the metadata capture. */
function afterDirectives(code) {
    const tokens = tokenizer(code, { ecmaVersion: 'latest', allowHashBang: true });
    let token = tokens.getToken();
    let insertion = token.start;
    while (token.type === tokTypes.string) {
        const expression = parseExpressionAt(code, token.start, { ecmaVersion: 'latest', sourceType: 'script' });
        if (expression.type !== 'Literal' || typeof Reflect.get(expression, 'value') !== 'string')
            break;
        do {
            token = tokens.getToken();
        } while (token.start < expression.end);
        if (token.type === tokTypes.semi) {
            insertion = token.end;
            token = tokens.getToken();
            continue;
        }
        if (token.type !== tokTypes.eof && !/[\n\r\u2028\u2029]/.test(code.slice(expression.end, token.start)))
            break;
        insertion = expression.end;
    }
    return insertion;
}
/**
 * Acorn, collecting each import() call as it recognizes one and dropping each
 * completed top-level statement, so only the one being parsed is held.
 */
class ImportCollector extends Parser {
    collected;
    constructor(options, input, collected) {
        super(options, input);
        this.collected = collected;
    }
    parseDynamicImport(node) {
        // Acorn enters this production at the opening parenthesis. Its end,
        // not source.start (which can exclude grouping parentheses), is the
        // exact end of the prefix we replace. Acorn validates the arguments.
        const end = Reflect.get(this, 'end');
        const parsed = Reflect.apply(PARSE_DYNAMIC_IMPORT, this, [node]);
        this.collected.edits.push({ start: node.start, end, text: this.collected.call });
        return parsed;
    }
    parseStatement(context, topLevel, exports) {
        const node = Reflect.apply(PARSE_STATEMENT, this, [context, topLevel, exports]);
        if (!topLevel)
            return node;
        if (node.type === 'ExpressionStatement') {
            const expression = Reflect.get(node, 'expression');
            if (expression?.type === 'Literal' && typeof expression.value === 'string')
                return node;
        }
        return { type: 'EmptyStatement', start: node.start, end: node.end };
    }
}
/** An ImportCollector that also collects import.meta, and every identifier. */
class MetadataCollector extends ImportCollector {
    parseImportMeta(node) {
        const parsed = Reflect.apply(PARSE_IMPORT_META, this, [node]);
        this.collected.metas.push({ start: node.start, end: node.end });
        return parsed;
    }
    parseIdent(liberal) {
        const node = Reflect.apply(PARSE_IDENT, this, [liberal]);
        this.collected.names.add(Reflect.get(node, 'name'));
        return node;
    }
}
/**
 * The grammar's reading of the cell. A cell it cannot parse in either goal is
 * returned as written, for its compile to report.
 */
function rewriteWithGrammar(code, parentUrl, metadata) {
    const collected = {
        call: DYNAMIC_IMPORT_HELPER + '(' + JSON.stringify(parentUrl) + ', ',
        edits: [],
        metas: [],
        names: metadata ? new Set() : null,
    };
    // Import-only cells need no identifier collection.
    const Collector = metadata ? MetadataCollector : ImportCollector;
    for (const sourceType of metadata ? ['module', 'script'] : ['script', 'module']) {
        collected.edits.length = 0;
        collected.metas.length = 0;
        collected.names?.clear();
        let program;
        try {
            program = new Collector({
                ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true,
                allowAwaitOutsideFunction: true, allowHashBang: true,
            }, code, collected).parse();
        }
        catch {
            continue;
        }
        if (!collected.edits.length && !collected.metas.length)
            return code;
        let insertion = program.body[0]?.start ?? code.length;
        for (const statement of program.body) {
            if (typeof Reflect.get(statement, 'directive') !== 'string')
                break;
            insertion = statement.end;
        }
        return applyEdits(code, collected.edits, collected.metas, collected.names, insertion);
    }
    return code;
}
function applyEdits(code, edits, metas, names, insertion) {
    if (metas.length) {
        let binding = METADATA_BINDING;
        while (code.includes(binding) || names.has(binding))
            binding += '_';
        for (const meta of metas)
            edits.push({ ...meta, text: `${binding}.__nimbusImportMeta` });
        edits.push({ start: insertion, end: insertion, text: `\n"use strict";\nconst ${binding} = arguments[2];\n` });
    }
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    const parts = [];
    let at = 0;
    for (const { start, end, text } of edits) {
        parts.push(code.slice(at, start), text);
        at = end;
    }
    parts.push(code.slice(at));
    return parts.join('');
}
