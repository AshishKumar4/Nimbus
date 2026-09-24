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
import { errorText } from '../_shared/error-text.js';
import { listInstalledManifestsView, rehydrateInstalledRuntimesView, runtimeAbiForManifest, runtimeEntrypoints, } from './installed-runtimes.js';
import { seedRuntimePackage, splitRuntimeSpec, } from './runtime-package.js';
export class RuntimeManager {
    vfs;
    registry;
    getHome;
    source;
    runnerFactories = new Map();
    /**
     * The newest queued op per target, keyed `${home}/${name}/${version}` for
     * installs and `${home}/${name}` for an uninstall's removal marker. Entries
     * live only while their `done` promise is unsettled.
     */
    inflight = new Map();
    /**
     * Resolutions whose canonical key is not yet registered — the gap where an
     * uninstall would otherwise slip between `source.resolve` and the queue.
     * Tracks ONLY the resolve promise: an unrelated name's payload write must
     * not hold a removal open, but a resolution in flight must.
     */
    resolving = new Set();
    constructor(options) {
        this.vfs = options.vfs;
        this.registry = options.registry;
        this.getHome = options.getHome;
        this.source = options.source;
    }
    /** The factory a manifest entrypoint's `runner` key resolves to. A later
     *  registration replaces an earlier one — a hosted compositor re-binds the
     *  core runners this way before it rehydrates. */
    registerRunner(key, factory) {
        this.runnerFactories.set(key, factory);
    }
    /** Re-register every verified installed runtime's bins from the manifests
     *  on disk. Trees that fail the payload digest check are skipped, not
     *  bound — the install path repairs them on demand. */
    rehydrate() {
        return rehydrateInstalledRuntimesView(this.vfs, this.registry, this.getHome(), (key) => this.runnerFactories.get(key));
    }
    /**
     * Install `spec` and register its bins. Throws when the spec resolves to
     * nothing, or when the package's entrypoints name a runner this workspace
     * has no factory for — checked BEFORE any payload write so an install that
     * could never produce an invokable bin leaves the filesystem untouched.
     */
    install(spec, options) {
        return this.installPrepared(() => this.resolveRunnable(spec), options);
    }
    /**
     * The package `spec` names that this workspace can run. A source is shared
     * by every deployment that reads it, and a runtime rebuilt against a new
     * runner contract publishes under a new version with a new runner key, so
     * the version a source offers by default is not always one this build can
     * bind. A bare name then takes the most recently published version whose
     * runners are all registered; an explicit `name@version` is a deliberate
     * request and is refused rather than substituted.
     */
    async resolveRunnable(spec) {
        const runtimePackage = await this.source.resolve(spec);
        if (runtimePackage === null) {
            throw new Error(`'${spec}' is not in catalog`);
        }
        const missing = this.missingRunners(runtimePackage.manifest);
        if (missing.length === 0)
            return runtimePackage;
        const { name, version } = runtimePackage.manifest;
        if (splitRuntimeSpec(spec).versionOverride === null) {
            const offered = (await this.source.list()).find((runtime) => runtime.name === name);
            for (const { version: candidate } of [...(offered?.versions ?? [])].reverse()) {
                if (candidate === version)
                    continue;
                const alternative = await this.source.resolve(`${name}@${candidate}`);
                if (alternative !== null && this.missingRunners(alternative.manifest).length === 0)
                    return alternative;
            }
        }
        throw new Error(`${name}@${version}: runner${missing.length === 1 ? '' : 's'} `
            + `'${missing.join("', '")}' not registered in this workspace`);
    }
    /** The runner keys `manifest`'s entrypoints name that this manager has no
     *  factory for, deduplicated, in entrypoint order. */
    missingRunners(manifest) {
        return [...new Set(runtimeEntrypoints(manifest)
                .map((ep) => ep.runner)
                .filter((key) => !this.runnerFactories.has(key)))];
    }
    /** Every runner key registered so far. */
    runnerKeys() {
        return [...this.runnerFactories.keys()];
    }
    /**
     * Install a package the caller already holds — the workspace's eager seed
     * and a host's direct provisioning share this path with `install`. No
     * runner check: seeding a filesystem that has nothing to run the payload
     * with is a legal state (bins bind at `rehydrate`), while `install` is the
     * command the user runs and must refuse to produce an unusable bin.
     */
    installPackage(runtimePackage, options) {
        return this.installPrepared(async () => runtimePackage, options);
    }
    installPrepared(resolve, options) {
        // One home per call, captured before any await: the key and the writes
        // must name the same tree even if the environment shifts mid-install.
        const home = this.getHome();
        // The resolve promise alone is what `uninstall` waits on: only it can
        // still produce a key this call has not registered yet.
        const resolution = resolve();
        this.resolving.add(resolution);
        const start = async () => {
            let runtimePackage;
            try {
                runtimePackage = await resolution;
            }
            finally {
                this.resolving.delete(resolution);
            }
            const manifest = runtimePackage.manifest;
            const name = manifest.name;
            const key = `${home}/${name}/${manifest.version}`;
            const nameKey = `${home}/${name}`;
            const prior = this.inflight.get(key);
            const removal = this.inflight.get(nameKey);
            if (prior?.kind === 'install' && removal === undefined && !options?.force) {
                // The same install is already queued or running: join it.
                return prior.done;
            }
            // Queue behind the newest op on this target — an earlier install
            // still running, or a removal marker. `force` and a removal never
            // join a prior write: one owes the caller a real reinstall, the
            // other a tree that still exists afterward.
            const after = removal?.done ?? prior?.done ?? Promise.resolve();
            const attempt = after.then(() => this.write(runtimePackage, home, options), () => this.write(runtimePackage, home, options));
            const entry = { kind: 'install', done: attempt };
            this.inflight.set(key, entry);
            attempt.then(() => { if (this.inflight.get(key) === entry)
                this.inflight.delete(key); }, () => { if (this.inflight.get(key) === entry)
                this.inflight.delete(key); });
            return attempt;
        };
        return start();
    }
    async write(runtimePackage, home, options) {
        const manifest = runtimePackage.manifest;
        const name = manifest.name;
        const entrypoints = runtimeEntrypoints(manifest);
        const totalBytes = manifest.files.reduce((a, f) => a + f.size, 0);
        options?.onProgress?.(`[${name}] manifest: ${manifest.files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
        const seeded = await seedRuntimePackage(this.vfs, home, runtimePackage, {
            force: options?.force,
            onProgress: options?.onProgress,
        });
        const bins = [];
        for (const ep of entrypoints) {
            const factory = this.runnerFactories.get(ep.runner);
            if (!factory)
                continue;
            this.registry.register(ep.binName, await factory(manifest, seeded.root, ep.binName, ep.kind));
            bins.push(ep.binName);
        }
        if (options?.onProgress) {
            if (seeded.written) {
                options.onProgress(`[${name}] installed at ${seeded.root} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`);
            }
            else {
                options.onProgress(`[${name}] already installed at ${seeded.root} (use --reinstall to refetch)`);
            }
        }
        return { ...seeded, bins };
    }
    /** Remove every installed version matching `spec` (`name` or
     *  `name@version`) and unregister its bins. Queued behind pending
     *  installs of the same name; bins a remaining VERIFIED version also
     *  provides are rebound so removing one of two installs loses no
     *  commands — and cannot resurrect a corrupt one. */
    async uninstall(spec) {
        const home = this.getHome();
        const atIdx = spec.indexOf('@');
        const name = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
        const versionOverride = atIdx >= 0 ? spec.slice(atIdx + 1) : null;
        const nameKey = `${home}/${name}`;
        // Wait for resolutions still open — their canonical key is not
        // registered yet — then chain behind every queued op on this name and
        // register the removal as the newest one, so later installs queue
        // behind IT. Resolutions of OTHER names are not waited on: only their
        // resolve can still produce an entry under this name.
        await Promise.allSettled([...this.resolving]);
        const pending = [...this.inflight.entries()]
            .filter(([key]) => key === nameKey || key.startsWith(`${nameKey}/`))
            .map(([, op]) => op.done);
        const removal = Promise.allSettled(pending)
            .then(async () => (await this.remove(name, versionOverride, home)));
        const entry = { kind: 'remove', done: removal };
        this.inflight.set(nameKey, entry);
        try {
            await removal;
        }
        finally {
            if (this.inflight.get(nameKey) === entry)
                this.inflight.delete(nameKey);
        }
    }
    async remove(name, versionOverride, home) {
        const matches = (await listInstalledManifestsView(this.vfs, home)).filter((entry) => entry.manifest.name === name
            && (versionOverride === null || entry.manifest.version === versionOverride));
        for (const match of matches) {
            for (const ep of runtimeEntrypoints(match.manifest)) {
                this.registry.unregister?.(ep.binName);
            }
            if (await this.vfs.exists(match.root))
                await this.vfs.remove(match.root, { recursive: true });
        }
        // Bins a surviving version of the same runtime also provides are rebound
        // — removing one of two installed versions must not unregister both.
        // The same digest verifier rehydration uses decides what may bind, so a
        // corrupted survivor stays unbound rather than inheriting the freed bins.
        if (versionOverride !== null && matches.length > 0) {
            await rehydrateInstalledRuntimesView(this.vfs, this.registry, home, (key) => this.runnerFactories.get(key));
        }
        // Empty `runtimes/<name>`/`runtimes` dirs go too.
        const base = `${home.replace(/^\/+/, '').replace(/\/+$/, '')}/.nimbus/runtimes`;
        for (const dir of [`${base}/${name}`, base]) {
            if ((await this.vfs.exists(dir)) && (await this.vfs.readdir(dir)).length === 0)
                (await this.vfs.rmdir(dir));
        }
    }
    /**
     * Register `bin` as a stub that runs `install(bin)` on first use and then
     * re-resolves its own name against the registry — the on-demand install
     * path. Re-resolving rather than calling a captured handler is what keeps
     * the stub honest: a resolve that still answers the stub means the runtime
     * landed with nothing able to run it here, and that is reported instead of
     * looped.
     */
    registerInstallStub(bin) {
        const stub = async (ctx) => {
            try {
                await this.install(bin);
            }
            catch (error) {
                ctx.stderr.write(`${bin}: installing the runtime failed: ${errorText(error)}\n`);
                return 127;
            }
            const command = this.registry.resolve ? await this.registry.resolve(bin) : undefined;
            if (!command || command === stub) {
                ctx.stderr.write(`${bin}: the runtime installed but provides no runnable ${bin} in this workspace\n`);
                return 127;
            }
            return command(ctx);
        };
        this.registry.register(bin, stub);
    }
    /** `source.resolve` without an install: the on-demand fallback checks
     *  whether an unregistered command name could be satisfied before
     *  registering a stub for it — catalog reads only, no payload write. */
    resolvable(spec) {
        return this.source.resolve(spec);
    }
    async list() {
        return (await listInstalledManifestsView(this.vfs, this.getHome())).map(({ root, manifest }) => ({
            name: manifest.name,
            version: manifest.version,
            root,
            abi: runtimeAbiForManifest(manifest),
            bins: runtimeEntrypoints(manifest).map((e) => e.binName),
            sizeBytes: manifest.files.reduce((a, f) => a + f.size, 0),
            license: manifest.license,
        }));
    }
    available() {
        return this.source.list();
    }
}
