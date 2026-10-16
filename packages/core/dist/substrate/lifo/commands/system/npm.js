import { ISOLATE_NETWORK } from '../../../../_shared/workspace-network.js';
import { basename, join, relative, resolve } from '../../utils/path.js';
import { writeTarballStream } from '../../../../_shared/tarball.js';
import { isNativeBinPath } from '../../../../runtime/os-contracts.js';
import { npmBinMap, npmBinShim } from '../../../../runtime/npm-bin-map.js';
import { pickPackumentVersion } from '../../../../_shared/npm-semver.js';
import { parseRegistryRequest, splitPackageSpec } from '../../../../_shared/npm-spec.js';
import { notCachedMessage } from '../../../../_shared/npm-cache-mode.js';
import { canonicalTreePath, depthOf, holdTree, isOptional, manifestEdges, meets, namedPackages, packageJsonText, parentPlacement, placementName, projectRoots, readPackageJson, saveNamed, withoutDeclared, } from '../../../../_shared/npm-tree.js';
import { planTree, requiredFailures } from '../../../../_shared/npm-arborist/plan.js';
import { InstallJournal } from './npm-journal.js';
import { sriDigestOf, sriDigestsEqual, strongestSriEntry } from '../../../../_shared/tarball-integrity.js';
import { RegistryPackumentSchema, RegistrySearchResponseSchema, renderSearchTable, } from './registry-schemas.js';
import { npmInstallInvocation, } from './npm-install-args.js';
import { installSummary, npmDevEnginesLines, npmEngineLines, npmLogEnabled, npmRemovedLine, parseNpmLogLevel } from './npm-log.js';
import { checkDevEngines } from '../../../../_shared/npm-libs.js';
import { checkEngines } from '../../../../_shared/npm-arborist/engines.js';
import { DEFAULT_PATH, NODE_SYSTEM, NODE_VERSION, NPM_VERSION, SYSTEM_IDENTITY } from '../../../../constants.js';
import { npmShellWord } from '../../../../_shared/shell-quote.js';
import { isVfsError } from '../../../../vfs/vfs-error.js';
import { direntTypeIn } from '../../../../vfs/dirent-type.js';
/** The registry an install reads from when its env names none. */
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
/**
 * npm's word on the tree's EBADENGINEs, on the command's stderr: under
 * `--engine-strict` the error the install failed with (true), else a
 * warning of each, at npm's warn level.
 */
async function writeEngines(ctx, engines = [], strict, loglevel) {
    if (strict && engines.length > 0) {
        for (const line of npmEngineLines(engines[0], true))
            await ctx.stderr.write(`${line}\n`);
        return true;
    }
    if (loglevel !== null && !npmLogEnabled(loglevel, 'warn'))
        return false;
    for (const engine of engines)
        for (const line of npmEngineLines(engine, false))
            await ctx.stderr.write(`${line}\n`);
    return false;
}
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
/** An install's registry: the one npm's configuration names, else the session's (getRegistry). */
function registryOf(ctx, invocation) {
    return invocation.registry === null ? getRegistry(ctx.env) : npmRegistryOrigin(invocation.registry);
}
/** Each command's configuration, read once (npmConfigOf). */
const configs = new WeakMap();
/**
 * npm's configuration for this command (npm-config.ts: npm's definitions and
 * nopt, so `--global=false` is local and `--location=global` global; its
 * .npmrc files and npm_config_* too), read once, as npm loads it before any
 * command: what it warns of printed, and `--force`'s warning.
 */
function npmConfigOf(ctx) {
    let config = configs.get(ctx);
    if (config === undefined) {
        config = (async () => {
            const loaded = await (await import('./npm-config.js')).loadNpmConfig(ctx.vfs, ctx.cwd, ctx.env, ctx.args);
            if (npmWarns(loaded)) {
                for (const warning of loaded.warnings)
                    await ctx.stderr.write(`npm warn ${warning}\n`);
                if (loaded.get('force'))
                    await ctx.stderr.write('npm warn using --force Recommended protections disabled.\n');
            }
            return loaded;
        })();
        configs.set(ctx, config);
    }
    return config;
}
/** Whether npm's configured log level (`--loglevel`, an .npmrc's) shows its warnings. */
function npmWarns(config) {
    return npmLogEnabled(parseNpmLogLevel(config.get('loglevel')), 'warn');
}
/** What npm's devEngines preflight compares a project's devEngines with: this runtime (npm-install-checks currentEnv.devEngines). */
const DEV_ENGINES_CURRENT = {
    cpu: { name: NODE_SYSTEM.arch },
    // No C library: what runs here is wasm (SYSTEM_IDENTITY.machine).
    libc: { name: null },
    os: { name: NODE_SYSTEM.platform, version: SYSTEM_IDENTITY.release },
    packageManager: { name: 'npm', version: NPM_VERSION },
    runtime: { name: 'node', version: NODE_VERSION },
};
/**
 * npm's devEngines preflight (base-cmd checkDevEngines), as npm runs it
 * before every command but a global one: the devEngines of the project at
 * npm's local prefix, by npm-install-checks' own checkDevEngines, against
 * this runtime. What npm lets pass (onFail warn, any under --force) is
 * warned of; else the first failure is the command's error, and it runs
 * nothing (true).
 */
