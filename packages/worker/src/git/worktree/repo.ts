/**
 * git/worktree/repo.ts — one repository as the worktree commands see it:
 * its object store, its worktree, its exclude rules and its index file.
 *
 * Objects are read through cf-git (loose objects) and the ranged pack store
 * the repository's filesystem carries, and written as git writes a loose
 * object, by one flow (objectWriter): one at a time, or for a command that
 * writes many (add's blobs) in the shared wave writer's waves, straight into
 * the engine. The worktree goes through the command's view of the
 * namespace. Configuration is cf-git's reading of .git/config, with the
 * global files and command overrides supplied by the command.
 */

import { deflateSync } from 'node:zlib';

import type { WriteBatchStreamResult } from '@nimbus-sh/core/runtime/wave-contracts.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { createWaveWriter } from '@nimbus-sh/platform/wave-writer.js';
import { concatBytes } from '@nimbus-sh/core/_shared/bytes.js';

import type { ProjectFs } from '../../runtime/project-fs.js';
import type { GitPacksSeam } from '../pack/store.js';
import { objectIdPrefix, type GitObjectType } from '../pack/format.js';
import { coneMatcher, parseConeSparseCheckout, type SparseMatcher } from '../pack/sparse.js';
import { DirCache, compareBytes, objectId, type IndexEdit } from './dircache.js';
import { Excludes, parsePatternList, type PatternList } from './excludes.js';
import { EMPTY_TREE, treeOf, type ObjectStore } from './tree.js';
import { UnsupportedGitOperation } from '../routing.js';
import { DEFAULT_PATH_PROTECTION, type PathProtection } from './verify-path.js';
import { configBool } from '../config-params.js';
import { matchStat, newCounters, worktreeBlobId, type WalkCounters, type Worktree, type WorktreeFs, type WorktreeStat, type WorktreeType } from './walk.js';

/** The cf-git calls a repository makes. */
export interface RepoGit {
  readObject(args: { fs: unknown; dir: string; oid: string; cache: object; format: 'content' }): Promise<{ type: string; object: unknown }>;
  getConfig(args: { fs: unknown; dir?: string; gitdir?: string; path: string }): Promise<unknown>;
  setConfig(args: { fs: unknown; gitdir: string; path: string; value: unknown }): Promise<unknown>;
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

/** Objects written by one command: each `write`'s object is there once `flush` has settled. */
export interface ObjectWriter {
  write(type: 'blob' | 'tree' | 'commit' | 'tag', data: Uint8Array): Promise<string>;
  flush(): Promise<void>;
}

/** git's core.looseCompression when unset: Z_BEST_SPEED. */
const LOOSE_COMPRESSION = 1;
/** A loose object's mode: read-only, as git leaves one. */
const LOOSE_MODE = 0o444;

/** The loose object's bytes for `type` and `data`: its header and content, deflated at git's loose compression. */
function looseBytes(type: GitObjectType, data: Uint8Array): Uint8Array {
  const raw = concatBytes([objectIdPrefix(type, data.length), data]);
  // Copied out: deflateSync's result is a view of a 16 KiB buffer (measured, Bun and Node).
  return new Uint8Array(deflateSync(raw, { level: LOOSE_COMPRESSION }));
}

/** Where one command's loose objects go: a file at a time, or in waves. */
interface ObjectSink {
  /** Write `bytes` as object `oid`'s loose file. */
  put(oid: string, bytes: Uint8Array): Promise<void>;
  /** Whether `oid` was put and is not published yet (only waves hold objects back). */
  pending(oid: string): boolean;
  flush(): Promise<void>;
}

/** ENOENT or ENOTDIR: the path is not there, which is an answer; anything else is a failure. */
function isAbsent(error: unknown): boolean {
  return isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR')
    || (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
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
  private indexWritten = false;
  private preparedIndex: DirCache | null = null;

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
      write: async (type, data) => await this.writeObject(this.singleSink(), type, data),
      prefetch: async (oids) => await gitFs.packs.prefetch(gitdir, oids),
    };
  }

  /**
   * The one flow every object is written by: hashed, and, when the
   * repository lacks it (and `sink` holds it back for no wave), its loose
   * bytes put into `sink`.
   */
  private async writeObject(sink: ObjectSink, type: GitObjectType, data: Uint8Array): Promise<string> {
    const oid = objectId(type, data);
    if (sink.pending(oid) || await this.store.has(oid)) return oid;
    await sink.put(oid, looseBytes(type, data));
    return oid;
  }

