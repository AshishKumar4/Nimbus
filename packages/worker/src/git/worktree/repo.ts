/**
 * git/worktree/repo.ts — one repository as the worktree commands see it:
 * its object store, its worktree, its exclude rules and its index file.
 *
 * Objects go through cf-git (loose objects) and the ranged pack store the
 * repository's filesystem carries, and a command that writes many (add's
 * blobs) writes them in the shared wave writer's waves, straight into the
 * engine (objectWriter); the worktree through the command's view of the
 * namespace. Configuration is cf-git's reading of .git/config, and for
 * core.excludesFile the global files git reads as well.
 */

import { deflateSync } from 'node:zlib';

import type { WriteBatchStreamResult } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { createWaveWriter } from '@nimbus-sh/platform/wave-writer.js';

import type { ProjectFs } from '../../runtime/project-fs.js';
import type { GitPacksSeam } from '../pack/store.js';
import { DirCache, compareBytes, objectId, type IndexEdit } from './dircache.js';
import { Excludes, parsePatternList, type PatternList } from './excludes.js';
import { EMPTY_TREE, treeOf, type ObjectStore } from './tree.js';
import { matchStat, newCounters, worktreeBlobId, type WalkCounters, type Worktree, type WorktreeFs, type WorktreeStat, type WorktreeType } from './walk.js';

/** The cf-git calls a repository makes. */
export interface RepoGit {
  readObject(args: { fs: unknown; dir: string; oid: string; cache: object; format: 'content' }): Promise<{ type: string; object: unknown }>;
  writeObject(args: { fs: unknown; dir: string; type: 'blob' | 'tree' | 'commit'; object: Uint8Array; format: 'content' }): Promise<string>;
  getConfig(args: { fs: unknown; dir?: string; gitdir?: string; path: string }): Promise<unknown>;
  resolveRef(args: { fs: unknown; gitdir: string; ref: string }): Promise<string>;
}

/** createGitFs's adapter: cf-git's filesystem, with the repository's pack store. */
export interface GitFs {
  packs: GitPacksSeam;
  promises: Record<string, unknown> & { readFile(path: string, options?: unknown): Promise<Uint8Array | string> };
}

/**
 * The engine, as the command's principal: where a repository on it takes
 * objects in waves. `key` is a path's engine key (no leading slash), null on
 * a mount, which the engine's waves cannot reach.
 */
export interface ObjectEngine {
  key(path: string): Promise<string | null>;
  writeStream(stream: ReadableStream<Uint8Array>): Promise<WriteBatchStreamResult>;
}

/** Objects written by one command, in waves: each `write`'s object is there once `flush` has settled. */
export interface ObjectWriter {
  write(type: 'blob' | 'tree' | 'commit', data: Uint8Array): Promise<string>;
  flush(): Promise<void>;
}

/** git's core.looseCompression when unset: Z_BEST_SPEED. */
const LOOSE_COMPRESSION = 1;

