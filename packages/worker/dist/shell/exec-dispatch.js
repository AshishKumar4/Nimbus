/**
 * exec-dispatch — POSIX execve semantics for path-shaped shell invocations
 * (`./x`, `/abs/x`, `../x`). Pure decision logic; the resolve-hook in
 * session/init.ts turns decisions into commands (wasm-runner, shebang
 * interpreter, sh fallback, or an error writer).
 *
 * Decision ladder (mirrors execve + the shell's ENOEXEC fallback):
 *   1. no exec bit → EACCES ("permission denied"), with one grandfather
 *      exception: wasm-magic files whose stored mode was never explicitly
 *      set stay executable (see below).
 *   2. `\0asm` magic → run via wasm-runner (the platform's native format).
 *   3. `#!` line → run via the named interpreter.
 *   4. binary-looking content (NUL byte in the head) → ENOEXEC surfaced as
 *      an honest "exec format not supported" error (ELF and friends).
 *   5. anything else → run as a shell script (POSIX ENOEXEC sh fallback).
 *
 * Grandfather rule (WASI-PLAN Stage 1): before Stage 1, chmod was a no-op,
 * so no stored mode was ever explicitly chosen by a user — wasm binaries
 * auto-ran on magic alone. Explicitly-set modes are stamped with POSIX
 * S_IF* filetype bits (SqliteVFS.chmod); bare permission values mean "mode
 * metadata was never set", and wasm-magic files with such modes stay
 * executable until touched. No migration.
 */
import { normalizeVfsPath, resolveVfsPath } from '../vfs/path.js';
/** Bytes of head to inspect: covers magic + the longest useful `#!` line. */
export const EXEC_HEAD_BYTES = 512;
export function isWasmMagic(head) {
    return head.length >= 4
        && head[0] === 0x00 && head[1] === 0x61
        && head[2] === 0x73 && head[3] === 0x6d;
}
export function isExecutableMode(mode, wasmMagic) {
    if ((mode & 0o111) !== 0)
        return true;
    return wasmMagic && (mode & 0o170000) === 0;
}
/**
 * Parse a `#!interp [args...]` first line. `#!/usr/bin/env X [args]`
 * resolves to interpreter X (env's `-S`/`--split-string` is transparent —
 * both forms word-split here anyway).
 */
export function parseShebang(head) {
    if (head.length < 3 || head[0] !== 0x23 || head[1] !== 0x21)
        return null;
    const nl = head.indexOf(0x0a);
    const lineBytes = head.subarray(2, nl === -1 ? head.length : nl);
    const line = new TextDecoder().decode(lineBytes).replace(/\r$/, '');
    const words = line.trim().split(/[ \t]+/).filter(Boolean);
    if (words.length === 0)
        return null;
    let interpreter = words[0];
    let args = words.slice(1);
    if (basename(interpreter) === 'env') {
        while (args[0] === '-S' || args[0] === '--split-string')
            args = args.slice(1);
        if (args.length === 0)
            return null;
        interpreter = args[0];
        args = args.slice(1);
    }
    return { interpreter, args };
}
export function basename(path) {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}
export function decideExecDispatch(mode, head) {
    const wasm = isWasmMagic(head);
    if (!isExecutableMode(mode, wasm))
        return { kind: 'denied' };
    if (wasm)
        return { kind: 'wasm' };
    const shebang = parseShebang(head);
    if (shebang)
        return { kind: 'shebang', shebang };
    if (head.includes(0))
        return { kind: 'exec-format-error' };
    return { kind: 'shell-script' };
}
export function installPathExecResolver(registry, kernelFs, getCwd) {
    const originalResolve = registry.resolve.bind(registry);
    registry.resolve = async (name) => {
        const found = await originalResolve(name);
        if (found)
            return found;
        if (!name || (!name.startsWith('./') && !name.startsWith('/') && !name.startsWith('../'))) {
            return undefined;
        }
        const resolved = resolveVfsPath(name, normalizeVfsPath(getCwd()));
        if (!kernelFs.exists(resolved))
            return undefined;
        if (kernelFs.isDirectory(resolved)) {
            return async (ctx) => {
                ctx.stderr.write(`${name}: Is a directory\n`);
                return 126;
            };
        }
        const target = kernelFs.isSymlink(resolved) ? kernelFs.resolveSymlink(resolved) : resolved;
        if (!target || !kernelFs.exists(target) || kernelFs.isDirectory(target))
            return undefined;
        let mode;
        let head;
        try {
            mode = kernelFs.stat(target).mode;
            head = kernelFs.readRange(target, 0, EXEC_HEAD_BYTES);
        }
        catch {
            return undefined;
        }
        const accessPath = '/' + resolved;
        const absPath = '/' + target;
        const authorize = (command) => async (ctx) => {
            try {
                ctx.vfs.access(accessPath, 0o1);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.startsWith('ENOENT:')) {
                    ctx.stderr.write(`${name}: No such file or directory\n`);
                    return 127;
                }
                if (message.startsWith('EACCES:') || message.startsWith('EPERM:')) {
                    ctx.stderr.write(`${name}: Permission denied\n`);
                    return 126;
                }
                ctx.stderr.write(`${name}: ${message}\n`);
                return 126;
            }
            return command(ctx);
        };
        const decision = decideExecDispatch(mode, head);
        switch (decision.kind) {
            case 'denied':
                return authorize(async (ctx) => {
                    ctx.stderr.write(`${name}: Permission denied\n`);
                    return 126;
                });
            case 'exec-format-error':
                return authorize(async (ctx) => {
                    ctx.stderr.write(`${name}: cannot execute binary file: exec format not supported on Nimbus (wasm32-wasi only)\n`);
                    return 126;
                });
            case 'wasm': {
                const wasmRunnerCmd = await originalResolve('wasm-runner');
                if (!wasmRunnerCmd)
                    return undefined;
                return authorize(async (ctx) => {
                    return await wasmRunnerCmd({ ...ctx, args: [absPath, ...ctx.args] });
                });
            }
            case 'shebang':
            case 'shell-script': {
                const interp = decision.kind === 'shebang' ? decision.shebang.interpreter : 'sh';
                const interpArgs = decision.kind === 'shebang' ? decision.shebang.args : [];
                return authorize(async (ctx) => {
                    const depth = interpreterDepth(ctx);
                    if (depth >= 4) {
                        ctx.stderr.write(`${name}: too many levels of interpreters\n`);
                        return 126;
                    }
                    let interpCmd = await registry.resolve(interp);
                    if (!interpCmd && interp.includes('/')) {
                        interpCmd = await registry.resolve(basename(interp));
                    }
                    if (!interpCmd) {
                        ctx.stderr.write(`${name}: ${interp}: bad interpreter: No such file or directory\n`);
                        return 127;
                    }
                    return await interpCmd({
                        ...ctx,
                        args: [...interpArgs, absPath, ...ctx.args],
                        execInterpreterDepth: depth + 1,
                    });
                });
            }
        }
    };
}
function interpreterDepth(ctx) {
    return ctx.execInterpreterDepth ?? 0;
}
