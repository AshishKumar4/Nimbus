import { ISOLATE_NETWORK } from '../../../../_shared/workspace-network.js';
import { resolveContext } from '../registry.js';
import { resolve, join } from '../../utils/path.js';
import { writeTarballStream } from '../../../../_shared/tarball.js';
import { isNativeBinPath } from '../../../../runtime/os-contracts.js';
import { npmBinMap } from '../../../../runtime/npm-bin-map.js';
import { pickPackumentVersion } from '../../../../_shared/npm-semver.js';
import { packageRangeSeparator, parseRegistryRequest } from '../../../../_shared/npm-spec.js';
import { MAX_NEST_DEPTH, decidePlacement, placementName, visiblePlacements } from '../../../../_shared/npm-placement.js';
import { sriDigestOf, sriDigestsEqual, strongestSriEntry } from '../../../../_shared/tarball-integrity.js';
import { RegistryPackumentSchema, RegistrySearchResponseSchema, renderSearchTable, } from './registry-schemas.js';
import { parseNpmInstallInvocation, } from './npm-install-args.js';
import { installSummary, npmLogEnabled } from './npm-log.js';
import { direntTypeIn } from '../../../../vfs/dirent-type.js';
/** The registry an install reads from when its env names none. */
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const NPM_VERSION = '10.0.0';
/** The end-of-install report (installSummary), on the command's own streams. */
async function writeInstallSummary(ctx, installed, failed, opts) {
    const { stdout, stderr } = installSummary({ ...opts, installed: installed.length, failed, elapsedMs: Date.now() - opts.startedAt });
    if (stderr)
        await ctx.stderr.write(stderr);
    if (stdout)
        await ctx.stdout.write(stdout);
}
// ─── Helpers ───
/**
 * The registry origin an install uses: the command's `NPM_REGISTRY`, else
 * the default. Normalized once, here, where the setting is read: blank is
 * unset, and a trailing slash is trimmed so one origin spelled two ways
 * shares one cache namespace downstream.
 */
export function npmRegistryOrigin(configured) {
    const trimmed = configured?.trim();
    return (trimmed ? trimmed : NPM_REGISTRY_ORIGIN).replace(/\/+$/, '');
}
function getRegistry(env) {
    return npmRegistryOrigin(env.NPM_REGISTRY);
}
/** `name[@range]` split where npm's npa splits it (core _shared/npm-spec.ts). */
function parsePackageSpec(spec) {
    const at = packageRangeSeparator(spec);
    return at === -1 ? { name: spec, version: null } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}
// ─── Registry fetch ───
function encodePackageName(name) {
    return name.startsWith('@')
        ? '@' + encodeURIComponent(name.slice(1))
        : encodeURIComponent(name);
}
/**
 * The version `version` (a range, an exact version, a dist-tag, an
 * `npm:<package>@<range>` alias, or none) installs, picked from the
 * packument by the rule the worker's resolver picks with (core
 * _shared/npm-spec.ts parseRegistryRequest, npm-semver.ts
 * pickPackumentVersion).
 */
async function fetchPackageInfo(network, registry, name, version, signal) {
    const request = parseRegistryRequest(name, version ?? '');
    const url = `${registry}/${encodePackageName(request.registryName)}`;
    const response = await network.fetch(url, {
        signal,
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(`Package '${name}${version ? '@' + version : ''}' not found in registry`);
        }
        throw new Error(`Registry returned ${response.status} ${response.statusText}`);
    }
    const data = RegistryPackumentSchema.parse(await response.json());
    const picked = pickPackumentVersion(data.versions, data['dist-tags'], request.range);
    const info = picked === null || !Object.hasOwn(data.versions, picked) ? undefined : data.versions[picked];
    if (!info) {
        throw new Error(`No version of '${request.registryName}' satisfies '${request.range}'`);
    }
    return info;
}
/**
 * Download a tarball, check it against `integrity` as an install checks it
 * (core _shared/tarball-integrity.ts: the strongest entry, as npm's ssri
 * does), and only then write it out.
 */
async function fetchAndStreamPackage(network, tarballUrl, integrity, targetDir, vfs, signal, stderr) {
    const response = await network.fetch(tarballUrl, { signal });
    if (!response.ok) {
        throw new Error(`Failed to download tarball: ${response.status}`);
    }
    if (!response.body)
        throw new Error(`Registry served no body for ${tarballUrl}`);
    const sri = integrity ? strongestSriEntry(integrity) : null;
    if (sri === null) {
        if (integrity)
            await stderr.write(`npm WARN integrity "${integrity}" names no algorithm npm checks; skipped verification\n`);
        return (await writeTarballStream(response.body, targetDir, vfs));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const got = await sriDigestOf(bytes, sri.digestAlgo);
    if (!sriDigestsEqual(got, sri.digest)) {
        throw new Error(`integrity mismatch for ${tarballUrl}: expected ${sri.algo}-${sri.digest}, got ${sri.algo}-${got}`);
    }
    return (await writeTarballStream(new Response(bytes).body, targetDir, vfs));
}
async function readProjectPackageJson(vfs, cwd) {
    const pkgPath = join(cwd, 'package.json');
    try {
        return JSON.parse((await vfs.readFileString(pkgPath)));
    }
    catch {
        return null;
    }
}
async function writeProjectPackageJson(vfs, cwd, pkg) {
    const pkgPath = join(cwd, 'package.json');
    (await vfs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n'));
}
/** A package's bins, name -> target inside the package, as npm installs them (npmBinMap). */
/**
 * The packages in a node_modules directory, by name (`pkg` or `@scope/pkg`):
 * each entry that is a directory or a link (an `npm link`ed or workspace
 * package), a scope's entries in its place. Names starting with `.` (`.bin`,
 * `.package-lock.json`) are npm's own files, not packages; a directory that
 * cannot be read holds none.
 */
export async function* packagesIn(vfs, modulesDir) {
    const read = async (dir) => {
        try {
            return await vfs.readdir(dir);
        }
        catch {
            return [];
        }
    };
    for (const entry of await read(modulesDir)) {
        if (entry.name.startsWith('.'))
            continue;
        const type = await direntTypeIn(vfs, modulesDir, entry);
        if (type !== 'directory' && type !== 'symlink')
            continue;
        if (!entry.name.startsWith('@')) {
            yield entry.name;
            continue;
        }
        const scopeDir = join(modulesDir, entry.name);
        for (const child of await read(scopeDir)) {
            const childType = await direntTypeIn(vfs, scopeDir, child);
            if (childType === 'directory' || childType === 'symlink')
                yield `${entry.name}/${child.name}`;
        }
    }
}
export function getBinEntries(pkg) {
    return Object.fromEntries(npmBinMap(pkg.name ?? '', pkg.bin));
}
export function registerBinCommand(registry, binName, scriptPath, kernel) {
    registry.registerLazy(binName, () => import('./node.js').then((mod) => ({
        default: (async (ctx) => {
            // Use kernel's portRegistry if available, otherwise fall back to default
            const nodeCommand = kernel ? mod.createNodeCommand(kernel) : mod.default;
            return (await nodeCommand({
                ...ctx,
                args: [scriptPath, ...ctx.args],
            }));
        }),
    })));
}
/**
 * The edges a manifest asks for from `from`: one per name among its
 * dependencies and optional ones (an optionalDependencies entry overrides
 * a dependencies one, as npm reads them), and the peers it requires.
 */
function manifestEdges(manifest, from) {
    const byName = new Map();
    for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
        byName.set(name, { name, range, from, kind: 'dep', optional: false });
    for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {}))
        byName.set(name, { name, range, from, kind: 'dep', optional: true });
    const edges = [...byName.values()];
    const optionalPeers = manifest.peerDependenciesMeta ?? {};
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (optionalPeers[name]?.optional !== true && !byName.has(name))
            edges.push({ name, range, from, kind: 'peer', optional: false });
    }
    return edges;
}
/**
 * Installs into one node_modules tree, one at a time: each waits for the one
 * before it (installTreeLocked). Keyed by the tree's namespace (a workspace's
 * kernel) and its canonical path there, so two paths to one tree (a prefix
 * through a symlink) are one queue.
 */
