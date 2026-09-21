import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { ExecutionFs as VFS } from '../../../../shell/execution-fs.js';
import type { Kernel } from '../../kernel/index.js';
import { resolve, join } from '../../utils/path.js';
import { writeTarballStream, type TarballWriteResult } from '../../../../_shared/tarball.js';
import {
	RegistryPackumentSchema,
	RegistrySearchResponseSchema,
	RegistryVersionInfoSchema,
	type RegistryVersionInfo,
} from './registry-schemas.js';
import {
  parseNpmInstallInvocation,
  type NpmInstallInvocation,
} from './npm-install-args.js';
import { npmLogEnabled, type NpmLogEmitter } from './npm-log.js';

/** The registry an install reads from when its env names none. */
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const NPM_VERSION = '10.0.0';

// ─── Types ───

interface PackageJson {
	name?: string;
	version?: string;
	description?: string;
	main?: string;
	bin?: string | Record<string, string>;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	license?: string;
	author?: string | { name: string };
}

export type ShellExecuteFn = (
	cmd: string,
	ctx: CommandContext,
) => Promise<number>;

/**
 * The host's piece of `npm install`: once the invocation has been parsed
 * into a spec and the summary output decided, the install itself is
 * whatever the host's batched installer does. Global installs carry the
 * resolved prefix so the host — not this command — owns where
 * `<prefix>/lib/node_modules` and `<prefix>/bin` land.
 */
export interface NpmInstallPort {
  install(spec: {
    projectDir: string;
    packages: readonly string[];
    global: boolean;
    /** Resolved absolute prefix — present only when `global` is set. */
    globalPrefix?: string;
    /** The running command's pid — authorizes the host's batch writes. */
    pid: number;
    /** Registry origin from the command's env (`NPM_REGISTRY`), else the default. */
    registry: string;
    production?: boolean;
    npmLog?: NpmLogEmitter | null;
    onProgress?: (line: string) => void;
  }): Promise<{ installed: string[]; failed: string[]; totalFiles?: number; fromCacheHits?: number; linkedBins?: number }>;
}

export interface NpmCommandDeps {
  installer?: NpmInstallPort;
}

/** The end-of-install report, shared by every install path so a failure
 *  reads the same regardless of which engine ran it. Byte-identical to
 *  what the worker's wrapper printed. */
async function writeInstallSummary(ctx: CommandContext,
installed: string[],
failed: string[],
opts: { totalFiles?: number; fromCacheHits?: number; linkedBins?: number; globalBinDir?: string; startedAt: number },): Promise<void> { if (failed.length > 0) {
  await ctx.stderr.write(`\x1b[31mFailed: ${failed.join(', ')}\x1b[0m\n`);
}
const secs = ((Date.now() - opts.startedAt) / 1000).toFixed(1);
if (installed.length === 0 && failed.length === 0) {
  await ctx.stdout.write(`\x1b[32mup to date in ${secs}s\x1b[0m\n`);
  return;
}
if (installed.length === 0) return;
const partial = failed.length > 0;
const color = partial ? '\x1b[33m' : '\x1b[32m';
const suffix = partial ? ` (${failed.length} failed, see above)` : '';
const files = opts.totalFiles !== undefined ? ` (${opts.totalFiles} files)` : '';
await ctx.stdout.write(`\n${color}added ${installed.length} packages${files} in ${secs}s${suffix}\x1b[0m\n`);
if (opts.fromCacheHits) {
  await ctx.stdout.write(`\x1b[2m  (${opts.fromCacheHits} from cache)\x1b[0m\n`);
}
if (opts.linkedBins) {
  const n = opts.linkedBins;
  await ctx.stdout.write(`\x1b[2m  linked ${n} bin${n === 1 ? '' : 's'} into ${opts.globalBinDir}\x1b[0m\n`);
} }
// ─── Helpers ───

/**
 * The registry origin an install uses: the command's `NPM_REGISTRY`, else
 * the default. Normalized once, here, where the setting is read: blank is
 * unset, and a trailing slash is trimmed so one origin spelled two ways
 * shares one cache namespace downstream.
 */
