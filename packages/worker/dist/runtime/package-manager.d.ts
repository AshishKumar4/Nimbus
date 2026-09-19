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
import { runtimeCatalogSource, type RuntimeCatalogEnv } from './runtime-catalog.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { RuntimeManager } from '@nimbus-sh/core/runtime/runtime-manager.js';
import type { RuntimeAvailability } from '@nimbus-sh/core/runtime/runtime-package.js';
import { type RuntimeWarmHook } from '@nimbus-sh/core/runtime/nimbus-command.js';
import type { MinShellRegistry } from '@nimbus-sh/core/runtime/installed-runtimes.js';
export { runtimeCatalogSource };
export type { RuntimeWarmHook };
export interface RuntimeInstallSummary {
    spec: string;
    exitCode: number;
    stdout: string;
    stderr: string;
}
export interface RuntimeCommandHint {
    command: string;
    runtimeName: string;
    installSpec: string;
}
/**
 * `nimbus install` without a shell: the same `runNimbusInstall` path the verb
 * runs, with output captured instead of written to a terminal. Deps take the
 * workspace's RuntimeManager — which already holds the source, the registry
 * and the runner factories — rather than a catalog env.
 */
export declare function installRuntimeProgrammatic(deps: {
    runtimes: RuntimeManager;
    registry: MinShellRegistry;
    vfs: CredentialedVfs;
    getHome(): string;
    warmRuntime?: RuntimeWarmHook;
}, spec: string, opts?: {
    force?: boolean;
}): Promise<RuntimeInstallSummary>;
export declare function ensureRuntimesProgrammatic(deps: {
    runtimes: RuntimeManager;
    registry: MinShellRegistry;
    vfs: CredentialedVfs;
    getHome(): string;
    warmRuntime?: RuntimeWarmHook;
}, specs: string[], opts?: {
    force?: boolean;
}): Promise<RuntimeInstallSummary[]>;
export declare function listAvailableRuntimes(env: RuntimeCatalogEnv): Promise<RuntimeAvailability[]>;
/**
 * Command-not-found hints, catalog-driven: a bare name the shell could not
 * resolve is answered with the runtime that provides it, so `python3` hints
 * at cpython and `wasm-ld` at clang. Loaded once and memoized; a fetch
 * failure drops the memo so the next unknown command retries.
 */
export declare function createRuntimeCommandHintResolver(env: RuntimeCatalogEnv): (command: string) => Promise<RuntimeCommandHint | null>;
//# sourceMappingURL=package-manager.d.ts.map