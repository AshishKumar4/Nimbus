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
 * Binary lookup and execution follow the same user-visible npx flow:
 *   1. Check cwd/node_modules/.bin/<cmd>
 *   2. Check /tmp/.npx-cache/node_modules/.bin/<cmd>
 *   3. Check global registry (built-ins like vite, esbuild — handled by
 *      caller; this module is only invoked when registry resolution failed)
 *   4. Install package via NpmInstaller into /tmp/.npx-cache
 *   5. Locate <pkg>/package.json#bin → resolve absolute path
 *   6. Invoke via Nimbus's `node` registry command (preserves PID
 *      tracking, log buffer, process table membership)
 */
import { bundleProfileForNpmBin } from '../runtime/bundle-profile.js';
/** Path where npx caches packages it installs. Matches the vendored substrate
 * cache layout so tooling that introspects npx state sees the expected path. */
export const NPX_CACHE_DIR = '/tmp/.npx-cache';
const NPX_CACHE_NM = `${NPX_CACHE_DIR}/node_modules`;
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
function readNpxInvocationHead(rawArgs) {
    let i = 0;
    while (i < rawArgs.length) {
        const arg = rawArgs[i];
        if (arg === '-y' || arg === '--yes') {
            i++;
            continue;
        }
        if (arg === '--package') {
            i += 2;
            continue;
        }
        if (arg.startsWith('--package=')) {
            i++;
            continue;
        }
        if (arg === '--version' || arg === '-v')
            return { self: 'version', command: null, commandIndex: -1 };
        if (arg === '--help' || arg === '-h')
            return { self: 'help', command: null, commandIndex: -1 };
        return { self: null, command: arg, commandIndex: i };
    }
    return { self: 'missing', command: null, commandIndex: -1 };
}
export function describeNpxSelfInvocation(rawArgs) {
    return readNpxInvocationHead(rawArgs).self;
}
export function getNpxCommandWord(rawArgs) {
    return readNpxInvocationHead(rawArgs).command;
}
export function getNpxCommandArgs(rawArgs) {
    const head = readNpxInvocationHead(rawArgs);
    return head.commandIndex >= 0 ? rawArgs.slice(head.commandIndex + 1) : [];
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
    let pkgOverride = null;
    const consumed = [];
    let yes = false;
    let i = 0;
    while (i < rawArgs.length) {
        const a = rawArgs[i];
        if (a === '-y' || a === '--yes') {
            yes = true;
            i++;
            continue;
        }
        if (a === '--package' && i + 1 < rawArgs.length) {
            pkgOverride = rawArgs[i + 1];
            i += 2;
            continue;
        }
        if (a.startsWith('--package=')) {
            pkgOverride = a.slice('--package='.length);
            i++;
            continue;
        }
        if (a === '--version' || a === '-v' || a === '--help' || a === '-h') {
            // Pass-through to surface npx's own version/help. Caller (init.ts
            // npx handler) is the one that prints these; this module returns
            // an error so the caller can branch.
            return { error: a };
        }
        break;
    }
    const first = rawArgs[i];
    if (!first)
        return { error: 'missing-cmd' };
    consumed.push(...rawArgs.slice(i + 1));
    // If --package=<pkg>, the positional arg is the BIN name; the package
    // installs `<pkg>` and we look for the binary `<first>`.
    // Else, the positional arg is `<name>[@<version>]`; binary is the
    // last path segment of `<name>`.
    let pkgSpec;
    let binName;
    if (pkgOverride) {
        pkgSpec = pkgOverride;
        binName = first;
    }
    else {
        pkgSpec = first;
        const namePart = splitSpec(first).name;
        binName = namePart.split('/').pop() || namePart;
    }
    const { name: pkgName } = splitSpec(pkgSpec);
    return { pkgSpec, pkgName, binName, binArgs: consumed, yes };
}
/** Split `name@version` (or scoped `@scope/name@version`) into parts. */
function splitSpec(spec) {
    if (spec.startsWith('@')) {
        const at = spec.indexOf('@', 1);
        if (at === -1)
            return { name: spec, version: null };
        return { name: spec.slice(0, at), version: spec.slice(at + 1) };
    }
    const at = spec.indexOf('@');
    if (at === -1)
        return { name: spec, version: null };
    return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}
