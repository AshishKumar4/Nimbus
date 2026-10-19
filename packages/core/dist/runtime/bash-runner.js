/**
 * bash-runner — real GNU bash 5.2.37 (wasm32-wasi, asyncified) in a
 * dedicated facet.
 *
 * bash CANNOT run through the stock JSPI wasm-runner: the binary is
 * asyncify-instrumented (fork/setjmp/blocking-pipe unwinds) and needs
 * the `nimbus_proc` imports plus MULTIPLE instances per facet (fork).
 * Its multi-instance fork/pipe/exec/setjmp scheduler is bash/preamble.ts,
 * the facet's preamble.
 *
 * Architecture (mirrors ruby-runner's facet dispatch):
 *  - bash.async.wasm + the coreutil exec targets ship through the facet
 *    host, which compiles them and exposes them on
 *    globalThis.__NIMBUS_WASM.
 *  - The preamble's __bashStep boots bash (__bashBoot) or feeds it
 *    (__bashFeed), pumping the scheduler until the process tree exits
 *    or the root parks on a terminal stdin read. Facet state persists
 *    across submits on the warm isolate (same mechanism as
 *    __rubyInstance caching).
 *  - stdin, stdout and stderr are the process's byte channels
 *    (openRuntimeStdio), and every file syscall goes to the session's
 *    filesystem authority as the invoking process.
 */
import { exitCodeForAbortSignal } from '../substrate/lifo/shell/signals.js';
import { BASH_STEP_TASK, BASH_REQUEST_TASK } from './compiled-bodies.generated.js';
import { installedPath } from './runtime-manifest.js';
import { hostImage, withHostView } from './process-files.js';
import { facetAnswer } from './facet-host.js';
import { z } from 'zod';
import { BASH_RUNNER_BODY_SRC } from './bash-runner.generated.js';
import { BASH_RUNNER, CRED_KERNEL, gateSyncLaunch, requireVfsCred } from './os-contracts.js';
import { resolveVfsPath } from '../vfs/path.js';
import { openRuntimeStdio } from './runtime-stdio.js';
import { errorText } from '../_shared/error-text.js';
const BashSliceSchema = z.object({
    state: z.enum(['need-input', 'exited', 'error']),
    exitCode: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    error: z.string().optional(),
    stats: z.record(z.string(), z.unknown()).optional(),
    control: z.record(z.string(), z.string()).optional(),
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
        stats: parsed.data.stats,
        control: parsed.data.control,
    };
}
/**
 * The installed bash as `artifacts` sees it: its wasm images' paths by module
 * name (bash, then each coreutils image the install has) and its busybox applets.
 */
