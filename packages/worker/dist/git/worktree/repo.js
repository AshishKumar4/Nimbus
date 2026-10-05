/**
 * git/worktree/repo.ts — one repository as the worktree commands see it:
 * its object store, its worktree, its exclude rules and its index file.
 *
 * Objects go through cf-git (loose objects) and the ranged pack store the
 * repository's filesystem carries; the worktree through the command's view
 * of the namespace. Configuration is cf-git's reading of .git/config, and
 * for core.excludesFile the global files git reads as well.
 */
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { DirCache, objectId } from './dircache.js';
import { Excludes, parsePatternList } from './excludes.js';
import { EMPTY_TREE, treeOf } from './tree.js';
import { matchStat, newCounters, worktreeBlobId } from './walk.js';
/** git_config_bool's spellings. */
export function configBool(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value !== 'string')
        return undefined;
    const text = value.toLowerCase();
    if (['true', 'yes', 'on', '1', ''].includes(text))
        return true;
    if (['false', 'no', 'off', '0'].includes(text))
        return false;
    return undefined;
}
export class WorktreeRepo {
    vfs;
    git;
    gitFs;
    root;
    gitdir;
    env;
    counters;
    store;
    fs;
    cache = {};
    worktreeConfig = null;
    /** `root` the worktree's top and `gitdir` its git directory, both absolute; `env` the command's. */
    constructor(vfs, git, gitFs, root, gitdir, env, counters = newCounters()) {
        this.vfs = vfs;
        this.git = git;
        this.gitFs = gitFs;
        this.root = root;
        this.gitdir = gitdir;
        this.env = env;
        this.counters = counters;
        const at = (path) => (path ? `${root}/${path}` : root);
        this.fs = {
            list: async (dir) => {
                let entries;
                try {
                    entries = await vfs.readdir(at(dir));
                }
                catch {
                    return [];
                }
                const out = [];
                for (const { name, type } of entries) {
                    if (type === 'file' || type === 'directory' || type === 'symlink')
                        out.push({ name, type });
                    else if (type === 'unknown')
                        out.push({ name, type: (await this.fs.lstat(dir ? `${dir}/${name}` : name))?.type ?? 'other' });
                    else
                        out.push({ name, type: 'other' });
                }
                return out;
            },
            lstat: async (path) => {
                let st;
                try {
                    st = await vfs.lstat(at(path));
                }
                catch {
                    return null;
                }
                const type = st.type === 'file' || st.type === 'directory' || st.type === 'symlink' ? st.type : 'other';
                return {
                    type, mode: st.mode, size: st.size, mtimeMs: st.mtime, ctimeMs: st.ctime,
                    dev: st.dev, ino: st.ino, uid: st.uid, gid: st.gid,
                };
            },
            // Read once to be hashed or stored: past the content cache, which keeps the session's working set.
            readFile: async (path) => await vfs.readFileUncached(at(path)),
            readRange: async (path, offset, length) => await vfs.readRangeUncached(at(path), offset, length),
            readlink: async (path) => await vfs.readlink(at(path)),
        };
        const loose = (oid) => `${gitdir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
        this.store = {
            // A loose object through cf-git; a packed one straight from the ranged store (a miss there costs no exception).
            read: async (oid) => {
                this.counters.objectsRead++;
                if (!await vfs.exists(loose(oid))) {
                    const packed = await gitFs.packs.read(gitdir, oid);
                    if (packed)
                        return { type: packed.type, data: packed.data };
                }
                const { type, object } = await git.readObject({ fs: gitFs, dir: root, oid, cache: this.cache, format: 'content' });
                return { type, data: object };
            },
            has: async (oid) => await vfs.exists(loose(oid)) || await gitFs.packs.has(gitdir, oid),
            write: async (type, data) => {
                const oid = objectId(type, data);
                if (await this.store.has(oid))
                    return oid;
                return await git.writeObject({ fs: gitFs, dir: root, type, object: data, format: 'content' });
            },
            prefetch: async (oids) => await gitFs.packs.prefetch(gitdir, oids),
        };
    }
    async config(path) {
        try {
            return await this.git.getConfig({ fs: this.gitFs, dir: this.root, path });
        }
        catch {
            return undefined;
        }
    }
    /** The worktree with the settings its comparisons take. */
    async worktree() {
        this.worktreeConfig ??= {
            fs: this.fs,
            filemode: (await this.config('core.filemode')) !== false,
            autocrlf: (await this.config('core.autocrlf')) === 'true',
            counters: this.counters,
        };
        return this.worktreeConfig;
    }
    async readIndex() {
        return await DirCache.read(this.vfs, `${this.gitdir}/index`);
    }
    /** HEAD's tree, the empty tree while HEAD names no commit. */
    async headTree() {
        let commit;
        try {
            commit = await this.git.resolveRef({ fs: this.gitFs, gitdir: this.gitdir, ref: 'HEAD' });
        }
        catch {
            return EMPTY_TREE;
        }
        return await treeOf(this.store, commit);
    }
    /** A pattern file's list, or none when it cannot be read. */
    async patternFile(path, base) {
        try {
            return parsePatternList(await this.vfs.readFile(path), base);
        }
        catch {
            return [];
        }
    }
    /** A global config value: ~/.gitconfig over $XDG_CONFIG_HOME/git/config, as git reads them. */
    async globalConfig(path) {
        const home = this.env.HOME;
        const xdg = this.env.XDG_CONFIG_HOME || (home ? `${home}/.config` : '');
        if (home) {
            // cf-git reads <gitdir>/config: the home file is offered under that name.
            const fake = `${home}/.gitconfig.nimbus`;
            const promises = { ...this.gitFs.promises, readFile: (file, options) => this.gitFs.promises.readFile(file === `${fake}/config` ? `${home}/.gitconfig` : file, options) };
            try {
                const value = await this.git.getConfig({ fs: { promises }, gitdir: fake, path });
                if (value !== undefined)
                    return value;
            }
            catch { /* no such file */ }
        }
        if (xdg) {
            try {
                return await this.git.getConfig({ fs: this.gitFs, gitdir: `${xdg}/git`, path });
            }
            catch { /* no such file */ }
        }
        return undefined;
    }
    /**
     * setup_standard_excludes: core.excludesFile (or $XDG_CONFIG_HOME/git/ignore,
     * else ~/.config/git/ignore), then $GIT_DIR/info/exclude, then each
     * directory's .gitignore. A .gitignore missing from a sparse worktree is
     * read from the index, as git reads a skip-worktree one.
     */
    async excludes(dc) {
        const home = this.env.HOME;
        const configured = await this.config('core.excludesfile') ?? await this.globalConfig('core.excludesfile');
        let file = typeof configured === 'string' ? configured : '';
        if (file.startsWith('~/') && home)
            file = `${home}${file.slice(1)}`;
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
            }
            catch {
                const i = dc.find(path);
                if (i < 0 || !dc.skipWorktree(i))
                    return null;
                return (await this.store.read(dc.oid(i))).data;
            }
        }, fileLists);
    }
    /**
     * ce_smudge_racily_clean_entry for each entry this command never checked:
     * racily clean, its stat still matching, and its content no longer the blob.
     */
    async racilySmudged(dc, edit) {
        const smudged = new Set();
        const tree = await this.worktree();
        for (let i = 0; i < dc.count; i++) {
            if (dc.isUptodate(i) || !dc.isRacy(i) || dc.stage(i) !== 0 || dc.skipWorktree(i) || edit.removed?.has(i))
                continue;
            const path = dc.path(i);
            const st = await this.fs.lstat(path);
            // Gone, or already stat-dirty: the next look reads it anyway.
            if (st === null || matchStat(dc, i, st, tree.filemode) !== 0)
                continue;
            if (await worktreeBlobId(tree, path, st) !== dc.oid(i))
                smudged.add(i);
        }
        return smudged;
    }
    /** write_locked_index: `dc` with `edit` applied, its racily clean entries smudged. */
    async writeIndex(dc, edit = {}) {
        const bytes = dc.encode(edit, await this.racilySmudged(dc, edit));
        await this.vfs.writeFile(`${this.gitdir}/index`, bytes);
    }
    /** repo_update_index_if_able: a status or diff writes back what it refreshed, or an index with racy entries. */
    async updateIndexIfAble(dc) {
        let racy = false;
        for (let i = 0; i < dc.count && !racy; i++)
            racy = dc.isRacy(i);
        if (dc.refreshed || dc.cacheTreeChanged || racy)
            await this.writeIndex(dc);
    }
}
