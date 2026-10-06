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
    const anchor = (path) => {
        const joined = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`;
        const out = [];
        for (const part of joined.split('/')) {
            if (part === '' || part === '.')
                continue;
            if (part === '..')
                out.pop();
            else
                out.push(part);
        }
        return `/${out.join('/')}`;
    };
    const named = program === null ? [] : [anchor(program)];
    for (const arg of argv)
        if (arg !== '' && !arg.startsWith('-'))
            named.push(anchor(arg));
    return named;
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
export const BASH_RUNNER = 'bash-runner@3';
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
