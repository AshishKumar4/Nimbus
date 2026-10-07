/**
 * package-manager.ts — the Worker's edge of runtime installation.
 *
 * The policy moved: installs, singleflight, bin registration and the `nimbus`
 * verb itself live in `@nimbus-sh/core` (`runtime/runtime-manager.ts`,
 * `runtime/nimbus-command.ts`) because a library workspace owns them too.
 * What remains here is what only a Cloudflare host can answer:
 *
 *   - `runtimeCatalogSource(env)` — the R2-backed RuntimeSource (the digest
 *     chain stays in runtime-catalog.ts beside this file's fetchers);
 *   - the programmatic entry points the SDK surface calls;
 *   - the command-not-found hint resolver init.ts wires into exec dispatch.
 */
import { catalogCommandIndex, runtimeCatalogSource, } from './runtime-catalog.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { runNimbusInstall, } from '@nimbus-sh/core/runtime/nimbus-command.js';
export { runtimeCatalogSource };
/**
 * `nimbus install` without a shell: the same `runNimbusInstall` path the verb
 * runs, with output captured instead of written to a terminal. Deps take the
 * workspace's RuntimeManager — which already holds the source, the registry
 * and the runner factories — rather than a catalog env.
 */
export async function installRuntimeProgrammatic(deps, spec, opts = {}) {
    const stdout = [];
    const stderr = [];
    let programmaticCred = CRED_KERNEL;
    const ctx = {
        pid: 0,
        get cred() { return programmaticCred; },
        setUmask: (umask) => { programmaticCred = { ...programmaticCred, umask }; },
        runAs: async () => ({ status: 126, signal: null }),
        args: [],
        env: {},
        cwd: deps.getHome(),
        stdout: { write: (s) => stdout.push(String(s)) },
        stderr: { write: (s) => stderr.push(String(s)) },
    };
    const verbDeps = {
        runtimes: deps.runtimes,
        registry: deps.registry,
        vfs: deps.vfs,
        warmRuntime: deps.warmRuntime,
    };
    const args = opts.force ? ['--reinstall', spec] : [spec];
    const exitCode = await runNimbusInstall(args, ctx, verbDeps);
    return {
        spec,
        exitCode,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
    };
}
export async function ensureRuntimesProgrammatic(deps, specs, opts = {}) {
    const results = [];
    for (const spec of specs) {
        results.push(await installRuntimeProgrammatic(deps, spec, opts));
    }
    return results;
}
/**
 * Command-not-found hints, catalog-driven: a bare name the shell could not
 * resolve is answered with the runtime that provides it, so `python3` hints
 * at cpython and `wasm-ld` at clang. Loaded once and memoized; a fetch
 * failure drops the memo so the next unknown command retries.
 */
export function createRuntimeCommandHintResolver(env) {
    let hintsPromise = null;
    const loadHints = async () => {
        const hints = new Map();
        for (const [command, runtimeName] of await catalogCommandIndex(env)) {
            if (command && !command.includes('/'))
                hints.set(command, { command, runtimeName, installSpec: command });
        }
        return hints;
    };
    return async (command) => {
        if (!command || command.includes('/'))
            return null;
        if (!hintsPromise) {
            hintsPromise = loadHints().catch((e) => {
                hintsPromise = null;
                throw e;
            });
        }
        const hints = await hintsPromise;
        return hints.get(command) ?? null;
    };
}
