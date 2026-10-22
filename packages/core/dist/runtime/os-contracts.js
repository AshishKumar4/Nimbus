import { rootClampedSegments } from '@nimbus-sh/platform/lexical-path.js';
import { errorText } from '../_shared/error-text.js';
export const CRED_KERNEL = Object.freeze({
    uid: 0,
    gid: 0,
    groups: Object.freeze([0]),
    umask: 0o022,
});
/**
 * The session's unprivileged login identity — `user` in /etc/passwd, the
 * credential every process inherits unless it deliberately transitions.
 *
 * It is also the credential the embedder-facing surfaces act with: the SDK
 * filesystem API, the remote `/rpc` file ops, and the static asset server are
 * host callers, not processes, and files they create must be owned by the same
 * identity `exec` runs as. Never CRED_KERNEL — a pid-less caller must never
 * gain more authority than the shell it is writing files for.
 */
export const CRED_SESSION_USER = Object.freeze({
    uid: 1000,
    gid: 1000,
    groups: Object.freeze([1000]),
    umask: 0o022,
});
/** A POSIX id (or mask): an unsigned integer. */
function isCredId(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
/** Whether `value` is a credential: unsigned integer uid, gid, umask and supplementary groups. The one shape check. */
export function isVfsCred(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const { uid, gid, groups, umask } = value;
    return isCredId(uid) && isCredId(gid) && isCredId(umask) && Array.isArray(groups) && groups.every(isCredId);
}
/** `value` as a credential of its own (its groups copied), or the refusal `source` makes without one. */
export function requireVfsCred(value, source) {
    if (!isVfsCred(value))
        throw new Error(`${source} requires process credentials`);
    return { uid: value.uid, gid: value.gid, groups: [...value.groups], umask: value.umask };
}
/** Whether two credentials are the same identity: the same ids, mask and groups, in order. */
export function sameCred(a, b) {
    return a.uid === b.uid && a.gid === b.gid && a.umask === b.umask
        && a.groups.length === b.groups.length && a.groups.every((group, index) => group === b.groups[index]);
}
/**
 * Whether `stat` is the file `expected` named, unchanged as far as its stat
 * can tell; its revision too where `expected` names one (0 names none: a
 * backend that keeps none, or a name kept without it, as a resident's
 * namespace keeps a mount's).
 */
export function sameFileVersion(stat, expected) {
    return stat !== null && stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size
        && stat.mtime === expected.mtime && stat.ctime === expected.ctime && (expected.revision === 0 || stat.revision === expected.revision);
}
/**
 * N17: a launch that reads synchronously waits for the paths it names (its
 * program, and each argument resolved against `cwd`; one that names nothing
 * pending costs nothing) to be hydrated. The error message when they are
 * not, by the deadline; null when the launch may start.
 */
export async function gateSyncLaunch(gate, cwd, program, argv) {
    if (typeof gate.gateLaunch !== 'function')
        return null;
    try {
        await gate.gateLaunch(launchNamedPaths(cwd, program, argv));
        return null;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
/** The paths a synchronous-reading launch names (see {@link gateSyncLaunch}). */
export function launchNamedPaths(cwd, program, argv) {
    const anchor = (path) => `/${rootClampedSegments(path.startsWith('/') ? path : `${cwd}/${path}`).join('/')}`;
    const named = program === null ? [] : [anchor(program)];
    for (const arg of argv)
        if (arg !== '' && !arg.startsWith('-'))
            named.push(anchor(arg));
    return named;
}
/**
 * A request to a process that was never sent: the instance its host was
 * pinned to at open was gone (replaced by a fresh one, as the platform does
 * with an idle host) before the request went out, so it ran nowhere and may
 * be run again, once, on a new process. Answered only after the process
 * reads exited, so a relaunch never finds the lost one. A request already in
 * flight when a host is lost may have run; it fails with the loss instead.
 */
export class ProcessNotAdmitted extends Error {
    pid;
    request;
    /**
     * `request`, when the refusal names it: the request as it was to be sent,
     * its body unread, which is what a re-run sends (PortRegistry.routeRequest).
     */
    constructor(pid, cause, request) {
        super(`process ${pid} did not take the request: its host was replaced before the request was sent (${errorText(cause)})`, { cause });
        this.pid = pid;
        this.request = request;
        this.name = 'ProcessNotAdmitted';
    }
}
export const NIMBUS_OS_NAME = 'nimbus';
export const NIMBUS_ABI_TARGET = 'wasm32-wasi-nimbus';
export const NIMBUS_ABI_ID = NIMBUS_ABI_TARGET;
/** Canonical Pyodide package artifact ABI label. The single source of
 *  truth for the label — runtime manifests, the pip planner, and
 *  diagnostics all consume this constant. */
export const PYODIDE_PACKAGE_ABI = 'pyodide-emscripten-2025_0-wasm32';
/** Canonical artifact class for native platform binaries Nimbus cannot
 *  execute (Linux/Windows/macOS executables, .node bindings, native
 *  wheels/gems). */
export const NATIVE_UNSUPPORTED_ABI = 'native-unsupported';
/** File extensions of native binaries no Workers isolate can load. */
export const NATIVE_BIN_EXTENSIONS = ['.exe', '.node'];
/** True when `path` (a bin target or file path, query/fragment allowed) is a native binary. */
export function isNativeBinPath(path, extensions = NATIVE_BIN_EXTENSIONS) {
    const clean = String(path || '').split(/[?#]/)[0];
    const name = clean.slice(clean.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 && extensions.includes(name.slice(dot).toLowerCase());
}
export const NIMBUS_RUNTIME_ABIS = Object.freeze({
    bash: NIMBUS_ABI_TARGET,
    clang: NIMBUS_ABI_TARGET,
    python: 'pyodide',
    // The wasm32-wasi interpreter. It does have compiled packages — numpy, and
    // markupsafe's speedups — but they are linked into a prebuilt interpreter
    // variant rather than loaded at run time, so no wheel carrying a native
    // extension can be installed. See packages/worker/wasm/python/EXTENSIONS.md.
    cpython: NATIVE_UNSUPPORTED_ABI,
    ruby: 'ruby-wasm',
    node: 'javascript',
    bun: 'javascript',
});
/**
 * The runner key a bash manifest entrypoint names. Its number is the contract
 * between the bash preamble and the wasm build in `packages/worker/wasm/bash`:
 * the `nimbus_proc` imports, required guest exports and Asyncify allowlist.
 * A rebuild changing them takes the next number and a new catalog version, because the
 * catalog is shared by every deployment reading it and a workspace binds only
 * the build its preamble was written against.
 */
export const BASH_RUNNER = 'bash-runner@6';
/**
 * The contracts this tree's bash runner implements, the keys it is
 * registered under, and what each build asks of its host. @6 gives bash's
 * own instance nimbus_proc.stat_metadata (5.2.37-7 asks it for a stat
 * preview1 gave no type); a @5 build (5.2.37-5, -6) does not import it, and
 * an instantiation ignores what a module does not import. @6's bash and
 * BusyBox also ask again a read or write their host gave up on
 * (nimbus-libc's restart wrappers); bash's host gives none up today.
 */
export const BASH_RUNNER_CONTRACTS = Object.freeze({
    'bash-runner@5': { restartsWaits: false },
    [BASH_RUNNER]: { restartsWaits: true },
});
/**
 * The runner key a CPython manifest entrypoint names: the contract between the
 * CPython preamble (cpython-preamble.ts) and the wasm build in
 * `packages/worker/wasm/python`. 3.13.14-2 imports nimbus_fs and nimbus_proc,
 * which an older runner does not give the module, so it is `@2`; 3.13.14-1
 * and before were published under `cpython-runner`. 3.13.14-3 asks again a
 * read or write its host gave up on (nimbus-libc's restart wrappers), which
 * a host may answer only to it, so it is `@3`. A rebuild that changes what
 * the module imports, exports or asks of its host takes the next number, as
 * BASH_RUNNER's do.
 */
export const CPYTHON_RUNNER = 'cpython-runner@3';
/**
 * The contracts this tree's CPython runner implements, the keys it is
 * registered under, and what each build asks of its host: each build's
 * imports are a subset of what it gives a module (preview1, and nimbus_fs
 * and nimbus_proc since @2), and an instantiation ignores the ones a module
 * does not import.
 */
export const CPYTHON_RUNNER_CONTRACTS = Object.freeze({
    'cpython-runner': { restartsWaits: false, takesSignals: false },
    'cpython-runner@2': { restartsWaits: false, takesSignals: false },
    [CPYTHON_RUNNER]: { restartsWaits: true, takesSignals: false },
    // A build that takes the signals sent to its process (nimbus-libc's signal
    // raiser, and CPython's periodic check, nimbus_proc.signal_check).
    'cpython-runner@4': { restartsWaits: true, takesSignals: true },
});
/**
 * Git's runner keys, and what each build asks of its host. The first imports
 * the shared Nimbus filesystem/process extensions; @2's libc also asks again
 * a read or write the host gave up waiting on (wasm/nimbus-libc
 * nimbus-restart.c), which a host answers NIMBUS_ERESTART only to it
 * (runtime/wasi/types.ts): to the first, EINTR, which its stdio took for an
 * end. @2's libc also raises the signals its host sends it
 * (nimbus-signal.c), so that git's own handling runs: to the first, a
 * signal ends the run. One runner serves both.
 */
export const GIT_RUNNER_CONTRACTS = Object.freeze({
    'git-runner': { restartsWaits: false, takesSignals: false },
    'git-runner@2': { restartsWaits: true, takesSignals: true },
});
/** The key this tree's git build names. */
export const GIT_RUNNER = 'git-runner@2';
/**
 * Set in real git's environment (the git runner): a `git` it starts (a
 * hook's, a subcommand's) carries it, and is real git too, wherever a
 * built-in git routes `git` between itself and real git.
 */
export const GIT_WASI_ENV = 'NIMBUS_GIT_WASI';
/**
 * The import modules a wasm runtime built in this tree may import: WASI
 * preview1, and the Nimbus extensions this tree's WASI hosts provide —
 * nimbus_fs (a file's mode and owner, chmod: runtime/wasi/types.ts
 * NimbusFsImports) and nimbus_proc (the process's children, pipes and
 * credential: the shared WASI layer's runtime/wasi/processes.ts; bash's
 * runner provides its own table under the name, runtime/bash/preamble.ts,
 * bound by BASH_RUNNER). The git build's verify stage checks its image
 * against this list (packages/worker/wasm/git/build-git.sh). An image
 * importing an extension needs a host that provides it, so the runtime names
 * a runner key no older host registers: git's builds name the keys of
 * {@link GIT_RUNNER_CONTRACTS}.
 */
export const WASI_RUNTIME_IMPORT_MODULES = Object.freeze(['nimbus_fs', 'nimbus_proc', 'wasi_snapshot_preview1']);
export const WASM32_WASI_NIMBUS_ABI = {
    os: NIMBUS_OS_NAME,
    target: NIMBUS_ABI_TARGET,
    id: NIMBUS_ABI_ID,
    env: Object.freeze({
        NIMBUS_OS: NIMBUS_OS_NAME,
        NIMBUS_ABI: NIMBUS_ABI_ID,
        NIMBUS_ABI_TARGET,
    }),
    capabilities: Object.freeze([
        'wasi.snapshot-preview1',
        'wasi.unstable-import-alias',
        'vfs.snapshot-diff',
        'stdio',
        'argv',
        'env',
        'clock',
        'random',
        'path',
        'symlink',
        'hardlink',
        'poll',
        'outbound-tcp-devtcp',
        // Cooperative, correct, and not parallel — see runtime/wasi-threads.ts.
        'wasi.threads',
    ]),
};
