import { expandWord } from './expander.js';
import { globMatch } from '../utils/glob.js';
/**
 * Implementation of the `test` / `[` shell builtin.
 * Evaluates conditional expressions.
 */
export async function evaluateTest(args, vfs, stderr, context) {
    // `[` requires a closing `]`
    const operands = args.length > 0 && args[args.length - 1] === ']' ? args.slice(0, -1) : args;
    return evaluateTestExpression(literalOperands(operands), vfs, stderr, context, 'test');
}
/**
 * `[[ ... ]]`, whose operands are expanded only when the expression actually
 * reaches them: `[[ $# = 2 && $2 = x ]]` must not touch `$2` under `set -u`.
 */
export async function evaluateDoubleBracketWords(words, expandCtx, vfs, stderr, context) {
    const expanded = new Map();
    const operands = {
        length: words.length,
        literal: (i) => operatorTextOf(words[i]),
        value: async (i) => {
            const cached = expanded.get(i);
            if (cached !== undefined)
                return cached;
            const word = words[i] ?? [];
            const value = await expandWord(word, expandCtx);
            const arg = {
                value,
                canUseAsPattern: hasUnquotedPart(word) && hasPatternSyntax(value),
            };
            expanded.set(i, arg);
            return arg;
        },
    };
    return evaluateTestExpression(operands, vfs, stderr, context, 'double-bracket');
}
function literalOperands(args) {
    return {
        length: args.length,
        literal: (i) => args[i],
        value: async (i) => literalArg(args[i] ?? ''),
    };
}
/** `[[` recognises an operator only when it is written literally. */
function operatorTextOf(word) {
    if (word === undefined || word.length !== 1)
        return undefined;
    const part = word[0];
    if (part.quoted !== 'none' || part.commandSubstitution !== undefined)
        return undefined;
    if (part.text.includes('$'))
        return undefined;
    return part.text;
}
async function evaluateTestExpression(operands, vfs, stderr, context, mode) {
    if (operands.length === 0) {
        return 1; // false
    }
    try {
        const result = await parseOr(operands, 0, vfs, context, mode, true);
        if (result.pos !== operands.length) {
            stderr.write('test: too many arguments\n');
            return 2;
        }
        return result.value ? 0 : 1;
    }
    catch (e) {
        stderr.write(`test: ${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
    }
}
/**
 * `evaluate` is false once a short-circuit has decided the result: the walk
 * still advances over the remaining operands (their positions are fixed by the
 * literal operators alone) but never expands them.
 */
async function parseOr(ops, pos, vfs, context, mode, evaluate) {
    let left = await parseAnd(ops, pos, vfs, context, mode, evaluate);
    while (left.pos < ops.length && isOrOperator(ops.literal(left.pos), mode)) {
        const right = await parseAnd(ops, left.pos + 1, vfs, context, mode, evaluate && !left.value);
        left = { value: left.value || right.value, pos: right.pos };
    }
    return left;
}
async function parseAnd(ops, pos, vfs, context, mode, evaluate) {
    let left = await parsePrimary(ops, pos, vfs, context, mode, evaluate);
    while (left.pos < ops.length && isAndOperator(ops.literal(left.pos), mode)) {
        const right = await parsePrimary(ops, left.pos + 1, vfs, context, mode, evaluate && left.value);
        left = { value: left.value && right.value, pos: right.pos };
    }
    return left;
}
async function parsePrimary(ops, pos, vfs, context, mode, evaluate) {
    if (pos >= ops.length) {
        return { value: false, pos };
    }
    const arg = ops.literal(pos) ?? '';
    const valueAt = async (index) => (evaluate ? (await ops.value(index)).value : '');
    // Negation
    if (arg === '!') {
        const result = await parsePrimary(ops, pos + 1, vfs, context, mode, evaluate);
        return { value: !result.value, pos: result.pos };
    }
    // Parenthesized expression
    if (arg === '(') {
        const result = await parseOr(ops, pos + 1, vfs, context, mode, evaluate);
        if (result.pos >= ops.length || ops.literal(result.pos) !== ')') {
            throw new Error('missing )');
        }
        return { value: result.value, pos: result.pos + 1 };
    }
    // Unary string tests
    if (arg === '-z' && pos + 1 < ops.length) {
        return { value: (await valueAt(pos + 1)).length === 0, pos: pos + 2 };
    }
    if (arg === '-n' && pos + 1 < ops.length) {
        return { value: (await valueAt(pos + 1)).length > 0, pos: pos + 2 };
    }
    if (arg === '-t' && pos + 1 < ops.length) {
        return {
            value: context?.isFdTerminal(toInt(await valueAt(pos + 1))) ?? false,
            pos: pos + 2,
        };
    }
    // Unary file tests
    if (arg.startsWith('-') && arg.length === 2 && pos + 1 < ops.length && isFileTestFlag(arg[1])) {
        const fileResult = evaluate
            ? evaluateFileTest(arg[1], await valueAt(pos + 1), vfs)
            : false;
        return { value: fileResult, pos: pos + 2 };
    }
    // Binary operators: check if there's an operator at pos+1
    if (pos + 2 <= ops.length) {
        const op = ops.literal(pos + 1);
        if (op !== undefined) {
            // String comparisons
            if (op === '=' || op === '==' || op === '!=') {
                const equal = evaluate
                    ? stringCompare(await ops.value(pos), await ops.value(pos + 2), mode)
                    : false;
                return { value: op === '!=' ? !equal : equal, pos: pos + 3 };
            }
            if (op === '<') {
                return { value: (await valueAt(pos)) < (await valueAt(pos + 2)), pos: pos + 3 };
            }
            if (op === '>') {
                return { value: (await valueAt(pos)) > (await valueAt(pos + 2)), pos: pos + 3 };
            }
            // Integer comparisons
            const integerCompare = INTEGER_COMPARISONS[op];
            if (integerCompare !== undefined) {
                const value = evaluate
                    && integerCompare(toInt(await valueAt(pos)), toInt(await valueAt(pos + 2)));
                return { value, pos: pos + 3 };
            }
        }
    }
    // Single string argument -- true if non-empty
    return { value: (await valueAt(pos)).length > 0, pos: pos + 1 };
}
const INTEGER_COMPARISONS = {
    '-eq': (a, b) => a === b,
    '-ne': (a, b) => a !== b,
    '-lt': (a, b) => a < b,
    '-le': (a, b) => a <= b,
    '-gt': (a, b) => a > b,
    '-ge': (a, b) => a >= b,
};
const FILE_TEST_FLAGS = 'efdsrwx';
function isFileTestFlag(flag) {
    return FILE_TEST_FLAGS.includes(flag);
}
function isOrOperator(value, mode) {
    return value === '-o' || (mode === 'double-bracket' && value === '||');
}
function isAndOperator(value, mode) {
    return value === '-a' || (mode === 'double-bracket' && value === '&&');
}
function stringCompare(left, right, mode) {
    if (mode === 'double-bracket' && right.canUseAsPattern) {
        return globMatch(right.value, left.value);
    }
    return left.value === right.value;
}
function literalArg(value) {
    return { value, canUseAsPattern: false };
}
function hasUnquotedPart(word) {
    return word.some((part) => part.quoted === 'none');
}
function hasPatternSyntax(value) {
    return value.includes('*') || value.includes('?') || value.includes('[');
}
function evaluateFileTest(flag, path, vfs) {
    switch (flag) {
        case 'e':
            return statOf(vfs, path) !== null;
        case 'f':
            return statOf(vfs, path)?.type === 'file';
        case 'd':
            return statOf(vfs, path)?.type === 'directory';
        case 's': {
            const stat = statOf(vfs, path);
            return stat !== null && stat.type === 'file' && stat.size > 0;
        }
        default: {
            const mode = flag === 'r' ? 0o4 : flag === 'w' ? 0o2 : 0o1;
            try {
                vfs.access(path, mode);
                return true;
            }
            catch {
                return false;
            }
        }
    }
}
function statOf(vfs, path) {
    try {
        return vfs.stat(path);
    }
    catch {
        return null;
    }
}
function toInt(s) {
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
}