  /** Each object written as it comes, through the command's view (which follows links into mounts). */
  private singleSink(): ObjectSink {
    return {
      put: async (oid, bytes) => {
        const dir = `${this.gitdir}/objects/${oid.slice(0, 2)}`;
        await this.vfs.mkdir(dir, { recursive: true });
        const path = `${dir}/${oid.slice(2)}`;
        await this.vfs.writeFile(path, bytes, { mode: LOOSE_MODE });
        await this.vfs.chmod(path, LOOSE_MODE);
      },
      pending: () => false,
      flush: async () => {},
    };
  }

  /**
   * A writer for the many objects one command writes (add's blobs): in the
   * shared wave writer's waves, straight into the engine, with no write,
   * existence check or directory walk an object (as cf-git's took: 17
   * lookups and a write a file, half of add -A's time at Linux's size).
   * `flush` publishes what is buffered: call it before writing what names
   * the objects (the index). An object put but not yet published is not put
   * again. The waves go to the objects directory where it really is (a
   * linked .git or objects resolved), and publish nothing above it; one
   * holding a link of its own, or on a mount the waves cannot reach, has
   * its objects written one at a time.
   */
  async objectWriter(): Promise<ObjectWriter> {
    const sink = await this.waveSink() ?? this.singleSink();
    return { write: (type, data) => this.writeObject(sink, type, data), flush: () => sink.flush() };
  }

  private async waveSink(): Promise<ObjectSink | null> {
    if (this.engine === null) return null;
    const objects = `${this.gitdir}/objects`;
    const key = await this.engine.key(objects);
    if (key === null) return null;
    // A link below the objects directory (a fan-out directory linked away) is the view's to follow.
    let entries: Awaited<ReturnType<ProjectFs['readdir']>> = [];
    try { entries = await this.vfs.readdir(objects); } catch (error) { if (!isAbsent(error)) throw error; }
    if (entries.some(({ type }) => type === 'symlink')) return null;
    const engine = this.engine;
    const inWaves = new Set<string>();
    const waves = createWaveWriter({
      supervisor: { writeBatchStream: (stream) => engine.writeStream(stream) },
      root: key,
      mtimeMs: Date.now(),
      // Published: there for store.has, and no longer held here.
      onWave: ({ receipts }) => {
        for (const { path } of receipts) inWaves.delete(path.slice(-41, -39) + path.slice(-38));
      },
    });
    return {
      put: async (oid, bytes) => {
        inWaves.add(oid);
        await waves.file(`${key}/${oid.slice(0, 2)}/${oid.slice(2)}`, LOOSE_MODE, bytes);
      },
      pending: (oid) => inWaves.has(oid),
      flush: () => waves.flush(),
    };
  }

  async config(path: string): Promise<unknown> {
    return await this.git.getConfig({ fs: this.gitFs, dir: this.root, path });
  }

  /**
   * cf-git's filesystem with the config file `file` offered as
   * `<gitdir>/config` of the answered gitdir: cf-git reads and writes only
   * that name.
   */
  private configFile(file: string): { fs: unknown; gitdir: string } {
    const fake = `${file}.nimbus`;
    const own = (name: string) => (name === `${fake}/config` ? file : name);
    const base = this.gitFs.promises as Record<string, (...args: unknown[]) => unknown>;
    const promises = {
      ...this.gitFs.promises,
      readFile: (name: string, ...rest: unknown[]) => base.readFile(own(name), ...rest),
      writeFile: (name: string, ...rest: unknown[]) => base.writeFile(own(name), ...rest),
    };
    return { fs: { promises }, gitdir: fake };
  }

  /**
   * init_worktree_config: extensions.worktreeConfig set, core.bare (when
   * true) and core.worktree moved from config to config.worktree, unless
   * the extension is set already.
   */
  async initWorktreeConfig(): Promise<void> {
    if (configBool(await this.config('extensions.worktreeConfig')) === true) return;
    await this.git.setConfig({ fs: this.gitFs, gitdir: this.gitdir, path: 'extensions.worktreeConfig', value: 'true' });
    const worktreeFile = this.configFile(`${this.gitdir}/config.worktree`);
    if (configBool(await this.config('core.bare')) === true) {
      await this.git.setConfig({ ...worktreeFile, path: 'core.bare', value: 'true' });
      await this.git.setConfig({ fs: this.gitFs, gitdir: this.gitdir, path: 'core.bare', value: undefined });
    }
    const worktree = await this.config('core.worktree');
    if (typeof worktree === 'string') {
      await this.git.setConfig({ ...worktreeFile, path: 'core.worktree', value: worktree });
      await this.git.setConfig({ fs: this.gitFs, gitdir: this.gitdir, path: 'core.worktree', value: undefined });
    }
  }

