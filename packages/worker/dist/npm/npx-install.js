/**
 * npx-install.ts — Nimbus-native npx implementation.
 *
 * Fixes the too-narrow semver-range detector in the original substrate command
 * path, which missed major-only ranges like `'1'`, `'2'`, and `'1.0'`.
 * That path treated `'1'` as a literal version, fetched `/wrappy/1`, got 404,
 * and silently skipped the dependency.
 *
 * Symptom captured by tests/behavioral/install/transitive-dep-resolution.mjs:
 *   `npx --yes rimraf@3.0.2 --help` →
 *     warn: could not install wrappy: Package 'wrappy@1' not found in registry
 *     warn: could not install inherits: Package 'inherits@2' not found in registry
 *     Cannot find module './' (from /tmp/.npx-cache/node_modules/rimraf)
 *
 * Fix: route the npx install step through Nimbus's NpmInstaller, which
 * uses always-fetch-packument + RESOLVE_VERSION-style version-pick path
 * (resolve-one-facet.ts:264 + RESOLVE_VERSION). Handles all semver-range
 * syntax including major-only and major.minor.
 *
 * Binary lookup and execution follow libnpmexec 10.9.8's flow:
 *   1. Built-ins (vite, esbuild) are the caller's, before this module.
 *   2. The package in cwd/node_modules, where it answers the request
 *      (libnpmexec missingFromTree, answers).
 *   3. The npx cache directory of this request (npxCacheDir: one per spec
 *      set, as libnpmexec's), where it answers it.
 *   4. Else install the package into that directory via NpmInstaller.
 *   5. The bin libnpmexec chooses from the package's manifest (npxPackageBin),
 *      invoked via Nimbus's `node` registry command.
 */
import { isStagedArtifactTarget, npxPackageBin } from './bin-links.js';
import { bundleProfileForNpmBin } from '@nimbus-sh/core/runtime/bundle-profile.js';
import { splitPackageSpec } from '@nimbus-sh/core/_shared/npm-spec.js';
import { satisfiesRange } from '@nimbus-sh/core/_shared/npm-semver.js';
import { bytesToHex } from '@nimbus-sh/platform/hex.js';
/** Where npx keeps what it installs: a directory for each request (npxCacheDir). */
const NPX_CACHE_DIR = '/tmp/.npx-cache';
/**
 * SqliteVFS uses absolute paths WITHOUT a leading slash (e.g. it stores
 * `tmp/.npx-cache/node_modules/foo/package.json`, not `/tmp/...`). The
 * NpmInstaller's `install()` entry strips the leading slash from its
 * `projectDir` arg, then propagates the slashless form into all
 * downstream pkgDirs and inode keys. To check existence post-install,
 * we MUST strip the same way; `vfs.exists('/...')` always returns false.
 *
 * Mirror of `_strip` in src/runtime/node-shims.ts:204.
 */
function _vfsKey(p) {
    return p.replace(/^\/+/, '');
}
export function parseNpxInvocation(rawArgs) {
    const invocation = { self: 'missing', command: null, args: [], packageOverride: null, yes: false };
    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg === '-y' || arg === '--yes') {
            invocation.yes = true;
        }
        else if (arg === '--package') {
            invocation.packageOverride = rawArgs[++i] ?? null;
        }
        else if (arg.startsWith('--package=')) {
            invocation.packageOverride = arg.slice('--package='.length);
        }
        else if (arg === '--version' || arg === '-v') {
            return { ...invocation, self: 'version' };
        }
        else if (arg === '--help' || arg === '-h') {
            return { ...invocation, self: 'help' };
        }
        else {
            return { ...invocation, self: null, command: arg, args: rawArgs.slice(i + 1) };
        }
    }
    return invocation;
}
export function formatNpxHelp() {
    return [
        'Usage: npx [options] <package[@version]> [args...]',
        '',
        'Options:',
        '  -y, --yes              skip prompts',
        '  --package=<pkg>        explicit package name',
        '  -v, --version          print version',
        '  -h, --help             show this help',
        '',
    ].join('\n');
}
function parseNpxArgs(rawArgs) {
    const invocation = parseNpxInvocation(rawArgs);
    // npx's own --help/--version are the caller's to print (hosted/commands.ts).
    if (invocation.self !== null || invocation.command === null) {
        return { error: invocation.self === 'missing' || invocation.self === null ? 'missing-cmd' : `--${invocation.self}` };
    }
    // With --package=<pkg>, the positional arg is the bin to run and the
    // package installs `<pkg>`. Without it, the positional arg is
    // `<name>[@<version>]`, the package, and its manifest decides the bin.
    const first = invocation.command;
    const pkgSpec = invocation.packageOverride ?? first;
    const command = invocation.packageOverride ? first : null;
    const { name: pkgName, parsed: spec } = splitPackageSpec(pkgSpec);
    return { pkgSpec, pkgName, spec, command, binArgs: invocation.args, yes: invocation.yes };
}
/**
 * The bin npx runs from the package at `packageDir`, chosen and validated as
 * npxPackageBin does, with the version of the package that has it; null for
 * none, or a staged-artifact bin (a sentinel, not a file `node` can run).
 */