const installQueues = new WeakMap();
const NO_KERNEL = {};
/**
 * Where `path` is: its deepest existing ancestor resolved through symlinks
 * (realpath), and the rest of it, which does not exist yet.
 */
async function canonicalTreePath(vfs, path) {
    let existing = path;
    let rest = '';
    while (existing !== '/' && existing !== '') {
        try {
            return (await vfs.realpath(existing)).replace(/\/+$/, '') + rest;
        }
        catch {
            const slash = existing.lastIndexOf('/');
            rest = existing.slice(slash) + rest;
            existing = slash > 0 ? existing.slice(0, slash) : '/';
        }
    }
    return rest || '/';
}
/** `run` once no other install into the tree at `targetBase` in this isolate is running. */
async function installTreeLocked(vfs, kernel, targetBase, run) {
    const namespace = kernel ?? NO_KERNEL;
    const queues = installQueues.get(namespace) ?? new Map();
    installQueues.set(namespace, queues);
    const key = await canonicalTreePath(vfs, targetBase);
    const before = queues.get(key) ?? Promise.resolve();
    const done = before.then(run, run);
    const settled = done.then(() => undefined, () => undefined);
    queues.set(key, settled);
    try {
        return await done;
    }
    finally {
        if (queues.get(key) === settled)
            queues.delete(key);
    }
}
/**
 * A retired copy: the package that was at `<dir>/<name>`, moved aside to
 * `<dir>/.<name>-retired-<run>` while an install replaces it, as arborist
 * retires one (a dot name no resolver asks for). The name says whose copy it
 * is, so an install that finds one whose target is missing (it crashed after
 * retiring) restores it.
 */
const RETIRED = /^\.(.+)-retired-[a-z0-9]+$/;
/** Every retired copy under `dir`'s node_modules trees, with the target it is beside. */
async function retiredCopies(vfs, dir, out = []) {
    let entries;
    try {
        entries = (await vfs.readdir(dir));
    }
    catch {
        return out;
    }
    for (const { name } of entries) {
        const retired = RETIRED.exec(name);
        if (retired) {
            out.push({ retired: join(dir, name), target: join(dir, retired[1]) });
        }
        else if (name.startsWith('@')) {
            await retiredCopies(vfs, join(dir, name), out);
        }
        else if (!name.startsWith('.')) {
            await retiredCopies(vfs, join(dir, name, 'node_modules'), out);
        }
    }
    return out;
}
/**
 * Install `roots` (name and range) and what they depend on under
 * `install.targetBase`, as npm's arborist does it. Its caller holds the
 * node_modules (installTreeLocked) across what it reads and writes besides:
 * the project's package.json.
 *
 * Recover: a retired copy whose target is missing (an install that crashed
 * after retiring it) is moved back first. One whose target is there is left
 * alone: no install deletes a retired copy it did not make.
 *
 * Plan: the whole ideal tree, before anything on disk changes. One
 * breadth-first walk over every root's edges puts each package where the
 * rule both engines share says (core _shared/npm-placement.ts), reading
 * versions and manifests from the registry. A package already on disk is a
 * copy the walk sees, and one it reuses has its own edges walked again, so a
 * replacement elsewhere in the tree (a root upgraded past a dependent's
 * range) nests the copy that dependent needs.
 *
 * A package is optional when every path to it from a root passes through an
 * optionalDependencies edge (a required path wins). One that fails (its
 * manifest, its download, its integrity, its archive) is skipped with what
 * needs it on the way, as arborist skips an optional dependency's set; any
 * other failure fails the install before it changes anything.
 *
 * Reify: every package is fetched, verified and extracted into this run's
 * own staging directory, then published, shallowest first: the package
 * there is retired beside it (RETIRED), the new one moved in, and the old
 * one's own node_modules moved under it. Each step is recorded before it is
 * made; a failure undoes every recorded step in reverse, and a retired copy
 * that could not be restored is kept and named. Retired copies are removed
 * only once every package is published. `failed` names what failed; empty,
 * the install is complete.
 */
