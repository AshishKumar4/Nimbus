import { normalizeVfsPath, resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { STAGED_ARTIFACT_BIN_PREFIX } from '../facets/wasm-swap-registry.js';
import { z } from 'zod/v4';
/**
 * A staged-artifact bin target (`nimbus-staged:<artifact>`) is a sentinel,
 * not a VFS path: the runnable bundle lives in the static-assets layer and is
 * fetched at exec time. It must NOT be resolved against the VFS.
 */
export function isStagedArtifactTarget(target) {
    return target.startsWith(STAGED_ARTIFACT_BIN_PREFIX);
}
export function stagedArtifactId(target) {
    return target.slice(STAGED_ARTIFACT_BIN_PREFIX.length);
}
export const NPM_BIN_MANIFEST_VERSION = 1;
export const NPM_BIN_MANIFEST_NAME = '.nimbus-bin-map.json';
const NpmBinEntrySchema = z.object({
    name: z.string().min(1),
    packageName: z.string().min(1),
    packageVersion: z.string(),
    packagePath: z.string().min(1),
    targetPath: z.string().min(1),
});
const NpmBinManifestSchema = z.object({
    version: z.literal(NPM_BIN_MANIFEST_VERSION),
    bins: z.record(z.string(), NpmBinEntrySchema),
});
const PackageJsonSchema = z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    bin: z.union([
        z.string(),
        z.record(z.string(), z.string()),
    ]).optional(),
}).passthrough();
export function npmBinDirPath(nodeModulesPath) {
    return normalizeVfsPath(`${nodeModulesPath}/.bin`);
}
export function npmBinManifestPath(nodeModulesPath) {
    return `${npmBinDirPath(nodeModulesPath)}/${NPM_BIN_MANIFEST_NAME}`;
}
export function createNpmBinManifest(entries) {
    const bins = {};
    for (const entry of entries)
        bins[entry.name] = entry;
    return { version: NPM_BIN_MANIFEST_VERSION, bins };
}
export function createNpmBinShim(entry, shimDir) {
    if (isStagedArtifactTarget(entry.targetPath)) {
        // The runnable bundle is staged in the assets layer; the shell dispatches
        // it through the staged-artifact runtime by recognizing the sentinel in
        // the bin manifest. The shim body is only a marker for PATH discovery.
        return `#!/usr/bin/env node\n// nimbus staged artifact: ${entry.targetPath}\n`;
    }
    // Relative to the shim, as npm's .bin symlinks are, so a node_modules
    // tree that is moved (a staged install renamed into place) still runs.
    return `#!/usr/bin/env node\nrequire(${JSON.stringify(relativeRequest(shimDir, entry.targetPath))});\n`;
}
function relativeRequest(fromDir, target) {
    const from = normalizeVfsPath(fromDir).split('/').filter(Boolean);
    const to = normalizeVfsPath(target).split('/').filter(Boolean);
    let common = 0;
    while (common < from.length && common < to.length - 1 && from[common] === to[common])
        common++;
    const rel = [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
    return rel.startsWith('../') ? rel : `./${rel}`;
}
export function packageBinEntries(pkg, nodeModulesPath) {
    const packagePath = normalizeVfsPath(`${nodeModulesPath}/${pkg.name}`);
    const entries = [];
    const packageVersion = String(pkg.version || '');
    if (!pkg.bin || typeof pkg.bin !== 'object')
        return entries;
    for (const [name, rawTarget] of Object.entries(pkg.bin)) {
        if (typeof rawTarget !== 'string' || !name)
            continue;
        entries.push({
            name,
            packageName: pkg.name,
            packageVersion,
            packagePath,
            // Staged-artifact sentinels pass through verbatim; everything else
            // resolves to a concrete VFS path under the package dir.
            targetPath: isStagedArtifactTarget(rawTarget)
                ? rawTarget
                : resolveVfsPath(rawTarget, packagePath),
        });
    }
    return entries;
}
export async function resolveNpmBin(vfs, cwd, name) {
    const root = normalizeVfsPath(cwd || '/home/user');
    for (const nodeModulesPath of candidateNodeModulesPaths(root)) {
        const resolved = await resolveNpmBinAt(vfs, nodeModulesPath, name);
        if (resolved)
            return resolved;
    }
    return null;
}
export async function resolveNpmBinFromPath(vfs, cwd, envPath, name) {
    for (const binDir of candidatePathDirs(cwd, envPath)) {
        const resolved = await resolveNpmBinInBinDir(vfs, binDir, name);
        if (resolved)
            return resolved;
    }
    return null;
}
/** A path-shaped invocation of an executable entry in a `node_modules/.bin` directory; null otherwise. */
export async function resolveNpmBinPath(vfs, cwd, path) {
    const shimPath = resolveVfsPath(path, cwd || '/home/user');
    const slash = shimPath.lastIndexOf('/');
    if (slash < 0)
        return null;
    const binDir = shimPath.slice(0, slash);
    if (!binDir.endsWith('/node_modules/.bin'))
        return null;
    try {
        if (((await vfs.stat(shimPath)).mode & 0o111) === 0)
            return null;
    }
    catch {
        return null;
    }
    return await resolveNpmBinInBinDir(vfs, binDir, shimPath.slice(slash + 1));
}
export async function materializeNpmBinShims(vfs, nodeModulesPath, binDir) {
    const entries = await listNpmBinEntries(vfs, normalizeVfsPath(nodeModulesPath));
    if (entries.length === 0)
        return 0;
    const targetBinDir = normalizeVfsPath(binDir);
    await vfs.mkdir(targetBinDir, { recursive: true });
    for (const entry of entries) {
        const shimPath = `${targetBinDir}/${entry.name}`;
        await vfs.writeFile(shimPath, createNpmBinShim(entry, targetBinDir));
        // writeFile creates files 0o644; a bin shim on PATH must be executable
        // or the shell rejects it ("command not found"). Match the 0o755 the
        // Phase-6 .bin linker uses. chmod (not a mode arg) so a re-install over
        // an existing 0o644 shim is corrected too.
        await vfs.chmod(shimPath, 0o755);
    }
    await vfs.writeFile(`${targetBinDir}/${NPM_BIN_MANIFEST_NAME}`, JSON.stringify(createNpmBinManifest(entries), null, 2) + '\n');
    return entries.length;
}
async function resolveNpmBinAt(vfs, nodeModulesPath, name) {
    const binDir = npmBinDirPath(nodeModulesPath);
    const shimPath = `${binDir}/${name}`;
    if (!await vfs.exists(shimPath) || await safeIsDirectory(vfs, shimPath))
        return null;
    const manifestEntry = await resolveFromManifest(vfs, nodeModulesPath, name);
    if (manifestEntry)
        return { ...manifestEntry, shimPath };
    const packageEntry = await resolveFromPackageTree(vfs, nodeModulesPath, name);
    if (packageEntry)
        return { ...packageEntry, shimPath };
    return {
        name,
        packageName: name,
        packageVersion: '',
        packagePath: binDir,
        targetPath: shimPath,
        shimPath,
    };
}
async function resolveNpmBinInBinDir(vfs, binDir, name) {
    const cleanBinDir = normalizeVfsPath(binDir);
    if (!cleanBinDir)
        return null;
    const shimPath = `${cleanBinDir}/${name}`;
    if (!await vfs.exists(shimPath) || await safeIsDirectory(vfs, shimPath))
        return null;
    const nodeModulesPath = nodeModulesPathForBinDir(cleanBinDir);
    if (nodeModulesPath) {
        const resolved = await resolveNpmBinAt(vfs, nodeModulesPath, name);
        if (resolved)
            return resolved;
    }
    const manifestEntry = await resolveFromBinDirManifest(vfs, cleanBinDir, name);
    if (manifestEntry)
        return { ...manifestEntry, shimPath };
    return {
        name,
        packageName: name,
        packageVersion: '',
        packagePath: cleanBinDir,
        targetPath: shimPath,
        shimPath,
    };
}
function candidateNodeModulesPaths(cwd) {
    const paths = [];
    let current = normalizeVfsPath(cwd || '/home/user');
    while (current) {
        paths.push(`${current}/node_modules`);
        const slash = current.lastIndexOf('/');
        if (slash < 0)
            break;
        current = current.slice(0, slash);
    }
    return paths;
}
function candidatePathDirs(cwd, envPath) {
    const dirs = [];
    const seen = new Set();
    for (const rawDir of (envPath || '').split(':')) {
        if (!rawDir)
            continue;
        const dir = rawDir.startsWith('/')
            ? normalizeVfsPath(rawDir)
            : resolveVfsPath(rawDir, cwd || '/home/user');
        if (!dir || seen.has(dir))
            continue;
        seen.add(dir);
        dirs.push(dir);
    }
    return dirs;
}
function nodeModulesPathForBinDir(binDir) {
    const suffix = '/.bin';
    if (!binDir.endsWith(suffix))
        return null;
    return binDir.slice(0, -suffix.length);
}
async function resolveFromManifest(vfs, nodeModulesPath, name) {
    const manifestPath = npmBinManifestPath(nodeModulesPath);
    if (!await vfs.exists(manifestPath) || await safeIsDirectory(vfs, manifestPath))
        return null;
    try {
        const manifest = JSON.parse(await vfs.readFileString(manifestPath));
        if (manifest.version !== NPM_BIN_MANIFEST_VERSION || !manifest.bins || typeof manifest.bins !== 'object') {
            return null;
        }
        return await validateEntry(vfs, manifest.bins[name]);
    }
    catch {
        return null;
    }
}
async function resolveFromBinDirManifest(vfs, binDir, name) {
    const manifestPath = `${binDir}/${NPM_BIN_MANIFEST_NAME}`;
    if (!await vfs.exists(manifestPath) || await safeIsDirectory(vfs, manifestPath))
        return null;
    return await resolveManifestEntry(vfs, manifestPath, name);
}
async function listNpmBinEntries(vfs, nodeModulesPath) {
    const manifestPath = npmBinManifestPath(nodeModulesPath);
    const manifestEntries = await readManifestEntries(vfs, manifestPath);
    if (manifestEntries)
        return manifestEntries;
    const entries = [];
    if (!await vfs.exists(nodeModulesPath) || !await safeIsDirectory(vfs, nodeModulesPath))
        return entries;
    for await (const packagePath of listPackagePaths(vfs, nodeModulesPath)) {
        const pkg = await readPackageJson(vfs, `${packagePath}/package.json`);
        if (!pkg)
            continue;
        entries.push(...await packageJsonBinEntry(vfs, packagePath, pkg));
    }
    return entries;
}
async function readManifestEntries(vfs, manifestPath) {
    const manifest = await readNpmBinManifest(vfs, manifestPath);
    if (!manifest)
        return null;
    const entries = [];
    for (const entry of Object.values(manifest.bins)) {
        const valid = await validateEntry(vfs, entry);
        if (valid)
            entries.push(valid);
    }
    return entries;
}
async function resolveManifestEntry(vfs, manifestPath, name) {
    const manifest = await readNpmBinManifest(vfs, manifestPath);
    return manifest ? await validateEntry(vfs, manifest.bins[name]) : null;
}
async function resolveFromPackageTree(vfs, nodeModulesPath, name) {
    if (!await vfs.exists(nodeModulesPath) || !await safeIsDirectory(vfs, nodeModulesPath))
        return null;
    for await (const packagePath of listPackagePaths(vfs, nodeModulesPath)) {
        const pkg = await readPackageJson(vfs, `${packagePath}/package.json`);
        if (!pkg)
            continue;
        const entry = (await packageJsonBinEntry(vfs, packagePath, pkg, name))[0];
        if (entry)
            return entry;
    }
    return null;
}
async function* listPackagePaths(vfs, nodeModulesPath) {
    let entries = [];
    try {
        entries = await vfs.readdir(nodeModulesPath);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.type !== 'directory' || entry.name === '.bin')
            continue;
        const path = `${nodeModulesPath}/${entry.name}`;
        if (!entry.name.startsWith('@')) {
            yield path;
            continue;
        }
        let scopedEntries = [];
        try {
            scopedEntries = await vfs.readdir(path);
        }
        catch {
            continue;
        }
        for (const scoped of scopedEntries) {
            if (scoped.type === 'directory')
                yield `${path}/${scoped.name}`;
        }
    }
}
async function packageJsonBinEntry(vfs, packagePath, pkg, requestedName) {
    const packageName = pkg.name;
    const packageVersion = pkg.version || '';
    const bin = pkg.bin;
    if (typeof bin === 'string') {
        const name = defaultBinName(packageName);
        if (requestedName && requestedName !== name)
            return [];
        const entry = await validateEntry(vfs, {
            name,
            packageName,
            packageVersion,
            packagePath,
            targetPath: resolveVfsPath(bin, packagePath),
        });
        return entry ? [entry] : [];
    }
    if (!bin || typeof bin !== 'object')
        return [];
    const entries = [];
    for (const [name, rawTarget] of Object.entries(bin)) {
        if (requestedName && requestedName !== name)
            continue;
        if (typeof rawTarget !== 'string')
            continue;
        const entry = await validateEntry(vfs, {
            name,
            packageName,
            packageVersion,
            packagePath,
            targetPath: resolveVfsPath(rawTarget, packagePath),
        });
        if (entry)
            entries.push(entry);
    }
    return entries;
}
async function validateEntry(vfs, entry) {
    const parsed = NpmBinEntrySchema.safeParse(entry);
    if (!parsed.success)
        return null;
    const candidate = parsed.data;
    // Staged-artifact sentinels are not VFS paths: the runnable bundle lives in
    // the assets layer. Pass them through verbatim so the manifest entry is
    // honoured and the shell dispatches via the staged-artifact runtime.
    if (isStagedArtifactTarget(candidate.targetPath)) {
        return {
            name: candidate.name,
            packageName: candidate.packageName,
            packageVersion: candidate.packageVersion,
            packagePath: normalizeVfsPath(candidate.packagePath),
            targetPath: candidate.targetPath,
        };
    }
    const targetPath = normalizeVfsPath(candidate.targetPath);
    const resolvedTarget = await resolveExistingTarget(vfs, targetPath);
    if (!resolvedTarget)
        return null;
    return {
        name: candidate.name,
        packageName: candidate.packageName,
        packageVersion: candidate.packageVersion,
        packagePath: normalizeVfsPath(candidate.packagePath),
        targetPath: resolvedTarget,
    };
}
async function resolveExistingTarget(vfs, targetPath) {
    if (await vfs.exists(targetPath) && !await safeIsDirectory(vfs, targetPath))
        return targetPath;
    for (const ext of ['.js', '.cjs', '.mjs']) {
        const withExt = targetPath + ext;
        if (await vfs.exists(withExt) && !await safeIsDirectory(vfs, withExt))
            return withExt;
    }
    return null;
}
async function readPackageJson(vfs, path) {
    try {
        const parsed = PackageJsonSchema.safeParse(JSON.parse(await vfs.readFileString(path)));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
async function readNpmBinManifest(vfs, manifestPath) {
    if (!await vfs.exists(manifestPath) || await safeIsDirectory(vfs, manifestPath))
        return null;
    try {
        const parsed = NpmBinManifestSchema.safeParse(JSON.parse(await vfs.readFileString(manifestPath)));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
async function safeIsDirectory(vfs, path) {
    try {
        return await vfs.isDirectory(path);
    }
    catch {
        return false;
    }
}
function defaultBinName(packageName) {
    const slash = packageName.lastIndexOf('/');
    return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}