async function binAt(vfs, packageDir, command) {
    const bin = await npxPackageBin(vfs, packageDir, command);
    return bin && !isStagedArtifactTarget(bin.targetPath) ? { name: bin.name, path: '/' + bin.targetPath, version: bin.packageVersion } : null;
}
/**
 * The directory npx installs `specs` into, as libnpmexec 10.9.8 names it: the
 * first 16 hex digits of the SHA-512 of the specs as written, sorted, one a
 * line. Each request set its own, so one that fails, or names another
 * version, never touches what another installed.
 */
export async function npxCacheDir(specs) {
    const text = [...specs].sort((a, b) => a.localeCompare(b, 'en')).join('\n');
    const digest = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(text));
    return `${NPX_CACHE_DIR}/${bytesToHex(new Uint8Array(digest, 0, 8))}`;
}
/**
 * Whether an installed `version` answers `spec`, as libnpmexec's
 * missingFromTree reads a tree: a spec by name alone, or a wildcard, takes
 * whatever is installed (a prerelease too); a registry version or range,
 * only a version that satisfies it. Any other spec (a tag, a git or tarball
 * url, a path) only the npx directory of that very request answers
 * (`ownRequest`): npm would fetch its manifest to compare, and that
 * directory holds what it named.
 */
function answers(spec, version, ownRequest) {
    if (spec === null)
        return false;
    if (spec.raw === spec.name)
        return true;
    if (spec.registry && (spec.type === 'version' || spec.type === 'range'))
        return spec.rawSpec === '*' || satisfiesRange(version, spec.rawSpec);
    return ownRequest;
}
/**
 * Resolve a binary for `npx <args>` by:
 *   1. Parsing args.
 *   2. Checking the package in cwd/node_modules, then this request's npx
 *      directory, where it answers the request (answers).
 *   3. Else installing the package into that directory via NpmInstaller.
 *
 * The caller is responsible for actually invoking the resulting binPath
 * via Nimbus's `node` command — keeping this module pure (no process
 * spawning) makes it testable.
 *
 * Note: deliberately does not format `--version`/`--help` for npx itself.
 * Callers can use parseNpxInvocation()/formatNpxHelp() before calling
 * this resolver.
 */
export async function resolveNpxBinary(installer, 
/** The caller's view of the namespace (runtime/project-fs.ts): the project and the npx cache alike. */
vfs, 
/** The caller's credential: what the npx cache install is written as. */
cred, cwd, rawArgs, log, pid, 
/** The command's `NPM_REGISTRY`; the npx cache install reads from it too. */
registry, 
/** The command's: an install it stops changes nothing, and one waiting for the cache never starts. */
signal) {
    const parsed = parseNpxArgs(rawArgs);
    if ('error' in parsed) {
        return { ok: false, error: parsed.error };
    }
    const found = (bin, source) => ({
        ok: true,
        binPath: bin.path,
        binArgs: parsed.binArgs,
        bundleProfile: bundleProfileForNpmBin({ name: bin.name, packageName: parsed.pkgName }),
        source,
    });
    // 1. The project's own package, where it answers the request.
    const spec = parsed.spec;
    const local = await binAt(vfs, `${cwd}/node_modules/${parsed.pkgName}`, parsed.command);
    if (local && answers(spec, local.version, false))
        return found(local, 'project-nm');
    // 2. This request's npx directory, where an earlier npx installed it.
    const dir = await npxCacheDir([parsed.pkgSpec]);
    const cached = `${dir}/node_modules/${parsed.pkgName}`;
    const there = await binAt(vfs, cached, parsed.command);
    if (there && answers(spec, there.version, true))
        return found(there, 'npx-cache');
    // 3. Install it there, made as libnpmexec makes it: what the install writes is that directory's alone.
    log(`  ${parsed.pkgSpec}...`);
    try {
        await vfs.mkdir(_vfsKey(dir), { recursive: true });
        const result = await installer.install(dir, {
            packages: [parsed.pkgSpec],
            pid,
            cred,
            registry,
            signal,
            onProgress: (msg) => log(`[npm] ${msg}`),
        });
        if ((result.failed?.length || 0) > 0) {
            return { ok: false, error: `npx: install partially failed: ${result.failed.join(', ')}` };
        }
    }
    catch (e) {
        return { ok: false, error: `npx: install failed: ${e?.message ?? String(e)}` };
    }
    const bin = await binAt(vfs, cached, parsed.command);
    if (bin)
        return found(bin, 'fresh-install');
    return {
        ok: false,
        error: parsed.command === null
            ? `npx: could not determine executable to run from ${parsed.pkgSpec}`
            : `npx: installed ${parsed.pkgSpec} but could not locate binary '${parsed.command}' in ${cached}`,
    };
}
