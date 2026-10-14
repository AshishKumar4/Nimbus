/**
 * runtime-store.ts — where `nimbus install` puts a runtime, as apt does on
 * Linux: its tree in `/usr/lib/nimbus/<name>/<version>`, owned by root, and
 * a launcher for each of its commands in `/usr/bin`, a link into the tree.
 *
 * The store is the kernel's, so it is reached through no directory anyone
 * else may replace: `/usr` is in root's `/`, and each directory from it
 * down is checked to be root's own real directory, writable by no one else,
 * before the kernel writes there. One a session's user owns, or a link (only
 * root could have made either), refuses the install rather than be written
 * through. Releases through core 0.19 kept runtimes below `~/.nimbus/runtimes`;
 * a workspace moves them here once, as it opens (moveHomeRuntimes).
 */

import type { CredentialedVfs as EngineVfs } from '../vfs/sqlite-vfs.js';
import type { RuntimeManifest } from './runtime-manifest.js';

/** Where installed runtimes live: `<store>/<name>/<version>`. */
export const RUNTIME_STORE = 'usr/lib/nimbus';

/** Where a runtime's commands get their launchers. */
export const LAUNCHER_DIR = 'usr/bin';

/** The directories from `/` to the store, each root's own. */
const STORE_DIRS = ['usr', 'usr/lib', RUNTIME_STORE];

