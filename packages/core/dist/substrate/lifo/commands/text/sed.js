import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';
class SedParseError extends Error {
    expr;
    constructor(expr) {
        super(`invalid expression: ${expr}`);
        this.expr = expr;
    }
}
// GNU keeps already-written output when an empty pattern has nothing to
// repeat yet; whatever a pass emitted before the failure has already left
// through its sink.
class SedRuntimeError extends Error {
    constructor() {
        super('no previous regular expression');
    }
}
// Yields logical lines on demand instead of materializing an array, so a
// multi-file pass holds only the current file's text plus one lookahead
// line. A file boundary starts a new logical line either way (GNU manual
// §6.1); `terminated` records whether the source ended the line itself.
function* iterateLogicalLines(text) {
    if (text === '')
        return;
    const finalTerminated = text.endsWith('\n');
    let start = 0;
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
        yield { text: text.slice(start, nl), terminated: true };
        start = nl + 1;
    }
    const tail = text.slice(start);
    if (tail !== '' || !finalTerminated) {
        yield { text: tail, terminated: finalTerminated };
    }
}
function pullFrom(lines) {
    return () => {
        const step = lines.next();
        return step.done ? null : step.value;
    };
}
function parseSedScript(expr) {
    const cur = { expr, i: 0 };
    const commands = [];
    for (;;) {
        skipBlanks(cur);
        const ch = peek(cur);
        if (ch === undefined)
            break;
        if (ch === ';' || ch === '\n') {
            cur.i++;
            continue;
        }
        if (ch === '#') {
            skipComment(cur);
            continue;
        }
        commands.push(parseSedCommand(cur));
    }
    return commands;
}
function parseSedCommand(cur) {
    let address;
    const start = tryParseSedAddress(cur);
    if (start) {
        skipBlanks(cur);
        if (peek(cur) === ',') {
            cur.i++;
            skipBlanks(cur);
            const end = tryParseSedAddress(cur);
            if (!end)
                throw new SedParseError(cur.expr);
            address = { kind: 'range', start, end };
        }
        else {
            address = start;
        }
    }
    skipBlanks(cur);
    let negate = false;
    if (peek(cur) === '!') {
        negate = true;
        cur.i++;
        skipBlanks(cur);
    }
    if (!address && negate)
        throw new SedParseError(cur.expr);
    if (peek(cur) === '!')
        throw new SedParseError(cur.expr);
    const op = peek(cur);
    if (op === 'd') {
        cur.i++;
        ensureCommandEnd(cur);
        return { address, negate, type: 'd' };
    }
    if (op === 'p') {
        cur.i++;
        ensureCommandEnd(cur);
        return { address, negate, type: 'p' };
    }
    if (op === 's') {
        return { address, negate, ...parseSubstitution(cur) };
    }
    throw new SedParseError(cur.expr);
}
function tryParseSedAddress(cur) {
    const ch = peek(cur);
    if (ch === undefined)
        return undefined;
    if (isDigit(ch)) {
        const start = cur.i;
        while (isDigit(peek(cur)))
            cur.i++;
        const value = Number(cur.expr.slice(start, cur.i));
        if (value === 0)
            throw new SedParseError(cur.expr);
        return { kind: 'line', value };
    }
    if (ch === '$') {
        cur.i++;
        return { kind: 'last' };
    }
    if (ch === '/') {
        return parseDelimitedRegex(cur);
    }
    return undefined;
}
function parseDelimitedRegex(cur) {
    cur.i++;
    let raw = '';
    let closed = false;
    while (cur.i < cur.expr.length) {
        const ch = peek(cur);
        if (ch === '\\') {
            // An escaped newline continues the pattern; everything else is literal.
            const next = cur.expr[cur.i + 1];
            if (next === undefined)
                break;
            raw += ch + next;
            cur.i += 2;
            continue;
        }
        if (ch === '\n')
            throw new SedParseError(cur.expr);
        if (ch === '/') {
            cur.i++;
            closed = true;
            break;
        }
        raw += ch;
        cur.i++;
    }
    if (!closed)
        throw new SedParseError(cur.expr);
    const source = toJavascriptPattern(raw);
    if (source === '')
        return { kind: 'empty' };
    try {
        return { kind: 'regex', regex: new RegExp(source) };
    }
    catch {
        throw new SedParseError(cur.expr);
    }
}
function parseSubstitution(cur) {
    cur.i++;
    const delim = peek(cur);
    if (delim === undefined)
        throw new SedParseError(cur.expr);
    cur.i++;
    const readPart = () => {
        let part = '';
        let escaped = false;
        while (cur.i < cur.expr.length) {
            const ch = peek(cur);
            if (escaped) {
                part += ch;
                escaped = false;
                cur.i++;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                part += '\\';
                cur.i++;
                continue;
            }
            if (ch === delim) {
                cur.i++;
                return part;
            }
            part += ch;
            cur.i++;
        }
        throw new SedParseError(cur.expr);
    };
    const patternStr = readPart();
    const replacement = readPart();
    // GNU's in_nonblank(): blanks may sit between flags; a flag run ends only
    // at `;`, a newline, a comment, or the end of the script.
    let flagStr = '';
    for (;;) {
        skipBlanks(cur);
        const ch = peek(cur);
        if (ch === undefined || ch === ';' || ch === '\n' || ch === '#')
            break;
        flagStr += ch;
        cur.i++;
    }
    for (const flag of flagStr) {
        if (flag !== 'g' && flag !== 'i' && flag !== 'p')
            throw new SedParseError(cur.expr);
    }
    const global = flagStr.includes('g');
    const insensitive = flagStr.includes('i');
    if (patternStr === '') {
        // Match modifiers belong to the repeated expression; only action flags
        // may accompany an empty pattern.
        if (insensitive)
            throw new SedParseError(cur.expr);
        return { type: 's', emptyPattern: true, replacement, global, insensitive, print: flagStr.includes('p') };
    }
    try {
        let flags = '';
        if (global)
            flags += 'g';
        if (insensitive)
            flags += 'i';
        const pattern = new RegExp(toJavascriptPattern(patternStr), flags);
        return { type: 's', pattern, replacement, global, insensitive, print: flagStr.includes('p') };
    }
    catch {
        throw new SedParseError(cur.expr);
    }
}
// Blanks may surround an address or an operation, but a command ends only at
// `;`, a newline, a comment, or the end of the script — never at a following
// command letter, which GNU sed reports as extra characters.
function ensureCommandEnd(cur) {
    skipBlanks(cur);
    const ch = peek(cur);
    if (ch === undefined || ch === ';' || ch === '\n' || ch === '#')
        return;
    throw new SedParseError(cur.expr);
}
function skipComment(cur) {
    const nl = cur.expr.indexOf('\n', cur.i);
    cur.i = nl === -1 ? cur.expr.length : nl + 1;
}
function skipBlanks(cur) {
    while (isBlank(peek(cur)))
        cur.i++;
}
function peek(cur) {
    return cur.expr[cur.i];
}
function isBlank(value) {
    return value === ' ' || value === '\t';
}
function isDigit(value) {
    if (value === undefined)
        return false;
    const code = value.charCodeAt(0);
    return code >= 48 && code <= 57;
}
function toJavascriptPattern(pattern) {
    let result = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        const next = pattern[i + 1];
        if (char === '\\' && (next === '(' || next === ')' || next === '/')) {
            result += next;
            i++;
            continue;
        }
        result += char;
    }
    return result;
}
// One pass over a logical-line stream: per-command range state, cycle
// numbering, and GNU footnote-8 newline handling live here. A non-in-place
// run shares one pass across all files and hands every emitted chunk
// straight to its sink; an in-place run buffers a single file's chunks so
// its rewrite stays all-or-nothing. The previous-regex record is passed in
// so it spans passes.
class SedPass {
    quiet;
    out;
    entries;
    evalCtx;
    pendingNewline = false;
    constructor(commands, quiet, out, lastRegex) {
        this.quiet = quiet;
        this.out = out;
        this.entries = commands.map((command) => ({ command, range: { open: false } }));
        this.evalCtx = { line: '', lineNumber: 0, isLast: false, lastRegex };
    }
    // Runs one cycle per line with a single lookahead, so `$` still selects
    // the true last line while later input is not read yet.
    runAll(next) {
        let current = next();
        let lookahead = next();
        let lineNumber = 0;
        while (current !== null) {
            this.runCycle(current.text, current.terminated, ++lineNumber, lookahead === null);
            current = lookahead;
            lookahead = next();
        }
    }
    runCycle(text, terminated, lineNumber, isLast) {
        const ctx = this.evalCtx;
        ctx.lineNumber = lineNumber;
        ctx.isLast = isLast;
        let line = text;
        let deleted = false;
        for (const entry of this.entries) {
            // Later addresses see the pattern space as earlier commands left it.
            ctx.line = line;
            if (!selects(entry.command, entry.range, ctx))
                continue;
            const command = entry.command;
            if (command.type === 'p') {
                this.emit(line, terminated);
            }
            else if (command.type === 'd') {
                deleted = true;
                break;
            }
            else if (command.type === 's' && command.replacement !== undefined) {
                let regex = command.pattern;
                if (command.emptyPattern) {
                    if (!ctx.lastRegex.source)
                        throw new SedRuntimeError();
                    // Match flags come from the repeated expression; only action
                    // flags such as g come from this substitution.
                    let flags = ctx.lastRegex.flags ?? '';
                    if (command.global && !flags.includes('g'))
                        flags += 'g';
                    regex = new RegExp(ctx.lastRegex.source, flags);
                }
                if (!regex)
                    continue;
                let changed = false;
                regex.lastIndex = 0;
                line = line.replace(regex, (...match) => {
                    changed = true;
                    return expandReplacement(command.replacement ?? '', match.slice(1, -2), String(match[0]));
                });
                if (!command.emptyPattern) {
                    ctx.lastRegex.source = regex.source;
                    // Only match modifiers repeat with an empty pattern; g is an
                    // action flag of the substitution that used the expression.
                    ctx.lastRegex.flags = command.insensitive ? 'i' : '';
                }
                if (changed && command.print)
                    this.emit(line, terminated);
            }
        }
        if (!deleted && !this.quiet)
            this.emit(line, terminated);
    }
    emit(text, terminated) {
        if (!terminated) {
            // Footnote 8: the missing newline waits until more output follows.
            if (this.pendingNewline)
                this.out('\n');
            this.out(text);
            this.pendingNewline = true;
            return;
        }
        if (this.pendingNewline) {
            this.out('\n');
            this.pendingNewline = false;
        }
        this.out(`${text}\n`);
    }
}
export async function runSed(ctx) {
    const options = parseSedArgs(ctx.args);
    if (options.expressions.length === 0) {
        ctx.stderr.write('sed: missing expression\n');
        return 1;
    }
    // Execution state: the last regular expression any address or substitution
    // actually evaluated, shared by `//` and empty s patterns across -e chunks
    // and files.
    const lastRegex = {};
    const commands = [];
    for (const expr of options.expressions) {
        try {
            commands.push(...parseSedScript(expr));
        }
        catch (e) {
            if (e instanceof SedParseError) {
                ctx.stderr.write(`sed: invalid expression: ${expr}\n`);
                return 1;
            }
            throw e;
        }
    }
    const streamOut = (chunk) => ctx.stdout.write(chunk);
    try {
        if (options.files.length === 0) {
            if (ctx.stdin) {
                const lines = iterateLogicalLines(await ctx.stdin.readAll());
                new SedPass(commands, options.quiet, streamOut, lastRegex).runAll(pullFrom(lines));
            }
            else {
                ctx.stderr.write('sed: missing file operand\n');
                return 1;
            }
            return 0;
        }
        if (options.inPlace) {
            let exitCode = 0;
            for (const file of options.files) {
                const path = resolve(ctx.cwd, file);
                try {
                    ctx.vfs.stat(path);
                    if (isBinaryMime(getMimeType(path))) {
                        ctx.stderr.write(`sed: ${file}: binary file, skipping\n`);
                        continue;
                    }
                    const content = ctx.vfs.readFileString(path);
                    // One buffered pass per file: nothing touches the file until its
                    // whole result exists, keeping the rewrite all-or-nothing.
                    const chunks = [];
                    new SedPass(commands, options.quiet, (chunk) => chunks.push(chunk), lastRegex)
                        .runAll(pullFrom(iterateLogicalLines(content)));
                    ctx.vfs.writeFile(path, chunks.join(''));
                }
                catch (e) {
                    if (e instanceof VFSError) {
                        ctx.stderr.write(`sed: ${file}: ${e.message}\n`);
                        exitCode = 1;
                    }
                    else {
                        throw e;
                    }
                }
            }
            return exitCode;
        }
        // All readable files feed one shared pass, so global line numbers, range
        // state, `$` and the previous-regex record span files. Each file opens
        // only after the previous one is fully consumed — at most one file's text
        // is ever held — and output leaves as each line is decided.
        let exitCode = 0;
        let index = 0;
        let lines = null;
        const nextLine = () => {
            for (;;) {
                if (lines !== null) {
                    const step = lines.next();
                    if (!step.done)
                        return step.value;
                    lines = null; // release this file before any later file is read
                }
                if (index >= options.files.length)
                    return null;
                const file = options.files[index++];
                const path = resolve(ctx.cwd, file);
                try {
                    ctx.vfs.stat(path);
                    if (isBinaryMime(getMimeType(path))) {
                        ctx.stderr.write(`sed: ${file}: binary file, skipping\n`);
                        continue;
                    }
                    lines = iterateLogicalLines(ctx.vfs.readFileString(path));
                }
                catch (e) {
                    if (e instanceof VFSError) {
                        ctx.stderr.write(`sed: ${file}: ${e.message}\n`);
                        exitCode = 1;
                    }
                    else {
                        throw e;
                    }
                }
            }
        };
        new SedPass(commands, options.quiet, streamOut, lastRegex).runAll(nextLine);
        return exitCode;
    }
    catch (e) {
        if (e instanceof SedRuntimeError) {
            // Output emitted before the failing cycle already reached stdout; an
            // in-place run wrote no file for the aborted pass.
            ctx.stderr.write(`sed: ${e.message}\n`);
            return 1;
        }
        throw e;
    }
}
function selects(command, range, ctx) {
    const address = command.address;
    let selected;
    if (!address) {
        selected = true;
    }
    else if (address.kind === 'range') {
        selected = rangeSelects(address, range, ctx);
    }
    else {
        selected = addressSelects(address, ctx);
    }
    return command.negate ? !selected : selected;
}
function addressSelects(address, ctx) {
    switch (address.kind) {
        case 'line':
            return ctx.lineNumber === address.value;
        case 'last':
            return ctx.isLast;
        case 'empty': {
            // `//` reads the record without writing it; nothing may establish one.
            if (!ctx.lastRegex.source)
                throw new SedRuntimeError();
            return new RegExp(ctx.lastRegex.source, ctx.lastRegex.flags ?? '').test(ctx.line);
        }
        case 'regex': {
            const matched = address.regex.test(ctx.line);
            ctx.lastRegex.source = address.regex.source;
            ctx.lastRegex.flags = address.regex.flags;
            return matched;
        }
    }
}
function rangeSelects(range, state, ctx) {
    if (!state.open) {
        if (!addressSelects(range.start, ctx))
            return false;
        // A numeric end at or before the start line leaves the range one line wide.
        state.open = !(range.end.kind === 'line' && range.end.value <= ctx.lineNumber);
        return true;
    }
    // A regular-expression end is first tested on the line after the range opens.
    const closes = range.end.kind === 'line'
        ? ctx.lineNumber >= range.end.value
        : range.end.kind === 'last'
            ? ctx.isLast
            : addressSelects(range.end, ctx);
    if (closes)
        state.open = false;
    return true;
}
function parseSedArgs(args) {
    const options = {
        inPlace: false,
        quiet: false,
        expressions: [],
        files: [],
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg === '-i') {
            options.inPlace = true;
            continue;
        }
        if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
            options.quiet = true;
            continue;
        }
        if (arg === '-e') {
            options.expressions.push(args[++i] ?? '');
            continue;
        }
        if (arg.startsWith('-') && arg.length > 2 && parseSedShortCluster(options, arg, args, i)) {
            if (clusterNeedsNextArg(arg))
                i++;
            continue;
        }
        if (options.expressions.length === 0 && !arg.startsWith('-')) {
            options.expressions.push(arg);
            continue;
        }
        options.files.push(arg);
    }
    return options;
}
function parseSedShortCluster(options, arg, args, index) {
    for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === 'n') {
            options.quiet = true;
            continue;
        }
        if (flag === 'i') {
            options.inPlace = true;
            continue;
        }
        if (flag === 'e') {
            const rest = arg.slice(j + 1);
            options.expressions.push(rest || args[index + 1] || '');
            return true;
        }
        return false;
    }
    return true;
}
function clusterNeedsNextArg(arg) {
    const eIndex = arg.indexOf('e');
    return eIndex !== -1 && eIndex === arg.length - 1;
}
function expandReplacement(replacement, captures, matched) {
    let result = '';
    for (let i = 0; i < replacement.length; i++) {
        const char = replacement[i];
        const next = replacement[i + 1];
        if (char === '\\' && next !== undefined) {
            if (isDigit(next)) {
                result += String(captures[Number(next) - 1] ?? '');
                i++;
                continue;
            }
            result += next;
            i++;
            continue;
        }
        if (char === '&') {
            result += matched;
            continue;
        }
        result += char;
    }
    return result;
}
const command = async (ctx) => runSed(ctx);
export default command;
