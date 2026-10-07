/**
 * staged-bindings.ts — the staged threadless napi-rs bindings.
 *
 * rolldown, satteri and the Astro compiler ship their N-API bindings as
 * platform `.node` shards plus one wasm build for wasm32-wasip1-threads; a
 * Worker isolate can run neither. scripts/napi-wasm/build.mjs builds each for
 * plain wasm32-wasip1 (emnapi's non-threaded N-API, Nimbus's WASI filesystem
 * codec, and for rolldown a tokio current-thread runtime the loader pumps from
 * the event loop), and scripts/bundle-napi-wasm.mjs stages them under
 * public/_assets/napi-wasm/ with every file's SHA-256 pinned.
 *
 * A node process whose closure requires any of them carries the shared loader
 * (ESM), the shared wasi trampoline, and each binding it requires: by value in
 * a one-shot, by kernel-owned VFS path in a resident process, where a
 * multi-megabyte member held inline would stay in the coordinator's heap for
 * the process's life. The generated main module registers each binding on
 * `globalThis.__nimbusStagedBindings` under every package name its owner
 * requires it by, and node-shims answers that `require` from there (see
 * __loadStagedBinding in node-shims.ts).
 *
 * Every byte is verified against its pinned digest on both cache tiers
 * before it is compiled or evaluated, as for the opencode artifact.
 */
import { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, STAGED_BINDING_ARTIFACTS, } from '../napi-wasm-artifacts.generated.js';
import { fetchStagedBytes, stagedAsset } from './staged-source.js';
import { packageRootOf } from '../facets/data-plan.js';
export { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE };
/** Module-map names of the members every launch with a staged binding carries. */
export const STAGED_BINDING_LOADER_MODULE = 'nimbus-napi-wasm-loader.js';
export const STAGED_BINDING_TRAMPOLINE_MODULE = 'nimbus-napi-wasm-trampoline.wasm';
const quoted = (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export const STAGED_BINDINGS = STAGED_BINDING_ARTIFACTS.map((artifact) => ({
    ...artifact,
    moduleName: `nimbus-staged-${artifact.name}.wasm`,
    vfsPath: `/var/lib/nimbus/staged/${artifact.name}/${artifact.version}/${artifact.name}.wasm`,
    specifier: new RegExp(`["'](?:${artifact.requiredAs.map(quoted).join('|')})["']`),
}));
/** The staged binding named `name`; a name no build produced is a programming error. */
export function stagedBinding(name) {
    const binding = STAGED_BINDINGS.find((b) => b.name === name);
    if (!binding)
        throw new Error(`Nimbus: no staged napi binding named ${name}`);
    return binding;
}
/** Names of the staged bindings a closure requires, in table order. */
export function stagedBindingsRequiredBy(cells) {
    const required = new Set();
    for (const [path, cell] of cells) {
        if (typeof cell !== 'string')
            continue;
        if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')))
            continue;
        for (const binding of STAGED_BINDINGS) {
            if (!required.has(binding.name) && binding.specifier.test(cell))
                required.add(binding.name);
        }
        if (required.size === STAGED_BINDINGS.length)
            break;
    }
    return STAGED_BINDINGS.filter((b) => required.has(b.name)).map((b) => b.name);
}
/** Most filesystem questions stagedBindingsDeclaredBy asks: package.json reads and node_modules probes. */
export const DECLARED_BINDING_PROBES = 1024;
const DECLARED_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
/**
 * Names of the staged bindings a launched bin's own dependency tree installs,
 * in table order: a binding's owner at the binding's version, reached through
 * the declared dependencies (dependencies, optionalDependencies,
 * peerDependencies) of the bin's package and of every package those resolve
 * to. Each name resolves as Node's resolver finds it, from the package that
 * declares it: its own node_modules, then each ancestor's, through links to
 * where the package really is. So the version matched is the one installed
 * where the requiring code would load it (__loadStagedBinding checks the
 * same), and a nested copy at another version is not taken for a hoisted
 * one.
 *
 * A closure names a binding only when its owner is in it, and a program can
 * reach the owner by a specifier no walk follows: Nuxt 4 loads its builder
 * with `if (builder === "@nuxt/vite-builder") return await import(builder)`,
 * and Vite then loads rolldown. The binding is compiled with the launch or not
 * at all, so a launch decided by its closure alone failed `nuxt dev` on its
 * first run ("Cannot find native binding"). Registering a binding creates
 * nothing (stagedBindingsFacetImport); only a require of it does.
 *
 * Asks at most `limit` questions (a package.json read, or whether a
 * directory has node_modules), and stops once every binding is found; a
 * declared name that is a binding's owner is checked when it is declared,
 * not when the breadth-first walk reaches it. A bin outside node_modules (a
 * program of the user's own) declares nothing here.
 */
export async function stagedBindingsDeclaredBy(fs, scriptPath, limit = DECLARED_BINDING_PROBES, 
/** Filled in with the questions asked, for a launch's diagnostics. */
stats) {
    if (scriptPath === undefined)
        return [];
    const strip = (path) => path.replace(/^\/+/, '');
    const script = await fs.realpath(scriptPath);
    const root = script === null ? null : packageRootOf(strip(script));
    if (root === null)
        return [];
    const owners = new Map();
    for (const binding of STAGED_BINDINGS)
        owners.set(binding.owner, [...(owners.get(binding.owner) ?? []), binding]);
    const found = new Set();
    let probes = 0;
    const manifests = new Map();
    const manifestOf = async (dir) => {
        if (manifests.has(dir))
            return manifests.get(dir);
        if (probes >= limit)
            return null;
        probes++;
        let manifest = null;
        const text = await fs.readText('/' + dir + '/package.json');
        if (text !== null) {
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    manifest = parsed;
            }
            catch {
                // Not a manifest: nothing installed here.
            }
        }
        manifests.set(dir, manifest);
        return manifest;
    };
    const modulesDirs = new Map();
    const hasModules = async (at) => {
        const dir = (at ? at + '/' : '') + 'node_modules';
        if (modulesDirs.has(dir))
            return modulesDirs.get(dir);
        if (probes >= limit)
            return false;
        probes++;
        const present = await fs.exists('/' + dir);
        modulesDirs.set(dir, present);
        return present;
    };
    // Node's node_modules lookup from `dir`: its own, then each ancestor's that is not one itself.
    const resolveFrom = async (dir, name) => {
        for (let at = dir; at !== null; at = at === '' ? null : at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : '') {
            if (at === 'node_modules' || at.endsWith('/node_modules'))
                continue;
            if (!await hasModules(at))
                continue;
            const candidate = (at ? at + '/' : '') + 'node_modules/' + name;
            if (await manifestOf(candidate) === null)
                continue;
            const real = await fs.realpath('/' + candidate);
            return real === null ? candidate : strip(real);
        }
        return null;
    };
    const take = (manifest) => {
        for (const binding of typeof manifest.name === 'string' ? owners.get(manifest.name) ?? [] : []) {
            if (manifest.version === binding.version)
                found.add(binding.name);
        }
    };
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length > 0 && found.size < STAGED_BINDINGS.length && probes < limit) {
        const dir = queue.shift();
        const manifest = await manifestOf(dir);
        if (manifest === null)
            continue;
        take(manifest);
        for (const field of DECLARED_FIELDS) {
            const declared = manifest[field];
            if (!declared || typeof declared !== 'object')
                continue;
            for (const name of Object.keys(declared)) {
                const at = await resolveFrom(dir, name);
                if (at === null || seen.has(at))
                    continue;
                seen.add(at);
                queue.push(at);
                if (owners.has(name)) {
                    const owner = await manifestOf(at);
                    if (owner !== null)
                        take(owner);
                }
            }
        }
    }
    if (stats)
        stats.probes = probes;
    return STAGED_BINDINGS.filter((b) => found.has(b.name)).map((b) => b.name);
}
/**
 * The colo-cache key of one staged file: its path and its own digest. A
 * binding rebuilt at the same version keeps its path, and a key shared with
 * the old bytes (the loader's build id was) found them in a warm colo's cache
 * and refused them as poisoned.
 */
