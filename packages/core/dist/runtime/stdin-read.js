/**
 * Whether a program reads its stdin synchronously, judged from its code before
 * it runs.
 *
 * A pipe or redirect streams to a program as it arrives (runtime-registry.ts,
 * RuntimeRunOpts.stdin), so a program that ignores a pipe that never ends
 * (`tail -f log | node x.js`) still runs and exits. A synchronous read of
 * fd 0 cannot wait for input that arrives after it starts, though:
 * `slow-writer | node -e "JSON.parse(fs.readFileSync(0))"` would see a pipe
 * that had not ended yet. Node's blocking read waits for the writer. So a
 * program whose code makes such a read gets its whole stdin, read to the end
 * before it starts.
 *
 * The reads recognised are those of fd 0 or its device, however the fs
 * function was reached (`fs.readFileSync`, a destructured or imported
 * `readFileSync`, esbuild's `(0, import_fs.readFileSync)`):
 * `readFileSync(0)`, `readFileSync(process.stdin.fd)`,
 * `readFileSync('/dev/stdin')` (or `/proc/self/fd/0`), and `readSync` of
 * fd 0 or `process.stdin.fd`. They are looked for anywhere in the entry and
 * in the program's own modules it loads directly (server-launch.ts,
 * resolveOwnModules), whether or not that code runs: reading a pipe whole only
 * costs waiting for its end, while a missed read fails with EAGAIN.
 */
import { forEachNode, parseJavaScriptProgram } from './javascript-ast.js';
import { resolveOwnModules, SERVER_LAUNCH_MODULE_BYTES } from './server-launch.js';
/** How many of the entry's own modules are read, and how many bytes of source in all. */
const MODULE_LIMIT = 24;
const SOURCE_BYTE_BUDGET = 4 * 1024 * 1024;
/** Paths that name the process's stdin. */
const STDIN_DEVICES = new Set(['/dev/stdin', '/proc/self/fd/0']);
/** Whether `program`, or one of its own modules it loads, reads stdin synchronously. */
export async function programReadsStdinSync(program, host) {
    if (program.source.length > SERVER_LAUNCH_MODULE_BYTES)
        return false;
    const entry = parseJavaScriptProgram(program.source);
    if (entry === null)
        return false;
    if (readsStdinSync(entry))
        return true;
    const deps = await resolveOwnModules(entry, program.path, program.dir, program.packageRoot, host);
    let reads = 0;
    let bytes = 0;
    for (const path of new Set(deps.values())) {
        if (path === null)
            continue;
        if (reads >= MODULE_LIMIT || bytes >= SOURCE_BYTE_BUDGET)
            break;
        reads++;
        const source = await host.read(path);
        if (source === null)
            continue;
        bytes += source.length;
        const ast = parseJavaScriptProgram(source);
        if (ast !== null && readsStdinSync(ast))
            return true;
    }
    return false;
}
/** Whether a synchronous read of stdin appears anywhere in `ast`. */
function readsStdinSync(ast) {
    let found = false;
    forEachNode(ast, (n) => {
        if (found || n.type !== 'CallExpression' || n.arguments.length === 0)
            return;
        const name = calleeName(n.callee);
        const target = n.arguments[0];
        if (name === 'readFileSync')
            found = isStdinFd(target) || isStdinDevice(target);
        else if (name === 'readSync')
            found = isStdinFd(target);
    });
    return found;
}
/** The function a call reaches: `f`, `x.f`, `x['f']`, or esbuild's `(0, x.f)`. */
function calleeName(callee) {
    let at = callee;
    while (at.type === 'SequenceExpression' || at.type === 'ParenthesizedExpression' || at.type === 'ChainExpression') {
        at = at.type === 'SequenceExpression' ? at.expressions[at.expressions.length - 1] : at.expression;
    }
    if (at.type === 'Identifier')
        return at.name;
    if (at.type !== 'MemberExpression')
        return null;
    if (!at.computed && at.property.type === 'Identifier')
        return at.property.name;
    return at.property.type === 'Literal' && typeof at.property.value === 'string' ? at.property.value : null;
}
/** `0`, or `process.stdin.fd`. */
function isStdinFd(node) {
    if (node.type === 'Literal')
        return node.value === 0;
    return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'fd'
        && node.object.type === 'MemberExpression' && !node.object.computed
        && node.object.property.type === 'Identifier' && node.object.property.name === 'stdin'
        && node.object.object.type === 'Identifier' && node.object.object.name === 'process';
}
/** `'/dev/stdin'` or `'/proc/self/fd/0'`, as a string or a template without expressions. */
function isStdinDevice(node) {
    if (node.type === 'Literal')
        return typeof node.value === 'string' && STDIN_DEVICES.has(node.value);
    return node.type === 'TemplateLiteral' && node.expressions.length === 0
        && STDIN_DEVICES.has(node.quasis[0]?.value?.cooked);
}
