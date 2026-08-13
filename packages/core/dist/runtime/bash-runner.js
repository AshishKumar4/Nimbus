import { z } from 'zod';
import { BASH_RUNNER_BODY_SRC } from './bash-runner.generated.js';
import { flushVfsDiff, snapshotVfs } from './vfs-snapshot.js';
import { requireVfsCred } from './os-contracts.js';
import { resolveVfsPath } from '../vfs/path.js';
const BashSliceSchema = z.object({
    state: z.enum(['need-input', 'exited', 'error']),
    exitCode: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    error: z.string().optional(),
    fsDiff: z.custom().optional(),
    stats: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
function normalizeSlice(raw) {
    const parsed = BashSliceSchema.safeParse(raw);
    if (!parsed.success)
        return null;
    return {
        state: parsed.data.state,
        exitCode: Number(parsed.data.exitCode ?? 0),
        stdout: parsed.data.stdout || '',
        stderr: parsed.data.stderr || '',
        error: parsed.data.error,
        fsDiff: parsed.data.fsDiff,
        stats: parsed.data.stats,
    };
}
function toArrayBuffer(bytes) {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
async function bashFacetStep(args) {
    const boot = Reflect.get(globalThis, '__bashBoot');
    const feed = Reflect.get(globalThis, '__bashFeed');
    if (typeof boot !== 'function' || typeof feed !== 'function') {
        return {
            state: 'error',
            exitCode: 127,
            stdout: '',
            stderr: '',
            error: 'bash-runner preamble missing (__bashBoot/__bashFeed not in scope)',
        };
    }
    return args.op === 'boot' ? boot(args) : feed(args);
}
export async function createBashFacetSession(deps) {
    const findFile = (relativePath) => {
        const entry = deps.manifest.files.find((file) => file.path === relativePath);
        return entry ? `${deps.installRoot}/${entry.path}` : null;
    };
    const bashWasmPath = findFile('share/bash/bash.async.wasm');
    if (!bashWasmPath || !deps.vfs.exists(bashWasmPath)) {
        throw new Error("bash.async.wasm missing (re-run 'nimbus install bash')");
    }
    const userEnv = { ...deps.env };
    userEnv.HOME ||= '/home/user';
    userEnv.PATH ||= '/bin:/usr/bin';
    userEnv.TERM ||= 'dumb';
    userEnv.NIMBUS_PWD = deps.cwd;
    userEnv.BASH_ENV ||= '/etc/nimbus.bashrc';
    userEnv.PWD = deps.cwd;
    const extraRoots = [...(deps.extraRoots ?? [])];
    if (userEnv.HOME !== '/home/user')
        extraRoots.push(userEnv.HOME);
    const fsSnapshot = snapshotVfs(deps.vfs, deps.cwd, { extraRoots });
    if ('error' in fsSnapshot)
        throw new Error(fsSnapshot.error);
    const wasmModules = {
        'bash.async.wasm': toArrayBuffer(deps.vfs.readFile(bashWasmPath)),
    };
    for (const file of deps.manifest.files) {
        const prefix = 'share/bash/coreutils/';
        if (!file.path.startsWith(prefix) || !file.path.endsWith('.wasm'))
            continue;
        const name = file.path.slice(prefix.length, -'.wasm'.length);
        const vfsPath = `${deps.installRoot}/${file.path}`;
        if (deps.vfs.exists(vfsPath)) {
            wasmModules[`cu_${name}.wasm`] = toArrayBuffer(deps.vfs.readFile(vfsPath));
        }
    }
    const appletsPath = findFile('share/bash/coreutils/busybox.applets');
    const busyboxApplets = appletsPath && deps.vfs.exists(appletsPath)
        ? new TextDecoder().decode(deps.vfs.readFile(appletsPath))
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
    const facet = deps.facets.open({
        tag: 'bash-runner',
        concurrency: 1,
        // No supervisor capability: bash is seeded with its subtree by value and
        // hands the whole mutation back as a diff on exit, so it makes no syscall
        // into the session while it runs.
        preamble: BASH_RUNNER_PREAMBLE,
        wasmModules,
    });
    let active = true;
    let closed = false;
    const submit = async (args) => {
        const slice = normalizeSlice(await facet.submit(bashFacetStep, args, { timeoutMs: 300_000 }));
        if (!slice)
            throw new Error('facet returned an invalid payload');
        if (slice.state === 'exited') {
            if (slice.fsDiff)
                flushVfsDiff(deps.vfs, slice.fsDiff);
            active = false;
        }
        else if (slice.state === 'error') {
            active = false;
        }
        return slice;
    };
    try {
        const initial = await submit({
            op: 'boot',
            argv: deps.argv,
            environ: Object.entries(userEnv).map(([key, value]) => `${key}=${value}`),
            cwd: deps.cwd,
            fsSnapshot: fsSnapshot.snapshot,
            stdinData: deps.stdinData ?? '',
            stdinClosed: deps.stdinClosed,
            stdinTty: deps.stdinTty,
            busyboxApplets,
        });
        return {
            initial,
            push(data, eof = false) {
                if (closed)
                    throw new Error('bash facet session is closed');
                return submit({ op: 'feed', data, eof });
            },
            async close() {
                if (closed)
                    return;
                try {
                    if (active)
                        await submit({ op: 'feed', data: '', eof: true });
                }
                catch {
                    // Session teardown is best-effort; the owning command already
                    // reports dispatch failures from boot/push.
                }
                finally {
                    closed = true;
                    facet.dispose();
                }
            },
        };
    }
    catch (error) {
        facet.dispose();
        throw error;
    }
}
/** bash flags that consume the following argv element. */
const BASH_OPT_WITH_ARG = new Set(['-c', '-o', '+o', '--rcfile', '--init-file']);
/**
 * Locate the script-path argv element (first non-flag arg when -c is
 * absent) so the handler can resolve it against the session cwd —
 * bash's own cwd inside the facet starts at '/' until the BASH_ENV
 * chdir runs, so relative script paths must be made absolute host-side.
 * Returns the argv index or -1 (interactive / -c / stdin modes).
 */
function findScriptArgIndex(argv) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--')
            return i + 1 < argv.length ? i + 1 : -1;
        if (a === '-')
            return -1; // read from stdin
        if (a.startsWith('-') || a.startsWith('+')) {
            if (BASH_OPT_WITH_ARG.has(a)) {
                if (a === '-c')
                    return -1; // command string mode
                i++; // skip the option's argument
            }
            continue;
        }
        return i;
    }
    return -1;
}
export function makeBashRunnerFactory(deps) {
    return function bashRunnerFactory(manifest, installRoot, binName, _binKind) {
        return async function bashBinHandler(ctx) {
            // All VFS access (runtime wasm reads, script probes, snapshot,
            // fsDiff writeback) runs as the INVOKING process credential —
            // S2a enforcement applies to bash exactly as to ruby/python.
            const cred = requireVfsCred('cred' in ctx ? ctx.cred : undefined, binName);
            const vfs = deps.vfs.as(cred);
            const argv = [...(ctx.args ?? [])];
            const cwd = ctx.cwd || '/home/user';
            // Resolve a relative script path against the session cwd.
            const scriptIdx = findScriptArgIndex(argv);
            const extraRoots = [];
            if (scriptIdx >= 0) {
                const abs = resolveVfsPath(argv[scriptIdx], cwd);
                if (!vfs.exists(abs)) {
                    ctx.stderr.write(`${binName}: ${argv[scriptIdx]}: No such file or directory\n`);
                    return 127;
                }
                // Pass bash an ABSOLUTE path: the facet chdir's to the session
                // cwd via BASH_ENV before opening the script, so a relative arg
                // would resolve against cwd twice. resolveVfsPath returns a
                // slash-less canonical key; re-anchor it at root.
                argv[scriptIdx] = '/' + abs;
                const dir = abs.replace(/\/[^/]*$/, '');
                if (dir)
                    extraRoots.push(dir);
            }
            // stdin plumbing. A terminal-backed fd 0 feeds incrementally
            // (interactive bash, `read` builtins); a piped stdin is drained
            // upfront and closed so the scheduler never parks on it.
            const stdinIsTty = typeof ctx.isFdTerminal === 'function' ? ctx.isFdTerminal(0) : !ctx.stdin;
            const feedStream = ctx.terminalStdin ?? ctx.stdin;
            let stdinData = '';
            let stdinClosed = true;
            if (stdinIsTty && feedStream) {
                stdinClosed = false;
            }
            else if (ctx.stdin) {
                stdinData = await ctx.stdin.readAll();
            }
            let session = null;
            try {
                session = await createBashFacetSession({
                    facets: deps.facets,
                    vfs,
                    manifest,
                    installRoot,
                    argv: [binName, ...argv],
                    env: ctx.env || {},
                    cwd,
                    stdinData,
                    stdinClosed,
                    stdinTty: stdinIsTty,
                    extraRoots,
                });
                let slice = session.initial;
                for (;;) {
                    if (slice.stdout)
                        ctx.stdout.write(slice.stdout);
                    if (slice.stderr)
                        ctx.stderr.write(slice.stderr);
                    if (slice.state === 'exited') {
                        return slice.exitCode;
                    }
                    if (slice.state === 'error') {
                        ctx.stderr.write(`${binName}: ${slice.error || 'bash facet error'}\n`);
                        return slice.exitCode || 1;
                    }
                    // need-input: pull the next chunk from the terminal.
                    let data = '';
                    let eof = true;
                    if (!ctx.signal.aborted && feedStream) {
                        const chunk = await feedStream.read();
                        if (!ctx.signal.aborted) {
                            data = chunk === null ? '' : chunk.replace(/\r\n?/g, '\n');
                            eof = chunk === null;
                        }
                    }
                    slice = await session.push(data, eof);
                }
            }
            catch (e) {
                ctx.stderr.write(`${binName}: dispatch failed: ${errorMessage(e)}\n`);
                return 1;
            }
            finally {
                await session?.close();
            }
        };
    };
}
/**
 * Source string injected as the facet `preamble`. The facet's scope evaluates
 * it verbatim so `__bashBoot` / `__bashFeed` are in scope when the user fn
 * runs. Self-contained — no closure captures, no imports.
 *
 * The scheduler itself lives in `bash/preamble.ts` as real TypeScript; the build
 * bundles it into `bash-runner.generated.ts`.
 */
export const BASH_RUNNER_PREAMBLE = BASH_RUNNER_BODY_SRC;
