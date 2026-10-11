import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import { ISOLATE_NETWORK, type WorkspaceNetwork } from '../../../../_shared/workspace-network.js';
import { resolveContext, type CommandRegistry } from '../registry.js';
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import type { Kernel } from '../../kernel/index.js';
import { basename, dirname, resolve, join } from '../../utils/path.js';
import { writeTarballStream, type TarballWriteResult } from '../../../../_shared/tarball.js';
import { isNativeBinPath } from '../../../../runtime/os-contracts.js';
import { npmBinMap } from '../../../../runtime/npm-bin-map.js';
import { pickPackumentVersion } from '../../../../_shared/npm-semver.js';
import { parseRegistryRequest, splitPackageSpec } from '../../../../_shared/npm-spec.js';
import {
	canonicalTreePath, depthOf, holdTree, namedPackages, placementName, planTree, projectRoots, requiredFailures, saveNamed,
	type ProjectManifest, type TreePackage, type TreeResolution, type TreeRoot,
} from '../../../../_shared/npm-tree.js';
import { renameOutcome } from '../../../../vfs/vfs-error.js';
import { sriDigestOf, sriDigestsEqual, strongestSriEntry } from '../../../../_shared/tarball-integrity.js';
import {
	RegistryPackumentSchema,
	RegistrySearchResponseSchema,
	renderSearchTable,
	RegistryVersionInfoSchema,
	type RegistryVersionInfo,
} from './registry-schemas.js';
import {
  parseNpmInstallInvocation,
  type NpmInstallInvocation,
} from './npm-install-args.js';
import { installSummary, npmLogEnabled, type NpmLogEmitter } from './npm-log.js';
import { exists } from '../../../../vfs/vfs.js';
import { direntTypeIn } from '../../../../vfs/dirent-type.js';

/** The registry an install reads from when its env names none. */
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const NPM_VERSION = '10.0.0';

// ─── Types ───

interface PackageJson extends ProjectManifest {
	name?: string;
	version?: string;
	description?: string;
	main?: string;
	bin?: string | Record<string, string>;
	scripts?: Record<string, string>;
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
    /** `--save-dev`: what is named is saved to devDependencies. */
    saveDev?: boolean;
    /** `--save-optional`: what is named is saved to optionalDependencies. */
    saveOptional?: boolean;
    /** `--force` / `--legacy-peer-deps`: a peer conflict with the project's own dependency is a warning, not ERESOLVE. */
    allowPeerConflicts?: boolean;
    /** The command's: an install it stops before publication changes nothing, and one waiting for the tree never starts. */
    signal?: AbortSignal;
    /** Registry origin from the command's env (`NPM_REGISTRY`), else the default. */
    registry: string;
    production?: boolean;
    /** `npm ci`: validate package-lock.json, remove node_modules, place exactly what the lock records. */
    fromLockfile?: boolean;
    npmLog?: NpmLogEmitter | null;
    onProgress?: (line: string) => void;
  }): Promise<{ installed: string[]; failed: string[]; totalFiles?: number; fromCacheHits?: number; linkedBins?: number }>;
}

export interface NpmCommandDeps {
  installer?: NpmInstallPort;
}

/** The end-of-install report (installSummary), on the command's own streams. */
async function writeInstallSummary(
  ctx: CommandContext,
  installed: string[],
  failed: string[],
  opts: { totalFiles?: number; fromCacheHits?: number; linkedBins?: number; globalBinDir?: string; startedAt: number },
): Promise<void> {
  const { stdout, stderr } = installSummary({ ...opts, installed: installed.length, failed, elapsedMs: Date.now() - opts.startedAt });
  if (stderr) await ctx.stderr.write(stderr);
  if (stdout) await ctx.stdout.write(stdout);
}
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

// ─── Registry fetch ───

