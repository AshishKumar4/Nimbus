/**
 * package-manager.ts — `nimbus install <runtime>` shell verb.
 *
 * Subcommands (all under `nimbus install`):
 *
 *   nimbus install <name>                 install latest of <name>
 *   nimbus install <name>@<version>       install specific version
 *   nimbus install --list                 show installed runtimes
 *   nimbus install --available            show catalog of installables
 *   nimbus install --reinstall <name>     force refetch
 *   nimbus uninstall <name>               remove installed runtime
 *
 * Per-user VFS layout:
 *
 *   ~/.nimbus/runtimes/<name>/<version>/
 *     manifest.json
 *     bin/<entry>
 *     share/<name>/...
 *     LICENSE
 *
 * Survives DO eviction (SqliteFS-backed). Boot-time rehydration reads
 * every `~/.nimbus/runtimes/STAR/STAR/manifest.json` and re-registers
 * each `entrypoints[].binName` as a shell command pointing at the
 * named runner factory.
 *
 * Errors throw and bubble up to the user as a single diagnostic line.
 */
import { fetchCatalog, fetchManifest, fetchBlob } from './runtime-catalog.js';
import { parseRuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
import { CRED_KERNEL, NIMBUS_RUNTIME_ABIS, NATIVE_UNSUPPORTED_ABI } from '@nimbus-sh/core/runtime/os-contracts.js';
import { installRoot, listInstalledManifestsView, rehydrateInstalledRuntimesView, runnerFactoryFor, runtimeAbiForManifest, runtimeEntrypoints, } from '@nimbus-sh/core/runtime/installed-runtimes.js';
function runtimeAbiForCatalogName(name) {
    return NIMBUS_RUNTIME_ABIS[name] ?? NATIVE_UNSUPPORTED_ABI;
}
function splitRuntimeSpec(spec) {
    const atIdx = spec.indexOf('@');
    return {
        name: atIdx >= 0 ? spec.slice(0, atIdx) : spec,
        versionOverride: atIdx >= 0 ? spec.slice(atIdx + 1) : null,
    };
}
/**
 * Runtimes replaced by another implementation, keyed by the name users type.
 *
 * `python` was Pyodide (CPython on Emscripten, with its own filesystem) and is
 * now CPython built for wasm32-wasi. Both are in the catalog, and the
 * redirection lives HERE rather than in the catalog's `default` because the
 * catalog is shared with production: flipping it would repoint deployed Workers
 * that still register the old runner, and `python` would become "command not
 * found" for everyone until they redeployed. In code, the cutover ships with
 * the Worker that can serve it.
 *
 * `nimbus install python@0.29.4` still reaches Pyodide — an explicit version is
 * a deliberate request and is left alone.
 */
const SUPERSEDED_RUNTIMES = { python: 'cpython' };
async function resolveRuntimeInstallTarget(env, catalog, spec) {
    const parsed = splitRuntimeSpec(spec);
    const superseding = parsed.versionOverride === null ? SUPERSEDED_RUNTIMES[parsed.name] : undefined;
    if (superseding && catalog.runtimes[superseding]) {
        return {
            runtimeName: superseding,
            versionOverride: null,
            // The name the user typed, so the installer's output still says `python`.
            requestedName: parsed.name,
        };
    }
    if (catalog.runtimes[parsed.name]) {
        return {
            runtimeName: parsed.name,
            versionOverride: parsed.versionOverride,
            requestedName: parsed.name,
        };
    }
    // Command-name aliasing is catalog-driven: any command a runtime
    // provides (manifest entrypoints + RUNTIME_EXTRA_ENTRYPOINTS) resolves
    // to that runtime, so `nimbus install python3|pip|gem|wasm-ld` all
    // work without a hand-maintained alias map.
    for (const [runtimeName, entry] of Object.entries(catalog.runtimes)) {
        // A superseded runtime does not answer for a command name either. It still
        // declares `python` and `python3`, it comes first in the catalog, and its
        // runner is no longer registered — so `nimbus install python3` installed
        // Pyodide and left two bins nothing could invoke, while `nimbus install
        // python` next to it installed CPython. The successor declares the same
        // commands and is reached further down this same loop.
        if (parsed.versionOverride === null
            && SUPERSEDED_RUNTIMES[runtimeName]
            && catalog.runtimes[SUPERSEDED_RUNTIMES[runtimeName]])
            continue;
        const version = entry.default;
        const versionEntry = entry.versions[version];
        if (!versionEntry)
            continue;
        try {
            const manifest = await fetchManifest(env, versionEntry);
            if (runtimeEntrypoints(manifest).some((ep) => ep.binName === parsed.name)) {
                return {
                    runtimeName,
                    versionOverride: parsed.versionOverride,
                    requestedName: parsed.name,
                };
            }
        }
        catch {
            // A bad manifest should not prevent canonical catalog names from
            // resolving; it only suppresses bin-name aliasing for that runtime.
        }
    }
    return null;
}
export function createRuntimeCommandHintResolver(env) {
    let hintsPromise = null;
    const loadHints = async () => {
        const catalog = await fetchCatalog(env);
        const hints = new Map();
        const add = (command, runtimeName) => {
            if (!command || command.includes('/'))
                return;
            if (!hints.has(command)) {
                hints.set(command, { command, runtimeName, installSpec: command });
            }
        };
        for (const runtimeName of Object.keys(catalog.runtimes)) {
            add(runtimeName, runtimeName);
        }
        for (const [runtimeName, entry] of Object.entries(catalog.runtimes)) {
            const versionEntry = entry.versions[entry.default];
            if (!versionEntry)
                continue;
            try {
                const manifest = await fetchManifest(env, versionEntry);
                for (const ep of runtimeEntrypoints(manifest))
                    add(ep.binName, runtimeName);
            }
            catch {
                // Hints are best-effort UX. Install itself still surfaces the
                // manifest/catalog error through the normal package-manager path.
            }
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
export async function listAvailableRuntimes(env) {
    const catalog = await fetchCatalog(env);
    return Object.entries(catalog.runtimes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => ({
        name,
        abi: runtimeAbiForCatalogName(name),
        defaultVersion: entry.default,
        versions: Object.entries(entry.versions)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([version, v]) => ({
            version,
            sizeBytes: v.size_bytes,
            license: v.license,
        })),
    }));
}
export async function installRuntimeProgrammatic(deps, spec, opts = {}) {
    const stdout = [];
    const stderr = [];
    let programmaticCred = CRED_KERNEL;
    const ctx = {
        pid: 0,
        get cred() { return programmaticCred; },
        setUmask: (umask) => { programmaticCred = { ...programmaticCred, umask }; },
        runAs: async () => 126,
        args: [],
        env: {},
        cwd: deps.getHome(),
        stdout: { write: (s) => stdout.push(String(s)) },
        stderr: { write: (s) => stderr.push(String(s)) },
    };
    const args = opts.force ? ['--reinstall', spec] : [spec];
    const exitCode = await runInstall(args, ctx, { ...deps, vfs: deps.vfs.as(CRED_KERNEL) });
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
 * Build the shell-command handler that implements `nimbus install …`,
 * `nimbus uninstall …`. Registered under the name `nimbus`.
 */
export function makeNimbusVerbHandler(deps) {
    const { env, registry, getHome, warmRuntime } = deps;
    const vfs = deps.vfs.as(CRED_KERNEL);
    return async function nimbus(ctx) {
        const argv = ctx.args || [];
        const verb = argv[0];
        const rest = argv.slice(1);
        if (verb === 'install') {
            return runInstall(rest, ctx, { env, vfs, registry, getHome, warmRuntime });
        }
        if (verb === 'uninstall') {
            return runUninstall(rest, ctx, { vfs, registry, getHome });
        }
        // Unknown verb.
        ctx.stderr.write(`nimbus: unknown subcommand '${verb || '(none)'}'\n`);
        ctx.stderr.write(`usage: nimbus install <name>[@<version>] | nimbus install --list | nimbus install --available | nimbus uninstall <name>\n`);
        return 2;
    };
}
// ── install ──────────────────────────────────────────────────────────
async function runInstall(args, ctx, deps) {
    // Flag parsing.
    const listOnly = args.includes('--list');
    const availOnly = args.includes('--available');
    const force = args.includes('--reinstall') || args.includes('--force');
    const positional = args.filter((a) => !a.startsWith('--'));
    if (listOnly)
        return runList(ctx, deps);
    if (availOnly)
        return runAvailable(ctx, deps);
    if (positional.length === 0) {
        ctx.stderr.write('nimbus install: missing runtime name\n');
        ctx.stderr.write('usage: nimbus install <name>[@<version>]\n');
        return 2;
    }
    const spec = positional[0];
    // Fetch catalog.
    let catalog;
    try {
        catalog = await fetchCatalog(deps.env);
    }
    catch (e) {
        ctx.stderr.write(`nimbus install: ${e?.message || e}\n`);
        return 1;
    }
    const target = await resolveRuntimeInstallTarget(deps.env, catalog, spec);
    if (!target) {
        const parsed = splitRuntimeSpec(spec);
        ctx.stderr.write(`nimbus install: '${parsed.name}' is not in catalog\n`);
        ctx.stderr.write(`nimbus install: try 'nimbus install --available' to see installable runtimes\n`);
        return 1;
    }
    const name = target.runtimeName;
    const runtimeEntry = catalog.runtimes[name];
    const version = target.versionOverride || runtimeEntry.default;
    const versionEntry = runtimeEntry.versions[version];
    if (!versionEntry) {
        ctx.stderr.write(`nimbus install: '${name}@${version}' not in catalog\n`);
        return 1;
    }
    const home = deps.getHome();
    const root = installRoot(home, name, version);
    // Idempotent: if manifest already on disk + sha-equivalent, skip.
    if (!force && deps.vfs.exists(`${root}/manifest.json`)) {
        // We could re-verify all blob sha256s, but that's expensive. The
        // manifest's presence implies the install completed; we trust it.
        ctx.stdout.write(`[${name}] already installed at ${root} (use --reinstall to refetch)\n`);
        // Still re-register bins in case the registry lost them — idempotent.
        rehydrateInstalledRuntimesView(deps.vfs, deps.registry, home, runnerFactoryFor);
        let manifest = null;
        try {
            manifest = parseRuntimeManifest(JSON.parse(deps.vfs.readFileString(`${root}/manifest.json`)));
        }
        catch {
            manifest = null;
        }
        if (manifest) {
            await warmRuntimeIfConfigured(ctx, deps, {
                name,
                version,
                root,
                manifest,
            });
        }
        return 0;
    }
    // Fetch manifest from R2.
    ctx.stdout.write(`[${name}] fetching manifest...\n`);
    let manifest;
    try {
        manifest = await fetchManifest(deps.env, versionEntry);
    }
    catch (e) {
        ctx.stderr.write(`nimbus install: ${e?.message || e}\n`);
        return 1;
    }
    // Pre-flight: budget check.
    const totalBytes = manifest.files.reduce((a, f) => a + f.size, 0);
    ctx.stdout.write(`[${name}] manifest: ${manifest.files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB\n`);
    // Create install root.
    deps.vfs.mkdir(root, { recursive: true });
    // Write manifest.json first (so a partial install can be retried
    // and the manifest is the source of truth).
    deps.vfs.writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
    // W2: bounded-parallel blob fetch (concurrency=3).
    //
    // Pre-W2 this was a serial for-loop awaiting fetchBlob one at a time.
    // For multi-blob bundles (clang has 5 blobs with the two largest
    // dominating wall-clock at ~31 MB + ~19 MB), overlap of network/L2
    // reads cuts cold-install wall-clock by 30-50%. Concurrency capped
    // at 3 to bound memory peak: worst-case clang holds 3 in-flight
    // blobs ≈ ~50-60 MB; well under the DO's 128 MB cap.
    //
    // mkdir-parent is hoisted OUT of the worker body so concurrent
    // workers don't race against vfs.mkdir for the same parent. Each
    // unique parent dir is created exactly once, synchronously, BEFORE
    // any worker starts.
    //
    // Manifest-first invariant preserved: this loop runs AFTER the
    // manifest.json write above. Partial-install detection unchanged.
    //
    // Progress UX: with parallel workers, lines arrive in completion
    // order, not start order. The final "[name] installed at … (Y MiB)"
    // line is still the authoritative completion signal.
    const FETCH_CONCURRENCY = 3;
    // Pre-compute + create all unique parent dirs sync. Avoids a
    // mkdir race between workers and is faster than per-blob exists()
    // checks.
    const uniqueParents = new Set();
    for (const f of manifest.files) {
        const target = `${root}/${f.path}`;
        const lastSlash = target.lastIndexOf('/');
        if (lastSlash > 0) {
            uniqueParents.add(target.slice(0, lastSlash));
        }
    }
    for (const parent of uniqueParents) {
        if (!deps.vfs.exists(parent))
            deps.vfs.mkdir(parent, { recursive: true });
    }
    // Hand-rolled worker pool: N workers consume indices off a shared
    // cursor until the queue is empty. Avoids head-of-line blocking
    // that chunked Promise.all suffers (a slow blob in batch i doesn't
    // delay blob i+N from starting).
    const files = manifest.files;
    const total = files.length;
    let nextIdx = 0;
    let completed = 0;
    const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, total) }, async () => {
        while (true) {
            const i = nextIdx++;
            if (i >= total)
                return;
            const f = files[i];
            const target = `${root}/${f.path}`;
            const bytes = await fetchBlob(deps.env, f);
            deps.vfs.writeFile(target, bytes);
            completed++;
            ctx.stdout.write(`[${name}] fetched ${f.path} (${(f.size / 1024 / 1024).toFixed(2)} MiB) ${completed}/${total}\n`);
        }
    });
    await Promise.all(workers);
    // Register entrypoints.
    for (const ep of runtimeEntrypoints(manifest)) {
        const factory = runnerFactoryFor(ep.runner);
        if (!factory) {
            ctx.stderr.write(`[${name}] warning: runner '${ep.runner}' not registered; bin '${ep.binName}' will not be invokable\n`);
            continue;
        }
        const handler = factory(manifest, root, ep.binName, ep.kind);
        deps.registry.register(ep.binName, handler);
    }
    ctx.stdout.write(`[${name}] installed at ${root} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)\n`);
    await warmRuntimeIfConfigured(ctx, deps, {
        name,
        version,
        root,
        manifest,
    });
    return 0;
}
async function warmRuntimeIfConfigured(ctx, deps, target) {
    if (!deps.warmRuntime)
        return;
    try {
        await deps.warmRuntime(target, ctx);
    }
    catch (e) {
        ctx.stderr.write(`[${target.name}] warning: runtime warm-up failed: ${e?.message || e}\n`);
    }
}
// ── --list ───────────────────────────────────────────────────────────
async function runList(ctx, deps) {
    const home = deps.getHome();
    const installed = listInstalledManifestsView(deps.vfs, home);
    if (installed.length === 0) {
        ctx.stdout.write('(no runtimes installed)\n');
        return 0;
    }
    ctx.stdout.write(`installed runtimes (${installed.length}):\n`);
    for (const { root, manifest } of installed) {
        const totalBytes = manifest.files.reduce((a, f) => a + f.size, 0);
        const bins = runtimeEntrypoints(manifest).map((e) => e.binName).join(', ');
        ctx.stdout.write(`  ${manifest.name}@${manifest.version}  abi=${runtimeAbiForManifest(manifest)}  ${(totalBytes / 1024 / 1024).toFixed(1)} MiB  bins=[${bins}]  ${root}\n`);
    }
    return 0;
}
// ── --available ──────────────────────────────────────────────────────
async function runAvailable(ctx, deps) {
    let catalog;
    try {
        catalog = await fetchCatalog(deps.env);
    }
    catch (e) {
        ctx.stderr.write(`nimbus install --available: ${e?.message || e}\n`);
        return 1;
    }
    const names = Object.keys(catalog.runtimes).sort();
    if (names.length === 0) {
        ctx.stdout.write('(no runtimes in catalog)\n');
        return 0;
    }
    ctx.stdout.write(`available runtimes (${names.length}):\n`);
    for (const name of names) {
        const r = catalog.runtimes[name];
        const versions = Object.keys(r.versions);
        ctx.stdout.write(`  ${name}  abi=${runtimeAbiForCatalogName(name)}  default=${r.default}  versions=[${versions.join(', ')}]\n`);
        for (const v of versions) {
            const ve = r.versions[v];
            ctx.stdout.write(`    ${v}  ${(ve.size_bytes / 1024 / 1024).toFixed(1)} MiB  license=${ve.license}\n`);
        }
    }
    return 0;
}
// ── uninstall ────────────────────────────────────────────────────────
async function runUninstall(args, ctx, deps) {
    if (args.length === 0 || args[0].startsWith('--')) {
        ctx.stderr.write('nimbus uninstall: missing runtime name\n');
        return 2;
    }
    const spec = args[0];
    const atIdx = spec.indexOf('@');
    const name = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
    const versionOverride = atIdx >= 0 ? spec.slice(atIdx + 1) : null;
    const home = deps.getHome();
    const installed = listInstalledManifestsView(deps.vfs, home);
    const matches = installed.filter((x) => x.manifest.name === name && (!versionOverride || x.manifest.version === versionOverride));
    if (matches.length === 0) {
        ctx.stderr.write(`nimbus uninstall: '${name}' is not installed\n`);
        return 1;
    }
    for (const m of matches) {
        // Unregister bins.
        for (const ep of runtimeEntrypoints(m.manifest)) {
            // We don't have a guaranteed `unregister`; bins shadowing is OK
            // because boot-rehydration only re-registers what's still on disk.
            if (typeof deps.registry.unregister === 'function') {
                deps.registry.unregister(ep.binName);
            }
        }
        if (deps.vfs.exists(m.root))
            deps.vfs.removeRecursive(m.root);
        ctx.stdout.write(`[${m.manifest.name}@${m.manifest.version}] uninstalled (removed ${m.root})\n`);
    }
    // Clean up empty parent dirs (~/.nimbus/runtimes/<name>/ if no
    // versions left; runtimes/ if no runtimes left).
    const runtimeDir = `${home.replace(/^\/+/, '').replace(/\/+$/, '')}/.nimbus/runtimes/${name}`;
    cleanupEmpty(deps.vfs, runtimeDir);
    cleanupEmpty(deps.vfs, `${home.replace(/^\/+/, '').replace(/\/+$/, '')}/.nimbus/runtimes`);
    return 0;
}
function cleanupEmpty(vfs, path) {
    if (!vfs.exists(path))
        return;
    if (vfs.readdir(path).length === 0) {
        vfs.rmdir(path);
    }
}