  /** repo_config_set_worktree_gently: `path` in config.worktree (the extension being set). */
  async setWorktreeSetting(path: string, value: string): Promise<void> {
    await this.git.setConfig({ ...this.configFile(`${this.gitdir}/config.worktree`), path, value });
  }

  /** core.sparseCheckout: whether the worktree is a sparse checkout. */
  async isSparse(): Promise<boolean> {
    return configBool(await this.config('core.sparseCheckout')) === true;
  }

  /**
   * The sparse checkout this worktree holds, or null for none: core.sparseCheckout,
   * in cone mode (core.sparseCheckoutCone), its cone read from
   * info/sparse-checkout and its paths compared as core.ignoreCase says. A
   * sparse checkout that is not cone mode is refused: its patterns are not
   * read here.
   */
  async sparseMatcher(): Promise<SparseMatcher | null> {
    if (!await this.isSparse()) return null;
    let patterns = '';
    try {
      patterns = new TextDecoder().decode(await this.vfs.readFile(`${this.gitdir}/info/sparse-checkout`));
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
    const cone = configBool(await this.config('core.sparseCheckoutCone')) === true ? parseConeSparseCheckout(patterns) : null;
    if (cone === null) throw new Error('fatal: a sparse checkout without cone mode is not supported');
    return coneMatcher(cone, configBool(await this.config('core.ignorecase')) === true);
  }

  /** core.protectHFS and core.protectNTFS as the command's config reads them (-c, the repository's, the global), else git's defaults (verify-path.ts). */
  async pathProtection(): Promise<PathProtection> {
    const setting = async (key: string) => configBool(await this.config(key));
    return {
      hfs: await setting('core.protecthfs') ?? DEFAULT_PATH_PROTECTION.hfs,
      ntfs: await setting('core.protectntfs') ?? DEFAULT_PATH_PROTECTION.ntfs,
    };
  }

  /** The worktree with the settings its comparisons take. */
  async worktree(): Promise<Worktree> {
    this.worktreeConfig ??= {
      fs: this.fs,
      filemode: configBool(await this.config('core.filemode')) !== false,
      autocrlf: configBool(await this.config('core.autocrlf')) === true,
      counters: this.counters,
    };
    return this.worktreeConfig;
  }

  /** The index, as git's repo_read_index leaves it: see clearPresentSkips. */
  async readIndex(): Promise<DirCache> {
    const dc = this.preparedIndex ?? await DirCache.read(this.vfs, `${this.gitdir}/index${this.indexWritten ? '.lock' : ''}`);
    this.preparedIndex = null;
    if (dc.hasSkipWorktree()) await this.clearPresentSkips(dc);
    return dc;
  }

  /** Capability is checked before branch creation, staging, fetch or checkout. Reuse the index read there. */
  async prepare(): Promise<void> {
    if (await this.isSparse()) {
      if (configBool(await this.config('core.sparseCheckoutCone')) !== true) {
        throw new UnsupportedGitOperation('fatal: a sparse checkout without cone mode is not supported\n', 128);
      }
      let patterns = '';
      try { patterns = new TextDecoder().decode(await this.vfs.readFile(`${this.gitdir}/info/sparse-checkout`)); }
      catch (error) { if (!isAbsent(error)) throw error; }
      if (parseConeSparseCheckout(patterns) === null) {
        throw new UnsupportedGitOperation('fatal: a sparse checkout without cone mode is not supported\n', 128);
      }
    }
    this.preparedIndex = await DirCache.read(this.vfs, `${this.gitdir}/index`);
  }

  /**
   * clear_skip_worktree_from_present_files, as git does on every index read:
   * in a sparse checkout (but with sparse.expectFilesOutsideOfPatterns), a
   * skip-worktree entry whose path the worktree holds (anything there) is
   * skip-worktree no longer, so what is there is compared, staged and
   * protected as a tracked file is. A directory found missing is remembered,
   * and nothing below it looked at (path_found).
   */
  private async clearPresentSkips(dc: DirCache): Promise<void> {
    if (!await this.isSparse()) return;
    if (configBool(await this.config('sparse.expectFilesOutsideOfPatterns')) === true) return;
    let missing = '';
    for (let i = 0; i < dc.count; i++) {
      if (!dc.skipWorktree(i)) continue;
      const path = dc.path(i);
      if (missing && path.startsWith(missing)) continue;
      if (await this.fs.lstat(path) !== null) dc.setSkipWorktree(i, false);
      else missing = await this.missingDirectory(path, missing);
    }
  }

  /**
   * path_found's remembered directory for a `path` the worktree lacks: the
   * top-most of its directories the worktree lacks, with its slash, or
   * `path/` when it has them all. The directories `path` shares with the one
   * missing before (`known`) are there and not looked at again. A directory
   * is there as lstat("dir/") finds it: a link to one is.
   */
  private async missingDirectory(path: string, known: string): Promise<string> {
    let at = 0;
    for (let i = 0; i < Math.min(path.length, known.length) && path[i] === known[i]; i++) if (path[i] === '/') at = i + 1;
    for (;;) {
      const slash = path.indexOf('/', at);
      if (slash < 0) return `${path}/`;
      at = slash + 1;
      if (!await this.isDirectory(path.slice(0, slash))) return path.slice(0, at);
    }
  }

  /** Whether the worktree's `path` is a directory, a link to one followed. */
  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await this.vfs.stat(`${this.root}/${path}`)).type === 'directory';
    } catch (error) {
      if (isAbsent(error) || isVfsError(error, 'ELOOP')) return false;
      throw error;
    }
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

  /**
   * setup_standard_excludes: core.excludesFile (or $XDG_CONFIG_HOME/git/ignore,
   * else ~/.config/git/ignore), then $GIT_DIR/info/exclude, then each
   * directory's .gitignore. A .gitignore missing from a sparse worktree is
   * read from the index, as git reads a skip-worktree one.
   */
  async excludes(dc: DirCache): Promise<Excludes> {
    const home = this.env.HOME;
    const configured = await this.config('core.excludesfile');
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
    const lock = `${this.gitdir}/index.lock`;
    let acquired = false;
    try {
      await this.vfs.writeFile(lock, new Uint8Array(0), { exclusive: true });
      acquired = true;
      this.locked = true;
      // The unlocked preparation may have preceded another writer.
      if (this.preparedIndex !== null) {
        const now = await this.currentTrailer();
        const before = this.preparedIndex.trailer;
        if (now === null || before === null ? now !== before : compareBytes(now, before) !== 0) this.preparedIndex = null;
      }
      const result = await fn();
      if (this.indexWritten) {
        await this.vfs.rename(lock, `${this.gitdir}/index`);
        acquired = false;
      }
      return result;
    } finally {
      this.locked = false;
      this.indexWritten = false;
      try { if (acquired) await this.vfs.unlink(lock); }
      finally {
        release();
        if (indexLocks.get(this.gitdir) === tail) indexLocks.delete(this.gitdir);
      }
    }
  }

  /** write_locked_index: `dc` with `edit` applied, its racily clean entries smudged. Only under the lock. */
  async writeIndex(dc: DirCache, edit: IndexEdit = {}): Promise<void> {
    if (!this.locked) throw new Error('internal error: the index is written only under its lock');
    const bytes = dc.encode(edit, await this.racilySmudged(dc, edit));
    await this.vfs.writeFile(`${this.gitdir}/index.lock`, bytes);
    this.preparedIndex = null;
    this.indexWritten = true;
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
   * wins, and the refresh is simply not kept. Nor is it where writing it
   * would run a hook (`hooked`): git runs post-index-change for every index
   * it writes, and the built-in runs none.
   */
  async updateIndexIfAble(dc: DirCache, hooked: () => Promise<boolean>): Promise<void> {
    let racy = false;
    for (let i = 0; i < dc.count && !racy; i++) racy = dc.isRacy(i);
    if (!dc.refreshed && !dc.cacheTreeChanged && !racy) return;
    if (await hooked()) return;
    try {
      await this.withIndexLock(async () => {
        const now = await this.currentTrailer();
        const same = now === null || dc.trailer === null ? now === dc.trailer : compareBytes(now, dc.trailer) === 0;
        if (same) await this.writeIndex(dc);
      });
    } catch (error) {
      if (!isVfsError(error, 'EEXIST')) throw error;
    }
  }
}