export function npmRegistryOrigin(configured: string | undefined): string {
	const trimmed = configured?.trim();
	return (trimmed ? trimmed : NPM_REGISTRY_ORIGIN).replace(/\/+$/, '');
}

function getRegistry(env: Record<string, string>): string {
	return npmRegistryOrigin(env.NPM_REGISTRY);
}

function parsePackageSpec(spec: string): { name: string; version: string | null } {
	// Scoped: @scope/name@version
	if (spec.startsWith('@')) {
		const slashIdx = spec.indexOf('/');
		if (slashIdx === -1) return { name: spec, version: null };
		const rest = spec.slice(slashIdx + 1);
		const atIdx = rest.lastIndexOf('@');
		if (atIdx > 0) {
			return {
				name: spec.slice(0, slashIdx + 1 + atIdx),
				version: rest.slice(atIdx + 1),
			};
		}
		return { name: spec, version: null };
	}

	// Regular: name@version
	const atIdx = spec.lastIndexOf('@');
	if (atIdx > 0) {
		return { name: spec.slice(0, atIdx), version: spec.slice(atIdx + 1) };
	}
	return { name: spec, version: null };
}

// ─── Semver helpers ───

function parseVersion(v: string): [number, number, number] | null {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
	if (a[0] !== b[0]) return a[0] - b[0];
	if (a[1] !== b[1]) return a[1] - b[1];
	return a[2] - b[2];
}

function isVersionRange(version: string): boolean {
	return /[\^~>=<|*x]/.test(version);
}

function satisfiesRange(version: string, range: string): boolean {
	const v = parseVersion(version);
	if (!v) return false;

	// Exact
	if (/^\d+\.\d+\.\d+$/.test(range)) {
		const r = parseVersion(range);
		return r !== null && v[0] === r[0] && v[1] === r[1] && v[2] === r[2];
	}

	// Caret ^X.Y.Z
	if (range.startsWith('^')) {
		const r = parseVersion(range.slice(1));
		if (!r) return false;
		if (r[0] > 0) return v[0] === r[0] && compareVersions(v, r) >= 0;
		if (r[1] > 0) return v[0] === 0 && v[1] === r[1] && compareVersions(v, r) >= 0;
		return v[0] === 0 && v[1] === 0 && v[2] === r[2];
	}

	// Tilde ~X.Y.Z
	if (range.startsWith('~')) {
		const r = parseVersion(range.slice(1));
		if (!r) return false;
		return v[0] === r[0] && v[1] === r[1] && v[2] >= r[2];
	}

	// >=X.Y.Z
	if (range.startsWith('>=')) {
		const r = parseVersion(range.slice(2).trim());
		if (!r) return false;
		return compareVersions(v, r) >= 0;
	}

	// * or latest
	if (range === '*' || range === 'latest' || range === '') return true;

	return true; // unrecognised range - accept anything
}

// ─── Registry fetch ───

function encodePackageName(name: string): string {
	return name.startsWith('@')
		? '@' + encodeURIComponent(name.slice(1))
		: encodeURIComponent(name);
}

async function fetchPackageInfo(
	registry: string,
	name: string,
	version: string | null,
	signal: AbortSignal,
): Promise<RegistryVersionInfo> {
	// If version is a semver range, resolve it against all versions
	if (version && isVersionRange(version)) {
		return (await fetchWithRange(registry, name, version, signal));
	}

	// Exact version or dist-tag (or null → latest)
	const tag = version || 'latest';
	const url = `${registry}/${encodePackageName(name)}/${tag}`;

	const response = await fetch(url, { signal });
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`Package '${name}${version ? '@' + version : ''}' not found in registry`);
		}
		throw new Error(`Registry returned ${response.status} ${response.statusText}`);
	}

	return RegistryVersionInfoSchema.parse(await response.json());
}