/**
 * Find the absolute path of a binary inside a package's directory.
 *
 * package.json#bin can be:
 *   - `string` → single bin named after the package itself
 *   - `Record<string, string>` → multiple bins
 *
 * Returns the resolved absolute path (rooted at packageDir) if a
 * matching bin name is found, else null.
 */
function findBinInPackage(vfs, packageDir, binName) {
    const pkgJsonPath = `${packageDir}/package.json`;
    // SqliteVFS stores keys without leading slash. Check via the stripped
    // key form to match the installer's write convention.
    if (!vfs.exists(_vfsKey(pkgJsonPath)))
        return null;
    let pkgJson;
    try {
        pkgJson = JSON.parse(vfs.readFileString(_vfsKey(pkgJsonPath)));
    }
    catch {
        return null;
    }
    const binField = pkgJson.bin;
    if (!binField)
        return null;
    let resolved = null;
    if (typeof binField === 'string') {
        // Single-bin shorthand: bin name is package name's last segment.
        const expected = String(pkgJson.name || '').split('/').pop();
        if (expected === binName)
            resolved = binField;
    }
    else if (typeof binField === 'object') {
        const candidate = binField[binName];
        if (typeof candidate === 'string') {
            resolved = candidate;
        }
        else {
            // Fall back to the first bin entry, matching npm's common single-binary
            // package behavior when the requested bin is not explicitly named.
            const first = Object.values(binField)[0];
            if (typeof first === 'string')
                resolved = first;
        }
    }
    if (!resolved)
        return null;
    // Strip leading "./" if present and join with packageDir. Return
    // the absolute path (with leading slash) — the `node` registry
    // command expects an absolute filesystem path as the first arg.
    // The vfs.exists checks against _vfsKey internally.
    const rel = resolved.startsWith('./') ? resolved.slice(2) : resolved;
    return `${packageDir}/${rel}`;
}
/**
 * Locate a binary by name across the standard search paths npx uses:
 *   1. cwd/node_modules/.bin/<binName>    (project-local install)
 *   2. NPX_CACHE_NM/<pkgName>/...         (npx-cache install)
 *
 * Returns the absolute path on hit, null on miss.
 */
function locateBinary(vfs, cwd, pkgName, binName) {
    // 1. Project-local node_modules. The packageDir is cwd/node_modules/<pkgName>.
    const projPkgDir = `${cwd}/node_modules/${pkgName}`;
    const projHit = findBinInPackage(vfs, projPkgDir, binName);
    if (projHit && vfs.exists(_vfsKey(projHit)))
        return projHit;
    // 2. NPX cache.
    const npxPkgDir = `${NPX_CACHE_NM}/${pkgName}`;
    const npxHit = findBinInPackage(vfs, npxPkgDir, binName);
    if (npxHit && vfs.exists(_vfsKey(npxHit)))
        return npxHit;
    return null;
}
/**
 * Ensure /tmp/.npx-cache/package.json exists with the requested spec
 * in its dependencies. NpmInstaller reads package.json from projectDir
 * to determine what to install; we synthesize one for the npx cache.
 *
 * Idempotent: if the file already exists and has the spec in deps,
 * leaves it alone. Returns the deps object after the write (useful
 * for the caller's log line).
 */