export function stagedBindingCacheKey(asset) {
    return `https://nimbus-cache.invalid${asset.path}?sha256=${asset.sha256}`;
}
/** Fetch one staged file, verified against its pinned digest. */
export function fetchStagedBindingAsset(env, asset) {
    return fetchStagedBytes(env, stagedAsset({
        label: 'staged napi binding',
        path: asset.path,
        l2Key: stagedBindingCacheKey(asset),
        sha256: asset.sha256,
        requiredBy: 'staged napi bindings',
        stagedBy: 'scripts/bundle-napi-wasm.mjs',
    }));
}
/**
 * The main-module block that registers `names`. It imports the shared loader
 * and trampoline and each binding, and hands node-shims one factory per
 * binding, registered under every package name it is required by; nothing is
 * instantiated until the program actually requires it.
 */
export function stagedBindingsFacetImport(names) {
    if (!names || names.length === 0)
        return '';
    const lines = [
        `import { createNapiWasmBinding as __nimbusCreateNapiWasmBinding } from ${JSON.stringify(STAGED_BINDING_LOADER_MODULE)};`,
        `import __nimbusNapiWasmTrampoline from ${JSON.stringify(STAGED_BINDING_TRAMPOLINE_MODULE)};`,
        `const __nimbusStagedBindingRegistry = (globalThis.__nimbusStagedBindings ??= new Map());`,
    ];
    names.forEach((name, i) => {
        const binding = stagedBinding(name);
        const module = `__nimbusStagedBinding${i}`;
        lines.push(`import ${module} from ${JSON.stringify(binding.moduleName)};`, `{`, `  const entry = {`, `    owner: ${JSON.stringify(binding.owner)},`, `    version: ${JSON.stringify(binding.version)},`, `    create: (host) => __nimbusCreateNapiWasmBinding({ ...host, binding: ${module}, trampoline: __nimbusNapiWasmTrampoline, memoryPages: ${binding.memoryPages}, name: ${JSON.stringify(binding.name)} }),`, `  };`, ...binding.requiredAs.map((id) => `  __nimbusStagedBindingRegistry.set(${JSON.stringify(id)}, entry);`), `}`);
    });
    return lines.join('\n');
}