async function installedBash(artifacts, manifest, installRoot) {
    const bash = installedPath(manifest, installRoot, 'share/bash/bash.async.wasm');
    if (!bash || !(await artifacts.exists(bash))) {
        throw new Error("bash.async.wasm missing (re-run 'nimbus install bash')");
    }
    const images = { 'bash.async.wasm': bash };
    const prefix = 'share/bash/coreutils/';
    for (const file of manifest.files) {
        if (!file.path.startsWith(prefix) || !file.path.endsWith('.wasm'))
            continue;
        const path = `${installRoot}/${file.path}`;
        if (await artifacts.exists(path))
            images[`cu_${file.path.slice(prefix.length, -'.wasm'.length)}.wasm`] = path;
    }
    const appletsPath = installedPath(manifest, installRoot, 'share/bash/coreutils/busybox.applets');
    const applets = appletsPath && (await artifacts.exists(appletsPath))
        ? new TextDecoder().decode(await artifacts.readFile(appletsPath))
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
    return { images, applets };
}
export async function createBashFacetSession(deps) {
    deps.signal?.throwIfAborted();
    const installed = await withHostView(deps.authority, CRED_KERNEL, (artifacts) => installedBash(artifacts, deps.manifest, deps.installRoot));
    const userEnv = { ...deps.env };
    userEnv.HOME ||= '/home/user';
    userEnv.PATH ||= '/bin:/usr/bin';
    userEnv.PATH = `/${deps.installRoot.replace(/^\/+/, '')}/bin:${userEnv.PATH}`;
    userEnv.TERM ||= 'dumb';
    userEnv.NIMBUS_PWD = deps.cwd;
    userEnv.BASH_ENV ||= '/etc/nimbus.bashrc';
    userEnv.PWD = deps.cwd;
    // Opened, not read: the host reads each for the facet's load alone
    // (FacetImage), through a lease of its own, for a session outlives the one
    // that opened them.
    const wasmModules = {};
    for (const [name, path] of Object.entries(installed.images))
        wasmModules[name] = await hostImage(deps.authority, CRED_KERNEL, path);
    const busyboxApplets = installed.applets;
    const facet = deps.facets.open({
        tag: BASH_RUNNER,
        concurrency: 1,
        syscalls: { vfs: deps.filesystem, pid: deps.pid, processes: deps.processes },
        preamble: BASH_RUNNER_PREAMBLE,
        wasmModules,
    });
    let stepController = null;
    let stepInFlight = null;
    let active = true;
    let closed = false;
    const submit = (args) => {
        const tracked = (async () => {
            deps.signal?.throwIfAborted();
            // One step's abort, the session's (interrupt) or the caller's, for either transport.
            const controller = new AbortController();
            stepController = controller;
            const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
            let raw;
            // No deadline: a process runs until it exits or is killed.
            try {
                if (facet.submitRequest) {
                    const response = await facet.submitRequest(BASH_REQUEST_TASK, new Request('https://bash-facet.invalid/step', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(args),
                        signal,
                    }));
                    raw = await facetAnswer(response);
                }
                else {
                    raw = await facet.submit(BASH_STEP_TASK, args, { signal });
                }
            }
            catch (error) {
                // An aborted step leaves the facet's session dead.
                if (signal.aborted)
                    active = false;
                throw error;
            }
            finally {
                if (stepController === controller)
                    stepController = null;
            }
            const slice = normalizeSlice(raw);
            if (!slice)
                throw new Error('facet returned an invalid payload');
            if (slice.state === 'exited') {
                active = false;
            }
            else if (slice.state === 'error') {
                active = false;
            }
            return slice;
        })();
        stepInFlight = tracked;
        tracked.then(() => { if (stepInFlight === tracked)
            stepInFlight = null; }, () => { if (stepInFlight === tracked)
            stepInFlight = null; });
        return tracked;
    };
    try {
        const initial = await submit({
            op: 'boot',
            argv: deps.argv,
            environ: Object.entries(userEnv).map(([key, value]) => `${key}=${value}`),
            cwd: deps.cwd,
            cred: deps.cred,
            parking: deps.facets.parking,
            memoryBudgetBytes: deps.facets.memoryBudgetBytes,
            stdinData: deps.stdinData ?? '',
            stdinClosed: deps.stdinClosed,
            stdinTty: deps.stdinTty,
            processPid: deps.pid,
            sharedInput: deps.sharedInput,
            outputControls: deps.outputControls,
            busyboxApplets,
            coreutilsRoot: deps.installRoot + '/bin',
        });
        return {
            initial,
            push(data, eof = false) {
                if (closed)
                    throw new Error('bash facet session is closed');
                return submit({ op: 'feed', data, eof });
            },
            // Abort the in-flight step's signal, then settle when the step
            // promise has — the caller observes the abort as the push's rejection.
            async interrupt() {
                stepController?.abort();
                const inFlight = stepInFlight;
                if (inFlight) {
                    try {
                        await inFlight;
                    }
                    catch { /* the push surfaces the error */ }
                }
                // The aborted dispatch leaves the facet's session dead — the
                // pool's generation bump guarantees the next dispatch a fresh
                // worker, and the local host's realm has ended — so close() must
                // not feed an EOF into the corpse.
                active = false;
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
            // Script probes and every guest syscall run as the INVOKING process
            // through its bound view; only the installed runtime blobs are read
            // through a kernel host lease, as for every other runtime.
            const cred = requireVfsCred('cred' in ctx ? ctx.cred : undefined, binName);
            const filesystem = ctx.vfs.process;
            const argv = [...(ctx.args ?? [])];
            const cwd = ctx.cwd || '/home/user';
            const notHydrated = await gateSyncLaunch(filesystem, cwd, null, argv);
            if (notHydrated !== null) {
                ctx.stderr.write(`${binName}: ${notHydrated}\n`);
                return 1;
            }
            // Resolve a relative script path against the session cwd.
            const scriptIdx = findScriptArgIndex(argv);
            if (scriptIdx >= 0) {
                const abs = resolveVfsPath(argv[scriptIdx], cwd);
                if (!(await ctx.vfs.exists(abs))) {
                    ctx.stderr.write(`${binName}: ${argv[scriptIdx]}: No such file or directory\n`);
                    return 127;
                }
                // Pass bash an ABSOLUTE path: the facet chdir's to the session
                // cwd via BASH_ENV before opening the script, so a relative arg
                // would resolve against cwd twice. resolveVfsPath returns a
                // slash-less canonical key; re-anchor it at root.
                argv[scriptIdx] = '/' + abs;
            }
            // stdin plumbing. A terminal-backed fd 0 feeds incrementally
            // (interactive bash, `read` builtins); a piped stdin is drained
            // upfront and closed so the scheduler never parks on it.
            const stdinIsTty = typeof ctx.isFdTerminal === 'function' ? ctx.isFdTerminal(0) : !ctx.stdin;
            const stdio = openRuntimeStdio(deps, ctx, [binName, ...argv].join(' '));
            let exitCode = 1;
            let session = null;
            try {
                session = await createBashFacetSession({
                    facets: deps.facets,
                    authority: deps.filesystem,
                    filesystem: stdio.syscalls.vfs,
                    pid: stdio.pid,
                    processes: deps.processes,
                    cred,
                    manifest,
                    installRoot,
                    argv: [binName, ...argv],
                    env: ctx.env || {},
                    cwd,
                    stdinClosed: false,
                    stdinTty: stdinIsTty,
                    sharedInput: true,
                    // A kill or Ctrl-C ends the step running, and the program with it.
                    signal: stdio.signal,
                });
                let slice = session.initial;
                for (;;) {
                    if (slice.state === 'exited') {
                        return exitCode = slice.exitCode;
                    }
                    if (slice.state === 'error') {
                        ctx.stderr.write(`${binName}: ${slice.error || 'bash facet error'}\n`);
                        return slice.exitCode || 1;
                    }
                    throw new Error('a shared fd0 reader must suspend inside its byte channel');
                }
            }
            catch (e) {
                // Killed: the program ends as an interrupted one does.
                if (stdio.signal.aborted)
                    return exitCode = exitCodeForAbortSignal(stdio.signal);
                ctx.stderr.write(`${binName}: dispatch failed: ${errorText(e)}\n`);
                return 1;
            }
            finally {
                await session?.close();
                await stdio.finish(exitCode);
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