function ensureNpxCachePackageJson(vfs, pkgName, pkgRange) {
    const pkgJsonPath = `${NPX_CACHE_DIR}/package.json`;
    const pkgJsonKey = _vfsKey(pkgJsonPath);
    let existing = { name: 'npx-cache', version: '0.0.0', dependencies: {} };
    if (vfs.exists(pkgJsonKey)) {
        try {
            existing = JSON.parse(vfs.readFileString(pkgJsonKey));
            if (!existing.dependencies)
                existing.dependencies = {};
        }
        catch {
            // Corrupted — overwrite with fresh content below.
            existing = { name: 'npx-cache', version: '0.0.0', dependencies: {} };
        }
    }
    else {
        // Ensure the parent dir exists. SqliteVFS auto-creates parent
        // dirs in writeFile, but mkdir keeps the cache path explicit here.
        try {
            vfs.mkdir(_vfsKey(NPX_CACHE_DIR), { recursive: true });
        }
        catch { /* dir exists */ }
    }
    existing.dependencies[pkgName] = pkgRange;
    vfs.writeFile(pkgJsonKey, JSON.stringify(existing, null, 2) + '\n');
}
/**
 * Resolve a binary for `npx <args>` by:
 *   1. Parsing args.
 *   2. Checking node_modules/.bin/<binName> in cwd, then NPX cache.
 *   3. If absent, installing the package via NpmInstaller into
 *      /tmp/.npx-cache, then re-checking.
 *
 * The caller is responsible for actually invoking the resulting binPath
 * via Nimbus's `node` command — keeping this module pure (no process
 * spawning) makes it testable.
 *
 * Note: deliberately does not format `--version`/`--help` for npx itself.
 * Callers can use describeNpxSelfInvocation()/formatNpxHelp() before calling
 * this resolver.
 */
export async function resolveNpxBinary(installer, vfs, cwd, rawArgs, log, pid) {
    const parsed = parseNpxArgs(rawArgs);
    if ('error' in parsed) {
        return { ok: false, error: parsed.error };
    }
    // 1. Check project + NPX cache for pre-installed bin.
    const existing = locateBinary(vfs, cwd, parsed.pkgName, parsed.binName);
    if (existing) {
        return {
            ok: true,
            binPath: existing,
            binArgs: parsed.binArgs,
            bundleProfile: bundleProfileForNpmBin({ name: parsed.binName, packageName: parsed.pkgName }),
            source: cwd && existing.startsWith(cwd) ? 'project-nm' : 'npx-cache',
        };
    }
    // 2. Not found anywhere — install into NPX cache via NpmInstaller.
    //    Use the package's `<pkgSpec>` directly; NpmInstaller parses the
    //    `<name>@<version>` form same as `npm install <pkgSpec>`.
    log(`  ${parsed.pkgSpec}...`);
    const { name: instName, version: instVer } = splitSpec(parsed.pkgSpec);
    const installSpec = instVer ? `${instName}@${instVer}` : instName;
    // Synthesize npx-cache package.json so NpmInstaller has a project
    // root. The deps map is the source of truth for the install set.
    ensureNpxCachePackageJson(vfs, instName, instVer || 'latest');
    try {
        const result = await installer.install(NPX_CACHE_DIR, {
            packages: [installSpec],
            pid,
        });
        if ((result.failed?.length || 0) > 0) {
            // Partial install — some package failed to resolve. The fix is
            // designed to handle major-only ranges; a residual failure here
            // means a genuinely missing package or an unrelated transitive
            // gap. Surface it as the error.
            return {
                ok: false,
                error: `npx: install partially failed: ${result.failed.join(', ')}`,
            };
        }
    }
    catch (e) {
        return {
            ok: false,
            error: `npx: install failed: ${e?.message ?? String(e)}`,
        };
    }
    // 3. Re-check NPX cache after install.
    const installed = locateBinary(vfs, cwd, parsed.pkgName, parsed.binName);
    if (installed) {
        return {
            ok: true,
            binPath: installed,
            binArgs: parsed.binArgs,
            bundleProfile: bundleProfileForNpmBin({ name: parsed.binName, packageName: parsed.pkgName }),
            source: 'fresh-install',
        };
    }
    return {
        ok: false,
        error: `npx: installed ${parsed.pkgSpec} but could not locate binary '${parsed.binName}' in ${NPX_CACHE_NM}/${parsed.pkgName}`,
    };
}