async function installTree(roots, install) {
    const { targetBase, vfs, network, npmRegistry, signal, stdout, stderr } = install;
    const describe = (e) => e instanceof Error ? e.message : String(e);
    const fail = async (edge, e) => {
        const message = describe(e);
        if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('CORS')) {
            await stderr.write(`npm ERR! network error fetching ${edge.name}\n`);
            await stderr.write(`This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n`);
        }
        else {
            await stderr.write(`npm ERR! ${edge.name}: ${message}\n`);
        }
        return { installed: 0, failed: [edge.name] };
    };
    // ── Recover ──
    // A staging directory left behind holds only new packages: no install
    // in this isolate is using it while this one holds the node_modules.
    try {
        for (const { name } of (await vfs.readdir(targetBase))) {
            if (name.startsWith('.nimbus-staging-'))
                await vfs.remove(join(targetBase, name), { recursive: true, force: true });
        }
    }
    catch { /* no node_modules yet */ }
    for (const { retired, target } of await retiredCopies(vfs, targetBase)) {
        if (await vfs.exists(target))
            continue;
        try {
            await vfs.rename(retired, target);
            await stderr.write(`npm WARN restored ${target}, retired by an install that did not finish\n`);
        }
        catch (e) {
            await stderr.write(`npm ERR! could not restore ${target}; its copy is kept at ${retired}: ${describe(e)}\n`);
            return { installed: 0, failed: [target] };
        }
    }
    // ── Plan ──
    // Placements on disk (as probed) and planned, by version; their manifests
    // on disk, for a reused package's edges.
    const placed = new Map();
    const onDisk = new Map();
    const pending = new Set();
    const probed = new Set();
    // Placements decided (planned or failed), and those whose edges are walked.
    const settled = new Set();
    const walked = new Set();
    const plan = [];
    // What failed, by placement: optional ones are skipped if they turn out optional.
    const failures = new Map();
    // Who asks for each planned or failed placement, and by which kind of edge.
    const askers = new Map();
    const asked = (at, edge) => {
        const list = askers.get(at) ?? [];
        askers.set(at, list);
        list.push({ from: edge.from, optional: edge.optional });
    };
    const probe = async (placement) => {
        if (probed.has(placement) || placed.has(placement) || pending.has(placement))
            return;
        probed.add(placement);
        try {
            const pkg = JSON.parse(await vfs.readFileString(join(targetBase, placement, 'package.json')));
            if (typeof pkg?.version !== 'string')
                return;
            placed.set(placement, { version: pkg.version });
            onDisk.set(placement, pkg);
        }
        catch { /* not on disk */ }
    };
    let queue = roots.map(([name, range]) => ({ name, range: range ?? '', from: '', kind: 'dep', optional: false }));
    while (queue.length > 0) {
        const layer = [];
        const next = [];
        for (const edge of queue) {
            for (const candidate of visiblePlacements(edge.from, edge.name))
                await probe(candidate);
            const decision = decidePlacement(edge, placed, pending);
            if (decision.kind === 'wait') {
                next.push(edge);
                continue;
            }
            if (decision.kind === 'met') {
                if (decision.mismatch)
                    await stderr.write(`npm WARN peer ${edge.name}@${edge.range} from ${edge.from} is met by ${decision.at}@${placed.get(decision.at).version}\n`);
                // Planned or reused from disk, it is part of the tree this edge reaches.
                asked(decision.at, edge);
                // A package reused from disk: its edges are the tree's too.
                const reused = onDisk.get(decision.at);
                if (reused && !walked.has(decision.at)) {
                    walked.add(decision.at);
                    next.push(...manifestEdges(reused, decision.at));
                }
                continue;
            }
            if (settled.has(decision.at)) {
                asked(decision.at, edge);
                continue;
            }
            if (decision.kind === 'too-deep') {
                settled.add(decision.at);
                await stderr.write(`  warn: could not install ${edge.name}: ${edge.name}@${edge.range} from ${edge.from} would nest deeper than ${MAX_NEST_DEPTH} levels\n`);
                continue;
            }
            pending.add(decision.at);
            asked(decision.at, edge);
            layer.push({ edge, at: decision.at });
        }
        for (const { edge, at } of layer) {
            pending.delete(at);
            settled.add(at);
            await stdout.write(`  ${edge.name}${edge.range ? '@' + edge.range : ''}...\n`);
            let info;
            try {
                info = await fetchPackageInfo(network, npmRegistry, edge.name, edge.range || null, signal);
            }
            catch (e) {
                failures.set(at, { edge, error: e });
                continue;
            }
            // What a copy already here was is replaced: its manifest is not the tree's.
            onDisk.delete(at);
            placed.set(at, { version: info.version });
            walked.add(at);
            plan.push({ edge, at, info });
            next.push(...manifestEdges(info, at));
        }
        queue = next;
    }
    // Required: reached from a root by a path of required edges, through
    // planned and reused packages alike; the rest is optional.
    const required = new Set();
    let grew = true;
    while (grew) {
        grew = false;
        for (const [at, list] of askers) {
            if (!required.has(at) && list.some(({ from, optional }) => !optional && (from === '' || required.has(from)))) {
                required.add(at);
                grew = true;
            }
        }
    }
    // What a failure takes with it: the optional packages that need what failed
    // (by a required edge), and what only they ask for.
    const skipped = new Set();
    const skip = (at) => {
        const queued = [at];
        while (queued.length > 0) {
            const member = queued.pop();
            if (skipped.has(member))
                continue;
            skipped.add(member);
            for (const { from, optional } of askers.get(member) ?? [])
                if (!optional && from !== '' && askers.has(from))
                    queued.push(from);
            for (const [other, list] of askers) {
                if (!skipped.has(other) && !required.has(other) && list.every(({ from }) => skipped.has(from)))
                    queued.push(other);
            }
        }
    };
    const settle = async (at, edge, error) => {
        if (required.has(at))
            return false;
        await stderr.write(`npm WARN optional SKIPPING OPTIONAL DEPENDENCY: ${edge.name}: ${describe(error)}\n`);
        skip(at);
        return true;
    };
    for (const [at, { edge, error }] of failures) {
        if (!(await settle(at, edge, error)))
            return await fail(edge, error);
    }
    // A skipped package already on disk goes, as arborist removes a failed
    // optional set (a reused one, or the copy a skipped one would replace).
    const removals = async () => {
        const out = [];
        for (const at of skipped)
            if (await vfs.exists(join(targetBase, at)))
                out.push(at);
        return out;
    };
    if (plan.every(({ at }) => skipped.has(at)) && (await removals()).length === 0)
        return { installed: 0, failed: [] };
    // ── Reify ──
    const run = Math.random().toString(36).slice(2, 10);
    const staging = join(targetBase, `.nimbus-staging-${run}`);
    const stagedAt = (i) => join(staging, String(i));
    try {
        for (let i = 0; i < plan.length; i++) {
            const { edge, at, info } = plan[i];
            if (skipped.has(at))
                continue;
            try {
                // writeTarballStream throws when the archive carried no manifest
                // and writes package.json last, so a return is a complete package.
                await fetchAndStreamPackage(network, info.dist.tarball, info.dist.integrity, stagedAt(i), vfs, signal, stderr);
            }
            catch (e) {
                if (!(await settle(at, edge, e)))
                    return await fail(edge, e);
            }
        }
        const order = plan.map((_, i) => i)
            .filter((i) => !skipped.has(plan[i].at))
            .sort((x, y) => plan[x].at.split('/node_modules/').length - plan[y].at.split('/node_modules/').length);
        // Each publish (and each removal), its steps recorded before they are made.
        const published = [];
        const retiredFor = (target) => {
            const slash = target.lastIndexOf('/');
            return `${target.slice(0, slash)}/.${target.slice(slash + 1)}-retired-${run}`;
        };
        // The edge whose package the step being made is for, should it fail.
        let current = plan[order[0] ?? 0]?.edge ?? { name: targetBase, range: '', from: '', kind: 'dep' };
        try {
            // Deepest first, so a package goes before the one it is nested in.
            for (const at of (await removals()).sort((x, y) => y.split('/node_modules/').length - x.split('/node_modules/').length)) {
                current = { name: placementName(at), range: '', from: '', kind: 'dep' };
                const target = join(targetBase, at);
                const step = { target, retired: retiredFor(target), steps: new Set() };
                published.push(step);
                step.steps.add('retire');
                await vfs.rename(target, step.retired);
            }
            for (const i of order) {
                current = plan[i].edge;
                const target = join(targetBase, plan[i].at);
                const slash = target.lastIndexOf('/');
                const step = { target, retired: retiredFor(target), steps: new Set() };
                published.push(step);
                if (await vfs.exists(target)) {
                    step.steps.add('retire');
                    await vfs.rename(target, step.retired);
                }
                try {
                    await vfs.mkdir(target.slice(0, slash), { recursive: true });
                }
                catch { /* exists */ }
                step.steps.add('publish');
                await vfs.rename(stagedAt(i), target);
                // The package's files are replaced; what is installed under it stays.
                if (step.steps.has('retire') && await vfs.exists(join(step.retired, 'node_modules')) && !(await vfs.exists(join(target, 'node_modules')))) {
                    step.steps.add('modules');
                    await vfs.rename(join(step.retired, 'node_modules'), join(target, 'node_modules'));
                }
            }
        }
        catch (e) {
            // Undo, newest first: what each recorded step may have done is
            // checked on disk, and a retired copy not put back is kept.
            for (const { target, retired, steps } of published.reverse()) {
                try {
                    if (steps.has('modules') && await vfs.exists(join(target, 'node_modules')) && !(await vfs.exists(join(retired, 'node_modules')))) {
                        await vfs.rename(join(target, 'node_modules'), join(retired, 'node_modules'));
                    }
                    if (steps.has('publish') && (!steps.has('retire') || await vfs.exists(retired)) && await vfs.exists(target)) {
                        await vfs.remove(target, { recursive: true });
                    }
                    if (steps.has('retire') && await vfs.exists(retired) && !(await vfs.exists(target)))
                        await vfs.rename(retired, target);
                }
                catch (undo) {
                    await stderr.write(`npm ERR! could not restore ${target}; its previous copy is kept at ${retired}: ${describe(undo)}\n`);
                }
            }
            return await fail(current, e);
        }
        // Published: the retired copies this run made are the old tree's.
        for (const { retired, steps } of published) {
            if (!steps.has('retire'))
                continue;
            try {
                await vfs.remove(retired, { recursive: true, force: true });
            }
            catch (e) {
                await stderr.write(`npm WARN could not remove ${retired}: ${describe(e)}\n`);
            }
        }
        if (install.globalBinDir) {
            for (const i of order) {
                if (plan[i].edge.from === '')
                    await linkGlobalBins(plan[i].info, join(targetBase, plan[i].at), install.globalBinDir, install);
            }
        }
        return { installed: order.length, failed: [] };
    }
    finally {
        try {
            await vfs.remove(staging, { recursive: true, force: true });
        }
        catch { /* none was made */ }
    }
}
/** Link a globally installed root's bins into the prefix's bin directory, and register them as commands. */
async function linkGlobalBins(info, targetDir, globalBinDir, install) {
    for (const [binName, binPath] of Object.entries(getBinEntries(info))) {
        const scriptPath = resolve(targetDir, binPath);
        registerBinCommand(install.registry, binName, scriptPath, install.kernel);
        try {
            (await install.vfs.mkdir(globalBinDir, { recursive: true }));
        }
        catch { /* exists */ }
        (await install.vfs.writeFile(join(globalBinDir, binName), `#!/usr/bin/env node\nrequire('${scriptPath}');\n`));
    }
}
// ─── Subcommands ───
async function printHelp(ctx) {
    await ctx.stdout.write('Usage: npm <command> [args]\n\n');
    await ctx.stdout.write('Commands:\n');
    await ctx.stdout.write('  init [-y]                  create package.json\n');
    await ctx.stdout.write('  install [pkg...] [-g] [-D] install packages\n');
    await ctx.stdout.write('  ci                         clean install from package-lock.json\n');
    await ctx.stdout.write('  uninstall <pkg> [-g]       remove a package\n');
    await ctx.stdout.write('  list [-g]                  list installed packages\n');
    await ctx.stdout.write('  run <script>               run a package.json script\n');
    await ctx.stdout.write('  start                      run the "start" script\n');
    await ctx.stdout.write('  test                       run the "test" script\n');
    await ctx.stdout.write('  info <pkg>                 show package info from registry\n');
    await ctx.stdout.write('  search <term>              search the npm registry\n');
    await ctx.stdout.write('  -v, --version              print npm version\n');
}
async function npmInit(ctx) {
    const pkgPath = join(ctx.cwd, 'package.json');
    if ((await ctx.vfs.exists(pkgPath))) {
        await ctx.stderr.write('package.json already exists\n');
        return 1;
    }
    const dirName = ctx.cwd.split('/').pop() || 'project';
    const pkg = {
        name: dirName,
        version: '1.0.0',
        description: '',
        main: 'index.js',
        scripts: {
            test: 'echo "Error: no test specified" && exit 1',
        },
        license: 'ISC',
    };
    (await writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg));
    await ctx.stdout.write(`Wrote to ${pkgPath}:\n\n`);
    await ctx.stdout.write(JSON.stringify(pkg, null, 2) + '\n');
    return 0;
}
async function npmInstall(ctx, registry, kernel, deps) {
    const args = ctx.args.slice(1);
    const invocation = parseNpmInstallInvocation(args);
    const packages = invocation.packages;
    // ── Pre-checks the host used to do behind a wrapper ────────────────
    // `npm install -g` needs names (npm says the same); `npm install` needs a
    // package.json when no names were given. Both fire before any work, and
    if (invocation.global && packages.length === 0) {
        await ctx.stderr.write('npm ERR! missing package name for global install\n');
        return 1;
    }
    if (!invocation.global && packages.length === 0) {
        if (!(await ctx.vfs.exists(join(ctx.cwd, 'package.json')))) {
            await ctx.stderr.write('npm ERR! no package.json found\n');
            return 1;
        }
    }
    // The prefix a global install resolves under — `--prefix` wins, then
    // the env's npm_config_prefix, then /usr/local. Both sides derive
    // `<prefix>/lib/node_modules` and `<prefix>/bin` from it.
    const globalPrefix = resolveNpmPrefixVfs(ctx.cwd, ctx.env, invocation.prefix);
    const globalBinDir = `${globalPrefix}/bin`;
    const globalModulesDir = `${globalPrefix}/lib/node_modules`;
    const npmRegistry = getRegistry(ctx.env);
    const startTime = Date.now();
    let installed = 0;
    // ── Host-batched install path ──────────────────────────────────────
    // The port owns install, prefix dirs, and bin materialisation. This
    // command owns the summary and the progress channel — per-invocation,
    // so two terminals' installs can't interleave lines on one installer.
    if (deps?.installer) {
        const npmLog = invocation.loglevel
            ? async (level, line) => { if (npmLogEnabled(invocation.loglevel, level))
                await ctx.stderr.write(`${line}\n`); }
            : null;
        try {
            const result = await deps.installer.install({
                projectDir: ctx.cwd,
                packages,
                global: invocation.global,
                globalPrefix: invocation.global ? globalPrefix : undefined,
                pid: ctx.pid,
                registry: npmRegistry,
                production: invocation.production,
                npmLog,
                onProgress: async (line) => await ctx.stdout.write(`[npm] ${line}\n`),
            });
            await writeInstallSummary(ctx, result.installed, result.failed, {
                totalFiles: result.totalFiles,
                fromCacheHits: result.fromCacheHits,
                linkedBins: result.linkedBins,
                globalBinDir,
                startedAt: startTime,
            });
            return result.failed.length > 0 ? 1 : 0;
        }
        catch (err) {
            await ctx.stderr.write(`\x1b[31mnpm install failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
            return 1;
        }
    }
    // ── In-process fallback ────────────────────────────────────────────
    // Same parse + same summary; the target tree derives from the resolved
    // prefix so --prefix and npm_config_prefix do what they say.
    const targetBase = invocation.global ? globalModulesDir : join(ctx.cwd, 'node_modules');
    if (invocation.global) {
        for (const dir of [globalModulesDir, globalBinDir]) {
            try {
                (await ctx.vfs.mkdir(dir, { recursive: true }));
            }
            catch { /* exists */ }
        }
    }
    const failed = [];
    const tree = {
        targetBase, vfs: ctx.vfs, network: kernel?.network ?? ISOLATE_NETWORK, npmRegistry, signal: ctx.signal,
        stdout: ctx.stdout, stderr: ctx.stderr, registry, kernel,
        ...(invocation.global ? { globalBinDir } : {}),
    };
    // The project's package.json is read and written under the node_modules
    // lock with the tree, so two installs at once add to it one after the
    // other.
    const status = await installTreeLocked(ctx.vfs, kernel, targetBase, async () => {
        // One plan for every root: the project's dependencies (a local install's)
        // with the packages named on the command line, which win their names.
        const project = invocation.global ? null : (await readProjectPackageJson(ctx.vfs, ctx.cwd));
        if (packages.length === 0 && !project) {
            await ctx.stderr.write('npm ERR! no package.json found\n');
            return 1;
        }
        const named = packages.map(parsePackageSpec);
        const roots = new Map(Object.entries({ ...project?.dependencies, ...project?.devDependencies }));
        for (const { name, version } of named)
            roots.set(name, version);
        if (roots.size === 0) {
            await ctx.stdout.write('up to date, audited 0 packages\n');
            return 0;
        }
        await ctx.stdout.write(packages.length === 0 ? 'Installing dependencies...\n' : 'Installing packages...\n');
        const result = await installTree([...roots], tree);
        installed += result.installed;
        failed.push(...result.failed);
        // What the command line named is saved to package.json, once it installed.
        if (result.failed.length === 0 && project && named.length > 0) {
            try {
                const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd)) ?? project;
                for (const { name } of named) {
                    let versionStr = 'latest';
                    try {
                        const ipkg = JSON.parse((await ctx.vfs.readFileString(join(targetBase, name, 'package.json'))));
                        // An alias (`mine@npm:real@^1`) saves the package it
                        // installed, as npm does: "mine": "npm:real@^1.1.0".
                        versionStr = (typeof ipkg.name === 'string' && ipkg.name !== name ? `npm:${ipkg.name}@` : '') + '^' + ipkg.version;
                    }
                    catch { /* ignore */ }
                    const field = invocation.saveDev ? 'devDependencies' : 'dependencies';
                    pkg[field] = { ...pkg[field], [name]: versionStr };
                }
                (await writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg));
            }
            catch (e) {
                failed.push(...named.map(({ name }) => name));
                await ctx.stderr.write(`npm ERR! ${e instanceof Error ? e.message : String(e)}\n`);
            }
        }
        return null;
    });
    if (status !== null)
        return status;
    // The in-process fallback reports the count it actually installed;
    // writeInstallSummary's file/bin/cache decorations don't apply here.
    await writeInstallSummary(ctx, installed > 0 ? new Array(installed).fill('') : [], failed, { startedAt: startTime });
    return failed.length > 0 ? 1 : 0;
}
/** npm's prefix resolution: --prefix wins, then npm_config_prefix, then
 *  /usr/local; a relative value resolves against cwd. Absolute result. */
function resolveNpmPrefixVfs(cwd, env, explicit) {
    const raw = explicit ?? env['npm_config_prefix'] ?? '/usr/local';
    return resolve(cwd, raw);
}
async function npmUninstall(ctx, _registry) {
    const args = ctx.args.slice(1);
    let isGlobal = false;
    const packages = [];
    for (const arg of args) {
        if (arg === '-g' || arg === '--global') {
            isGlobal = true;
        }
        else if (!arg.startsWith('-')) {
            packages.push(arg);
        }
    }
    if (packages.length === 0) {
        await ctx.stderr.write('npm uninstall requires at least one package name\n');
        return 1;
    }
    const globalPrefix = isGlobal ? resolveNpmPrefixVfs(ctx.cwd, ctx.env, null) : null;
    const targetBase = isGlobal ? `${globalPrefix}/lib/node_modules` : join(ctx.cwd, 'node_modules');
    const globalBinDir = isGlobal ? `${globalPrefix}/bin` : null;
    for (const name of packages) {
        const targetDir = join(targetBase, name);
        if (!(await ctx.vfs.exists(targetDir))) {
            await ctx.stderr.write(`npm warn: ${name} is not installed\n`);
            continue;
        }
        // Unlink global binaries
        if (isGlobal && globalBinDir) {
            try {
                const pkg = JSON.parse((await ctx.vfs.readFileString(join(targetDir, 'package.json'))));
                for (const binName of Object.keys(getBinEntries(pkg))) {
                    try {
                        (await ctx.vfs.unlink(join(globalBinDir, binName)));
                    }
                    catch { /* ignore */ }
                }
            }
            catch { /* ignore */ }
        }
        // Remove the package
        try {
            (await ctx.vfs.remove(targetDir, { recursive: true }));
        }
        catch (e) {
            await ctx.stderr.write(`npm ERR! could not remove ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
            return 1;
        }
        // Update package.json for local uninstalls
        if (!isGlobal) {
            const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd));
            if (pkg) {
                if (pkg.dependencies)
                    delete pkg.dependencies[name];
                if (pkg.devDependencies)
                    delete pkg.devDependencies[name];
                (await writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg));
            }
        }
        await ctx.stdout.write(`removed ${name}\n`);
    }
    return 0;
}
async function npmList(ctx) {
    const args = ctx.args.slice(1);
    const isGlobal = args.includes('-g') || args.includes('--global');
    const globalPrefix = isGlobal ? resolveNpmPrefixVfs(ctx.cwd, ctx.env, null) : null;
    const modulesDir = isGlobal ? `${globalPrefix}/lib/node_modules` : join(ctx.cwd, 'node_modules');
    const header = isGlobal
        ? `${globalPrefix}/lib`
        : ((await readProjectPackageJson(ctx.vfs, ctx.cwd))?.name || ctx.cwd);
    await ctx.stdout.write(`${header}\n`);
    if (!(await ctx.vfs.exists(modulesDir))) {
        await ctx.stdout.write('└── (empty)\n');
        return 0;
    }
    const packages = [];
    for await (const name of packagesIn(ctx.vfs, modulesDir)) {
        packages.push({ name, version: await readPkgVersion(ctx.vfs, join(modulesDir, name)) });
    }
    if (packages.length === 0) {
        await ctx.stdout.write('└── (empty)\n');
    }
    else {
        for (let i = 0; i < packages.length; i++) {
            const p = packages[i];
            const last = i === packages.length - 1;
            await ctx.stdout.write(`${last ? '└── ' : '├── '}${p.name}@${p.version}\n`);
        }
    }
    return 0;
}
async function readPkgVersion(vfs, pkgDir) {
    try {
        const pkg = JSON.parse((await vfs.readFileString(join(pkgDir, 'package.json'))));
        return pkg.version || '?';
    }
    catch {
        return '?';
    }
}
async function npmRun(ctx, shellExecute, registry, kernel) {
    const args = ctx.args.slice(1);
    const scriptName = args[0];
    const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd));
    if (!pkg) {
        await ctx.stderr.write('npm ERR! no package.json found\n');
        return 1;
    }
    if (!scriptName) {
        // List available scripts
        if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) {
            await ctx.stdout.write('No scripts defined in package.json\n');
            return 0;
        }
        await ctx.stdout.write('Available scripts:\n');
        for (const [name, cmd] of Object.entries(pkg.scripts)) {
            await ctx.stdout.write(`  ${name}\n    ${cmd}\n`);
        }
        return 0;
    }
    if (!pkg.scripts || !pkg.scripts[scriptName]) {
        await ctx.stderr.write(`npm ERR! Missing script: "${scriptName}"\n`);
        if (pkg.scripts) {
            await ctx.stderr.write('\nAvailable scripts:\n');
            for (const name of Object.keys(pkg.scripts)) {
                await ctx.stderr.write(`  - ${name}\n`);
            }
        }
        return 1;
    }
    const script = pkg.scripts[scriptName];
    await ctx.stdout.write(`\n> ${pkg.name || ''}@${pkg.version || '1.0.0'} ${scriptName}\n`);
    await ctx.stdout.write(`> ${script}\n\n`);
    // Register local bin scripts from node_modules so they're available in scripts
    if (registry) {
        (await registerLocalBins(ctx.vfs, ctx.cwd, registry, kernel));
    }
    // For simple scripts (single command, no shell operators), invoke directly
    // to avoid extra stack frames from shell.execute → interpreter chain
    if (registry) {
        const trimmed = script.trim();
        const hasShellSyntax = /[;&|`$(){}]/.test(trimmed);
        if (!hasShellSyntax) {
            const parts = trimmed.split(/\s+/);
            const cmdName = parts[0];
            const cmdArgs = parts.slice(1);
            const cmd = await registry.resolve(cmdName, resolveContext(ctx.cwd, ctx.env, ctx.vfs));
            if (cmd) {
                return (await cmd({ ...ctx, args: cmdArgs }));
            }
        }
    }
    if (shellExecute) {
        return (await shellExecute(script, ctx));
    }
    // No shell access - print the command for the user
    await ctx.stderr.write('(shell integration unavailable, run the command directly)\n');
    return 1;
}
/** Scan node_modules for packages with bin entries and register them as commands */
async function registerLocalBins(vfs, cwd, registry, kernel) {
    const nmDir = join(cwd, 'node_modules');
    let count = 0;
    for await (const name of packagesIn(vfs, nmDir))
        count += await registerPkgBins(vfs, join(nmDir, name), registry, kernel);
    return count;
}
async function registerPkgBins(vfs, pkgDir, registry, kernel) {
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!(await vfs.exists(pkgJsonPath)))
        return 0;
    let count = 0;
    try {
        const pkg = JSON.parse((await vfs.readFileString(pkgJsonPath)));
        const bins = getBinEntries(pkg);
        for (const [binName, binPath] of Object.entries(bins)) {
            // Native-executable bins (.exe/.node) are not runnable here; skip
            // them so a package whose only bin is a native launcher (e.g.
            // opencode-ai's bin/opencode.exe) is handled by the npm-bin
            // fallback resolver, which reads the authoritative bin manifest
            // (including staged-artifact sentinels) instead of this raw scan.
            if (isNativeBinPath(binPath))
                continue;
            // Only register if not already in registry
            if (!registry.has(binName)) {
                const scriptPath = resolve(pkgDir, binPath);
                registerBinCommand(registry, binName, scriptPath, kernel);
                count++;
            }
        }
    }
    catch { /* ignore */ }
    return count;
}
async function npmInfo(ctx, network) {
    const args = ctx.args.slice(1);
    const spec = args[0];
    if (!spec) {
        await ctx.stderr.write('Usage: npm info <package>\n');
        return 1;
    }
    const { name, version } = parsePackageSpec(spec);
    const npmRegistry = getRegistry(ctx.env);
    try {
        const info = await fetchPackageInfo(network, npmRegistry, name, version, ctx.signal);
        await ctx.stdout.write(`\n${info.name}@${info.version}\n`);
        if (info.description)
            await ctx.stdout.write(`${info.description}\n`);
        await ctx.stdout.write('\n');
        if (info.main)
            await ctx.stdout.write(`main: ${info.main}\n`);
        const binEntries = getBinEntries(info);
        if (Object.keys(binEntries).length > 0) {
            await ctx.stdout.write(`bin: ${Object.keys(binEntries).join(', ')}\n`);
        }
        if (info.dependencies) {
            const deps = Object.keys(info.dependencies);
            await ctx.stdout.write(`\ndependencies (${deps.length}):\n`);
            for (const dep of deps) {
                await ctx.stdout.write(`  ${dep}: ${info.dependencies[dep]}\n`);
            }
        }
        await ctx.stdout.write(`\ntarball: ${info.dist.tarball}\n`);
        if (info.dist.shasum)
            await ctx.stdout.write(`shasum: ${info.dist.shasum}\n`);
        if (info.dist.integrity)
            await ctx.stdout.write(`integrity: ${info.dist.integrity}\n`);
    }
    catch (e) {
        await ctx.stderr.write(`npm ERR! ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
    return 0;
}
async function npmSearch(ctx, network) {
    const args = ctx.args.slice(1);
    const term = args.join(' ');
    if (!term) {
        await ctx.stderr.write('Usage: npm search <term>\n');
        return 1;
    }
    const npmRegistry = getRegistry(ctx.env);
    const url = `${npmRegistry}/-/v1/search?text=${encodeURIComponent(term)}&size=10`;
    try {
        const response = await network.fetch(url, { signal: ctx.signal });
        if (!response.ok) {
            throw new Error(`Registry returned ${response.status}`);
        }
        const data = RegistrySearchResponseSchema.parse(await response.json());
        const results = data.objects;
        if (!results || results.length === 0) {
            await ctx.stdout.write('No results found\n');
            return 0;
        }
        await ctx.stdout.write(renderSearchTable(results.map((r) => r.package)));
    }
    catch (e) {
        await ctx.stderr.write(`npm ERR! ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
    return 0;
}
// ─── Factory ───
export function createNpmCommand(registry, shellExecute, kernel, deps) {
    return async (ctx) => {
        const subcommand = ctx.args[0];
        if (!subcommand || subcommand === '--help' || subcommand === '-h') {
            await printHelp(ctx);
            return subcommand ? 0 : 1;
        }
        switch (subcommand) {
            case 'init':
                return (await npmInit(ctx));
            case 'install':
            case 'i':
            case 'add':
                return (await npmInstall(ctx, registry, kernel, deps));
            case 'ci':
            case 'clean-install':
            case 'install-clean':
                return (await npmCi(ctx, deps));
            case 'uninstall':
            case 'remove':
            case 'rm':
            case 'un':
                return (await npmUninstall(ctx, registry));
            case 'list':
            case 'ls':
                return (await npmList(ctx));
            case 'run':
            case 'run-script':
                return (await npmRun(ctx, shellExecute, registry, kernel));
            case 'start':
                return (await npmRun({ ...ctx, args: ['run', 'start', ...ctx.args.slice(1)] }, shellExecute, registry));
            case 'test':
                return (await npmRun({ ...ctx, args: ['run', 'test', ...ctx.args.slice(1)] }, shellExecute, registry));
            case 'info':
            case 'view':
            case 'show':
                return (await npmInfo(ctx, kernel?.network ?? ISOLATE_NETWORK));
            case 'search':
                return (await npmSearch(ctx, kernel?.network ?? ISOLATE_NETWORK));
            case '-v':
            case '--version':
                await ctx.stdout.write(NPM_VERSION + '\n');
                return 0;
            default:
                await ctx.stderr.write(`npm: unknown command '${subcommand}'\n`);
                await ctx.stderr.write('Run npm --help for usage\n');
                return 1;
        }
    };
}
/**
 * `npm ci`: a clean install of exactly the tree package-lock.json (or
 * npm-shrinkwrap.json) records. The host validates the lock and only then
 * removes node_modules: a lock that disagrees with package.json fails the
 * install with the project untouched, instead of being re-resolved.
 */
async function npmCi(ctx, deps) {
    const invocation = parseNpmInstallInvocation(ctx.args.slice(1));
    if (invocation.global) {
        await ctx.stderr.write('npm ERR! `npm ci` does not work for global packages\n');
        return 1;
    }
    if (invocation.packages.length > 0) {
        await ctx.stderr.write('npm ERR! `npm ci` does not take package arguments; use `npm install <pkg>`\n');
        return 1;
    }
    let hasLock = false;
    for (const name of ['npm-shrinkwrap.json', 'package-lock.json']) {
        if (await ctx.vfs.exists(join(ctx.cwd, name)))
            hasLock = true;
    }
    if (!hasLock) {
        await ctx.stderr.write('npm ERR! The `npm ci` command can only install with an existing package-lock.json or\n' +
            'npm ERR! npm-shrinkwrap.json. Run `npm install` to generate one, then try again.\n');
        return 1;
    }
    if (!deps?.installer) {
        await ctx.stderr.write('npm ERR! `npm ci` needs the host installer, which this runtime does not provide\n');
        return 1;
    }
    const startTime = Date.now();
    const npmLog = invocation.loglevel
        ? async (level, line) => { if (npmLogEnabled(invocation.loglevel, level))
            await ctx.stderr.write(`${line}\n`); }
        : null;
    try {
        const result = await deps.installer.install({
            projectDir: ctx.cwd,
            packages: [],
            global: false,
            pid: ctx.pid,
            registry: getRegistry(ctx.env),
            production: invocation.production,
            fromLockfile: true,
            npmLog,
            onProgress: async (line) => await ctx.stdout.write(`[npm] ${line}\n`),
        });
        await writeInstallSummary(ctx, result.installed, result.failed, {
            totalFiles: result.totalFiles,
            fromCacheHits: result.fromCacheHits,
            startedAt: startTime,
        });
        return result.failed.length > 0 ? 1 : 0;
    }
    catch (err) {
        await ctx.stderr.write(`npm ERR! ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
}
/**
 * Install a single npm package globally into the VFS.
 *
 * Called directly by `lifo install` to avoid the shell.execute()
 * round-trip which can silently swallow output and errors.
 */
// ─── npx ───
const NPX_CACHE = '/tmp/.npx-cache/node_modules';
async function findBinScript(vfs, pkgDir, binName) {
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!(await vfs.exists(pkgJsonPath)))
        return null;
    try {
        const pkg = JSON.parse((await vfs.readFileString(pkgJsonPath)));
        const bins = getBinEntries(pkg);
        if (Object.keys(bins).length === 0)
            return null;
        // If a specific bin name is requested, look for it
        if (binName && bins[binName])
            return resolve(pkgDir, bins[binName]);
        // Otherwise return the first entry
        const first = Object.values(bins)[0];
        return first ? resolve(pkgDir, first) : null;
    }
    catch {
        return null;
    }
}
export function createNpxCommand(registry, shellExecute, 
/** Its network is the one the npx cache install fetches through. */
kernel) {
    return async (ctx) => {
        const rawArgs = ctx.args.slice();
        let explicitPkg = null;
        // Parse flags
        const passthrough = [];
        let i = 0;
        while (i < rawArgs.length) {
            const a = rawArgs[i];
            if (a === '-y' || a === '--yes') {
                i++;
                continue;
            }
            if (a === '--package' && i + 1 < rawArgs.length) {
                explicitPkg = rawArgs[i + 1];
                i += 2;
                continue;
            }
            if (a.startsWith('--package=')) {
                explicitPkg = a.slice('--package='.length);
                i++;
                continue;
            }
            if (a === '--version' || a === '-v') {
                await ctx.stdout.write(NPM_VERSION + '\n');
                return 0;
            }
            if (a === '--help' || a === '-h') {
                await ctx.stdout.write('Usage: npx [options] <package[@version]> [args...]\n\n');
                await ctx.stdout.write('Options:\n');
                await ctx.stdout.write('  -y, --yes              skip prompts\n');
                await ctx.stdout.write('  --package=<pkg>        explicit package name\n');
                await ctx.stdout.write('  -v, --version          print version\n');
                await ctx.stdout.write('  -h, --help             show this help\n');
                return 0;
            }
            // First non-flag is the package spec (or bin name if --package was set)
            break;
        }
        const spec = rawArgs[i];
        if (!spec) {
            await ctx.stderr.write('npx: missing package or command\n');
            await ctx.stderr.write('Usage: npx <package[@version]> [args...]\n');
            return 1;
        }
        // Everything after the spec is passthrough args
        passthrough.push(...rawArgs.slice(i + 1));
        const { name: parsedName, version } = parsePackageSpec(explicitPkg || spec);
        // The bin name to look for: if --package was used, spec is the bin name; otherwise derive from package name
        const binName = explicitPkg ? spec : parsedName.split('/').pop();
        // 1. Check local node_modules
        const localPkgDir = join(ctx.cwd, 'node_modules', parsedName);
        let scriptPath = (await findBinScript(ctx.vfs, localPkgDir, binName));
        // 2. Check global modules
        if (!scriptPath) {
            const globalModules = `${resolveNpmPrefixVfs(ctx.cwd, ctx.env, null)}/lib/node_modules`;
            scriptPath = (await findBinScript(ctx.vfs, join(globalModules, parsedName), binName));
        }
        // 3. Install to cache
        if (!scriptPath) {
            const cacheDir = join(NPX_CACHE, parsedName);
            if (!(await ctx.vfs.exists(join(cacheDir, 'package.json')))) {
                const result = await installTreeLocked(ctx.vfs, kernel, NPX_CACHE, () => installTree([[parsedName, version]], {
                    targetBase: NPX_CACHE, vfs: ctx.vfs, network: kernel?.network ?? ISOLATE_NETWORK, npmRegistry: getRegistry(ctx.env),
                    signal: ctx.signal, stdout: ctx.stdout, stderr: ctx.stderr, registry, kernel,
                }));
                if (result.failed.length > 0) {
                    await ctx.stderr.write(`npx: could not install ${parsedName}\n`);
                    return 1;
                }
            }
            scriptPath = (await findBinScript(ctx.vfs, cacheDir, binName));
        }
        if (!scriptPath) {
            await ctx.stderr.write(`npx: could not find executable for '${binName}'\n`);
            return 1;
        }
        // 4. Execute via node (prefer direct invocation to avoid shell reentrance)
        const nodeCmd = await registry.resolve('node');
        if (nodeCmd) {
            return (await nodeCmd({ ...ctx, args: [scriptPath, ...passthrough] }));
        }
        // Fallback: shellExecute
        if (shellExecute) {
            const cmd = ['node', scriptPath, ...passthrough]
                .map((s) => (s.includes(' ') ? `"${s}"` : s))
                .join(' ');
            return (await shellExecute(cmd, ctx));
        }
        await ctx.stderr.write('npx: node command not available\n');
        return 1;
    };
}
export async function npmInstallGlobal(packageName, ctx, registry, kernel) {
    const startTime = Date.now();
    const prefix = resolveNpmPrefixVfs(ctx.cwd, ctx.env, null);
    const modulesDir = `${prefix}/lib/node_modules`;
    const binDir = `${prefix}/bin`;
    try {
        (await ctx.vfs.mkdir(modulesDir, { recursive: true }));
    }
    catch { /* exists */ }
    try {
        (await ctx.vfs.mkdir(binDir, { recursive: true }));
    }
    catch { /* exists */ }
    const { installed, failed } = await installTreeLocked(ctx.vfs, kernel, modulesDir, () => installTree([[packageName, null]], {
        targetBase: modulesDir, vfs: ctx.vfs, network: kernel?.network ?? ISOLATE_NETWORK, npmRegistry: getRegistry(ctx.env),
        signal: ctx.signal, stdout: ctx.stdout, stderr: ctx.stderr, registry, kernel, globalBinDir: binDir,
    }));
    if (failed.length > 0)
        return 1;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await ctx.stdout.write(`\nadded ${installed} package${installed !== 1 ? 's' : ''} in ${elapsed}s\n`);
    return 0;
}