/** What the store asks of the filesystem it is written through: the installer's own view. */
export interface RuntimeStoreFs {
  stat(path: string, options?: { follow?: boolean }): Promise<{ type: string; uid?: number; mode?: number } | null>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/** Whether `entry` (looked at without following it) is a directory only root may change. */
export function rootsOwn(entry: { type: string; uid?: number; mode?: number } | null): boolean {
  return entry?.type === 'directory' && entry.uid === 0 && ((entry.mode ?? 0) & 0o022) === 0;
}

/** The directories from `/` to the store: each must be root's own (rootsOwn) for the store to be read or written. */
export const RUNTIME_STORE_DIRS: readonly string[] = STORE_DIRS;

/**
 * The directories of `manifest`'s tree at `root` its files are in, with every
 * directory between them and `root`, parents first: what each file is
 * reached through.
 */
function treeDirectories(root: string, manifest: RuntimeManifest): string[] {
  const dirs = new Set<string>();
  for (const file of manifest.files) {
    const names = file.path.split('/').slice(0, -1);
    for (let i = 1; i <= names.length; i++) dirs.add(`${root}/${names.slice(0, i).join('/')}`);
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
}

/**
 * Whether every directory `manifest`'s files at `root` are reached through
 * that is there is root's own (rootsOwn): a tree whose files nobody else
 * could have put there, or can change. One that is missing is no file's.
 */
export async function runtimeTreeOwn(fs: Pick<RuntimeStoreFs, 'stat'>, root: string, manifest: RuntimeManifest): Promise<boolean> {
  for (const dir of treeDirectories(root, manifest)) {
    const entry = await fs.stat(dir, { follow: false });
    if (entry !== null && !rootsOwn(entry)) return false;
  }
  return true;
}

/**
 * Make the store ready to write `manifest`'s tree into: each directory from
 * `/usr` down to the runtime's own, and each its files are in, made by root
 * if it is missing, and refused unless it is root's own real directory that
 * no one else may write. Nothing of the tree is then reached through
 * anything a user made or can change: not a store an earlier release left
 * the user's, nor a home configured inside a tree.
 */
export async function prepareRuntimeStore(fs: RuntimeStoreFs, manifest: RuntimeManifest): Promise<void> {
  const root = `${RUNTIME_STORE}/${manifest.name}/${manifest.version}`;
  for (const dir of [...STORE_DIRS, `${RUNTIME_STORE}/${manifest.name}`, root, ...treeDirectories(root, manifest)]) {
    let entry = await fs.stat(dir, { follow: false });
    if (entry === null) {
      await fs.mkdir(dir, { mode: 0o755 });
      entry = await fs.stat(dir, { follow: false });
    }
    if (!rootsOwn(entry)) {
      throw new Error(
        `nimbus install: /${dir} is not root's own directory (a ${entry?.type ?? 'missing entry'}`
        + ` owned by uid ${entry?.uid}); runtimes are not installed through it`,
      );
    }
  }
}

/** A runtime command's launcher in `/usr/bin`. */
export interface RuntimeLauncher {
  /** The command it launches, as its entrypoint names it. */
  binName: string;
  /** The name it runs by path, as the registry knows it: `/usr/bin/<command>`. */
  command: string;
  /** The launcher, as a key: `usr/bin/<command>`. */
  path: string;
  /** What it links to: the tree's own `bin/<command>`. */
  target: string;
}

/** A runtime's launchers: `/usr/bin/<command>` for each of `commands` its tree has a `bin/<command>` for. */
export function runtimeLaunchers(manifest: RuntimeManifest, root: string, commands: Iterable<string>): RuntimeLauncher[] {
  const files = new Set(manifest.files.map((file) => file.path));
  const out: RuntimeLauncher[] = [];
  for (const binName of commands) {
    if (binName.includes('/') || !files.has(`bin/${binName}`)) continue;
    out.push({ binName, command: `/${LAUNCHER_DIR}/${binName}`, path: `${LAUNCHER_DIR}/${binName}`, target: `/${root}/bin/${binName}` });
  }
  return out;
}

/** Whether `/usr/bin` is root's own real directory, as `/usr` is: launchers are written into nothing else. */
async function launcherDirOwn(fs: RuntimeStoreFs): Promise<boolean> {
  return rootsOwn(await fs.stat('usr', { follow: false })) && rootsOwn(await fs.stat(LAUNCHER_DIR, { follow: false }));
}

/**
 * Point each launcher at its tree, and answer the ones that lead there: a
 * launcher of ours that leads to another version is replaced; anything else
 * at that name (a file or link someone put there with sudo) is left, and the
 * command runs by name only. The tree's `bin/<command>` is a marker the
 * shell's registry runs by its path, not a program: one left executable (as
 * an earlier tree may be) is made not to be, so a guest Bash that finds it
 * is refused it rather than running its comments as an empty script. The
 * tree is the store's, reached through root's own directories only
 * (listInstalledManifestsView, prepareRuntimeStore).
 */
export async function linkLaunchers(fs: RuntimeStoreFs, launchers: readonly RuntimeLauncher[]): Promise<RuntimeLauncher[]> {
  if (launchers.length === 0 || !(await launcherDirOwn(fs))) return [];
  const linked: RuntimeLauncher[] = [];
  for (const launcher of launchers) {
    const { path, target } = launcher;
    const marker = await fs.stat(target, { follow: false });
    if (marker?.type !== 'file' || marker.uid !== 0) continue;
    if (((marker.mode ?? 0) & 0o111) !== 0) await fs.chmod(target, (marker.mode ?? 0) & 0o666);
    const entry = await fs.stat(path, { follow: false });
    if (entry !== null) {
      if (entry.type !== 'symlink') continue;
      const current = await fs.readlink(path);
      if (current === target) { linked.push(launcher); continue; }
      // Ours leads into the store.
      if (!current.startsWith(`/${RUNTIME_STORE}/`)) continue;
      await fs.unlink(path);
    }
    await fs.symlink(target, path);
    linked.push(launcher);
  }
  return linked;
}

/** Remove each launcher that leads into its tree, and answer the ones removed. */
export async function unlinkLaunchers(fs: RuntimeStoreFs, launchers: readonly RuntimeLauncher[]): Promise<RuntimeLauncher[]> {
  if (launchers.length === 0 || !(await launcherDirOwn(fs))) return [];
  const removed: RuntimeLauncher[] = [];
  for (const launcher of launchers) {
    const entry = await fs.stat(launcher.path, { follow: false });
    if (entry?.type !== 'symlink' || (await fs.readlink(launcher.path)) !== launcher.target) continue;
    await fs.unlink(launcher.path);
    removed.push(launcher);
  }
  return removed;
}

/**
 * Move the runtimes an earlier release installed below `<home>/.nimbus/runtimes`
 * into the store, as the kernel, once, and leave a link at the old path so
 * what names it (a durable launch's recipe, a script) still finds them. One
 * synchronous turn on the session's own filesystem, so nothing changes
 * between a look and a move; each name is looked at without following it,
 * and only root's own real directories move. A version already in the store
 * stays where it was; then the link is not made. What moved is verified by
 * its payload digests when it is bound (rehydration), not here.
 */
export function moveHomeRuntimes(kernel: EngineVfs, home: string): string[] {
  const homeKey = home.replace(/^\/+/, '').replace(/\/+$/, '');
  if (homeKey === '') return [];
  const old = `${homeKey}/.nimbus/runtimes`;
  const rootDir = (path: string) => rootsOwn(kernel.statIfPresent(path, false));
  if (!rootDir(`${homeKey}/.nimbus`) || !rootDir(old)) return [];
  for (const dir of STORE_DIRS) {
    if (kernel.statIfPresent(dir, false) === null && dir === RUNTIME_STORE) kernel.mkdir(dir, { mode: 0o755 });
    if (!rootDir(dir)) return [];
  }
  const moved: string[] = [];
  let left = false;
  for (const name of kernel.readdir(old).map((entry) => entry.name)) {
    const nameDir = `${old}/${name}`;
    if (!rootDir(nameDir)) { left = true; continue; }
    for (const version of kernel.readdir(nameDir).map((entry) => entry.name)) {
      const from = `${nameDir}/${version}`;
      const to = `${RUNTIME_STORE}/${name}/${version}`;
      if (!rootDir(from) || kernel.statIfPresent(to, false) !== null) { left = true; continue; }
      if (kernel.statIfPresent(`${RUNTIME_STORE}/${name}`, false) === null) kernel.mkdir(`${RUNTIME_STORE}/${name}`, { mode: 0o755 });
      kernel.rename(from, to);
      moved.push(to);
    }
    if (kernel.readdir(nameDir).length === 0) kernel.rmdir(nameDir);
    else left = true;
  }
  if (!left && kernel.readdir(old).length === 0) {
    kernel.rmdir(old);
    kernel.symlink(`/${RUNTIME_STORE}`, old);
  }
  return moved;
}