async function devEnginesRefuse(ctx, config) {
    if (config.get('global') === true || config.get('location') === 'global')
        return false;
    let devEngines;
    try {
        devEngines = JSON.parse(await ctx.vfs.readFileString(join(config.localPrefix, 'package.json'))).devEngines;
    }
    catch {
        return false;
    }
    if (devEngines === undefined)
        return false;
    let failures;
    try {
        failures = checkDevEngines(devEngines, DEV_ENGINES_CURRENT);
    }
    catch (error) {
        await ctx.stderr.write(`npm error ${error instanceof Error ? error.message : String(error)}\n`);
        return true;
    }
    const force = config.get('force') === true;
    const errors = failures.filter((failure) => failure.isError);
    const passed = [...failures.filter((failure) => failure.isWarn), ...(force ? errors : [])];
    if (npmWarns(config))
        for (const [at, failure] of passed.entries())
            for (const line of npmDevEnginesLines(failure, at === 0, 'warn'))
                await ctx.stderr.write(`${line}\n`);
    if (force || errors.length === 0)
        return false;
    for (const line of npmDevEnginesLines(errors[0], true, 'error'))
        await ctx.stderr.write(`${line}\n`);
    return true;
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
async function fetchPackageInfo(network, registry, name, version, signal, 
/** The shell keeps no packuments: under `--offline` none is read. */
cache = 'default') {
    const request = parseRegistryRequest(name, version ?? '');
    const url = `${registry}/${encodePackageName(request.registryName)}`;
    if (cache === 'only-if-cached')
        throw Object.assign(new Error(notCachedMessage(url)), { code: 'ENOTCACHED' });
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
/** package.json in `dir`, as the engine reads it; null where there is none, or it is not a JSON object. */
async function packageJsonIn(vfs, dir) {
    try {
        return readPackageJson(await vfs.readFileString(join(dir, 'package.json')));
    }
    catch {
        return null;
    }
}
/** The package installed at `dir` under `name`: its manifest, version and registry name; null where there is none, or it names no version. */
async function installedPackage(vfs, dir, name) {
    const read = await packageJsonIn(vfs, dir);
    const version = read?.json.version;
    if (read === null || typeof version !== 'string')
        return null;
    const registryName = read.json.name;
    return { ...read.manifest, name, version, registryName: typeof registryName === 'string' ? registryName : name };
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
/** The kernel-less shell's install queues are one namespace. */
const NO_KERNEL = {};
const describeError = (error) => error instanceof Error ? error.message : String(error);
/**
 * Every package installed under `modulesDir`'s tree, at its placement, in
 * the top-level folders `top` keeps: a linked package (a symlink) is the
 * link's, and not walked into.
 */
async function installedPlacements(vfs, modulesDir, top, prefix = '', out = []) {
    for await (const name of packagesIn(vfs, modulesDir)) {
        if (prefix === '' && !top(name))
            continue;
        const placement = prefix + name;
        out.push(placement);
        if (!(await vfs.isSymlink(join(modulesDir, name))))
            await installedPlacements(vfs, join(modulesDir, name, 'node_modules'), top, `${placement}/node_modules/`, out);
    }
    return out;
}
async function installTree(roots, install, project) {
    const { targetBase, vfs, network, npmRegistry, signal, stdout, stderr } = install;
    const fail = async (name, message) => {
        if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('CORS')) {
            await stderr.write(`npm ERR! network error fetching ${name}\n`);
            await stderr.write(`This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n`);
        }
        else {
            await stderr.write(`npm ERR! ${name}: ${message}\n`);
        }
        return { installed: [], failed: [name] };
    };
    // ── Recover ──
    if (!(await InstallJournal.recover(vfs, targetBase, stderr))) {
        return await fail(targetBase, 'an install that did not finish could not be undone; its copies are kept as named above');
    }
    // A staging directory left behind holds only new packages: no install
    // into this tree is using it while this one holds it.
    try {
        for (const { name } of await vfs.readdir(targetBase)) {
            if (name.startsWith('.nimbus-staging-'))
                await vfs.remove(join(targetBase, name), { recursive: true, force: true });
        }
    }
    catch { /* no node_modules yet */ }
    // ── Plan ──
    const global = install.globalBinDir !== undefined;
    const named = new Set(roots.map(({ name }) => name));
    const onDisk = await installedPlacements(vfs, targetBase, (name) => !global || named.has(name));
    const installed = (await Promise.all(onDisk.map(async (at) => {
        const pkg = await installedPackage(vfs, join(targetBase, at), placementName(at));
        return pkg && { at, pkg };
    }))).flatMap((entry) => (entry ? [entry] : []));
    const plan = await planTree(roots, global ? [] : installed, {
        async resolve(requests) {
            const answers = [];
            for (const { name, range } of requests) {
                await stdout.write(`  ${name}${range ? '@' + range : ''}...\n`);
                try {
                    const info = await fetchPackageInfo(network, npmRegistry, name, range || null, signal, install.cache);
                    answers.push({ package: { ...info, name, registryName: info.name, integrity: info.dist.integrity, bundleDependencies: info.bundleDependencies ?? info.bundledDependencies, info } });
                }
                catch (error) {
                    answers.push({ failed: describeError(error) });
                }
            }
            return answers;
        },
        warn: async (message) => { await stderr.write(`npm WARN ${message}\n`); },
    }, { global, force: install.force, strictPeerDeps: install.strictPeerDeps, legacyPeerDeps: install.legacyPeerDeps, preferDedupe: install.preferDedupe });
    const [requiredFailure] = requiredFailures(plan);
    if (requiredFailure)
        return await fail(requiredFailure.edge.name, requiredFailure.reason);
    for (const { id, edge } of plan.failures) {
        await stderr.write(`npm WARN optional SKIPPING OPTIONAL DEPENDENCY: ${edge.name}: ${plan.reasons.get(id)}\n`);
    }
    // npm's engine check of the tree: under --engine-strict a mismatch fails the install before anything changes.
    const engines = checkEngines(project, plan, install.force === true);
    if (install.engineStrict === true && engines.length > 0)
        return { installed: [], failed: [engines[0].pkgid ?? targetBase], engines };
    signal.throwIfAborted();
    // ── Reify ──
    const run = Math.random().toString(36).slice(2, 10);
    const staging = join(targetBase, `.nimbus-staging-${run}`);
    // The tree to publish: what the plan holds, but what it leaves out and, with --omit=dev, what only devDependencies reach.
    const inTree = (at) => plan.nodes.has(at) && !plan.skipped.has(at) && !plan.omits(at, install.omit);
    const plannedVersion = (name) => (plan.skipped.has(name) ? null : plan.nodes.get(name)?.pkg.version ?? null);
    // What the plan places is fetched, but where that package is installed already.
    const installedAt = new Map(installed.map(({ at, pkg }) => [at, pkg]));
    const planned = [];
    for (const node of plan.nodes.values()) {
        if (!node.planned || !inTree(node.at))
            continue;
        const current = installedAt.get(node.at);
        if (current?.version !== node.pkg.version || current.registryName !== node.pkg.info.name)
            planned.push(node);
    }
    const stagedAt = new Map(planned.map((node, i) => [node.at, join(staging, String(i))]));
    try {
        for (const node of planned) {
            if (!inTree(node.at))
                continue;
            try {
                // writeTarballStream throws when the archive carried no manifest
                // and writes package.json last, so a return is a complete package.
                await fetchAndStreamPackage(network, node.pkg.info.dist.tarball, node.pkg.info.dist.integrity, stagedAt.get(node.at) ?? staging, vfs, signal, stderr);
            }
            catch (error) {
                if (plan.fail(node.at, describeError(error)) === null)
                    return await fail(node.edge.name, describeError(error));
                await stderr.write(`npm WARN optional SKIPPING OPTIONAL DEPENDENCY: ${node.edge.name}: ${describeError(error)}\n`);
            }
        }
        signal.throwIfAborted();
        // What is on disk the tree does not hold goes (npm prunes it).
        const removals = onDisk.filter((at) => !inTree(at));
        const publish = planned.filter((node) => inTree(node.at)).sort((x, y) => depthOf(x.at) - depthOf(y.at));
        // A project's .bin is the bins of its top-level packages as they are now.
        const topLevel = [...plan.nodes.keys()].filter((at) => inTree(at) && depthOf(at) === 1);
        if (publish.length === 0 && removals.length === 0) {
            if (!install.globalBinDir)
                await linkProjectBins(vfs, targetBase, topLevel);
            return { installed: [], failed: [], plannedVersion, engines };
        }
        // The bins a global root being replaced linked: the ones its new version does not declare go.
        const replacedBins = new Map();
        if (install.globalBinDir) {
            for (const node of publish) {
                if (node.edge.from !== '')
                    continue;
                const before = await packageJsonIn(vfs, join(targetBase, node.at));
                if (before !== null)
                    replacedBins.set(node.at, [...npmBinMap(placementName(node.at), before.json.bin).keys()]);
            }
        }
        const journal = InstallJournal.begin(vfs, targetBase, run);
        const retiredAt = new Map();
        // The package the step being made is for, should it fail.
        let current = targetBase;
        try {
            // Deepest first, so a package goes before the one it is nested in.
            for (const at of removals.sort((x, y) => depthOf(y) - depthOf(x))) {
                current = placementName(at);
                const target = join(targetBase, at);
                if (!(await vfs.exists(target)))
                    continue;
                await journal.move('retire', target, journal.retired(target));
                retiredAt.set(at, journal.retired(target));
            }
            for (const node of publish) {
                current = node.edge.name;
                const target = join(targetBase, node.at);
                if (await vfs.exists(target)) {
                    await journal.move('retire', target, journal.retired(target));
                    retiredAt.set(node.at, journal.retired(target));
                }
                await journal.move('publish', stagedAt.get(node.at) ?? staging, target);
            }
            // A kept package whose ancestor was retired (replaced, or bundling
            // its own node_modules) went with it: it moves back into the tree,
            // beside whatever the new ancestor bundles.
            const published = new Set(publish.map((node) => node.at));
            const kept = [...plan.nodes.values()].filter((node) => inTree(node.at) && !published.has(node.at)).sort((x, y) => depthOf(x.at) - depthOf(y.at));
            for (const node of kept) {
                const target = join(targetBase, node.at);
                if (await vfs.exists(target))
                    continue;
                const ancestor = [...retiredAt.keys()].filter((at) => node.at.startsWith(at + '/node_modules/')).sort((x, y) => depthOf(y) - depthOf(x))[0];
                if (ancestor === undefined)
                    continue;
                current = node.at;
                const source = (retiredAt.get(ancestor) ?? '') + node.at.slice(ancestor.length);
                if (await vfs.exists(source))
                    await journal.move('carry', source, target);
            }
        }
        catch (error) {
            await journal.undo(stderr);
            return await fail(current, describeError(error));
        }
        await journal.commit(stderr);
        // npm's bin links, found through PATH: a global install's roots' into
        // the prefix's bin, a project's top-level packages' into its
        // node_modules/.bin, which its scripts have first on PATH (npmScriptEnv).
        const { globalBinDir } = install;
        if (globalBinDir) {
            for (const node of publish) {
                if (node.edge.from !== '')
                    continue;
                const linked = await linkBins(node.pkg.info, join(targetBase, node.at), globalBinDir, vfs);
                for (const name of replacedBins.get(node.at) ?? [])
                    if (!linked.includes(name))
                        await vfs.remove(join(globalBinDir, name), { force: true });
            }
        }
        else {
            await linkProjectBins(vfs, targetBase, topLevel);
        }
        return { installed: publish.map((node) => `${node.pkg.name}@${node.pkg.version}`), failed: [], plannedVersion, engines };
    }
    finally {
        try {
            await vfs.remove(staging, { recursive: true, force: true });
        }
        catch { /* none was made */ }
    }
}
/**
 * The shims linking `bin` (a package.json's bin) of the package at
 * `packageDir` into `binDir`, by name (npmBinShim). A native launcher
 * (.exe/.node) runs nowhere here, and is not linked.
 */
function binShims(packageName, bin, packageDir, binDir) {
    const shims = new Map();
    for (const [name, target] of npmBinMap(packageName, bin)) {
        if (!isNativeBinPath(target))
            shims.set(name, npmBinShim(binDir, resolve(packageDir, target)));
    }
    return shims;
}
/** Write each of `shims` into `binDir`, executable, unless it is there already. */
async function writeShims(vfs, binDir, shims) {
    if (shims.size > 0)
        await vfs.mkdir(binDir, { recursive: true });
    for (const [name, text] of shims) {
        const shim = join(binDir, name);
        if (await vfs.exists(shim) && await vfs.readFileString(shim) === text)
            continue;
        await vfs.writeFile(shim, text);
        await vfs.chmod(shim, 0o755);
    }
}
/** Link the bins of a global root into the prefix's bin; answers their names. */
async function linkBins(info, packageDir, binDir, vfs) {
    const shims = binShims(info.name, info.bin, packageDir, binDir);
    await writeShims(vfs, binDir, shims);
    return [...shims.keys()];
}
/**
 * A project's node_modules/.bin as npm's bin links leave it: a shim for each
 * bin of each top-level package (`placements`) as it is on disk, and no
 * other (a dot file is not a bin). After every install, so what was
 * installed before, pruned since, or now declares other bins is linked as
 * it is.
 */
async function linkProjectBins(vfs, targetBase, placements) {
    const binDir = join(targetBase, '.bin');
    const shims = new Map();
    for (const at of placements) {
        const packageDir = join(targetBase, at);
        const manifest = await packageJsonIn(vfs, packageDir);
        if (manifest === null)
            continue;
        const name = typeof manifest.json.name === 'string' ? manifest.json.name : placementName(at);
        for (const [bin, text] of binShims(name, manifest.json.bin, packageDir, binDir))
            shims.set(bin, text);
    }
    if (await vfs.exists(binDir)) {
        for (const entry of await vfs.readdir(binDir)) {
            if (!entry.name.startsWith('.') && !shims.has(entry.name))
                await vfs.remove(join(binDir, entry.name), { force: true });
        }
    }
    await writeShims(vfs, binDir, shims);
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
// `npm init`, `npm create` and `npm innit` are npm-init.ts's: npm's own
// libraries there (hosted-git-info, npm-package-arg, semver, the SPDX list)
// are evaluated the first time a session runs one, not when it starts.
async function npmInstall(ctx, kernel, deps) {
    const invocation = npmInstallInvocation(await npmConfigOf(ctx));
    const packages = invocation.packages;
    if (invocation.unsupported.length > 0) {
        for (const line of invocation.unsupported)
            await ctx.stderr.write(`npm ERR! ${line}\n`);
        return 1;
    }
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
    // Both sides derive `<prefix>/lib/node_modules` and `<prefix>/bin` from it.
    const globalPrefix = await npmGlobalPrefix(ctx);
    const globalBinDir = `${globalPrefix}/bin`;
    const npmRegistry = registryOf(ctx, invocation);
    const startTime = Date.now();
    // The port owns the install, prefix dirs and bin materialisation: the
    // host's, else the shell's own (shellInstallPort). This command owns the
    // summary and the progress channel — per-invocation, so two terminals'
    // installs can't interleave lines on one installer.
    const installer = deps?.installer ?? shellInstallPort(ctx, kernel);
    const npmLog = invocation.loglevel
        ? async (level, line) => { if (npmLogEnabled(invocation.loglevel, level))
            await ctx.stderr.write(`${line}\n`); }
        : null;
    try {
        const result = await installer.install({
            projectDir: ctx.cwd,
            packages,
            global: invocation.global,
            globalPrefix: invocation.global ? globalPrefix : undefined,
            pid: ctx.pid,
            registry: npmRegistry,
            cache: invocation.cache,
            production: invocation.production,
            saveDev: invocation.saveDev,
            saveOptional: invocation.saveOptional,
            force: invocation.force,
            engineStrict: invocation.engineStrict,
            strictPeerDeps: invocation.strictPeerDeps,
            legacyPeerDeps: invocation.legacyPeerDeps,
            omitOptional: invocation.omitOptional,
            omitPeer: invocation.omitPeer,
            preferDedupe: invocation.preferDedupe,
            save: invocation.save,
            savePrefix: invocation.savePrefix,
            signal: ctx.signal,
            npmLog,
            onProgress: async (line) => await ctx.stdout.write(`[npm] ${line}\n`),
        });
        if (await writeEngines(ctx, result.engines, invocation.engineStrict, invocation.loglevel))
            return 1;
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
/**
 * The shell's own install port: npm's one engine (installTree) for a host
 * that gives the command no port of its own (a library's shell). Its view
 * of the filesystem is the command's identity's, not bound to the command's
 * signal: a Ctrl-C stops the install before it publishes, and never takes
 * away what it needs to finish or undo a publication. A local install plans
 * the project's roots with the packages named, under the tree's hold, and
 * saves what was named to package.json once the install is complete.
 */
function shellInstallPort(ctx, kernel) {
    return {
        async install(spec) {
            const signal = spec.signal ?? ctx.signal;
            const vfs = ctx.vfsUntilExit?.() ?? ctx.vfs;
            const targetBase = spec.global ? `${spec.globalPrefix}/lib/node_modules` : join(spec.projectDir, 'node_modules');
            const globalBinDir = spec.global ? `${spec.globalPrefix}/bin` : undefined;
            const tree = {
                targetBase, vfs, network: (kernel?.network ?? ISOLATE_NETWORK).forProcess(ctx.pid), npmRegistry: spec.registry, cache: spec.cache ?? 'default', signal,
                stdout: ctx.stdout, stderr: ctx.stderr,
                force: spec.force === true, engineStrict: spec.engineStrict === true, strictPeerDeps: spec.strictPeerDeps === true, legacyPeerDeps: spec.legacyPeerDeps === true, preferDedupe: spec.preferDedupe === true,
                omit: { dev: spec.production === true, optional: spec.omitOptional === true, peer: spec.omitPeer === true },
                ...(globalBinDir ? { globalBinDir } : {}),
            };
            // The project's package.json is read and written under the tree's
            // hold, so two installs at once add to it one after the other.
            const release = await holdShellTree(vfs, kernel, targetBase, signal);
            try {
                if (globalBinDir) {
                    for (const dir of [targetBase, globalBinDir])
                        await vfs.mkdir(dir, { recursive: true });
                }
                // A global prefix has no package.json: its roots are what is named.
                const project = spec.global ? null : await packageJsonIn(vfs, spec.projectDir);
                const named = namedPackages(project?.manifest ?? null, spec.packages, { saveDev: spec.saveDev, saveOptional: spec.saveOptional });
                const roots = projectRoots(project?.manifest ?? null, named, { legacyPeerDeps: spec.legacyPeerDeps === true });
                await ctx.stdout.write(spec.packages.length === 0 ? 'Installing dependencies...\n' : 'Installing packages...\n');
                const result = await installTree(roots, tree, project?.manifest ?? null);
                if (result.failed.length > 0 || project === null || named.length === 0 || spec.save === false)
                    return result;
                // What the command line named is saved to package.json, at the version the tree holds, once it installed.
                try {
                    const saved = (await packageJsonIn(vfs, spec.projectDir)) ?? project;
                    await writeProjectPackageJson(vfs, spec.projectDir, saveNamed(saved.json, named, (name) => result.plannedVersion?.(name) ?? null, spec.savePrefix));
                    return result;
                }
                catch (error) {
                    await ctx.stderr.write(`npm ERR! ${describeError(error)}\n`);
                    return { installed: result.installed, failed: named.map(({ name }) => name) };
                }
            }
            finally {
                release();
            }
        },
    };
}
/** The tree at `modulesDir` held for one change (holdTree), by its canonical path, in the shell's namespace: its kernel's. */
async function holdShellTree(vfs, kernel, modulesDir, signal) {
    const held = holdTree(kernel ?? NO_KERNEL, await canonicalTreePath((path) => vfs.realpath(path), modulesDir), signal);
    return typeof held === 'function' ? held : await held;
}
/**
 * The prefix npm installs globally under, as `config` (read in `cwd`)
 * resolves it: --prefix, npm_config_prefix, an .npmrc, else PREFIX or
 * /usr/local; absolute. Its lib/node_modules holds the packages, its bin
 * their bins.
 */
export function npmGlobalPrefixOf(config, cwd) {
    return resolve(cwd, String(config.get('prefix')));
}
/** npmGlobalPrefixOf this command's configuration. */
export async function npmGlobalPrefix(ctx) {
    return npmGlobalPrefixOf(await npmConfigOf(ctx), ctx.cwd);
}
/**
 * The invocation as npm's configuration reads it (npm-config.ts: npm's
 * definitions and nopt, so `--global=false` is local and `--location=global`
 * global; its .npmrc files and npm_config_* too), its warnings printed: the
 * names it gives, and the global prefix it acts on, null for the project.
 * npm's libraries load the first time a session runs one.
 */
async function npmInvocation(ctx) {
    const config = await npmConfigOf(ctx);
    const global = config.get('global') === true || config.get('location') === 'global';
    return {
        names: config.positionals.slice(1),
        prefix: global ? await npmGlobalPrefix(ctx) : null,
        save: config.get('save') !== false,
    };
}
/**
 * `npm uninstall`: each package named (as written: npm takes no version)
 * goes from the tree, its bins with it (reify trashes a package's path and
 * its binPaths), and from every field of package.json that declares it,
 * whether it was installed or not (add-rm-pkg-deps rm). `-g`: from the
 * global prefix, its bins from the prefix's bin directory; `--no-save`
 * leaves package.json as it is. The host's records of the bins go too (its
 * port's unlinkBins). All of it happens under the hold an install into the
 * tree takes (its port's hold), so an install and an uninstall at once each
 * see the tree, its bins and package.json whole. package.json is read
 * first: one it cannot read fails the command before anything changes, one
 * it cannot write fails it; one that is not a JSON object is left as it
 * is. A package it cannot reach or remove fails the command, and the others
 * go on. Unlike npm's reify, what only a removed package depended on stays
 * installed.
 */
async function npmUninstall(ctx, kernel, deps) {
    const startedAt = Date.now();
    const { names, prefix, save } = await npmInvocation(ctx);
    if (names.length === 0) {
        await ctx.stderr.write('npm error Must provide a package name to remove\n');
        return 1;
    }
    const modulesDir = prefix === null ? join(ctx.cwd, 'node_modules') : `${prefix}/lib/node_modules`;
    // The tree, its bins and package.json change under the hold installs into the tree take.
    const hold = deps?.installer?.hold;
    const release = hold === undefined
        ? await holdShellTree(ctx.vfs, kernel, modulesDir, ctx.signal)
        : await hold({ modulesDir, pid: ctx.pid, signal: ctx.signal });
    try {
        const binDir = prefix === null ? join(modulesDir, '.bin') : `${prefix}/bin`;
        const pkgPath = join(ctx.cwd, 'package.json');
        let project = null;
        if (prefix === null && save) {
            try {
                const text = await ctx.vfs.readFileString(pkgPath);
                const read = readPackageJson(text);
                if (read !== null)
                    project = { text, json: read.json };
            }
            catch (error) {
                if (!isVfsError(error, 'ENOENT')) {
                    await ctx.stderr.write(`npm ERR! could not update package.json: ${describeError(error)}\n`);
                    return 1;
                }
            }
        }
        // A package it cannot reach or remove fails the command, and the rest go on.
        const removed = [];
        let failed = false;
        for (const name of names) {
            const dir = join(modulesDir, name);
            try {
                if ((await ctx.vfs.stat(dir, { follow: false })) === null)
                    continue;
                const manifest = (await packageJsonIn(ctx.vfs, dir))?.json;
                const own = manifest?.name;
                await ctx.vfs.remove(dir, { recursive: true, force: true });
                for (const bin of npmBinMap(typeof own === 'string' ? own : name, manifest?.bin).keys())
                    await ctx.vfs.remove(join(binDir, bin), { force: true });
                removed.push(name);
            }
            catch (error) {
                await ctx.stderr.write(`npm ERR! could not remove ${name}: ${describeError(error)}\n`);
                failed = true;
            }
        }
        const unlinkBins = deps?.installer?.unlinkBins;
        if (removed.length > 0 && unlinkBins !== undefined) {
            try {
                await unlinkBins({ modulesDir, globalBinDir: prefix === null ? undefined : binDir, pid: ctx.pid, packages: removed });
            }
            catch (error) {
                await ctx.stderr.write(`npm ERR! could not remove the bins of ${removed.join(', ')}: ${describeError(error)}\n`);
                failed = true;
            }
        }
        if (project !== null) {
            const text = packageJsonText(withoutDeclared(project.json, names), project.text);
            if (text.trim() !== project.text.trim()) {
                try {
                    await deps?.beforeWrite?.(ctx, pkgPath);
                    await ctx.vfs.writeFile(pkgPath, text);
                }
                catch (error) {
                    await ctx.stderr.write(`npm ERR! could not update package.json: ${describeError(error)}\n`);
                    return 1;
                }
            }
        }
        if (failed)
            return 1;
        await ctx.stdout.write(`\n${npmRemovedLine(removed.length, Date.now() - startedAt)}\n`);
        return 0;
    }
    finally {
        release();
    }
}
const byPkgid = new Intl.Collator('en');
/**
 * `npm ls` at its default depth, as npm prints it (lib/commands/ls.js over
 * arborist's actual tree): the root; then, sorted as npm sorts them, each
 * dependency it declares, installed, UNMET where it is not (OPTIONAL for an
 * optional one), or invalid for its range; and each package in node_modules
 * nothing installed depends on, extraneous. `-g`: every package in the
 * global prefix, none extraneous. A missing required or an invalid
 * dependency fails the command (ELSPROBLEMS), an extraneous package alone
 * does not; a root package.json that is not a JSON object fails it
 * (EJSONPARSE) once the tree is printed.
 */
async function npmList(ctx) {
    const { prefix } = await npmInvocation(ctx);
    const global = prefix !== null;
    const root = global ? `${prefix}/lib` : ctx.cwd;
    const modulesDir = join(root, 'node_modules');
    let text = null;
    if (!global) {
        try {
            text = await ctx.vfs.readFileString(join(root, 'package.json'));
        }
        catch (error) {
            if (!isVfsError(error, 'ENOENT')) {
                await ctx.stderr.write(`npm error ${describeError(error)}\n`);
                return 1;
            }
        }
    }
    const project = text === null ? null : readPackageJson(text);
    const json = project?.json ?? {};
    const field = (key) => {
        const value = json[key];
        return typeof value === 'string' ? value : '';
    };
    const rootId = `${field('name') || basename(root)}@${field('version')}`;
    const rootReal = await ctx.vfs.realpath(root).catch(() => root);
    // Every package in the tree, at its placement; those its root's edges reach, through node_modules upward from each (Node.resolve).
    const placements = new Set(await installedPlacements(ctx.vfs, modulesDir, () => true));
    const resolveFrom = (from, name) => {
        for (let at = from;; at = parentPlacement(at)) {
            const placement = at === '' ? name : `${at}/node_modules/${name}`;
            if (placements.has(placement))
                return placement;
            if (at === '')
                return null;
        }
    };
    const nodes = new Map();
    const nodeAt = async (placement) => {
        const known = nodes.get(placement);
        if (known !== undefined)
            return known;
        const dir = join(modulesDir, placement);
        const read = await packageJsonIn(ctx.vfs, dir);
        const name = placementName(placement);
        const own = read?.json.name;
        const written = read?.json.version;
        const version = typeof written === 'string' ? written : '';
        const alias = typeof own === 'string' && own !== '' && own !== name ? `npm:${own}@` : '';
        const link = (await ctx.vfs.isSymlink(dir)) ? await ctx.vfs.realpath(dir).then((real) => relative(rootReal, real), () => null) : null;
        const node = { pkgid: `${name}@${alias}${version}`, version, manifest: read?.manifest ?? {}, link };
        nodes.set(placement, node);
        return node;
    };
    const edges = global ? [] : projectRoots(project?.manifest ?? null, []);
    const reached = new Set();
    const pending = edges.map(({ name }) => ['', name]);
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const at = resolveFrom(...next);
        if (at === null || reached.has(at))
            continue;
        reached.add(at);
        const node = await nodeAt(at);
        // A link's dependencies are its target's, resolved where the target is.
        if (node.link === null)
            for (const edge of manifestEdges(node.manifest))
                pending.push([at, edge.name]);
    }
    const listed = [];
    const linked = (node) => (node.link === null ? '' : ` -> ./${node.link}`);
    for (const edge of edges) {
        if (!placements.has(edge.name)) {
            const pkgid = `${edge.name}@${edge.range}`;
            const optional = isOptional(edge.type);
            listed.push({ pkgid, label: `UNMET ${optional ? 'OPTIONAL ' : ''}DEPENDENCY ${pkgid}`, problems: optional ? [] : [`missing: ${pkgid}, required by ${rootId}`] });
            continue;
        }
        const node = await nodeAt(edge.name);
        const invalid = !meets(node.version, edge);
        listed.push({
            pkgid: node.pkgid,
            label: `${node.pkgid}${invalid ? ` invalid: ${JSON.stringify(edge.range)} from the root project` : ''}${linked(node)}`,
            problems: invalid ? [`invalid: ${node.pkgid} ${join(modulesDir, edge.name)}`] : [],
        });
    }
    for (const name of placements) {
        if (name.includes('/node_modules/') || reached.has(name))
            continue;
        const node = await nodeAt(name);
        listed.push({
            pkgid: node.pkgid,
            label: `${node.pkgid}${global ? '' : ' extraneous'}${linked(node)}`,
            problems: global ? [] : [`extraneous: ${node.pkgid} ${join(modulesDir, name)}`],
        });
    }
    listed.sort((a, b) => byPkgid.compare(a.pkgid, b.pkgid));
    const header = global || Object.keys(json).length === 0 ? root : `${rootId} ${root}`;
    const lines = listed.length === 0 ? ['└── (empty)'] : listed.map(({ label }, i) => `${i === listed.length - 1 ? '└── ' : '├── '}${label}`);
    await ctx.stdout.write(`${header}\n${lines.join('\n')}\n\n`);
    if (text !== null && project === null) {
        await ctx.stderr.write('npm error code EJSONPARSE\nnpm error JSON.parse Failed to parse root package.json\nnpm error JSON.parse Failed to parse JSON data.\nnpm error JSON.parse Note: package.json must be actual JSON, not just JavaScript.\n');
        return 1;
    }
    const problems = listed.flatMap(({ problems }) => problems);
    if (problems.every((problem) => problem.startsWith('extraneous:')))
        return 0;
    await ctx.stderr.write(['code ELSPROBLEMS', ...problems].map((line) => `npm error ${line}\n`).join(''));
    return 1;
}
/**
 * npm's run (`npm run`, `run-script`, `test`, `start`): the project's script
 * for the event, its pre<event> before it and post<event> after it unless
 * --ignore-scripts, each through the host's shell as @npmcli/run-script runs
 * one: the words after the event (after `--`) appended to the event's own
 * script, each quoted for sh (npmShellWord), under npm's lifecycle
 * environment (npmScriptEnv). The first script that fails stops the rest.
 */
async function npmRun(ctx, shellExecute, deps) {
    const config = await npmConfigOf(ctx);
    const [command, ...words] = config.positionals;
    const [event, args] = command === 'run' || command === 'run-script' ? [words[0], words.slice(1)] : [command, words];
    const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd));
    if (!pkg) {
        await ctx.stderr.write('npm ERR! no package.json found\n');
        return 1;
    }
    const scripts = pkg.scripts ?? {};
    if (event === undefined) {
        if (Object.keys(scripts).length === 0) {
            await ctx.stdout.write('No scripts defined in package.json\n');
            return 0;
        }
        await ctx.stdout.write('Available scripts:\n');
        for (const [name, cmd] of Object.entries(scripts)) {
            await ctx.stdout.write(`  ${name}\n    ${cmd}\n`);
        }
        return 0;
    }
    const own = Object.hasOwn(scripts, event) ? scripts[event] : undefined;
    if (own === undefined) {
        if (config.get('if-present') === true)
            return 0;
        await ctx.stderr.write(`npm ERR! Missing script: "${event}"\n`);
        if (Object.keys(scripts).length > 0) {
            await ctx.stderr.write('\nAvailable scripts:\n');
            for (const name of Object.keys(scripts)) {
                await ctx.stderr.write(`  - ${name}\n`);
            }
        }
        return 1;
    }
    // Positional words go to the event's own script, not to its pre and post.
    const lifecycle = [{ event, script: own, args }];
    if (config.get('ignore-scripts') !== true) {
        const pre = scripts[`pre${event}`];
        const post = scripts[`post${event}`];
        if (pre)
            lifecycle.unshift({ event: `pre${event}`, script: pre, args: [] });
        if (post)
            lifecycle.push({ event: `post${event}`, script: post, args: [] });
    }
    const refused = await deps?.beforeRun?.(ctx, { event, scripts: lifecycle, manifest: pkg });
    if (refused !== undefined && refused !== null)
        return refused;
    if (!shellExecute) {
        await ctx.stderr.write('(shell integration unavailable, run the command directly)\n');
        return 1;
    }
    for (const [at, run] of lifecycle.entries()) {
        await ctx.stdout.write(`\n> ${pkg.name || ''}@${pkg.version || '1.0.0'} ${run.event}\n> ${`${run.script.trim()} ${run.args.join(' ')}`.trim()}\n\n`);
        const command = [run.script, ...run.args.map(npmShellWord)].join(' ');
        const outcome = await shellExecute(command, { ...ctx, env: npmScriptEnv(ctx, pkg, run.event, run.script) }, run);
        if (outcome === 'resident') {
            // It runs on after npm run returns, so what would follow its end cannot.
            for (const after of lifecycle.slice(at + 1))
                await ctx.stderr.write(`npm warn ${after.event} not run: ${run.event} is still running\n`);
            return 0;
        }
        if (outcome !== 0)
            return outcome;
    }
    return 0;
}
/**
 * The environment npm runs a script of `pkg` under (@npmcli/run-script):
 * the command's, with the script's event and text, the package's name,
 * version and package.json, and node_modules/.bin of the project and of
 * each directory above it first on PATH, so a project's bins are found
 * from its scripts, and only from them.
 */
function npmScriptEnv(ctx, pkg, event, script) {
    const bins = [];
    for (let dir = resolve(ctx.cwd);; dir = resolve(dir, '..')) {
        bins.push(join(dir, 'node_modules', '.bin'));
        if (dir === '/')
            break;
    }
    return {
        ...ctx.env,
        npm_package_json: join(resolve(ctx.cwd), 'package.json'),
        npm_lifecycle_event: event,
        npm_lifecycle_script: script,
        npm_package_name: pkg.name ?? '',
        npm_package_version: pkg.version ?? '',
        PATH: [...bins, ctx.env.PATH ?? DEFAULT_PATH].join(':'),
    };
}
async function npmInfo(ctx, network) {
    const args = ctx.args.slice(1);
    const spec = args[0];
    if (!spec) {
        await ctx.stderr.write('Usage: npm info <package>\n');
        return 1;
    }
    const { name, range: version } = splitPackageSpec(spec);
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
/** The command npm runs for `subcommand` (one of its aliases), or null for one it does not know. */
function npmSubcommand(subcommand, shellExecute, kernel, deps) {
    switch (subcommand) {
        case 'init':
        case 'create':
        case 'innit':
            return async (ctx) => (await import('./npm-init.js')).npmInitCommand(ctx, await npmConfigOf(ctx));
        case 'install':
        case 'i':
        case 'add':
            return (ctx) => npmInstall(ctx, kernel, deps);
        case 'ci':
        case 'clean-install':
        case 'install-clean':
            return (ctx) => npmCi(ctx, deps);
        case 'uninstall':
        case 'remove':
        case 'rm':
        case 'un':
            return (ctx) => npmUninstall(ctx, kernel, deps);
        case 'list':
        case 'ls':
            return (ctx) => npmList(ctx);
        case 'run':
        case 'run-script':
        case 'start':
        case 'test':
            return (ctx) => npmRun(ctx, shellExecute, deps);
        case 'info':
        case 'view':
        case 'show':
            return (ctx) => npmInfo(ctx, (kernel?.network ?? ISOLATE_NETWORK).forProcess(ctx.pid));
        case 'search':
            return (ctx) => npmSearch(ctx, (kernel?.network ?? ISOLATE_NETWORK).forProcess(ctx.pid));
        default:
            return null;
    }
}
/**
 * The npm command. It registers no commands: a project's bins are found on
 * its scripts' PATH and global bins on the prefix's bin, so `_registry` is
 * unread, kept for the signature's callers.
 */
export function createNpmCommand(_registry, shellExecute, kernel, deps) {
    return async (ctx) => {
        const subcommand = ctx.args[0];
        if (!subcommand || subcommand === '--help' || subcommand === '-h') {
            await printHelp(ctx);
            return subcommand ? 0 : 1;
        }
        if (subcommand === '-v' || subcommand === '--version') {
            await ctx.stdout.write(NPM_VERSION + '\n');
            return 0;
        }
        const run = npmSubcommand(subcommand, shellExecute, kernel, deps);
        if (run === null) {
            await ctx.stderr.write(`npm: unknown command '${subcommand}'\n`);
            await ctx.stderr.write('Run npm --help for usage\n');
            return 1;
        }
        // What npm does before any command it knows: its configuration read, and the project's devEngines checked.
        if (await devEnginesRefuse(ctx, await npmConfigOf(ctx)))
            return 1;
        return await run(ctx);
    };
}
/**
 * `npm ci`: a clean install of the tree package-lock.json (or
 * npm-shrinkwrap.json) records. The host builds npm's tree over the lock
 * and only then removes node_modules: a lock that is not that tree fails
 * the install with the project untouched.
 */
async function npmCi(ctx, deps) {
    const invocation = npmInstallInvocation(await npmConfigOf(ctx));
    if (invocation.unsupported.length > 0) {
        for (const line of invocation.unsupported)
            await ctx.stderr.write(`npm ERR! ${line}\n`);
        return 1;
    }
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
            signal: ctx.signal,
            registry: registryOf(ctx, invocation),
            cache: invocation.cache,
            production: invocation.production,
            omitOptional: invocation.omitOptional,
            omitPeer: invocation.omitPeer,
            force: invocation.force,
            engineStrict: invocation.engineStrict,
            strictPeerDeps: invocation.strictPeerDeps,
            legacyPeerDeps: invocation.legacyPeerDeps,
            preferDedupe: invocation.preferDedupe,
            fromLockfile: true,
            npmLog,
            onProgress: async (line) => await ctx.stdout.write(`[npm] ${line}\n`),
        });
        if (await writeEngines(ctx, result.engines, invocation.engineStrict, invocation.loglevel))
            return 1;
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
 * Install one package globally, through the install port (the host's, else
 * the shell's own). Called directly by `lifo install` to avoid the
 * shell.execute() round-trip, which can silently swallow output and errors.
 */
export async function npmInstallGlobal(packageName, ctx, kernel, deps) {
    const startTime = Date.now();
    const prefix = await npmGlobalPrefix(ctx);
    const installer = deps?.installer ?? shellInstallPort(ctx, kernel);
    const { installed, failed } = await installer.install({
        projectDir: ctx.cwd, packages: [packageName], global: true, globalPrefix: prefix, pid: ctx.pid, signal: ctx.signal, registry: getRegistry(ctx.env),
    });
    if (failed.length > 0)
        return 1;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await ctx.stdout.write(`\nadded ${installed.length} package${installed.length !== 1 ? 's' : ''} in ${elapsed}s\n`);
    return 0;
}
