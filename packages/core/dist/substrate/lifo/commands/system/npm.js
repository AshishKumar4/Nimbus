import { ISOLATE_NETWORK } from '../../../../_shared/workspace-network.js';
import { resolveContext } from '../registry.js';
import { resolve, join } from '../../utils/path.js';
import { writeTarballStream } from '../../../../_shared/tarball.js';
import { isNativeBinPath } from '../../../../runtime/os-contracts.js';
import { npmBinMap } from '../../../../runtime/npm-bin-map.js';
import { pickPackumentVersion } from '../../../../_shared/npm-semver.js';
import { parseRegistryRequest, splitPackageSpec } from '../../../../_shared/npm-spec.js';
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
// ─── Install logic ───
async function installSinglePackage(name, version, targetBase, vfs, npmRegistry, signal, stdout, stderr, isGlobal, registry, seen, globalBinDir, kernel) {
    if (seen.has(name))
        return 0;
    seen.add(name);
    const targetDir = join(targetBase, name);
    // Skip if already installed
    if ((await vfs.exists(join(targetDir, 'package.json')))) {
        return 0;
    }
    (await stdout.write(`  ${name}${version ? '@' + version : ''}...\n`));
    const network = kernel?.network ?? ISOLATE_NETWORK;
    const info = await fetchPackageInfo(network, npmRegistry, name, version, signal);
    // writeTarballStream throws when the archive carried no manifest and writes
    // package.json last, so a return here is a complete package on disk.
    await fetchAndStreamPackage(network, info.dist.tarball, info.dist.integrity, targetDir, vfs, signal, stderr);
    let installed = 1;
    // Global install: link binaries into the resolved prefix's bin dir
    if (isGlobal && globalBinDir) {
        const binEntries = getBinEntries(info);
        for (const [binName, binPath] of Object.entries(binEntries)) {
            const scriptPath = resolve(targetDir, binPath);
            registerBinCommand(registry, binName, scriptPath, kernel);
            try {
                (await vfs.mkdir(globalBinDir, { recursive: true }));
            }
            catch { /* exists */ }
            (await vfs.writeFile(join(globalBinDir, binName), `#!/usr/bin/env node\nrequire('${scriptPath}');\n`));
        }
    }
    // Recursively install dependencies (flat into the same targetBase)
    if (info.dependencies) {
        for (const [depName, depRange] of Object.entries(info.dependencies)) {
            try {
                installed += await installSinglePackage(depName, depRange, targetBase, vfs, npmRegistry, signal, stdout, stderr, isGlobal, registry, seen, globalBinDir, kernel);
            }
            catch (e) {
                (await stderr.write(`  warn: could not install ${depName}: ${e instanceof Error ? e.message : String(e)}\n`));
            }
        }
    }
    return installed;
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
/**
 * `npm init`, `npm create` and `npm innit` (npm-init.ts). npm's own
 * libraries there (hosted-git-info, npm-package-arg, semver, the SPDX list)
 * are evaluated the first time a session runs one, not when it starts.
 */
async function npmInit(ctx) {
    return (await import('./npm-init.js')).npmInitCommand(ctx);
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
    if (packages.length === 0) {
        // Install from package.json
        const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd));
        if (!pkg) {
            await ctx.stderr.write('npm ERR! no package.json found\n');
            return 1;
        }
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        const depNames = Object.keys(allDeps);
        if (depNames.length === 0) {
            await ctx.stdout.write('up to date, audited 0 packages\n');
            return 0;
        }
        await ctx.stdout.write('Installing dependencies...\n');
        const seen = new Set();
        for (const [name, range] of Object.entries(allDeps)) {
            try {
                installed += await installSinglePackage(name, range, targetBase, ctx.vfs, npmRegistry, ctx.signal, ctx.stdout, ctx.stderr, false, registry, seen, undefined, kernel);
            }
            catch (e) {
                failed.push(name);
                await ctx.stderr.write(`npm ERR! ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
            }
        }
    }
    else {
        // Install specified packages
        await ctx.stdout.write('Installing packages...\n');
        const seen = new Set();
        for (const spec of packages) {
            const { name, range: version } = splitPackageSpec(spec);
            try {
                installed += await installSinglePackage(name, version, targetBase, ctx.vfs, npmRegistry, ctx.signal, ctx.stdout, ctx.stderr, invocation.global, registry, seen, invocation.global ? globalBinDir : undefined);
                // Update package.json for local installs
                if (!invocation.global) {
                    const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd));
                    if (pkg) {
                        const installedPkgPath = join(targetBase, name, 'package.json');
                        let versionStr = 'latest';
                        try {
                            const ipkg = JSON.parse((await ctx.vfs.readFileString(installedPkgPath)));
                            // An alias (`mine@npm:real@^1`) saves the package it
                            // installed, as npm does: "mine": "npm:real@^1.1.0".
                            versionStr = (typeof ipkg.name === 'string' && ipkg.name !== name ? `npm:${ipkg.name}@` : '') + '^' + ipkg.version;
                        }
                        catch { /* ignore */ }
                        if (invocation.saveDev) {
                            pkg.devDependencies = pkg.devDependencies || {};
                            pkg.devDependencies[name] = versionStr;
                        }
                        else {
                            pkg.dependencies = pkg.dependencies || {};
                            pkg.dependencies[name] = versionStr;
                        }
                        (await writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg));
                    }
                }
            }
            catch (e) {
                failed.push(name);
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
                    await ctx.stderr.write(`npm ERR! network error fetching ${name}\n`);
                    await ctx.stderr.write(`This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n`);
                }
                else {
                    await ctx.stderr.write(`npm ERR! ${msg}\n`);
                }
            }
        }
    }
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
export function createNpmCommand(registry, shellExecute, kernel, deps) {
    return async (ctx) => {
        const subcommand = ctx.args[0];
        if (!subcommand || subcommand === '--help' || subcommand === '-h') {
            await printHelp(ctx);
            return subcommand ? 0 : 1;
        }
        switch (subcommand) {
            case 'init':
            case 'create':
            case 'innit':
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
export function createNpxCommand(registry, shellExecute) {
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
        const { name: parsedName, range: version } = splitPackageSpec(explicitPkg || spec);
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
                const npmRegistry = getRegistry(ctx.env);
                const seen = new Set();
                try {
                    await installSinglePackage(parsedName, version, NPX_CACHE, ctx.vfs, npmRegistry, ctx.signal, ctx.stdout, ctx.stderr, false, registry, seen);
                }
                catch (e) {
                    await ctx.stderr.write(`npx: could not install ${parsedName}: ${e instanceof Error ? e.message : String(e)}\n`);
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
    const npmRegistry = getRegistry(ctx.env);
    const startTime = Date.now();
    const seen = new Set();
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
    try {
        const installed = await installSinglePackage(packageName, null, modulesDir, ctx.vfs, npmRegistry, ctx.signal, ctx.stdout, ctx.stderr, true, registry, seen, binDir, kernel);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        await ctx.stdout.write(`\nadded ${installed} package${installed !== 1 ? 's' : ''} in ${elapsed}s\n`);
        return 0;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
            await ctx.stderr.write(`npm ERR! network error fetching ${packageName}\n`);
            await ctx.stderr.write('This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n');
        }
        else {
            await ctx.stderr.write(`npm ERR! ${msg}\n`);
        }
        return 1;
    }
}