async function fetchWithRange(
	registry: string,
	name: string,
	range: string,
	signal: AbortSignal,
): Promise<RegistryVersionInfo> {
	const url = `${registry}/${encodePackageName(name)}`;
	const response = await fetch(url, {
		signal,
		headers: { Accept: 'application/json' },
	});
	if (!response.ok) {
		throw new Error(`Package '${name}' not found in registry`);
	}

	const data = RegistryPackumentSchema.parse(await response.json());
	const versions = Object.keys(data.versions || {});

	const matching = versions
		.filter((v) => satisfiesRange(v, range))
		.map((v) => ({ version: v, parsed: parseVersion(v)! }))
		.filter((v) => v.parsed !== null)
		.sort((a, b) => compareVersions(b.parsed, a.parsed)); // highest first

	if (matching.length === 0) {
		throw new Error(`No version of '${name}' satisfies '${range}'`);
	}

	return data.versions[matching[0].version];
}

async function fetchAndStreamPackage(
	tarballUrl: string,
	targetDir: string,
	vfs: VFS,
	signal: AbortSignal,
): Promise<TarballWriteResult> {
	const response = await fetch(tarballUrl, { signal });
	if (!response.ok) {
		throw new Error(`Failed to download tarball: ${response.status}`);
	}

	if (!response.body) throw new Error(`Registry served no body for ${tarballUrl}`);
	return (await writeTarballStream(response.body, targetDir, vfs));
}

async function readProjectPackageJson(vfs: VFS, cwd: string): Promise<PackageJson | null> {
	const pkgPath = join(cwd, 'package.json');
	try {
		return JSON.parse((await vfs.readFileString(pkgPath)));
	} catch {
		return null;
	}
}

