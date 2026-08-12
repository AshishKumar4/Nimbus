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
export function createNpmBinShim(entry) {
    if (isStagedArtifactTarget(entry.targetPath)) {
        // The runnable bundle is staged in the assets layer; the shell dispatches
        // it through the staged-artifact runtime by recognizing the sentinel in
        // the bin manifest. The shim body is only a marker for PATH discovery.
        return `#!/usr/bin/env node\n// nimbus staged artifact: ${entry.targetPath}\n`;
    }
    // targetPath is a normalized VFS path with no leading slash. require()
    // must receive it as absolute (leading "/"), otherwise the runtime's
    // resolver treats "home/user/…" as a bare specifier and fails the
    // node_modules lookup. Matches how npm-bin-entrypoints runs the manifest
    // target ("/" + targetPath).
    return `#!/usr/bin/env node\nrequire(${JSON.stringify('/' + entry.targetPath)});\n`;
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
export function resolveNpmBin(vfs, cwd, name) {
    const root = normalizeVfsPath(cwd || '/home/user');
    for (const nodeModulesPath of candidateNodeModulesPaths(root)) {
        const resolved = resolveNpmBinAt(vfs, nodeModulesPath, name);
        if (resolved)
            return resolved;
    }
    return null;
}
export function resolveNpmBinFromPath(vfs, cwd, envPath, name) {
    for (const binDir of candidatePathDirs(cwd, envPath)) {
        const resolved = resolveNpmBinInBinDir(vfs, binDir, name);
        if (resolved)
            return resolved;
    }
    return null;
}
export function materializeNpmBinShims(vfs, nodeModulesPath, binDir) {
    const entries = listNpmBinEntries(vfs, normalizeVfsPath(nodeModulesPath));
    if (entries.length === 0)
        return 0;
    const targetBinDir = normalizeVfsPath(binDir);
    vfs.mkdir(targetBinDir, { recursive: true });
    for (const entry of entries) {
        const shimPath = `${targetBinDir}/${entry.name}`;
        vfs.writeFile(shimPath, createNpmBinShim(entry));
        // writeFile creates files 0o644; a bin shim on PATH must be executable
        // or the shell rejects it ("command not found"). Match the 0o755 the
        // Phase-6 .bin linker uses. chmod (not a mode arg) so a re-install over
        // an existing 0o644 shim is corrected too.
        vfs.chmod(shimPath, 0o755);
    }
    vfs.writeFile(`${targetBinDir}/${NPM_BIN_MANIFEST_NAME}`, JSON.stringify(createNpmBinManifest(entries), null, 2) + '\n');
    return entries.length;
}
function resolveNpmBinAt(vfs, nodeModulesPath, name) {
    const binDir = npmBinDirPath(nodeModulesPath);
    const shimPath = `${binDir}/${name}`;
    if (!vfs.exists(shimPath) || safeIsDirectory(vfs, shimPath))
        return null;
    const manifestEntry = resolveFromManifest(vfs, nodeModulesPath, name);
    if (manifestEntry)
        return { ...manifestEntry, shimPath };
    const packageEntry = resolveFromPackageTree(vfs, nodeModulesPath, name);
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
function resolveNpmBinInBinDir(vfs, binDir, name) {
    const cleanBinDir = normalizeVfsPath(binDir);
    if (!cleanBinDir)
        return null;
    const shimPath = `${cleanBinDir}/${name}`;
    if (!vfs.exists(shimPath) || safeIsDirectory(vfs, shimPath))
        return null;
    const nodeModulesPath = nodeModulesPathForBinDir(cleanBinDir);
    if (nodeModulesPath) {
        const resolved = resolveNpmBinAt(vfs, nodeModulesPath, name);
        if (resolved)
            return resolved;
    }
    const manifestEntry = resolveFromBinDirManifest(vfs, cleanBinDir, name);
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
function resolveFromManifest(vfs, nodeModulesPath, name) {
    const manifestPath = npmBinManifestPath(nodeModulesPath);
    if (!vfs.exists(manifestPath) || safeIsDirectory(vfs, manifestPath))
        return null;
    try {
        const manifest = JSON.parse(vfs.readFileString(manifestPath));
        if (manifest.version !== NPM_BIN_MANIFEST_VERSION || !manifest.bins || typeof manifest.bins !== 'object') {
            return null;
        }
        return validateEntry(vfs, manifest.bins[name]);
    }
    catch {
        return null;
    }
}
function resolveFromBinDirManifest(vfs, binDir, name) {
    const manifestPath = `${binDir}/${NPM_BIN_MANIFEST_NAME}`;
    if (!vfs.exists(manifestPath) || safeIsDirectory(vfs, manifestPath))
        return null;
    return resolveManifestEntry(vfs, manifestPath, name);
}
function listNpmBinEntries(vfs, nodeModulesPath) {
    const manifestPath = npmBinManifestPath(nodeModulesPath);
    const manifestEntries = readManifestEntries(vfs, manifestPath);
    if (manifestEntries)
        return manifestEntries;
    const entries = [];
    if (!vfs.exists(nodeModulesPath) || !safeIsDirectory(vfs, nodeModulesPath))
        return entries;
    for (const packagePath of listPackagePaths(vfs, nodeModulesPath)) {
        const pkg = readPackageJson(vfs, `${packagePath}/package.json`);
        if (!pkg)
            continue;
        entries.push(...packageJsonBinEntry(vfs, packagePath, pkg));
    }
    return entries;
}
function readManifestEntries(vfs, manifestPath) {
    const manifest = readNpmBinManifest(vfs, manifestPath);
    if (!manifest)
        return null;
    const entries = [];
    for (const entry of Object.values(manifest.bins)) {
        const valid = validateEntry(vfs, entry);
        if (valid)
            entries.push(valid);
    }
    return entries;
}
function resolveManifestEntry(vfs, manifestPath, name) {
    const manifest = readNpmBinManifest(vfs, manifestPath);
    return manifest ? validateEntry(vfs, manifest.bins[name]) : null;
}
function resolveFromPackageTree(vfs, nodeModulesPath, name) {
    if (!vfs.exists(nodeModulesPath) || !safeIsDirectory(vfs, nodeModulesPath))
        return null;
    for (const packagePath of listPackagePaths(vfs, nodeModulesPath)) {
        const pkg = readPackageJson(vfs, `${packagePath}/package.json`);
        if (!pkg)
            continue;
        const entry = packageJsonBinEntry(vfs, packagePath, pkg, name)[0];
        if (entry)
            return entry;
    }
    return null;
}
function* listPackagePaths(vfs, nodeModulesPath) {
    let entries = [];
    try {
        entries = vfs.readdir(nodeModulesPath);
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
            scopedEntries = vfs.readdir(path);
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
function packageJsonBinEntry(vfs, packagePath, pkg, requestedName) {
    const packageName = pkg.name;
    const packageVersion = pkg.version || '';
    const bin = pkg.bin;
    if (typeof bin === 'string') {
        const name = defaultBinName(packageName);
        if (requestedName && requestedName !== name)
            return [];
        const entry = validateEntry(vfs, {
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
        const entry = validateEntry(vfs, {
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
function validateEntry(vfs, entry) {
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
    const resolvedTarget = resolveExistingTarget(vfs, targetPath);
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
function resolveExistingTarget(vfs, targetPath) {
    if (vfs.exists(targetPath) && !safeIsDirectory(vfs, targetPath))
        return targetPath;
    for (const ext of ['.js', '.cjs', '.mjs']) {
        const withExt = targetPath + ext;
        if (vfs.exists(withExt) && !safeIsDirectory(vfs, withExt))
            return withExt;
    }
    return null;
}
function readPackageJson(vfs, path) {
    try {
        const parsed = PackageJsonSchema.safeParse(JSON.parse(vfs.readFileString(path)));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
function readNpmBinManifest(vfs, manifestPath) {
    if (!vfs.exists(manifestPath) || safeIsDirectory(vfs, manifestPath))
        return null;
    try {
        const parsed = NpmBinManifestSchema.safeParse(JSON.parse(vfs.readFileString(manifestPath)));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
function safeIsDirectory(vfs, path) {
    try {
        return vfs.isDirectory(path);
    }
    catch {
        return false;
    }
}
function defaultBinName(packageName) {
    const slash = packageName.lastIndexOf('/');
    return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}