function encodePackageName(name: string): string {
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
async function fetchPackageInfo(
	network: WorkspaceNetwork,
	registry: string,
	name: string,
	version: string | null,
	signal: AbortSignal,
): Promise<RegistryVersionInfo> {
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
async function fetchAndStreamPackage(
	network: WorkspaceNetwork,
	tarballUrl: string,
	integrity: string | undefined,
	targetDir: string,
	vfs: VFS,
	signal: AbortSignal,
	stderr: CommandOutputStream,
): Promise<TarballWriteResult> {
	const response = await network.fetch(tarballUrl, { signal });
	if (!response.ok) {
		throw new Error(`Failed to download tarball: ${response.status}`);
	}

	if (!response.body) throw new Error(`Registry served no body for ${tarballUrl}`);
	const sri = integrity ? strongestSriEntry(integrity) : null;
	if (sri === null) {
		if (integrity) await stderr.write(`npm WARN integrity "${integrity}" names no algorithm npm checks; skipped verification\n`);
		return (await writeTarballStream(response.body, targetDir, vfs));
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const got = await sriDigestOf(bytes, sri.digestAlgo);
	if (!sriDigestsEqual(got, sri.digest)) {
		throw new Error(`integrity mismatch for ${tarballUrl}: expected ${sri.algo}-${sri.digest}, got ${sri.algo}-${got}`);
	}
	return (await writeTarballStream(new Response(bytes).body!, targetDir, vfs));
}

async function readProjectPackageJson(vfs: VFS, cwd: string): Promise<PackageJson | null> {
	const pkgPath = join(cwd, 'package.json');
	try {
		const pkg: unknown = JSON.parse(await vfs.readFileString(pkgPath));
		return typeof pkg === 'object' && pkg !== null && !Array.isArray(pkg) ? pkg : null;
	} catch {
		return null;
	}
}

async function writeProjectPackageJson(vfs: VFS, cwd: string, pkg: PackageJson): Promise<void> {
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
export async function* packagesIn(vfs: VFS, modulesDir: string): AsyncGenerator<string> {
	const read = async (dir: string) => {
		try { return await vfs.readdir(dir); } catch { return []; }
	};
	for (const entry of await read(modulesDir)) {
		if (entry.name.startsWith('.')) continue;
		const type = await direntTypeIn(vfs, modulesDir, entry);
		if (type !== 'directory' && type !== 'symlink') continue;
		if (!entry.name.startsWith('@')) { yield entry.name; continue; }
		const scopeDir = join(modulesDir, entry.name);
		for (const child of await read(scopeDir)) {
			const childType = await direntTypeIn(vfs, scopeDir, child);
			if (childType === 'directory' || childType === 'symlink') yield `${entry.name}/${child.name}`;
		}
	}
}

export function getBinEntries(pkg: PackageJson): Record<string, string> {
	return Object.fromEntries(npmBinMap(pkg.name ?? '', pkg.bin));
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


// ─── Install: the shell's host of the one engine ───

/** What the shell's install needs besides its roots. */
interface TreeInstall {
	/** The `node_modules` the tree lands in. */
	targetBase: string;
	/** The install's own view: its publication and rollback outlive a Ctrl-C, which revokes the command's. */
	vfs: VFS;
	/** Every registry request goes through it (the workspace's, under an egress). */
	network: WorkspaceNetwork;
	npmRegistry: string;
	/** The command's: it stops the install before publication, never during it. */
	signal: AbortSignal;
	stdout: CommandOutputStream;
	stderr: CommandOutputStream;
	registry: CommandRegistry;
	kernel?: Kernel;
	/** A global install: npm's shallow layout, and the roots' bins linked into this directory. */
	globalBinDir?: string;
	/** `--force` / `--legacy-peer-deps`: a peer conflict with the project's own dependency is a warning. */
	allowPeerConflicts?: boolean;
}

/** A package the shell resolved, by the name it installs under (an alias's), with its registry version to fetch. */
type ResolvedShellPackage = TreePackage & { readonly info: RegistryVersionInfo };

/** A package installed before this install: its manifest on disk. */
type InstalledShellPackage = TreePackage;

/**
 * The install journal, at `<node_modules>/.nimbus-install-journal`: every
 * rename publication makes, recorded before it starts and once its outcome
 * is known, and `committed` once every package is published. An install
 * that did not finish (a crash, a lost isolate) is undone from it by the
 * next, and only from what it records.
 */
const JOURNAL = '.nimbus-install-journal';

/** A rename publication makes: `kind` says whose content `from` holds. */
interface JournalStep {
	/** retire: the installed copy moved aside; publish: a staged package moved in; carry: a kept package moved from a retired copy into the new tree. */
	readonly kind: 'retire' | 'publish' | 'carry';
	readonly from: string;
	readonly to: string;
	/** begun: not known to have finished; done: `to` holds all of it (what is left at `from` is residue); none: nothing moved. */
	state: 'begun' | 'done' | 'none';
}

interface Journal {
	readonly run: string;
	readonly steps: JournalStep[];
	committed: boolean;
}

/** The kernel-less shell's install queues are one namespace. */
const NO_KERNEL = {};

/**
 * Undo what `journal` records, newest first: a published package goes (its
 * content is new), and a retired or carried copy moves back, over any
 * residue a rename left where it came from. A step that may have moved part
 * of an installed copy (begun, its outcome unknown, both names there) is
 * not guessed at: both are kept, and named. Answers whether every installed
 * copy is back where it was.
 */
async function undoJournal(vfs: VFS, journal: Journal, stderr: CommandOutputStream): Promise<boolean> {
	let restored = true;
	for (const step of [...journal.steps].reverse()) {
		const { kind, from, to } = step;
		let state = step.state;
		try {
			if (state === 'begun') {
				const atFrom = await vfs.exists(from);
				const atTo = await vfs.exists(to);
				state = !atTo ? 'none' : !atFrom ? 'done' : kind === 'publish' ? 'done' : 'begun';
			}
			if (state === 'none') continue;
			if (kind === 'publish') {
				// Staged and published content alike are this install's own.
				await vfs.remove(to, { recursive: true, force: true });
				await vfs.remove(from, { recursive: true, force: true });
				continue;
			}
			if (state === 'begun') {
				await stderr.write(`npm ERR! could not tell whether ${from} or ${to} holds the installed copy; both are kept\n`);
				restored = false;
				continue;
			}
			await vfs.remove(from, { recursive: true, force: true });
			await vfs.mkdir(dirname(from), { recursive: true });
			await vfs.rename(to, from);
		} catch (error) {
			await stderr.write(`npm ERR! could not restore ${from}; its copy is kept at ${to}: ${describeError(error)}\n`);
			restored = false;
		}
	}
	return restored;
}

const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Every package installed under `modulesDir`'s tree, at its placement: a
 * linked package (a symlink) is the link's, and not walked into.
 */
async function installedPlacements(vfs: VFS, modulesDir: string, prefix = '', out: string[] = []): Promise<string[]> {
	for await (const name of packagesIn(vfs, modulesDir)) {
		const placement = prefix + name;
		out.push(placement);
		if (!(await vfs.isSymlink(join(modulesDir, name)))) await installedPlacements(vfs, join(modulesDir, name, 'node_modules'), `${placement}/node_modules/`, out);
	}
	return out;
}

/**
 * Install `roots` and what they depend on under `install.targetBase`, as
 * npm's arborist does it. Its caller holds the tree (holdTree).
 *
 * Recover: an install the journal records as unfinished is undone first.
 *
 * Plan: the one engine's (core _shared/npm-tree.ts planTree), reading
 * versions and manifests from the registry one package at a time and what
 * is installed from node_modules. A required failure fails the install
 * before it changes anything. A stop (the command's signal) after the plan
 * changes nothing either.
 *
 * Reify: every package is fetched, verified and extracted into this run's
 * own staging directory; one that fails there is left out with its optional
 * set, or fails the install when it is required. Then, under the journal:
 * what the tree no longer holds (extraneous, or left out) is retired;
 * each package published shallowest first, the copy it replaces retired
 * beside it; and each kept package an ancestor's retirement took along is
 * carried back into place. A failure undoes the journal. Once every package
 * is published, the journal is committed and the retired copies go.
 */
async function installTree(roots: readonly TreeRoot[], install: TreeInstall): Promise<{ installed: string[]; failed: string[] }> {
	const { targetBase, vfs, network, npmRegistry, signal, stdout, stderr } = install;
	const fail = async (name: string, message: string): Promise<{ installed: string[]; failed: string[] }> => {
		if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('CORS')) {
			await stderr.write(`npm ERR! network error fetching ${name}\n`);
			await stderr.write(`This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n`);
		} else {
			await stderr.write(`npm ERR! ${name}: ${message}\n`);
		}
		return { installed: [], failed: [name] };
	};
	const journalPath = join(targetBase, JOURNAL);
	const writeJournal = async (journal: Journal) => {
		await vfs.writeFile(journalPath, JSON.stringify(journal));
	};

	// ── Recover ──
	if (await vfs.exists(journalPath)) {
		let journal: Journal | null = null;
		try { journal = JSON.parse(await vfs.readFileString(journalPath)); } catch { journal = null; }
		if (journal !== null && !journal.committed && !(await undoJournal(vfs, journal, stderr))) {
			return await fail(targetBase, 'an install that did not finish could not be undone; its copies are kept as named above');
		}
		if (journal?.committed) {
			for (const { kind, to, state } of journal.steps) if (kind === 'retire' && state !== 'none') await vfs.remove(to, { recursive: true, force: true });
		}
		await vfs.remove(journalPath, { force: true });
	}
	// A staging directory left behind holds only new packages: no install
	// into this tree is using it while this one holds it.
	try {
		for (const { name } of await vfs.readdir(targetBase)) {
			if (name.startsWith('.nimbus-staging-')) await vfs.remove(join(targetBase, name), { recursive: true, force: true });
		}
	} catch { /* no node_modules yet */ }

	// ── Plan ──
	const plan = await planTree<ResolvedShellPackage, InstalledShellPackage>(roots, {
		async resolve(requests) {
			const answers: Array<TreeResolution<ResolvedShellPackage>> = [];
			for (const { name, range } of requests) {
				await stdout.write(`  ${name}${range ? '@' + range : ''}...\n`);
				try {
					const info = await fetchPackageInfo(network, npmRegistry, name, range || null, signal);
					answers.push({ package: { ...info, name, info } });
				} catch (error) {
					answers.push({ failed: describeError(error) });
				}
			}
			return answers;
		},
		installed: (placements) => Promise.all(placements.map(async (placement): Promise<InstalledShellPackage | null> => {
			try {
				const pkg: PackageJson = JSON.parse(await vfs.readFileString(join(targetBase, placement, 'package.json')));
				return typeof pkg.version === 'string' ? { ...pkg, name: placementName(placement), version: pkg.version } : null;
			} catch { return null; }
		})),
		peerMismatch: async (edge, at, version) => {
			await stderr.write(`npm WARN peer ${edge.name}@${edge.range} from ${edge.from} is met by ${at}@${version}\n`);
		},
	}, { shallow: install.globalBinDir !== undefined, allowPeerConflicts: install.allowPeerConflicts });
	const [requiredFailure] = requiredFailures(plan);
	if (requiredFailure) return await fail(requiredFailure.edge.name, requiredFailure.reason);
	for (const { id, edge } of plan.failures) {
		await stderr.write(`npm WARN optional SKIPPING OPTIONAL DEPENDENCY: ${edge.name}: ${plan.reasons.get(id)}\n`);
	}
	signal.throwIfAborted();

	// ── Reify ──
	const run = Math.random().toString(36).slice(2, 10);
	const staging = join(targetBase, `.nimbus-staging-${run}`);
	const planned = [...plan.nodes.values()].flatMap((node) => node.planned ? [node] : []);
	const stagedAt = new Map(planned.map((node, i) => [node.at, join(staging, String(i))]));
	try {
		for (const node of planned) {
			if (plan.skipped.has(node.at)) continue;
			try {
				// writeTarballStream throws when the archive carried no manifest
				// and writes package.json last, so a return is a complete package.
				await fetchAndStreamPackage(network, node.pkg.info.dist.tarball, node.pkg.info.dist.integrity, stagedAt.get(node.at) ?? staging, vfs, signal, stderr);
			} catch (error) {
				if (plan.fail(node.at, describeError(error)) === null) return await fail(node.edge.name, describeError(error));
				await stderr.write(`npm WARN optional SKIPPING OPTIONAL DEPENDENCY: ${node.edge.name}: ${describeError(error)}\n`);
			}
		}
		signal.throwIfAborted();

		const tree = new Set([...plan.nodes.keys()].filter((at) => !plan.skipped.has(at)));
		// What is on disk the tree does not hold goes (npm prunes it); a
		// global prefix's own packages are its roots, and stay.
		const onDisk = await installedPlacements(vfs, targetBase);
		const removals = onDisk.filter((at) => !tree.has(at) && ![...tree].some((kept) => at.startsWith(kept + '/node_modules/') && !plan.nodes.has(at) && plan.nodes.get(kept)?.planned === false));
		const publish = planned.filter((node) => tree.has(node.at)).sort((x, y) => depthOf(x.at) - depthOf(y.at));
		if (publish.length === 0 && removals.length === 0) return { installed: [], failed: [] };

		const journal: Journal = { run, steps: [], committed: false };
		const retiredFor = (target: string) => join(dirname(target), `.${basename(target)}-retired-${run}`);
		const retiredAt = new Map<string, string>();
		const step = async (kind: JournalStep['kind'], from: string, to: string) => {
			const entry: JournalStep = { kind, from, to, state: 'begun' };
			journal.steps.push(entry);
			await writeJournal(journal);
			try {
				await vfs.mkdir(dirname(to), { recursive: true });
				await vfs.rename(from, to);
				entry.state = 'done';
			} catch (error) {
				const outcome = renameOutcome(error);
				if (outcome !== undefined) entry.state = outcome === 'all' ? 'done' : 'none';
				await writeJournal(journal);
				throw error;
			}
			await writeJournal(journal);
		};
		// The package the step being made is for, should it fail.
		let current = targetBase;
		try {
			// Deepest first, so a package goes before the one it is nested in.
			for (const at of removals.sort((x, y) => depthOf(y) - depthOf(x))) {
				current = placementName(at);
				const target = join(targetBase, at);
				if (!(await vfs.exists(target))) continue;
				await step('retire', target, retiredFor(target));
				retiredAt.set(at, retiredFor(target));
			}
			for (const node of publish) {
				current = node.edge.name;
				const target = join(targetBase, node.at);
				if (await vfs.exists(target)) {
					await step('retire', target, retiredFor(target));
					retiredAt.set(node.at, retiredFor(target));
				}
				await step('publish', stagedAt.get(node.at) ?? staging, target);
			}
			// A kept package whose ancestor was retired (replaced, or bundling
			// its own node_modules) went with it: it moves back into the tree,
			// beside whatever the new ancestor bundles.
			const kept = [...plan.nodes.values()].filter((node) => !node.planned && tree.has(node.at)).sort((x, y) => depthOf(x.at) - depthOf(y.at));
			for (const node of kept) {
				const target = join(targetBase, node.at);
				if (await vfs.exists(target)) continue;
				const ancestor = [...retiredAt.keys()].filter((at) => node.at.startsWith(at + '/node_modules/')).sort((x, y) => depthOf(y) - depthOf(x))[0];
				if (ancestor === undefined) continue;
				current = node.at;
				const source = (retiredAt.get(ancestor) ?? '') + node.at.slice(ancestor.length);
				if (await vfs.exists(source)) await step('carry', source, target);
			}
		} catch (error) {
			const restored = await undoJournal(vfs, journal, stderr);
			if (restored) await vfs.remove(journalPath, { force: true });
			return await fail(current, describeError(error));
		}
		journal.committed = true;
		await writeJournal(journal);
		// Published: the retired copies this run made are the old tree's.
		for (const { kind, to, state } of journal.steps) {
			if (kind !== 'retire' || state === 'none') continue;
			try { await vfs.remove(to, { recursive: true, force: true }); } catch (error) {
				await stderr.write(`npm WARN could not remove ${to}: ${describeError(error)}\n`);
			}
		}
		await vfs.remove(journalPath, { force: true });
		if (install.globalBinDir) {
			for (const node of publish) {
				if (node.edge.from === '') await linkGlobalBins(node.pkg.info, join(targetBase, node.at), install.globalBinDir, install);
			}
		}
		return { installed: publish.map((node) => `${node.pkg.name}@${node.pkg.version}`), failed: [] };
	} finally {
		try { await vfs.remove(staging, { recursive: true, force: true }); } catch { /* none was made */ }
	}
}

/** Link a globally installed root's bins into the prefix's bin directory, and register them as commands. */
async function linkGlobalBins(info: RegistryVersionInfo, targetDir: string, globalBinDir: string, install: TreeInstall): Promise<void> {
	for (const [binName, binPath] of Object.entries(getBinEntries(info))) {
		const scriptPath = resolve(targetDir, binPath);
		registerBinCommand(install.registry, binName, scriptPath, install.kernel);
		try { (await install.vfs.mkdir(globalBinDir, { recursive: true })); } catch { /* exists */ }
		(await install.vfs.writeFile(
			join(globalBinDir, binName),
			`#!/usr/bin/env node\nrequire('${scriptPath}');\n`,
		));
	}
}

// ─── Subcommands ───

async function printHelp(ctx: CommandContext): Promise<void> { await ctx.stdout.write('Usage: npm <command> [args]\n\n');
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
	await ctx.stdout.write('  -v, --version              print npm version\n'); }

/**
 * `npm init`, `npm create` and `npm innit` (npm-init.ts). npm's own
 * libraries there (hosted-git-info, npm-package-arg, semver, the SPDX list)
 * are evaluated the first time a session runs one, not when it starts.
 */
async function npmInit(ctx: CommandContext): Promise<number> {
	return (await import('./npm-init.js')).npmInitCommand(ctx);
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

	const npmRegistry = getRegistry(ctx.env);
	const startTime = Date.now();

	// The port owns the install, prefix dirs and bin materialisation: the
	// host's, else the shell's own (shellInstallPort). This command owns the
	// summary and the progress channel — per-invocation, so two terminals'
	// installs can't interleave lines on one installer.
	const installer = deps?.installer ?? shellInstallPort(ctx, registry, kernel);
	const npmLog: NpmLogEmitter | null = invocation.loglevel
		? async (level, line) => { if (npmLogEnabled(invocation.loglevel, level)) await ctx.stderr.write(`${line}\n`); }
		: null;
	try {
		const result = await installer.install({
			projectDir: ctx.cwd,
			packages,
			global: invocation.global,
			globalPrefix: invocation.global ? globalPrefix : undefined,
			pid: ctx.pid,
			registry: npmRegistry,
			production: invocation.production,
			saveDev: invocation.saveDev,
			saveOptional: invocation.saveOptional,
			allowPeerConflicts: invocation.allowPeerConflicts,
			signal: ctx.signal,
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

/**
 * The shell's own install port: npm's one engine (installTree) for a host
 * that gives the command no port of its own (a library's shell). Its view
 * of the filesystem is the command's identity's, not bound to the command's
 * signal: a Ctrl-C stops the install before it publishes, and never takes
 * away what it needs to finish or undo a publication. A local install plans
 * the project's roots with the packages named, under the tree's hold, and
 * saves what was named to package.json once the install is complete.
 */
function shellInstallPort(ctx: CommandContext, registry: CommandRegistry, kernel?: Kernel): NpmInstallPort {
	return {
		async install(spec) {
			const signal = spec.signal ?? ctx.signal;
			const vfs = ctx.vfsUntilExit?.() ?? ctx.vfs;
			const targetBase = spec.global ? `${spec.globalPrefix}/lib/node_modules` : join(spec.projectDir, 'node_modules');
			const globalBinDir = spec.global ? `${spec.globalPrefix}/bin` : undefined;
			const tree: TreeInstall = {
				targetBase, vfs, network: kernel?.network ?? ISOLATE_NETWORK, npmRegistry: spec.registry, signal,
				stdout: ctx.stdout, stderr: ctx.stderr, registry, kernel,
				...(globalBinDir ? { globalBinDir } : {}),
				...(spec.allowPeerConflicts ? { allowPeerConflicts: true } : {}),
			};
			// The project's package.json is read and written under the tree's
			// hold, so two installs at once add to it one after the other.
			const canonical = await canonicalTreePath((path) => vfs.realpath(path), targetBase);
			const held = holdTree(kernel ?? NO_KERNEL, canonical, signal);
			const release = typeof held === 'function' ? held : await held;
			try {
				if (globalBinDir) {
					for (const dir of [targetBase, globalBinDir]) await vfs.mkdir(dir, { recursive: true });
				}
				// A global prefix's packages are its roots: each kept as it is.
				const project: PackageJson | null = spec.global ? null : await readProjectPackageJson(vfs, spec.projectDir);
				const implicit: string[] = [];
				if (spec.global) for await (const name of packagesIn(vfs, targetBase)) implicit.push(name);
				const named = namedPackages(project, spec.packages, { saveDev: spec.saveDev, saveOptional: spec.saveOptional });
				const roots = projectRoots(project, named, { production: spec.production === true, implicit });
				if (roots.length === 0) {
					await ctx.stdout.write('up to date, audited 0 packages\n');
					return { installed: [], failed: [] };
				}
				await ctx.stdout.write(spec.packages.length === 0 ? 'Installing dependencies...\n' : 'Installing packages...\n');
				const result = await installTree(roots, tree);
				if (result.failed.length > 0 || project === null || named.length === 0) return result;
				// What the command line named is saved to package.json, once it installed.
				try {
					const installedAs = async (name: string) => {
						try {
							const pkg: PackageJson = JSON.parse(await vfs.readFileString(join(targetBase, name, 'package.json')));
							return typeof pkg.version === 'string' ? { version: pkg.version, registryName: pkg.name ?? name } : null;
						} catch { return null; }
					};
					const versions = new Map(await Promise.all(named.map(async ({ name }) => [name, await installedAs(name)] as const)));
					await writeProjectPackageJson(vfs, spec.projectDir, saveNamed((await readProjectPackageJson(vfs, spec.projectDir)) ?? project, named, (name) => versions.get(name) ?? null));
					return result;
				} catch (error) {
					await ctx.stderr.write(`npm ERR! ${describeError(error)}\n`);
					return { installed: result.installed, failed: named.map(({ name }) => name) };
				}
			} finally {
				release();
			}
		},
	};
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
			(await ctx.vfs.remove(targetDir, { recursive: true }));
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

	const packages: { name: string; version: string }[] = [];
	for await (const name of packagesIn(ctx.vfs, modulesDir)) {
		packages.push({ name, version: await readPkgVersion(ctx.vfs, join(modulesDir, name)) });
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
async function registerLocalBins(vfs: VFS, cwd: string, registry: CommandRegistry, kernel?: Kernel): Promise<number> {
	const nmDir = join(cwd, 'node_modules');
	let count = 0;
	for await (const name of packagesIn(vfs, nmDir)) count += await registerPkgBins(vfs, join(nmDir, name), registry, kernel);
	return count;
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
			if (isNativeBinPath(binPath)) continue;
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

async function npmInfo(ctx: CommandContext, network: WorkspaceNetwork): Promise<number> {
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

async function npmSearch(ctx: CommandContext, network: WorkspaceNetwork): Promise<number> {
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
async function npmCi(ctx: CommandContext, deps?: NpmCommandDeps): Promise<number> {
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
		if (await ctx.vfs.exists(join(ctx.cwd, name))) hasLock = true;
	}
	if (!hasLock) {
		await ctx.stderr.write(
			'npm ERR! The `npm ci` command can only install with an existing package-lock.json or\n' +
			'npm ERR! npm-shrinkwrap.json. Run `npm install` to generate one, then try again.\n',
		);
		return 1;
	}
	if (!deps?.installer) {
		await ctx.stderr.write('npm ERR! `npm ci` needs the host installer, which this runtime does not provide\n');
		return 1;
	}
	const startTime = Date.now();
	const npmLog: NpmLogEmitter | null = invocation.loglevel
		? async (level, line) => { if (npmLogEnabled(invocation.loglevel, level)) await ctx.stderr.write(`${line}\n`); }
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
	} catch (err) {
		await ctx.stderr.write(`npm ERR! ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

// ─── npx ───

/** Where npx installs what it runs: a project of its own. */
const NPX_CACHE_PROJECT = '/tmp/.npx-cache';
const NPX_CACHE = `${NPX_CACHE_PROJECT}/node_modules`;

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
	/** Its network is the one the npx cache install fetches through. */
	kernel?: Kernel,
	deps?: NpmCommandDeps,
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

		const { name: parsedName } = splitPackageSpec(explicitPkg || spec);
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
				const installer = deps?.installer ?? shellInstallPort(ctx, registry, kernel);
				const result = await installer.install({
					projectDir: NPX_CACHE_PROJECT, packages: [explicitPkg || spec], global: false,
					pid: ctx.pid, registry: getRegistry(ctx.env),
				});
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

/**
 * Install one package globally, through the install port (the host's, else
 * the shell's own). Called directly by `lifo install` to avoid the
 * shell.execute() round-trip, which can silently swallow output and errors.
 */
export async function npmInstallGlobal(
	packageName: string,
	ctx: CommandContext,
	registry: CommandRegistry,
	kernel?: Kernel,
	deps?: NpmCommandDeps,
): Promise<number> {
	const startTime = Date.now();
	const prefix = resolveNpmPrefixVfs(ctx.cwd, ctx.env, null);
	const installer = deps?.installer ?? shellInstallPort(ctx, registry, kernel);
	const { installed, failed } = await installer.install({
		projectDir: ctx.cwd, packages: [packageName], global: true, globalPrefix: prefix, pid: ctx.pid, registry: getRegistry(ctx.env),
	});
	if (failed.length > 0) return 1;
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	await ctx.stdout.write(`\nadded ${installed.length} package${installed.length !== 1 ? 's' : ''} in ${elapsed}s\n`);
	return 0;
}
