import { normalizeVfsPath } from '../vfs/path.js';
import { ESBUILD_CLI_BODY_SRC } from './esbuild-cli.generated.js';
/**
 * Go's wasm_exec.js and the runner, as one script. Evaluated in the isolate
 * that hosts esbuild, it installs `globalThis.__esbuildCliRun(args,
 * supervisor, output, module)`.
 */
export const ESBUILD_CLI_PREAMBLE = ESBUILD_CLI_BODY_SRC;
// The environment esbuild reads; esbuild-wasm's own launcher passes exactly these.
const ESBUILD_ENV = ['NO_COLOR', 'NODE_PATH', 'npm_config_user_agent', 'WT_SESSION'];
async function readStdin(stdin) {
    if (!stdin.readBytes)
        return new TextEncoder().encode(await stdin.readAll());
    const chunks = [];
    let length = 0;
    for (let chunk = await stdin.readBytes(65536); chunk !== null; chunk = await stdin.readBytes(65536)) {
        chunks.push(chunk);
        length += chunk.length;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}
async function emit(stream, bytes) {
    if (bytes.length === 0)
        return;
    if (stream.writeBytes)
        await stream.writeBytes(bytes);
    else
        await stream.write(new TextDecoder().decode(bytes));
}
export function makeEsbuildCommand(deps) {
    return async function esbuild(ctx) {
        const argv = ctx.args ?? [];
        const persistent = argv.find((arg) => /^--(watch|serve)(=|$)/.test(arg));
        if (persistent) {
            ctx.stderr.write(`esbuild: ${persistent.split('=')[0]} is not supported: each esbuild command runs one build and exits\n`);
            return 1;
        }
        const stdinIsTerminal = ctx.isFdTerminal?.(0) ?? ctx.stdin === undefined;
        // esbuild reads stdin only when it has no entry point; a bare `esbuild`
        // at a terminal prints its help, which the facet cannot tell it to do.
        const runArgv = argv.length === 0 && stdinIsTerminal ? ['--help'] : [...argv];
        const readsStdin = !argv.some((arg) => !arg.startsWith('-'));
        const stdin = readsStdin && !stdinIsTerminal && ctx.stdin ? await readStdin(ctx.stdin) : null;
        if ((ctx.isFdTerminal?.(2) ?? false) && !argv.some((arg) => /^--color(=|$)/.test(arg)))
            runArgv.push('--color=true');
        const env = {};
        for (const key of ESBUILD_ENV) {
            const value = ctx.env[key];
            if (value !== undefined)
                env[key] = value;
        }
        const args = {
            argv: runArgv,
            cwd: `/${normalizeVfsPath(ctx.cwd || '/')}`,
            env,
            uid: ctx.cred.uid,
            gid: ctx.cred.gid,
            groups: [...ctx.cred.groups],
            umask: ctx.cred.umask,
            stdin,
        };
        try {
            return await deps.run(args, ctx, (fd, bytes) => emit(fd === 1 ? ctx.stdout : ctx.stderr, bytes));
        }
        catch (error) {
            ctx.stderr.write(`esbuild: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    };
}
