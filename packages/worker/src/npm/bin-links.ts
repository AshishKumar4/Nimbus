import { projectEntryType, type ProjectFs } from '../runtime/project-fs.js';
import { normalizeVfsPath, resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { npmBinMap, npmBinName } from '@nimbus-sh/core/runtime/npm-bin-map.js';
import type { ResolvedPackage } from './resolver.js';
import { STAGED_ARTIFACT_BIN_PREFIX } from '../facets/wasm-swap-registry.js';
import { z } from 'zod/v4';

/**
 * A staged-artifact bin target (`nimbus-staged:<artifact>`) is a sentinel,
 * not a VFS path: the runnable bundle lives in the static-assets layer and is
 * fetched at exec time. It must NOT be resolved against the VFS.
 */
export function isStagedArtifactTarget(target: string): boolean {
  return target.startsWith(STAGED_ARTIFACT_BIN_PREFIX);
}

export function stagedArtifactId(target: string): string {
  return target.slice(STAGED_ARTIFACT_BIN_PREFIX.length);
}

/** The bin manifest a `.nimbus-bin-map.json` holds; null when it is not one, or names a file outside `.bin`. */
export function parseNpmBinManifest(text: string): NpmBinManifest | null {
  try {
    const parsed = NpmBinManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const NPM_BIN_MANIFEST_VERSION = 1;
export const NPM_BIN_MANIFEST_NAME = '.nimbus-bin-map.json';

export interface NpmBinEntry {
  name: string;
  packageName: string;
  packageVersion: string;
  packagePath: string;
  targetPath: string;
}

export interface NpmBinManifest {
  version: typeof NPM_BIN_MANIFEST_VERSION;
  bins: Record<string, NpmBinEntry>;
}

export interface NpmBinResolution extends NpmBinEntry {
  shimPath: string;
}

/**
 * What bins are looked up and linked through: a project's filesystem as the
 * caller (see runtime/project-fs.ts), each call answered at once by the
 * engine or awaited through the caller's view of the namespace.
 */
type VfsLike = Pick<ProjectFs, 'exists' | 'isDirectory' | 'readFileString' | 'readdir' | 'lstat'>;
type WritableVfsLike = VfsLike & Pick<ProjectFs, 'mkdir' | 'writeFile' | 'chmod'>;

interface PackageJsonLike {
  name: string;
  version?: string;
  bin?: string | Record<string, string>;
}

const NpmBinEntrySchema: z.ZodType<NpmBinEntry> = z.object({
  name: z.string().refine((name) => npmBinName(name) === name),
  packageName: z.string().min(1),
  packageVersion: z.string(),
  packagePath: z.string().min(1),
  targetPath: z.string().min(1),
});

const NpmBinManifestSchema: z.ZodType<NpmBinManifest> = z.object({
  version: z.literal(NPM_BIN_MANIFEST_VERSION),
  bins: z.record(z.string(), NpmBinEntrySchema),
}).refine((manifest) => Object.entries(manifest.bins).every(([key, entry]) => key === entry.name));

const PackageJsonSchema: z.ZodType<PackageJsonLike> = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  bin: z.union([
    z.string(),
    z.record(z.string(), z.string()),
  ]).optional(),
}).passthrough();

export function npmBinDirPath(nodeModulesPath: string): string {
  return normalizeVfsPath(`${nodeModulesPath}/.bin`);
}

export function npmBinManifestPath(nodeModulesPath: string): string {
  return `${npmBinDirPath(nodeModulesPath)}/${NPM_BIN_MANIFEST_NAME}`;
}

export function createNpmBinManifest(entries: NpmBinEntry[]): NpmBinManifest {
  const bins: Record<string, NpmBinEntry> = {};
  for (const entry of entries) bins[entry.name] = entry;
  return { version: NPM_BIN_MANIFEST_VERSION, bins };
}

export function createNpmBinShim(entry: NpmBinEntry, shimDir: string): string {
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

function relativeRequest(fromDir: string, target: string): string {
  const from = normalizeVfsPath(fromDir).split('/').filter(Boolean);
  const to = normalizeVfsPath(target).split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const rel = [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
  return rel.startsWith('../') ? rel : `./${rel}`;
}

export function packageBinEntries(pkg: ResolvedPackage, nodeModulesPath: string): NpmBinEntry[] {
  const packagePath = normalizeVfsPath(`${nodeModulesPath}/${pkg.name}`);
  const packageVersion = String(pkg.version || '');
  return [...npmBinMap(pkg.name, pkg.bin)].map(([name, target]) => ({
    name,
    packageName: pkg.name,
    packageVersion,
    packagePath,
    // Staged-artifact sentinels pass through verbatim; everything else is a
    // VFS path under the package dir.
    targetPath: isStagedArtifactTarget(target) ? target : `${packagePath}/${target}`,
  }));
}

export async function resolveNpmBin(vfs: VfsLike, cwd: string, name: string): Promise<NpmBinResolution | null> {
  const root = normalizeVfsPath(cwd || '/home/user');
  for (const nodeModulesPath of candidateNodeModulesPaths(root)) {
    const resolved = await resolveNpmBinAt(vfs, nodeModulesPath, name);
    if (resolved) return resolved;
  }
  return null;
}

export async function resolveNpmBinFromPath(
  vfs: VfsLike,
  cwd: string,
  envPath: string,
  name: string,
): Promise<NpmBinResolution | null> {
  for (const binDir of candidatePathDirs(cwd, envPath)) {
    const resolved = await resolveNpmBinInBinDir(vfs, binDir, name);
    if (resolved) return resolved;
  }
  return null;
}

/** A path-shaped invocation of an executable entry in a `node_modules/.bin` directory; null otherwise. */
export async function resolveNpmBinPath(vfs: VfsLike & Pick<ProjectFs, 'stat'>, cwd: string, path: string): Promise<NpmBinResolution | null> {
  const shimPath = resolveVfsPath(path, cwd || '/home/user');
  const slash = shimPath.lastIndexOf('/');
  if (slash < 0) return null;
  const binDir = shimPath.slice(0, slash);
  if (!binDir.endsWith('/node_modules/.bin')) return null;
  try {
    if (((await vfs.stat(shimPath)).mode & 0o111) === 0) return null;
  } catch {
    return null;
  }
  return await resolveNpmBinInBinDir(vfs, binDir, shimPath.slice(slash + 1));
}

export async function materializeNpmBinShims(
  vfs: WritableVfsLike,
  nodeModulesPath: string,
  binDir: string,
): Promise<number> {
  const entries = await listNpmBinEntries(vfs, normalizeVfsPath(nodeModulesPath));
  if (entries.length === 0) return 0;

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
  await vfs.writeFile(
    `${targetBinDir}/${NPM_BIN_MANIFEST_NAME}`,
    JSON.stringify(createNpmBinManifest(entries), null, 2) + '\n',
  );
  return entries.length;
}

async function resolveNpmBinAt(vfs: VfsLike, nodeModulesPath: string, name: string): Promise<NpmBinResolution | null> {
  const binDir = npmBinDirPath(nodeModulesPath);
  const shimPath = `${binDir}/${name}`;
  if (!await vfs.exists(shimPath) || await safeIsDirectory(vfs, shimPath)) return null;

  const manifestEntry = await resolveFromManifest(vfs, nodeModulesPath, name);
  if (manifestEntry) return { ...manifestEntry, shimPath };

  const packageEntry = await resolveFromPackageTree(vfs, nodeModulesPath, name);
  if (packageEntry) return { ...packageEntry, shimPath };

  return {
    name,
    packageName: name,
    packageVersion: '',
    packagePath: binDir,
    targetPath: shimPath,
    shimPath,
  };
}

async function resolveNpmBinInBinDir(vfs: VfsLike, binDir: string, name: string): Promise<NpmBinResolution | null> {
  const cleanBinDir = normalizeVfsPath(binDir);
  if (!cleanBinDir) return null;
  const shimPath = `${cleanBinDir}/${name}`;
  if (!await vfs.exists(shimPath) || await safeIsDirectory(vfs, shimPath)) return null;

  const nodeModulesPath = nodeModulesPathForBinDir(cleanBinDir);
  if (nodeModulesPath) {
    const resolved = await resolveNpmBinAt(vfs, nodeModulesPath, name);
    if (resolved) return resolved;
  }

  const manifestEntry = await resolveFromBinDirManifest(vfs, cleanBinDir, name);
  if (manifestEntry) return { ...manifestEntry, shimPath };

  return {
    name,
    packageName: name,
    packageVersion: '',
    packagePath: cleanBinDir,
    targetPath: shimPath,
    shimPath,
  };
}

function candidateNodeModulesPaths(cwd: string): string[] {
  const paths: string[] = [];
  let current = normalizeVfsPath(cwd || '/home/user');
  while (current) {
    paths.push(`${current}/node_modules`);
    const slash = current.lastIndexOf('/');
    if (slash < 0) break;
    current = current.slice(0, slash);
  }
  return paths;
}

function candidatePathDirs(cwd: string, envPath: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const rawDir of (envPath || '').split(':')) {
    if (!rawDir) continue;
    const dir = rawDir.startsWith('/')
      ? normalizeVfsPath(rawDir)
      : resolveVfsPath(rawDir, cwd || '/home/user');
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function nodeModulesPathForBinDir(binDir: string): string | null {
  const suffix = '/.bin';
  if (!binDir.endsWith(suffix)) return null;
  return binDir.slice(0, -suffix.length);
}

async function resolveFromManifest(vfs: VfsLike, nodeModulesPath: string, name: string): Promise<NpmBinEntry | null> {
  return await resolveManifestEntry(vfs, npmBinManifestPath(nodeModulesPath), name);
}

async function resolveFromBinDirManifest(vfs: VfsLike, binDir: string, name: string): Promise<NpmBinEntry | null> {
  const manifestPath = `${binDir}/${NPM_BIN_MANIFEST_NAME}`;
  if (!await vfs.exists(manifestPath) || await safeIsDirectory(vfs, manifestPath)) return null;
  return await resolveManifestEntry(vfs, manifestPath, name);
}

async function listNpmBinEntries(vfs: VfsLike, nodeModulesPath: string): Promise<NpmBinEntry[]> {
  const manifestPath = npmBinManifestPath(nodeModulesPath);
  const manifestEntries = await readManifestEntries(vfs, manifestPath);
  if (manifestEntries) return manifestEntries;

  const entries: NpmBinEntry[] = [];
  if (!await vfs.exists(nodeModulesPath) || !await safeIsDirectory(vfs, nodeModulesPath)) return entries;
  for await (const packagePath of listPackagePaths(vfs, nodeModulesPath)) {
    const pkg = await readPackageJson(vfs, `${packagePath}/package.json`);
    if (!pkg) continue;
    entries.push(...await packageJsonBinEntry(vfs, packagePath, pkg));
  }
  return entries;
}

async function readManifestEntries(vfs: VfsLike, manifestPath: string): Promise<NpmBinEntry[] | null> {
  const manifest = await readNpmBinManifest(vfs, manifestPath);
  if (!manifest) return null;

  const entries: NpmBinEntry[] = [];
  for (const entry of Object.values(manifest.bins)) {
    const valid = await validateEntry(vfs, entry);
    if (valid) entries.push(valid);
  }
  return entries;
}

async function resolveManifestEntry(vfs: VfsLike, manifestPath: string, name: string): Promise<NpmBinEntry | null> {
  const manifest = await readNpmBinManifest(vfs, manifestPath);
  return manifest ? await validateEntry(vfs, manifest.bins[name]) : null;
}

async function resolveFromPackageTree(vfs: VfsLike, nodeModulesPath: string, name: string): Promise<NpmBinEntry | null> {
  if (!await vfs.exists(nodeModulesPath) || !await safeIsDirectory(vfs, nodeModulesPath)) return null;

  for await (const packagePath of listPackagePaths(vfs, nodeModulesPath)) {
    const pkg = await readPackageJson(vfs, `${packagePath}/package.json`);
    if (!pkg) continue;
    const entry = (await packageJsonBinEntry(vfs, packagePath, pkg, name))[0];
    if (entry) return entry;
  }
  return null;
}

async function* listPackagePaths(vfs: VfsLike, nodeModulesPath: string): AsyncGenerator<string> {
  let entries: Awaited<ReturnType<VfsLike['readdir']>> = [];
  try { entries = await vfs.readdir(nodeModulesPath); } catch { return; }

  for (const entry of entries) {
    if (entry.name === '.bin' || (await projectEntryType(vfs, nodeModulesPath, entry)) !== 'directory') continue;
    const path = `${nodeModulesPath}/${entry.name}`;
    if (!entry.name.startsWith('@')) {
      yield path;
      continue;
    }

    let scopedEntries: Awaited<ReturnType<VfsLike['readdir']>> = [];
    try { scopedEntries = await vfs.readdir(path); } catch { continue; }
    for (const scoped of scopedEntries) {
      if ((await projectEntryType(vfs, path, scoped)) === 'directory') yield `${path}/${scoped.name}`;
    }
  }
}

async function packageJsonBinEntry(
  vfs: VfsLike,
  packagePath: string,
  pkg: PackageJsonLike,
  requestedName?: string,
): Promise<NpmBinEntry[]> {
  const packageName = pkg.name;
  const packageVersion = pkg.version || '';
  const entries: NpmBinEntry[] = [];
  for (const [name, target] of npmBinMap(packageName, pkg.bin)) {
    if (requestedName && requestedName !== name) continue;
    const entry = await validateEntry(vfs, {
      name,
      packageName,
      packageVersion,
      packagePath,
      targetPath: isStagedArtifactTarget(target) ? target : `${packagePath}/${target}`,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

async function validateEntry(vfs: VfsLike, entry: unknown): Promise<NpmBinEntry | null> {
  const parsed = NpmBinEntrySchema.safeParse(entry);
  if (!parsed.success) return null;

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
  if (!resolvedTarget) return null;
  return {
    name: candidate.name,
    packageName: candidate.packageName,
    packageVersion: candidate.packageVersion,
    packagePath: normalizeVfsPath(candidate.packagePath),
    targetPath: resolvedTarget,
  };
}

async function resolveExistingTarget(vfs: VfsLike, targetPath: string): Promise<string | null> {
  if (await vfs.exists(targetPath) && !await safeIsDirectory(vfs, targetPath)) return targetPath;
  for (const ext of ['.js', '.cjs', '.mjs']) {
    const withExt = targetPath + ext;
    if (await vfs.exists(withExt) && !await safeIsDirectory(vfs, withExt)) return withExt;
  }
  return null;
}

async function readPackageJson(vfs: VfsLike, path: string): Promise<PackageJsonLike | null> {
  try {
    const parsed = PackageJsonSchema.safeParse(JSON.parse(await vfs.readFileString(path)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readNpmBinManifest(vfs: VfsLike, manifestPath: string): Promise<NpmBinManifest | null> {
  if (!await vfs.exists(manifestPath) || await safeIsDirectory(vfs, manifestPath)) return null;
  try {
    return parseNpmBinManifest(await vfs.readFileString(manifestPath));
  } catch {
    return null;
  }
}

async function safeIsDirectory(vfs: VfsLike, path: string): Promise<boolean> {
  try { return await vfs.isDirectory(path); } catch { return false; }
}

