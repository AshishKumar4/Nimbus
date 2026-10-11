import { resolveContext } from '../commands/registry.js';
import { resolve } from '../utils/path.js';
import { echoOutput } from '../utils/backslash-escapes.js';
import { singleQuote } from '../../../_shared/shell-quote.js';
import { isDecimalInteger, isShellIdentifier } from './names.js';
import { assignArray, assignVariable } from './variables.js';
import { DEFAULT_HOME } from '../../../constants.js';
import { ExitSignal } from './interpreter.js';
import { lex } from './lexer.js';
import { TokenKind } from './types.js';
import { resolveJobSpec } from './jobs.js';
import { evaluateTest } from './test-builtin.js';
import { isVfsError, strerror } from '../../../vfs/vfs-error.js';
import { statOrThrow } from '../../../vfs/vfs.js';
import { runKill } from '../commands/system/kill.js';
const BUILTINS = {
    cd: builtinCd,
    pwd: builtinPwd,
    echo: builtinEcho,
    clear: builtinClear,
    export: builtinExport,
    exit: builtinExit,
    true: async () => 0,
    false: async () => 1,
    ':': async () => 0,
    set: builtinSet,
    shift: builtinShift,
    trap: builtinTrap,
    hash: builtinHash,
    readonly: builtinReadonly,
    read: builtinRead,
    wait: builtinWait,
    kill: ({ args, stdout, stderr, state, host }) => runKill({ args, stdout, stderr }, host.processRegistry, state.jobTable.list(), host.hostProcessSignals()),
    unset: builtinUnset,
    local: (call) => builtinDeclare('local', call),
    declare: (call) => builtinDeclare('declare', call),
    typeset: (call) => builtinDeclare('typeset', call),
    jobs: builtinJobs,
    fg: builtinFg,
    bg: builtinBg,
    history: builtinHistory,
    source: builtinSource,
    '.': builtinSource,
    alias: builtinAlias,
    unalias: builtinUnalias,
    test: ({ args, stderr, context }) => evaluateTest(args, context.vfs, stderr, context),
    '[': ({ args, stderr, context }) => evaluateTest(args, context.vfs, stderr, context, true),
};
/** The shell's builtins, by name, over `host`. */
export function shellBuiltins(host) {
    const builtins = new Map();
    for (const [name, builtin] of Object.entries(BUILTINS)) {
        builtins.set(name, (args, stdout, stderr, stdin, context) => builtin({ args, stdout, stderr, stdin, context, state: context.shell, host }));
    }
    return builtins;
}
async function builtinCd({ args, stderr, state, host }) {
    const target = args[0] ?? state.env['HOME'] ?? DEFAULT_HOME;
    let newPath;
    if (target === '-') {
        newPath = state.env['OLDPWD'] ?? state.getCwd();
    }
    else if (target === '~' || target.startsWith('~/')) {
        const home = state.env['HOME'] ?? DEFAULT_HOME;
        newPath = target === '~' ? home : resolve(home, target.slice(2));
    }
    else {
        newPath = resolve(state.getCwd(), target);
    }
    try {
        const stat = (await statOrThrow(host.vfs(), newPath));
        if (stat.type !== 'directory') {
            (await stderr.write(`cd: ${target}: Not a directory\n`));
            return 1;
        }
        state.env['OLDPWD'] = state.getCwd();
        state.setCwd(newPath);
        return 0;
    }
    catch (e) {
        if (isVfsError(e)) {
            (await stderr.write(`cd: ${target}: ${strerror(e)}\n`));
            return 1;
        }
        throw e;
    }
}
async function builtinPwd({ stdout, state }) {
    (await stdout.write(state.getCwd() + '\n'));
    return 0;
}
async function builtinEcho({ args, stdout }) {
    (await stdout.write(echoOutput(args)));
    return 0;
}
async function builtinClear({ host }) {
    host.clearTerminal();
    return 0;
}
async function builtinExport({ args, stderr, state }) {
    let exitCode = 0;
    for (const arg of args) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx !== -1) {
            const key = arg.slice(0, eqIdx);
            const value = arg.slice(eqIdx + 1);
            if (!(await assignEnv(state, key, value, stderr)))
                exitCode = 1;
        }
    }
    return exitCode;
}
async function builtinSet({ args, stdout, stderr, state, context }) {
    if (args.length === 0) {
        for (const key of Object.keys(state.env).sort()) {
            (await stdout.write(`${key}=${quoteSetValue(state.env[key] ?? '')}\n`));
        }
        return 0;
    }
    let positionalsStart = -1;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            positionalsStart = i + 1;
            break;
        }
        if (arg === '-') {
            continue;
        }
        if (arg === '-o' || arg === '+o') {
            const option = args[i + 1];
            if (!option) {
                (await printShellOptions(state, stdout));
                return 0;
            }
            if (!setShellOptionByName(state, option, arg[0] === '-')) {
                (await stderr.write(`set: ${option}: invalid option name\n`));
                return 2;
            }
            i++;
            continue;
        }
        if (isSetOptionCluster(arg)) {
            const enabled = arg[0] === '-';
            for (let j = 1; j < arg.length; j++) {
                const flag = arg[j];
                if (flag === 'o') {
                    const option = j === arg.length - 1 ? args[i + 1] : arg.slice(j + 1);
                    if (!option) {
                        (await printShellOptions(state, stdout));
                        return 0;
                    }
                    if (!setShellOptionByName(state, option, enabled)) {
                        (await stderr.write(`set: ${option}: invalid option name\n`));
                        return 2;
                    }
                    if (j === arg.length - 1)
                        i++;
                    break;
                }
                if (!setShellOptionByFlag(state, flag, enabled)) {
                    (await stderr.write(`set: -${flag}: invalid option\n`));
                    return 2;
                }
            }
            continue;
        }
        positionalsStart = i;
        break;
    }
    if (positionalsStart >= 0) {
        context.setPositionals(args.slice(positionalsStart));
    }
    return 0;
}
async function builtinShift({ args, stderr, context }) {
    if (args.length > 1) {
        (await stderr.write('shift: too many arguments\n'));
        return 1;
    }
    const raw = args[0] ?? '1';
    if (!isDecimalInteger(raw)) {
        (await stderr.write(`shift: ${raw}: numeric argument required\n`));
        return 1;
    }
    const count = Number.parseInt(raw, 10);
    const positionals = [...context.getPositionals()];
    if (count > positionals.length) {
        (await stderr.write('shift: shift count out of range\n'));
        return 1;
    }
    context.setPositionals(positionals.slice(count));
    return 0;
}
async function builtinTrap({ args, stdout, stderr, state }) {
    if (args.length === 0) {
        for (const [signal, action] of state.traps.entries()) {
            (await stdout.write(`trap -- ${quoteSetValue(action)} ${signal}\n`));
        }
        return 0;
    }
    let index = 0;
    if (args[index] === '--')
        index++;
    const action = args[index];
    if (action === undefined) {
        (await stderr.write('trap: missing action\n'));
        return 2;
    }
    index++;
    if (index >= args.length) {
        (await stderr.write('trap: missing signal\n'));
        return 2;
    }
    for (; index < args.length; index++) {
        const signal = normalizeTrapSignal(args[index]);
        if (!signal) {
            (await stderr.write(`trap: ${args[index]}: invalid signal\n`));
            return 2;
        }
        if (action === '-')
            state.traps.delete(signal);
        else
            state.traps.set(signal, action);
    }
    return 0;
}
async function builtinHash({ args, stdout, stderr, state, host }) {
    if (args.length === 0 || (args.length === 1 && args[0] === '-r'))
        return 0;
    let exitCode = 0;
    for (const arg of args) {
        if (arg.startsWith('-')) {
            (await stderr.write(`hash: ${arg}: invalid option\n`));
            exitCode = 2;
            continue;
        }
        const command = await host.registry.resolve(arg, resolveContext(state.getCwd(), state.env, host.vfs()));
        if (!command) {
            (await stderr.write(`hash: ${arg}: not found\n`));
            exitCode = 1;
        }
        else {
            (await stdout.write(`${arg}\n`));
        }
    }
    return exitCode;
}
async function printShellOptions(state, stdout) {
    (await stdout.write(`errexit         ${state.options.errexit ? 'on' : 'off'}\n`));
    (await stdout.write(`nounset         ${state.options.nounset ? 'on' : 'off'}\n`));
    (await stdout.write(`pipefail        ${state.options.pipefail ? 'on' : 'off'}\n`));
}
function setShellOptionByName(state, option, enabled) {
    switch (option) {
        case 'errexit':
            state.options.errexit = enabled;
            return true;
        case 'nounset':
            state.options.nounset = enabled;
            return true;
        case 'pipefail':
            state.options.pipefail = enabled;
            return true;
        default:
            return false;
    }
}
function setShellOptionByFlag(state, flag, enabled) {
    switch (flag) {
        case 'e':
            state.options.errexit = enabled;
            return true;
        case 'u':
            state.options.nounset = enabled;
            return true;
        default:
            return false;
    }
}
async function builtinReadonly({ args, stdout, stderr, state }) {
    if (args.length === 0 || (args.length === 1 && args[0] === '-p')) {
        for (const name of Array.from(state.readonlyNames).sort()) {
            const value = state.env[name];
            (await stdout.write(value === undefined
                ? `readonly ${name}\n`
                : `readonly ${name}=${quoteSetValue(value)}\n`));
        }
        return 0;
    }
    let exitCode = 0;
    for (const arg of args) {
        if (arg.startsWith('-')) {
            (await stderr.write(`readonly: ${arg}: invalid option\n`));
            exitCode = 2;
            continue;
        }
        const eqIdx = arg.indexOf('=');
        if (eqIdx > 0) {
            const name = arg.slice(0, eqIdx);
            if (!isShellIdentifier(name)) {
                (await stderr.write(`readonly: ${name}: not a valid identifier\n`));
                exitCode = 1;
                continue;
            }
            if ((await assignEnv(state, name, arg.slice(eqIdx + 1), stderr))) {
                state.readonlyNames.add(name);
            }
            else {
                exitCode = 1;
            }
            continue;
        }
        if (!isShellIdentifier(arg)) {
            (await stderr.write(`readonly: ${arg}: not a valid identifier\n`));
            exitCode = 1;
            continue;
        }
        state.readonlyNames.add(arg);
    }
    return exitCode;
}
async function builtinRead({ args, stdin, stderr, state, context }) {
    const options = parseReadArgs(args);
    if (!options.ok) {
        (await stderr.write(`read: ${options.error}\n`));
        return 1;
    }
    if (options.prompt && context.isFdTerminal(0)) {
        (await stderr.write(options.prompt));
    }
    const line = await readLineStdin(stdin);
    if (line === null) {
        // EOF: bash clears every named variable before returning non-zero.
        for (const name of options.names) {
            if (!(await assignEnv(state, name, '', stderr)))
                return 1;
        }
        return 1;
    }
    const assignments = splitReadAssignments(line, options.names);
    for (const [name, value] of assignments) {
        if (!(await assignEnv(state, name, value, stderr)))
            return 1;
    }
    return 0;
}
async function builtinWait({ args, stderr, state, host }) {
    if (args[0] === '--')
        args = args.slice(1);
    if (args.length === 0) {
        const jobs = state.jobTable.list();
        await Promise.all(jobs.map((job) => job.promise.catch(() => undefined)));
        for (const job of jobs)
            state.jobTable.remove(job.id);
        state.jobTable.clearWaited();
        return 0;
    }
    let last = 0;
    for (const arg of args) {
        const byJob = arg.startsWith('%');
        if (!byJob && !/^\d+$/.test(arg)) {
            await stderr.write(`wait: \`${arg}': not a pid or valid job spec\n`);
            last = 1;
            continue;
        }
        const job = byJob ? state.jobTable.waitTarget(arg) : state.jobTable.byPid(Number(arg));
        if (job === 'ambiguous') {
            await stderr.write(`wait: ${arg.slice(1)}: ambiguous job spec\n`);
            last = 127;
            continue;
        }
        const promise = job?.promise ?? (byJob ? undefined : host.processRegistry.get(Number(arg))?.promise);
        if (!promise) {
            await stderr.write(byJob ? `wait: ${arg}: no such job\n` : `wait: pid ${arg} is not a child of this shell\n`);
            last = 127;
            continue;
        }
        try {
            last = await promise;
        }
        catch {
            last = 1;
        }
        if (job)
            state.jobTable.reap(job);
    }
    return last;
}
/**
 * `unset [-f] [-v] [-n] [name ...]`, as bash: -f removes functions, -v
 * (and -n, as this shell has no namerefs) variables, and with neither a
 * name is a variable, or a function when no variable has that name.
 */