/** ENOENT or ENOTDIR: the path is not there, which is an answer; anything else is a failure. */
function isAbsent(error: unknown): boolean {
  return isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR')
    || (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}

/** git_config_bool's spellings. */
export function configBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.toLowerCase();
  if (['true', 'yes', 'on', '1', ''].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return undefined;
}

/**
 * The index's lock, one per repository across the session's processes (git's
 * index.lock): a command that reads the index to change it holds it from the
 * read to the write, so two writers never write over each other.
 */
const indexLocks = new Map<string, Promise<void>>();

export class WorktreeRepo {
  /** This command holds its repository's index lock. */
  private locked = false;

  readonly store: ObjectStore;
  readonly fs: WorktreeFs;
  private readonly cache = {};
  private worktreeConfig: Worktree | null = null;

  /** `root` the worktree's top and `gitdir` its git directory, both absolute; `env` the command's. */
  constructor(
    readonly vfs: ProjectFs,
    readonly git: RepoGit,
    readonly gitFs: GitFs,
    readonly root: string,
    readonly gitdir: string,
    private readonly env: Record<string, string>,
    readonly counters: WalkCounters = newCounters(),
    private readonly engine: ObjectEngine | null = null,
  ) {
    const at = (path: string) => (path ? `${root}/${path}` : root);
    this.fs = {
      list: async (dir) => {
        let entries: Awaited<ReturnType<ProjectFs['readdir']>>;
        // Nothing there is no listing; any other failure (EACCES, EIO) is the caller's to report.
        try { entries = await vfs.readdir(at(dir)); } catch (error) { if (isAbsent(error)) return []; throw error; }
        const out: Array<{ name: string; type: WorktreeType }> = [];
        for (const { name, type } of entries) {
          if (type === 'file' || type === 'directory' || type === 'symlink') out.push({ name, type });
          else if (type === 'unknown') out.push({ name, type: (await this.fs.lstat(dir ? `${dir}/${name}` : name))?.type ?? 'other' });
          else out.push({ name, type: 'other' });
        }
        return out;
      },
      lstat: async (path) => {
        let st: Awaited<ReturnType<ProjectFs['lstat']>>;
        try { st = await vfs.lstat(at(path)); } catch (error) { if (isAbsent(error)) return null; throw error; }
        const type = st.type === 'file' || st.type === 'directory' || st.type === 'symlink' ? st.type : 'other';
        return {
          type, mode: st.mode, size: st.size, mtimeMs: st.mtime, ctimeMs: st.ctime,
          dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid,
        } satisfies WorktreeStat;
      },
      // Read once to be hashed or stored: past the content cache, which keeps the session's working set.
      readFile: async (path) => await vfs.readFileUncached(at(path)),
      readRange: async (path, offset, length) => await vfs.readRangeUncached(at(path), offset, length),
      readlink: async (path) => await vfs.readlink(at(path)),
    };
    const loose = (oid: string) => `${gitdir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    this.store = {
      // A loose object through cf-git; a packed one straight from the ranged store (a miss there costs no exception).
      read: async (oid) => {
        this.counters.objectsRead++;
        if (!await vfs.exists(loose(oid))) {
          const packed = await gitFs.packs.read(gitdir, oid);
          if (packed) return { type: packed.type, data: packed.data };
        }
        const { type, object } = await git.readObject({ fs: gitFs, dir: root, oid, cache: this.cache, format: 'content' });
        return { type, data: object as Uint8Array };
      },
      has: async (oid) => await vfs.exists(loose(oid)) || await gitFs.packs.has(gitdir, oid),
      write: async (type, data) => {
        const oid = objectId(type, data);
        if (await this.store.has(oid)) return oid;
        return await git.writeObject({ fs: gitFs, dir: root, type, object: data, format: 'content' });
      },
      prefetch: async (oids) => await gitFs.packs.prefetch(gitdir, oids),
    };
  }

  /**
   * A writer for the many objects one command writes (add's blobs): each is
   * hashed and, when the repository lacks it, deflated (git's loose
   * compression) and written as its loose object in the shared wave
   * writer's waves, straight into the engine: no write, existence check or
   * directory walk an object (as cf-git's took: 17 lookups and a write a
   * file, half of add -A's time at Linux's size). `flush` publishes what is
   * buffered: call it before writing what names the objects (the index). A
   * repository on a mount, which the waves cannot reach, has each object
   * written alone (store.write).
   */
  async objectWriter(): Promise<ObjectWriter> {
    const key = this.engine === null ? null : await this.engine.key(this.gitdir);
    if (this.engine === null || key === null) return { write: (type, data) => this.store.write(type, data), flush: async () => {} };
    const engine = this.engine;
    const waves = createWaveWriter({ supervisor: { writeBatchStream: (stream) => engine.writeStream(stream) }, root: key, mtimeMs: Date.now() });
    return {
      write: async (type, data) => {
        const oid = objectId(type, data);
        if (await this.store.has(oid)) return oid;
        const header = new TextEncoder().encode(`${type} ${data.length}\0`);
        const raw = new Uint8Array(header.length + data.length);
        raw.set(header);
        raw.set(data, header.length);
        // Copied out: deflateSync's result is a view of a 16 KiB buffer (measured, Bun and Node), and a
        // wave holds a thousand of them. Read-only, as git leaves a loose object.
        const loose = new Uint8Array(deflateSync(raw, { level: LOOSE_COMPRESSION }));
        await waves.file(`${key}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, 0o444, loose);
        return oid;
      },
      flush: () => waves.flush(),
    };
  }

  async config(path: string): Promise<unknown> {
    try { return await this.git.getConfig({ fs: this.gitFs, dir: this.root, path }); } catch { return undefined; }
  }

  /** The worktree with the settings its comparisons take. */
  async worktree(): Promise<Worktree> {
    this.worktreeConfig ??= {
      fs: this.fs,
      filemode: (await this.config('core.filemode')) !== false,
      autocrlf: (await this.config('core.autocrlf')) === 'true',
      counters: this.counters,
    };
    return this.worktreeConfig;
  }

  async readIndex(): Promise<DirCache> {
    return await DirCache.read(this.vfs, `${this.gitdir}/index`);
  }

  /** HEAD's tree, the empty tree while HEAD names no commit. */
  async headTree(): Promise<string> {
    let commit: string;
    try { commit = await this.git.resolveRef({ fs: this.gitFs, gitdir: this.gitdir, ref: 'HEAD' }); } catch { return EMPTY_TREE; }
    return await treeOf(this.store, commit);
  }

  /** A pattern file's list, or none when it cannot be read. */
  private async patternFile(path: string, base: string): Promise<PatternList> {
    try { return parsePatternList(await this.vfs.readFile(path), base); } catch { return []; }
  }

  /** A global config value: ~/.gitconfig over $XDG_CONFIG_HOME/git/config, as git reads them. */
  private async globalConfig(path: string): Promise<unknown> {
    const home = this.env.HOME;
    const xdg = this.env.XDG_CONFIG_HOME || (home ? `${home}/.config` : '');
    if (home) {
      // cf-git reads <gitdir>/config: the home file is offered under that name.
      const fake = `${home}/.gitconfig.nimbus`;
      const promises = { ...this.gitFs.promises, readFile: (file: string, options?: unknown) =>
        this.gitFs.promises.readFile(file === `${fake}/config` ? `${home}/.gitconfig` : file, options) };
      try {
        const value = await this.git.getConfig({ fs: { promises }, gitdir: fake, path });
        if (value !== undefined) return value;
      } catch { /* no such file */ }
    }
    if (xdg) {
      try { return await this.git.getConfig({ fs: this.gitFs, gitdir: `${xdg}/git`, path }); } catch { /* no such file */ }
    }
    return undefined;
  }

  /**
   * setup_standard_excludes: core.excludesFile (or $XDG_CONFIG_HOME/git/ignore,
   * else ~/.config/git/ignore), then $GIT_DIR/info/exclude, then each
   * directory's .gitignore. A .gitignore missing from a sparse worktree is
   * read from the index, as git reads a skip-worktree one.
   */
  async excludes(dc: DirCache): Promise<Excludes> {
    const home = this.env.HOME;
    const configured = await this.config('core.excludesfile') ?? await this.globalConfig('core.excludesfile');
    let file = typeof configured === 'string' ? configured : '';
    if (file.startsWith('~/') && home) file = `${home}${file.slice(1)}`;
    if (!file) {
      const xdg = this.env.XDG_CONFIG_HOME;
      file = xdg ? `${xdg}/git/ignore` : home ? `${home}/.config/git/ignore` : '';
    }
    const fileLists = [
      file ? await this.patternFile(normalizeVfsPath(file.startsWith('/') ? file : `${this.root}/${file}`), '') : [],
      await this.patternFile(`${this.gitdir}/info/exclude`, ''),
    ];
    return new Excludes(async (dir) => {
      const path = dir ? `${dir}/.gitignore` : '.gitignore';
      try {
        return await this.vfs.readFile(`${this.root}/${path}`);
      } catch {
        const i = dc.find(path);
        if (i < 0 || !dc.skipWorktree(i)) return null;
        return (await this.store.read(dc.oid(i))).data;
      }
    }, fileLists, configBool(await this.config('core.ignorecase')) === true);
  }

  /**
   * ce_smudge_racily_clean_entry for each entry this command never checked:
   * racily clean, its stat still matching, and its content no longer the blob.
   */
  private async racilySmudged(dc: DirCache, edit: IndexEdit): Promise<Set<number>> {
    const smudged = new Set<number>();
    const tree = await this.worktree();
    for (let i = 0; i < dc.count; i++) {
      if (dc.isUptodate(i) || !dc.isRacy(i) || dc.stage(i) !== 0 || dc.skipWorktree(i) || edit.removed?.has(i)) continue;
      const path = dc.path(i);
      let st: WorktreeStat | null;
      try { st = await this.fs.lstat(path); } catch { continue; }
      // Gone, unreadable, or already stat-dirty: the next look reads it anyway.
      if (st === null || matchStat(dc, i, st, tree.filemode) !== 0) continue;
      if (await worktreeBlobId(tree, path, st) !== dc.oid(i)) smudged.add(i);
    }
    return smudged;
  }

  /**
   * Run `fn` holding the repository's index lock: the index read in it is
   * the one its write replaces. A command that changes the index reads and
   * writes it in here; others wait their turn.
   */
  async withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) return await fn();
    const previous = indexLocks.get(this.gitdir) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    indexLocks.set(this.gitdir, tail);
    await previous;
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      release();
      if (indexLocks.get(this.gitdir) === tail) indexLocks.delete(this.gitdir);
    }
  }

  /** write_locked_index: `dc` with `edit` applied, its racily clean entries smudged. Only under the lock. */
  async writeIndex(dc: DirCache, edit: IndexEdit = {}): Promise<void> {
    if (!this.locked) throw new Error('internal error: the index is written only under its lock');
    const bytes = dc.encode(edit, await this.racilySmudged(dc, edit));
    await this.vfs.writeFile(`${this.gitdir}/index`, bytes);
  }

  /** The checksum the index file ends with now, null when there is none. */
  private async currentTrailer(): Promise<Uint8Array | null> {
    const path = `${this.gitdir}/index`;
    let size: number;
    try { size = (await this.vfs.lstat(path)).size; } catch (error) { if (isAbsent(error)) return null; throw error; }
    return size < 20 ? null : await this.vfs.readRangeUncached(path, size - 20, 20);
  }

  /**
   * repo_update_index_if_able: a status or diff, which read the index without
   * the lock, writes back what it refreshed (or an index with racy entries)
   * only if the index is still the one it read; a writer that came between
   * wins, and the refresh is simply not kept.
   */
  async updateIndexIfAble(dc: DirCache): Promise<void> {
    let racy = false;
    for (let i = 0; i < dc.count && !racy; i++) racy = dc.isRacy(i);
    if (!dc.refreshed && !dc.cacheTreeChanged && !racy) return;
    await this.withIndexLock(async () => {
      const now = await this.currentTrailer();
      const same = now === null || dc.trailer === null ? now === dc.trailer : compareBytes(now, dc.trailer) === 0;
      if (same) await this.writeIndex(dc);
    });
  }
}