async function writeProjectPackageJson(vfs: VFS, cwd: string, pkg: PackageJson): Promise<void> {
	const pkgPath = join(cwd, 'package.json');
	(await vfs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n'));
}

export function getBinEntries(pkg: PackageJson): Record<string, string> {
	if (!pkg.bin) return {};
	if (typeof pkg.bin === 'string') {
		return { [pkg.name || 'unknown']: pkg.bin };
	}
	return pkg.bin;
}

export function registerBinCommand(registry: CommandRegistry, binName: string, scriptPath: string, kernel?: Kernel): void {
	registry.registerLazy(binName, () =>
		import('./node.js').then((mod) => ({
			default: (async (ctx: CommandContext) => {
				// Use kernel's portRegistry if available, otherwise fall back to default
				const nodeCommand = kernel ? mod.createNodeCommand(kernel) : mod.default;
				return (await nodeCommand({
					...ctx,
					args: [scriptPath, ...ctx.args],
				}));
			}) as Command,
		})),
	);
}


// ─── Install logic ───

async function installSinglePackage(
	name: string,
	version: string | null,
	targetBase: string,
	vfs: VFS,
	npmRegistry: string,
	signal: AbortSignal,
	stdout: CommandOutputStream,
	stderr: CommandOutputStream,
	isGlobal: boolean,
	registry: CommandRegistry,
	seen: Set<string>,
	globalBinDir?: string,
	kernel?: Kernel,
): Promise<number> {
	if (seen.has(name)) return 0;
	seen.add(name);

	const targetDir = join(targetBase, name);

	// Skip if already installed
	if ((await vfs.exists(join(targetDir, 'package.json')))) {
		return 0;
	}

	(await stdout.write(`  ${name}${version ? '@' + version : ''}...\n`));

	const info = await fetchPackageInfo(npmRegistry, name, version, signal);

	// writeTarballStream throws when the archive carried no manifest and writes
	// package.json last, so a return here is a complete package on disk.
	await fetchAndStreamPackage(info.dist.tarball, targetDir, vfs, signal);

	let installed = 1;

	// Global install: link binaries into the resolved prefix's bin dir
	if (isGlobal && globalBinDir) {
		const binEntries = getBinEntries(info);
		for (const [binName, binPath] of Object.entries(binEntries)) {
			const scriptPath = resolve(targetDir, binPath);
			registerBinCommand(registry, binName, scriptPath, kernel);
			try { (await vfs.mkdir(globalBinDir, { recursive: true })); } catch { /* exists */ }
			(await vfs.writeFile(
				join(globalBinDir, binName),
				`#!/usr/bin/env node\nrequire('${scriptPath}');\n`,
			));
		}

	}

	// Recursively install dependencies (flat into the same targetBase)
	if (info.dependencies) {
		for (const [depName, depRange] of Object.entries(info.dependencies)) {
			try {
				installed += await installSinglePackage(
					depName, depRange, targetBase, vfs, npmRegistry, signal,
					stdout, stderr, isGlobal, registry, seen, globalBinDir, kernel,
				);
			} catch (e) {
				(await stderr.write(`  warn: could not install ${depName}: ${e instanceof Error ? e.message : String(e)}\n`));
			}
		}
	}

	return installed;
}

// ─── Subcommands ───

async function printHelp(ctx: CommandContext): Promise<void> { await ctx.stdout.write('Usage: npm <command> [args]\n\n');
	await ctx.stdout.write('Commands:\n');
	await ctx.stdout.write('  init [-y]                  create package.json\n');
	await ctx.stdout.write('  install [pkg...] [-g] [-D] install packages\n');
	await ctx.stdout.write('  uninstall <pkg> [-g]       remove a package\n');
	await ctx.stdout.write('  list [-g]                  list installed packages\n');
	await ctx.stdout.write('  run <script>               run a package.json script\n');
	await ctx.stdout.write('  start                      run the "start" script\n');
	await ctx.stdout.write('  test                       run the "test" script\n');
	await ctx.stdout.write('  info <pkg>                 show package info from registry\n');
	await ctx.stdout.write('  search <term>              search the npm registry\n');
	await ctx.stdout.write('  -v, --version              print npm version\n'); }

async function npmInit(ctx: CommandContext): Promise<number> {
	const pkgPath = join(ctx.cwd, 'package.json');
	if ((await ctx.vfs.exists(pkgPath))) {
		await ctx.stderr.write('package.json already exists\n');
		return 1;
	}

	const dirName = ctx.cwd.split('/').pop() || 'project';
	const pkg: PackageJson = {
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

async function npmInstall(
	ctx: CommandContext,
	registry: CommandRegistry,
	kernel?: Kernel,
	deps?: NpmCommandDeps,
): Promise<number> {
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
		const npmLog: NpmLogEmitter | null = invocation.loglevel
			? async (level, line) => { if (npmLogEnabled(invocation.loglevel, level)) await ctx.stderr.write(`${line}\n`); }
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
		} catch (err) {
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
			try { (await ctx.vfs.mkdir(dir, { recursive: true })); } catch { /* exists */ }
		}
	}

	const failed: string[] = [];

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
		const seen = new Set<string>();
		for (const [name, range] of Object.entries(allDeps)) {
			try {
				installed += await installSinglePackage(
					name, range, targetBase, ctx.vfs, npmRegistry, ctx.signal,
					ctx.stdout, ctx.stderr, false, registry, seen, undefined, kernel,
				);
			} catch (e) {
				failed.push(name);
				await ctx.stderr.write(`npm ERR! ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
			}
		}
	} else {
		// Install specified packages
		await ctx.stdout.write('Installing packages...\n');
		const seen = new Set<string>();
		for (const spec of packages) {
			const { name, version } = parsePackageSpec(spec);
			try {
				installed += await installSinglePackage(
					name, version, targetBase, ctx.vfs, npmRegistry, ctx.signal,
					ctx.stdout, ctx.stderr, invocation.global, registry, seen,
					invocation.global ? globalBinDir : undefined,
				);

				// Update package.json for local installs
				if (!invocation.global) {
					const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd));
					if (pkg) {
						const installedPkgPath = join(targetBase, name, 'package.json');
						let versionStr = 'latest';
						try {
							const ipkg = JSON.parse((await ctx.vfs.readFileString(installedPkgPath)));
							versionStr = '^' + ipkg.version;
						} catch { /* ignore */ }

						if (invocation.saveDev) {
							pkg.devDependencies = pkg.devDependencies || {};
							pkg.devDependencies[name] = versionStr;
						} else {
							pkg.dependencies = pkg.dependencies || {};
							pkg.dependencies[name] = versionStr;
						}
						(await writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg));
					}
				}
			} catch (e) {
				failed.push(name);
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
					await ctx.stderr.write(`npm ERR! network error fetching ${name}\n`);
					await ctx.stderr.write(`This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n`);
				} else {
					await ctx.stderr.write(`npm ERR! ${msg}\n`);
				}
			}
		}
	}

	// The in-process fallback reports the count it actually installed;
	// writeInstallSummary's file/bin/cache decorations don't apply here.
	await writeInstallSummary(ctx,
		installed > 0 ? new Array<string>(installed).fill('') : [],
		failed,
		{ startedAt: startTime },);
	return failed.length > 0 ? 1 : 0;
}

/** npm's prefix resolution: --prefix wins, then npm_config_prefix, then
 *  /usr/local; a relative value resolves against cwd. Absolute result. */
function resolveNpmPrefixVfs(cwd: string, env: Record<string, string>, explicit: string | null): string {
	const raw = explicit ?? env['npm_config_prefix'] ?? '/usr/local';
	return resolve(cwd, raw);
}

async function npmUninstall(ctx: CommandContext, _registry: CommandRegistry): Promise<number> {
	const args = ctx.args.slice(1);
	let isGlobal = false;
	const packages: string[] = [];

	for (const arg of args) {
		if (arg === '-g' || arg === '--global') {
			isGlobal = true;
		} else if (!arg.startsWith('-')) {
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
				const pkg: PackageJson = JSON.parse((await ctx.vfs.readFileString(join(targetDir, 'package.json'))));
				for (const binName of Object.keys(getBinEntries(pkg))) {
					try { (await ctx.vfs.unlink(join(globalBinDir, binName))); } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
		}

		// Remove the package
		try {
			(await ctx.vfs.rmdirRecursive(targetDir));
		} catch (e) {
			await ctx.stderr.write(`npm ERR! could not remove ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
			return 1;
		}

		// Update package.json for local uninstalls
		if (!isGlobal) {
			const pkg = (await readProjectPackageJson(ctx.vfs, ctx.cwd));
			if (pkg) {
				if (pkg.dependencies) delete pkg.dependencies[name];
				if (pkg.devDependencies) delete pkg.devDependencies[name];
				(await writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg));
			}
		}

		await ctx.stdout.write(`removed ${name}\n`);
	}

	return 0;
}

async function npmList(ctx: CommandContext): Promise<number> {
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

	const entries = (await ctx.vfs.readdir(modulesDir));
	const packages: { name: string; version: string }[] = [];

	for (const entry of entries) {
		if (entry.type !== 'directory') continue;

		if (entry.name.startsWith('@')) {
			// Scoped packages
			try {
				const scopeEntries = (await ctx.vfs.readdir(join(modulesDir, entry.name)));
				for (const se of scopeEntries) {
					if (se.type !== 'directory') continue;
					const v = (await readPkgVersion(ctx.vfs, join(modulesDir, entry.name, se.name)));
					packages.push({ name: `${entry.name}/${se.name}`, version: v });
				}
			} catch { /* ignore */ }
		} else {
			const v = (await readPkgVersion(ctx.vfs, join(modulesDir, entry.name)));
			packages.push({ name: entry.name, version: v });
		}
	}

	if (packages.length === 0) {
		await ctx.stdout.write('└── (empty)\n');
	} else {
		for (let i = 0; i < packages.length; i++) {
			const p = packages[i];
			const last = i === packages.length - 1;
			await ctx.stdout.write(`${last ? '└── ' : '├── '}${p.name}@${p.version}\n`);
		}
	}

	return 0;
}

async function readPkgVersion(vfs: VFS, pkgDir: string): Promise<string> {
	try {
		const pkg = JSON.parse((await vfs.readFileString(join(pkgDir, 'package.json'))));
		return pkg.version || '?';
	} catch {
		return '?';
	}
}

async function npmRun(ctx: CommandContext, shellExecute?: ShellExecuteFn, registry?: CommandRegistry, kernel?: Kernel): Promise<number> {
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
			const cmd = await registry.resolve(cmdName);
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
async function registerLocalBins(vfs: VFS, cwd: string, registry: CommandRegistry, kernel?: Kernel): Promise<number> {
	const nmDir = join(cwd, 'node_modules');
	if (!(await vfs.exists(nmDir))) return 0;

	let count = 0;
	try {
		const entries = (await vfs.readdir(nmDir));
		for (const dirent of entries) {
			const name = dirent.name;
			if (name.startsWith('.')) continue;

			if (name.startsWith('@')) {
				// Scoped packages: read @scope/pkg
				const scopeDir = join(nmDir, name);
				try {
					const scopeEntries = (await vfs.readdir(scopeDir));
					for (const scopeEntry of scopeEntries) {
						count += (await registerPkgBins(vfs, join(scopeDir, scopeEntry.name), registry, kernel));
					}
				} catch { /* ignore */ }
			} else {
				count += (await registerPkgBins(vfs, join(nmDir, name), registry, kernel));
			}
		}
	} catch { /* ignore */ }
	return count;
}

function isNativeExecutableBin(binPath: string): boolean {
	const clean = binPath.split(/[?#]/)[0];
	const base = clean.slice(clean.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';
	return ext === '.exe' || ext === '.node';
}

async function registerPkgBins(vfs: VFS, pkgDir: string, registry: CommandRegistry, kernel?: Kernel): Promise<number> {
	const pkgJsonPath = join(pkgDir, 'package.json');
	if (!(await vfs.exists(pkgJsonPath))) return 0;
	let count = 0;
	try {
		const pkg: PackageJson = JSON.parse((await vfs.readFileString(pkgJsonPath)));
		const bins = getBinEntries(pkg);
		for (const [binName, binPath] of Object.entries(bins)) {
			// Native-executable bins (.exe/.node) are not runnable here; skip
			// them so a package whose only bin is a native launcher (e.g.
			// opencode-ai's bin/opencode.exe) is handled by the npm-bin
			// fallback resolver, which reads the authoritative bin manifest
			// (including staged-artifact sentinels) instead of this raw scan.
			if (isNativeExecutableBin(binPath)) continue;
			// Only register if not already in registry
			if (!registry.has(binName)) {
				const scriptPath = resolve(pkgDir, binPath);
				registerBinCommand(registry, binName, scriptPath, kernel);
				count++;
			}
		}
	} catch { /* ignore */ }
	return count;
}

async function npmInfo(ctx: CommandContext): Promise<number> {
	const args = ctx.args.slice(1);
	const spec = args[0];

	if (!spec) {
		await ctx.stderr.write('Usage: npm info <package>\n');
		return 1;
	}

	const { name, version } = parsePackageSpec(spec);
	const npmRegistry = getRegistry(ctx.env);

	try {
		const info = await fetchPackageInfo(npmRegistry, name, version, ctx.signal);
		await ctx.stdout.write(`\n${info.name}@${info.version}\n`);
		if (info.description) await ctx.stdout.write(`${info.description}\n`);
		await ctx.stdout.write('\n');
		if (info.main) await ctx.stdout.write(`main: ${info.main}\n`);

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
		if (info.dist.shasum) await ctx.stdout.write(`shasum: ${info.dist.shasum}\n`);
		if (info.dist.integrity) await ctx.stdout.write(`integrity: ${info.dist.integrity}\n`);
	} catch (e) {
		await ctx.stderr.write(`npm ERR! ${e instanceof Error ? e.message : String(e)}\n`);
		return 1;
	}

	return 0;
}

async function npmSearch(ctx: CommandContext): Promise<number> {
	const args = ctx.args.slice(1);
	const term = args.join(' ');

	if (!term) {
		await ctx.stderr.write('Usage: npm search <term>\n');
		return 1;
	}

	const npmRegistry = getRegistry(ctx.env);
	const url = `${npmRegistry}/-/v1/search?text=${encodeURIComponent(term)}&size=10`;

	try {
		const response = await fetch(url, { signal: ctx.signal });
		if (!response.ok) {
			throw new Error(`Registry returned ${response.status}`);
		}

		const data = RegistrySearchResponseSchema.parse(await response.json());
		const results = data.objects;

		if (!results || results.length === 0) {
			await ctx.stdout.write('No results found\n');
			return 0;
		}

		// Header
		await ctx.stdout.write('NAME'.padEnd(30) + 'VERSION'.padEnd(12) + 'DESCRIPTION\n');
		await ctx.stdout.write('-'.repeat(70) + '\n');

		for (const r of results) {
			const p = r.package;
			const name = p.name.length > 28 ? p.name.slice(0, 28) + '..' : p.name;
			const desc = (p.description || '').slice(0, 40);
			await ctx.stdout.write(`${name.padEnd(30)}${p.version.padEnd(12)}${desc}\n`);
		}
	} catch (e) {
		await ctx.stderr.write(`npm ERR! ${e instanceof Error ? e.message : String(e)}\n`);
		return 1;
	}

	return 0;
}

// ─── Factory ───

export function createNpmCommand(
	registry: CommandRegistry,
	shellExecute?: ShellExecuteFn,
	kernel?: Kernel,
	deps?: NpmCommandDeps,
): Command {
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
				return (await npmInfo(ctx));
			case 'search':
				return (await npmSearch(ctx));
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
 * Install a single npm package globally into the VFS.
 *
 * Called directly by `lifo install` to avoid the shell.execute()
 * round-trip which can silently swallow output and errors.
 */
// ─── npx ───

const NPX_CACHE = '/tmp/.npx-cache/node_modules';

async function findBinScript(
	vfs: VFS,
	pkgDir: string,
	binName: string | null,
): Promise<string | null> {
	const pkgJsonPath = join(pkgDir, 'package.json');
	if (!(await vfs.exists(pkgJsonPath))) return null;
	try {
		const pkg: PackageJson = JSON.parse((await vfs.readFileString(pkgJsonPath)));
		const bins = getBinEntries(pkg);
		if (Object.keys(bins).length === 0) return null;
		// If a specific bin name is requested, look for it
		if (binName && bins[binName]) return resolve(pkgDir, bins[binName]);
		// Otherwise return the first entry
		const first = Object.values(bins)[0];
		return first ? resolve(pkgDir, first) : null;
	} catch {
		return null;
	}
}

export function createNpxCommand(
	registry: CommandRegistry,
	shellExecute?: ShellExecuteFn,
): Command {
	return async (ctx) => {
		const rawArgs = ctx.args.slice();
		let explicitPkg: string | null = null;

		// Parse flags
		const passthrough: string[] = [];
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
		const binName = explicitPkg ? spec : parsedName.split('/').pop()!;

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
				const seen = new Set<string>();
				try {
					await installSinglePackage(
						parsedName, version, NPX_CACHE, ctx.vfs, npmRegistry, ctx.signal,
						ctx.stdout, ctx.stderr, false, registry, seen,
					);
				} catch (e) {
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

export async function npmInstallGlobal(
	packageName: string,
	ctx: CommandContext,
	registry: CommandRegistry,
	kernel?: Kernel,
): Promise<number> {
	const npmRegistry = getRegistry(ctx.env);
	const startTime = Date.now();
	const seen = new Set<string>();

	const prefix = resolveNpmPrefixVfs(ctx.cwd, ctx.env, null);
	const modulesDir = `${prefix}/lib/node_modules`;
	const binDir = `${prefix}/bin`;
	try { (await ctx.vfs.mkdir(modulesDir, { recursive: true })); } catch { /* exists */ }
	try { (await ctx.vfs.mkdir(binDir, { recursive: true })); } catch { /* exists */ }

	try {
		const installed = await installSinglePackage(
			packageName, null, modulesDir, ctx.vfs, npmRegistry, ctx.signal,
			ctx.stdout, ctx.stderr, true, registry, seen, binDir, kernel,
		);

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		await ctx.stdout.write(`\nadded ${installed} package${installed !== 1 ? 's' : ''} in ${elapsed}s\n`);
		return 0;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
			await ctx.stderr.write(`npm ERR! network error fetching ${packageName}\n`);
			await ctx.stderr.write('This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n');
		} else {
			await ctx.stderr.write(`npm ERR! ${msg}\n`);
		}
		return 1;
	}
}