async function builtinUnset({ args, stderr, state, context }) {
    let functions = false;
    let variables = false;
    let first = 0;
    for (; first < args.length && args[first].startsWith('-') && args[first] !== '-'; first++) {
        if (args[first] === '--') {
            first++;
            break;
        }
        for (const flag of args[first].slice(1)) {
            if (flag === 'f')
                functions = true;
            else if (flag === 'v' || flag === 'n')
                variables = true;
            else {
                (await stderr.write(`unset: -${flag}: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]\n`));
                return 2;
            }
        }
    }
    if (functions && variables) {
        (await stderr.write('unset: cannot simultaneously unset a function and a variable\n'));
        return 1;
    }
    let exitCode = 0;
    for (const arg of args.slice(first)) {
        if (functions) {
            context.unsetFunction(arg);
            continue;
        }
        if (!variables && !Object.hasOwn(state.env, arg) && !state.arrays.has(arg) && context.unsetFunction(arg))
            continue;
        // `unset arr[2]` clears one element; `unset arr` removes the variable.
        const element = /^([a-zA-Z_][a-zA-Z0-9_]*)\[([^\]]*)\]$/.exec(arg);
        const name = element === null ? arg : element[1];
        if (!isShellIdentifier(name))
            continue;
        if (state.readonlyNames.has(name)) {
            (await stderr.write(`${name}: readonly variable\n`));
            exitCode = 1;
            continue;
        }
        if (element === null) {
            delete state.env[name];
            state.arrays.delete(name);
            continue;
        }
        const array = state.arrays.get(name);
        if (array === undefined)
            continue;
        const index = Number.parseInt(element[2], 10);
        if (Number.isNaN(index))
            continue;
        delete array[index < 0 ? array.length + index : index];
    }
    return exitCode;
}
/**
 * `local name`, `local name=value`, `local name=(word …)` and the `declare` /
 * `typeset` spellings. `local` binds each name to the running function, so
 * the value it had outside comes back when the function returns; `declare`
 * only does so when it is itself inside a function, matching bash.
 *
 * Attribute flags (-a -A -i -r -x -g) are accepted. Only -r has an effect —
 * the rest describe types this shell does not distinguish.
 */
