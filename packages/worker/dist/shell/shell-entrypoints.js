import { resolveVfsPath } from '../vfs/path.js';
import { parseShellInvocation } from './shell-invocation.js';
const SHELL_ALIASES = {
    sh: ['sh', '/bin/sh', '/usr/bin/sh'],
    bash: ['bash', '/bin/bash', '/usr/bin/bash'],
};
export function registerShellEntrypointCommands(registry, shell, vfs) {
    const sh = makeShellEntrypoint('sh', shell, vfs);
    const bash = makeShellEntrypoint('bash', shell, vfs);
    for (const name of SHELL_ALIASES.sh)
        registry.register(name, sh);
    for (const name of SHELL_ALIASES.bash)
        registry.register(name, bash);
}
function makeShellEntrypoint(shellName, shell, vfs) {
    return async (ctx) => {
        const argv = normalizeArgs(ctx.args);
        if (argv.includes('--version')) {
            ctx.stdout.write(shellName === 'bash'
                ? 'Nimbus bash-compatible shell engine\n'
                : 'Nimbus POSIX sh-compatible shell engine\n');
            return 0;
        }
        if (argv.includes('--help')) {
            ctx.stdout.write(`usage: ${shellName} [-c command] [script]\n`);
            ctx.stdout.write('Executes commands through the Nimbus shell engine with VFS-backed stdin and scripts.\n');
            return 0;
        }
        const program = await parseShellProgram(shellName, ctx, ctx.vfs);
        if ('error' in program) {
            if (program.error)
                ctx.stderr.write(program.error + '\n');
            return program.exitCode;
        }
        let forwardedStdout = '';
        let forwardedStderr = '';
        const inheritedStdin = await resolveInheritedStdin(shellName, program, ctx);
        if ('error' in inheritedStdin) {
            ctx.stderr.write(inheritedStdin.error + '\n');
            return inheritedStdin.exitCode;
        }
        const result = await shell.execute(program.body, {
            cwd: ctx.cwd || '/home/user',
            env: shellEnvWithPositionals(ctx.env, program.argv0, program.args),
            isolateShellState: true,
            shellOptions: program.options,
            scriptMode: true,
            stdin: inheritedStdin.stdin,
            terminalStdin: ctx.terminalStdin,
            onStdout: (data) => {
                forwardedStdout += data;
                ctx.stdout.write(data);
            },
            onStderr: (data) => {
                forwardedStderr += data;
                ctx.stderr.write(data);
            },
            runExitTrap: true,
            terminalFds: {
                stdin: ctx.isFdTerminal?.(0) ?? false,
                stdout: ctx.isFdTerminal?.(1) ?? false,
                stderr: ctx.isFdTerminal?.(2) ?? false,
            },
            commandContext: {
                pid: ctx.pid,
                cred: ctx.cred,
                setUmask: ctx.setUmask,
            },
            runAs: (_parent, cred, argv) => ctx.runAs(cred, argv),
        });
        writeUnforwarded(ctx.stdout, result.stdout, forwardedStdout);
        writeUnforwarded(ctx.stderr, result.stderr, forwardedStderr);
        return result.exitCode;
    };
}
async function resolveInheritedStdin(shellName, program, ctx) {
    if (program.kind === 'stdin')
        return { stdin: '' };
    if (ctx.isFdTerminal?.(0) !== false)
        return {};
    try {
        return { stdin: await readContextStdin(ctx.stdin) };
    }
    catch (e) {
        return { error: `${shellName}: failed to read stdin: ${formatError(e)}`, exitCode: 1 };
    }
}
async function parseShellProgram(shellName, ctx, vfs) {
    const parsed = parseShellInvocation(shellName, ctx.args);
    if (!parsed.ok) {
        if (parsed.exitCode !== 0)
            return { error: parsed.error, exitCode: parsed.exitCode };
        let stdin = '';
        try {
            stdin = await readContextStdin(ctx.stdin);
        }
        catch (e) {
            return { error: `${shellName}: failed to read stdin: ${formatError(e)}`, exitCode: 1 };
        }
        if (stdin.length > 0)
            return { kind: 'stdin', body: stdin, argv0: shellName, args: [], options: {} };
        return { error: parsed.error, exitCode: parsed.exitCode };
    }
    if (parsed.invocation.kind === 'command') {
        const { argv0, args } = commandPositionals(shellName, parsed.invocation.args);
        return {
            kind: 'command',
            body: parsed.invocation.body,
            argv0,
            args,
            options: parsed.invocation.options,
        };
    }
    if (parsed.invocation.kind === 'script') {
        return loadScript(shellName, parsed.invocation.path, parsed.invocation.args, parsed.invocation.options, ctx.cwd, vfs);
    }
    let stdin = '';
    try {
        stdin = await readContextStdin(ctx.stdin);
    }
    catch (e) {
        return { error: `${shellName}: failed to read stdin: ${formatError(e)}`, exitCode: 1 };
    }
    return { kind: 'stdin', body: stdin, argv0: shellName, args: parsed.invocation.args, options: parsed.invocation.options };
}
function loadScript(shellName, script, args, options, cwd, vfs) {
    const path = resolveVfsPath(script, cwd || '/home/user');
    if (!vfs.exists(path))
        return { error: `${shellName}: ${script}: No such file or directory`, exitCode: 127 };
    return { kind: 'script', path, body: vfs.readFileString(path), argv0: script, args, options };
}
async function readContextStdin(stdin) {
    if (typeof stdin === 'string')
        return stdin;
    if (!stdin || typeof stdin !== 'object')
        return '';
    if (hasReadAll(stdin)) {
        return stdinChunkToString(await stdin.readAll());
    }
    if (hasRead(stdin)) {
        const chunks = [];
        while (true) {
            const chunk = await stdin.read();
            if (chunk === null || chunk === undefined)
                break;
            chunks.push(stdinChunkToString(chunk));
        }
        return chunks.join('');
    }
    return '';
}
function commandPositionals(shellName, args) {
    const [argv0, ...positionals] = args;
    return { argv0: argv0 ?? shellName, args: positionals };
}
function shellEnvWithPositionals(baseEnv, argv0, args) {
    const env = { ...(baseEnv || {}) };
    for (const key of Object.keys(env)) {
        if (key === '@' || key === '#' || isPositionalKey(key))
            delete env[key];
    }
    env['0'] = argv0;
    env['#'] = String(args.length);
    env['@'] = args.join(' ');
    for (let i = 0; i < args.length; i++) {
        env[String(i + 1)] = args[i];
    }
    return env;
}
function isPositionalKey(key) {
    if (key.length === 0)
        return false;
    for (let i = 0; i < key.length; i++) {
        const code = key.charCodeAt(i);
        if (code < 48 || code > 57)
            return false;
    }
    return true;
}
function hasReadAll(value) {
    return 'readAll' in value && typeof value.readAll === 'function';
}
function hasRead(value) {
    return 'read' in value && typeof value.read === 'function';
}
function stdinChunkToString(chunk) {
    if (typeof chunk === 'string')
        return chunk;
    if (chunk instanceof Uint8Array)
        return new TextDecoder().decode(chunk);
    if (chunk instanceof ArrayBuffer)
        return new TextDecoder().decode(chunk);
    return String(chunk);
}
function normalizeArgs(args) {
    return Array.isArray(args) ? args.map(String) : [];
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function writeUnforwarded(output, returned, forwarded) {
    if (!returned)
        return;
    if (!forwarded) {
        output.write(returned);
        return;
    }
    if (returned.length > forwarded.length && returned.startsWith(forwarded)) {
        output.write(returned.slice(forwarded.length));
    }
}
