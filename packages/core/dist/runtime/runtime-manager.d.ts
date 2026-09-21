/**
 * runtime-manager.ts — one runtime installer per workspace.
 *
 * Where the runtimes come from is the injected `RuntimeSource` (npm packages
 * the embedder imported, an R2 catalog adapter, or a composition of both);
 * where they land is always `~/.nimbus/runtimes/<name>/<version>/` through
 * `seedRuntimePackage`; what makes them invokable is the runner factory map
 * this instance owns. All three are per-instance because a second workspace
 * in the same process must not inherit the first one's runners or touch its
 * registry — the module-global table this replaces did both.
 *
 * Operations on a canonical target serialize rather than memoize: two
 * concurrent installs of the same package share the first one's write, a
 * `--reinstall` queues its own write behind what is already running instead
 * of joining it, and an uninstall chains behind every pending install of
 * that name before its removal registers as the newest op — so nothing
 * writes into a tree that is being removed, and nothing removes a tree that
 * is being written. A settled entry is dropped, so `uninstall` then
 * `install` reinstalls rather than answering a stale memo, and a failed
 * install is forgotten so the next attempt retries.
 */
import type { ExecutionFs as CredentialedVfs } from '../shell/execution-fs.js';
import { type MinShellRegistry, type RunnerFactory, type RuntimeSummary } from './installed-runtimes.js';
import { type RuntimeAvailability, type RuntimePackage, type RuntimeSource, type SeededRuntime } from './runtime-package.js';
export interface RuntimeManagerOptions {
    vfs: CredentialedVfs;
    registry: MinShellRegistry;
    getHome(): string;
    source: RuntimeSource;
}
type InstalledBins = SeededRuntime & {
    bins: string[];
};
export declare class RuntimeManager {
    private readonly vfs;
    private readonly registry;
    private readonly getHome;
    private readonly source;
    private readonly runnerFactories;
    /**
     * The newest queued op per target, keyed `${home}/${name}/${version}` for
     * installs and `${home}/${name}` for an uninstall's removal marker. Entries
     * live only while their `done` promise is unsettled.
     */
    private readonly inflight;
    /**
     * Resolutions whose canonical key is not yet registered — the gap where an
     * uninstall would otherwise slip between `source.resolve` and the queue.
     * Tracks ONLY the resolve promise: an unrelated name's payload write must
     * not hold a removal open, but a resolution in flight must.
     */
    private readonly resolving;
    constructor(options: RuntimeManagerOptions);
    /** The factory a manifest entrypoint's `runner` key resolves to. A later
     *  registration replaces an earlier one — a hosted compositor re-binds the
     *  core runners this way before it rehydrates. */
    registerRunner(key: string, factory: RunnerFactory): void;
    /** Re-register every verified installed runtime's bins from the manifests
     *  on disk. Trees that fail the payload digest check are skipped, not
     *  bound — the install path repairs them on demand. */
    rehydrate(): Promise<{
        count: number;
        bins: string[];
    }>;
    /**
     * Install `spec` and register its bins. Throws when the spec resolves to
     * nothing, or when the package's entrypoints name a runner this workspace
     * has no factory for — checked BEFORE any payload write so an install that
     * could never produce an invokable bin leaves the filesystem untouched.
     */
    install(spec: string, options?: {
        force?: boolean;
        onProgress?: (line: string) => void;
    }): Promise<InstalledBins>;
    /**
     * The package `spec` names that this workspace can run. A source is shared
     * by every deployment that reads it, and a runtime rebuilt against a new
     * runner contract publishes under a new version with a new runner key, so
     * the version a source offers by default is not always one this build can
     * bind. A bare name then takes the most recently published version whose
     * runners are all registered; an explicit `name@version` is a deliberate
     * request and is refused rather than substituted.
     */
    private resolveRunnable;
    private missingRunners;
    /**
     * Install a package the caller already holds — the workspace's eager seed
     * and a host's direct provisioning share this path with `install`. No
     * runner check: seeding a filesystem that has nothing to run the payload
     * with is a legal state (bins bind at `rehydrate`), while `install` is the
     * command the user runs and must refuse to produce an unusable bin.
     */
    installPackage(runtimePackage: RuntimePackage, options?: {
        force?: boolean;
        onProgress?: (line: string) => void;
    }): Promise<InstalledBins>;
    private installPrepared;
    private write;
    /** Remove every installed version matching `spec` (`name` or
     *  `name@version`) and unregister its bins. Queued behind pending
     *  installs of the same name; bins a remaining VERIFIED version also
     *  provides are rebound so removing one of two installs loses no
     *  commands — and cannot resurrect a corrupt one. */
    uninstall(spec: string): Promise<void>;
    private remove;
    /**
     * Register `bin` as a stub that runs `install(bin)` on first use and then
     * re-resolves its own name against the registry — the on-demand install
     * path. Re-resolving rather than calling a captured handler is what keeps
     * the stub honest: a resolve that still answers the stub means the runtime
     * landed with nothing able to run it here, and that is reported instead of
     * looped.
     */
    registerInstallStub(bin: string): void;
    /** `source.resolve` without an install: the on-demand fallback checks
     *  whether an unregistered command name could be satisfied before
     *  registering a stub for it — catalog reads only, no payload write. */
    resolvable(spec: string): Promise<RuntimePackage | null>;
    list(): Promise<RuntimeSummary[]>;
    available(): Promise<RuntimeAvailability[]>;
}
export {};
//# sourceMappingURL=runtime-manager.d.ts.map