async function builtinDeclare(verb, { args, stderr, state, context }) {
    let readonlyFlag = false;
    let global = false;
    let exitCode = 0;
    for (const arg of args) {
        if (arg.startsWith('-') && arg.length > 1 && !arg.includes('=')) {
            for (const flag of arg.slice(1)) {
                if (flag === 'r')
                    readonlyFlag = true;
                else if (flag === 'g')
                    global = true;
                else if (!'aAixlunft'.includes(flag)) {
                    (await stderr.write(`${verb}: -${flag}: invalid option\n`));
                    return 2;
                }
            }
            continue;
        }
        const eq = arg.indexOf('=');
        const name = eq === -1 ? arg : arg.slice(0, eq);
        if (!isShellIdentifier(name)) {
            (await stderr.write(`${verb}: \`${arg}': not a valid identifier\n`));
            exitCode = 1;
            continue;
        }
        const scope = verb === 'local' || !global;
        if (scope && context.declareLocal(name) !== true && verb === 'local') {
            (await stderr.write(`${verb}: can only be used in a function\n`));
            return 1;
        }
        if (eq !== -1 && !(await assignDeclared(state, name, arg.slice(eq + 1), stderr)))
            exitCode = 1;
        if (readonlyFlag)
            state.readonlyNames.add(name);
    }
    return exitCode;
}
/** The right-hand side of a declaration: `(word …)` is an array literal. */
async function assignDeclared(state, name, text, stderr) {
    if (state.readonlyNames.has(name)) {
        (await stderr.write(`${name}: readonly variable\n`));
        return false;
    }
    if (text.startsWith('(') && text.endsWith(')')) {
        const elements = [];
        for (const token of lex(text.slice(1, -1))) {
            if (token.kind === TokenKind.Word)
                elements.push(unquoteWord(token));
        }
        return assignArray(state, name, elements);
    }
    return assignVariable(state, name, text);
}
async function assignEnv(state, name, value, stderr) {
    if (assignVariable(state, name, value))
        return true;
    (await stderr.write(`${name}: readonly variable\n`));
    return false;
}
async function builtinExit({ args, stderr, context }) {
    if (args.length > 1) {
        (await stderr.write('exit: too many arguments\n'));
        return 1;
    }
    if (args.length === 0) {
        throw new ExitSignal(context.getLastExitCode());
    }
    const status = parseShellExitStatus(args[0] ?? '');
    if (status === null) {
        (await stderr.write(`exit: ${args[0]}: numeric argument required\n`));
        throw new ExitSignal(2);
    }
    throw new ExitSignal(status);
}
async function builtinJobs({ args, stdout, stderr, state }) {
    const jobs = state.jobTable.list();
    let format = '';
    let filter = '';
    let index = 0;
    for (; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--') {
            index++;
            break;
        }
        if (!arg.startsWith('-'))
            break;
        for (const flag of arg.slice(1)) {
            if (flag === 'l' || flag === 'p')
                format = flag;
            else if (flag === 'r' || flag === 's')
                filter = flag;
            else {
                await stderr.write(`jobs: -${flag}: invalid option\n`);
                return 2;
            }
        }
    }
    const current = resolveJobSpec('%+', jobs);
    const previous = resolveJobSpec('%-', jobs);
    let status = 0;
    const selected = index === args.length ? jobs : args.slice(index).map((arg) => resolveJobSpec(arg, jobs));
    for (let n = 0; n < selected.length; n++) {
        const job = selected[n];
        if (!job || job === 'ambiguous') {
            const spec = args[index + n];
            await stderr.write(`jobs: ${spec}: ${job === 'ambiguous' ? 'ambiguous job spec' : 'no such job'}\n`);
            status = 1;
            continue;
        }
        if (filter === 'r' && job.status !== 'running' || filter === 's' && job.status !== 'stopped')
            continue;
        if (format === 'p')
            await stdout.write(`${job.pid}\n`);
        else {
            const marker = job === current ? '+' : job === previous ? '-' : ' ';
            const state = job.status === 'running' ? 'Running' : job.status === 'stopped' ? 'Stopped'
                : job.exitCode === 0 ? 'Done' : job.exitCode === 143 ? 'Terminated' : job.exitCode === 137 ? 'Killed' : `Exit ${job.exitCode}`;
            await stdout.write(`[${job.id}]${marker} ${format === 'l' ? `${job.pid} ` : ' '}${state.padEnd(27)}${job.command}${job.status === 'running' ? ' &' : ''}\n`);
        }
        if (job.status === 'done')
            state.jobTable.remove(job.id);
    }
    return status;
}
async function builtinFg({ args, stdout, stderr, state, host, context }) {
    if (!context.interactive) {
        await stderr.write('fg: no job control\n');
        return 1;
    }
    const jobs = state.jobTable.list();
    if (jobs.length === 0) {
        await stderr.write('fg: no current job\n');
        return 1;
    }
    const spec = args[0] ?? '%+';
    const job = resolveJobSpec(spec, jobs);
    if (!job || job === 'ambiguous') {
        await stderr.write(`fg: ${spec}: ${job === 'ambiguous' ? 'ambiguous job spec' : 'no such job'}\n`);
        return 1;
    }
    await stdout.write(`${job.command}\n`);
    if (host.processRegistry.get(job.pid)?.status === 'stopped')
        host.processRegistry.kill(job.pid, 'CONT');
    const exitCode = await job.promise;
    state.jobTable.reap(job);
    return exitCode;
}
async function builtinBg({ args, stdout, stderr, state, host, context }) {
    if (!context.interactive) {
        await stderr.write('bg: no job control\n');
        return 1;
    }
    const jobs = state.jobTable.list();
    if (jobs.length === 0) {
        await stderr.write('bg: no current job\n');
        return 1;
    }
    const spec = args[0] ?? '%+';
    const job = resolveJobSpec(spec, jobs);
    if (!job || job === 'ambiguous') {
        await stderr.write(`bg: ${spec}: ${job === 'ambiguous' ? 'ambiguous job spec' : 'no such job'}\n`);
        return 1;
    }
    host.processRegistry.kill(job.pid, 'CONT');
    await stdout.write(`[${job.id}]+ ${job.command} &\n`);
    return 0;
}
async function builtinHistory({ stdout, host }) {
    const entries = host.history();
    for (let i = 0; i < entries.length; i++) {
        (await stdout.write(`  ${i + 1}  ${entries[i]}\n`));
    }
    return 0;
}
async function builtinSource({ args, stderr, state, host, context }) {
    if (args.length === 0) {
        (await stderr.write('source: missing filename\n'));
        return 1;
    }
    const path = resolve(state.getCwd(), args[0]);
    let content;
    try {
        content = (await host.vfs().readFileString(path));
    }
    catch {
        (await stderr.write(`source: ${args[0]}: No such file\n`));
        return 1;
    }
    const sourceArgs = args.slice(1);
    return (await context.executeInline(content, sourceArgs.length > 0 ? { positionals: sourceArgs } : undefined));
}
async function builtinAlias({ args, stdout, state }) {
    if (args.length === 0) {
        for (const [name, value] of state.aliases) {
            (await stdout.write(`alias ${name}='${value}'\n`));
        }
        return 0;
    }
    for (const arg of args) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx !== -1) {
            const name = arg.slice(0, eqIdx);
            const value = arg.slice(eqIdx + 1);
            state.aliases.set(name, value);
        }
        else {
            const value = state.aliases.get(arg);
            if (value !== undefined) {
                (await stdout.write(`alias ${arg}='${value}'\n`));
            }
            else {
                (await stdout.write(`alias: ${arg}: not found\n`));
            }
        }
    }
    return 0;
}
async function builtinUnalias({ args, stderr, state }) {
    if (args.length === 0) {
        (await stderr.write('unalias: usage: unalias name ...\n'));
        return 1;
    }
    for (const name of args) {
        if (!state.aliases.delete(name)) {
            (await stderr.write(`unalias: ${name}: not found\n`));
        }
    }
    return 0;
}
function parseReadArgs(args) {
    const names = [];
    let prompt;
    let parsingOptions = true;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (parsingOptions && arg === '--') {
            parsingOptions = false;
            continue;
        }
        if (parsingOptions && arg.startsWith('-') && arg !== '-') {
            if (arg === '-r')
                continue;
            if (arg === '-p' || arg === '-rp' || arg === '-pr') {
                const next = args[++i];
                if (next === undefined)
                    return { ok: false, error: `${arg}: option requires an argument` };
                prompt = next;
                continue;
            }
            if (arg.startsWith('-p') && arg.length > 2) {
                prompt = arg.slice(2);
                continue;
            }
            return { ok: false, error: `${arg}: unsupported option` };
        }
        parsingOptions = false;
        names.push(arg);
    }
    const resolvedNames = names.length > 0 ? names : ['REPLY'];
    for (const name of resolvedNames) {
        if (!isShellIdentifier(name))
            return { ok: false, error: `${name}: not a valid identifier` };
    }
    return prompt === undefined
        ? { ok: true, names: resolvedNames }
        : { ok: true, names: resolvedNames, prompt };
}
async function readLineStdin(stdin) {
    if (!stdin)
        return null;
    if (stdin.readLine)
        return (await stdin.readLine());
    let line = '';
    let readChunk = false;
    while (true) {
        const chunk = await stdin.read();
        if (chunk === null)
            break;
        readChunk = true;
        const newline = chunk.indexOf('\n');
        if (newline >= 0)
            return line + chunk.slice(0, newline);
        line += chunk;
    }
    if (readChunk)
        return line;
    const content = await stdin.readAll();
    if (content.length === 0)
        return null;
    const newline = content.indexOf('\n');
    return newline >= 0 ? content.slice(0, newline) : content;
}
function splitReadAssignments(line, names) {
    if (names.length === 1)
        return [[names[0], line]];
    const fields = splitWhitespaceFields(line);
    const assignments = [];
    for (let i = 0; i < names.length; i++) {
        if (i === names.length - 1) {
            assignments.push([names[i], fields.slice(i).join(' ')]);
        }
        else {
            assignments.push([names[i], fields[i] ?? '']);
        }
    }
    return assignments;
}
function splitWhitespaceFields(line) {
    const fields = [];
    let current = '';
    for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        const whitespace = code === 32 || code === 9;
        if (whitespace) {
            if (current.length > 0) {
                fields.push(current);
                current = '';
            }
        }
        else {
            current += line[i];
        }
    }
    if (current.length > 0)
        fields.push(current);
    return fields;
}
/** A lexed word's text with its quoting removed, the way expansion leaves it. */
function unquoteWord(token) {
    return token.parts === undefined ? token.value : token.parts.map((p) => p.text).join('');
}
function isSetOptionCluster(arg) {
    if (arg.length < 2)
        return false;
    if (arg[0] !== '-' && arg[0] !== '+')
        return false;
    return arg !== '--' && arg !== '++';
}
function normalizeTrapSignal(raw) {
    const signal = raw.toUpperCase();
    if (signal === '0' || signal === 'EXIT')
        return 'EXIT';
    if (signal.startsWith('SIG') && signal.length > 3)
        return signal.slice(3);
    if (isShellIdentifier(signal))
        return signal;
    return null;
}
function quoteSetValue(value) {
    return value.length > 0 && isPlainSetValue(value) ? value : singleQuote(value);
}
function isPlainSetValue(value) {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        const ok = (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            code === 95 ||
            code === 45 ||
            code === 46 ||
            code === 47 ||
            code === 58;
        if (!ok)
            return false;
    }
    return true;
}
function parseShellExitStatus(raw) {
    if (raw.length === 0)
        return null;
    const sign = raw[0] === '-' ? -1n : 1n;
    const digits = raw[0] === '-' || raw[0] === '+' ? raw.slice(1) : raw;
    if (!isDecimalInteger(digits))
        return null;
    const value = BigInt(digits) * sign;
    const normalized = ((value % 256n) + 256n) % 256n;
    return Number(normalized);
}
