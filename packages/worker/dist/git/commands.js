/**
 * git/commands.ts — Nimbus v2.0 Git integration via isomorphic-git.
 *
 * Provides a full `git` command with subcommands:
 * init, clone, status, add, commit, log, branch, checkout, diff,
 * ls-files, rev-parse, remote, fetch, pull, push, merge, reset, tag
 *
 * Uses a VFS→isomorphic-git FS adapter over the command's view of the
 * namespace, as its credential: a repository on SQLite or on a mount alike.
 */
import { ISOLATE_NETWORK } from '@nimbus-sh/core/_shared/workspace-network.js';
import { engineKey } from '@nimbus-sh/core/runtime/process-files.js';
import { projectFs } from '../runtime/project-fs.js';
import { execGitNetwork, GIT_CLONE_JOB_MARKER } from './network-facet.js';
import { packsSeam } from './pack/store.js';
import { fetchMissingObjects } from './promisor.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { dec, enc } from '@nimbus-sh/core/_shared/bytes.js';
import { DEFAULT_CONTEXT, DEFAULT_RENAME_SCORE, absentSpec, binaryPath, bytesFromBinary, detectRenames, formatNameOnly, formatNameStatus, formatPatch, formatStat, parseRenameScore, pathLine, statFile, StatList, } from './unified-diff.js';
import { CheckoutRefused, UnmergedIndex, switchTrees } from './worktree/checkout.js';
import { DirCache, NewEntries, comparePaths } from './worktree/dircache.js';
import { isValidRefName } from './worktree/refname.js';
import { PairList } from './worktree/pairs.js';
import { WorktreeRepo, configBool } from './worktree/repo.js';
import { collectStatus, inSpecs, shortStatusLines, walkTreeAndIndex } from './worktree/status.js';
import { EMPTY_TREE, treeLeaves, treeOf, writeTreeFromIndex } from './worktree/tree.js';
import { DirtySet, modeFromStat, newCounters, scanWorktree, worktreeBlob, worktreeBlobId, } from './worktree/walk.js';
// ── Lazy-loaded isomorphic-git (avoid ~1MB load on every cold start) ────
// NOTE: local git ops (init, status, add, commit, log, branch, checkout,
// diff, ls-files, rev-parse, remote, merge, reset, tag, config) run here in the supervisor DO.
// Network ops (clone, fetch, pull) are delegated to the git-network-facet
// because the supervisor's CPU budget cannot handle packfile processing
// for real-world repos (>100 files).
let _git = null;
async function getGit() {
    if (!_git) {
        // Same patched build artifact used by the network facet. A fresh npm
        // consumer does not run Nimbus' repository dependency-patching hook.
        _git = (await import('../../vendor/git.generated.mjs')).git;
    }
    return _git;
}
// ── VFS→isomorphic-git FS adapter ───────────────────────────────────────
/**
 * `fs.promises.readFile` takes its encoding either bare or on an options
 * object, and cf-git uses both spellings — `fs.read(path, 'utf8')` for
 * .gitignore, .git/info/exclude and the stash reflog, the object form
 * everywhere else. An adapter that honours only the object form hands
 * those call sites bytes where they asked for text, and cf-git feeds the
 * result straight to `ignore().add()`, which silently accepts only
 * strings — so every .gitignore rule became a no-op.
 */
function wantsUtf8(options) {
    const encoding = typeof options === 'string'
        ? options
        : options?.encoding;
    return encoding === 'utf8' || encoding === 'utf-8';
}
/**
 * Creates an isomorphic-git compatible `fs` object over the repository's
 * filesystem. isomorphic-git requires: readFile, writeFile, unlink,
 * readdir, mkdir, rmdir, stat, lstat (all as promises).
 *
 * With a `worktree`, the adapter writes that worktree the way git's checkout
 * does (entry.c create_directories, has_symlink_leading_path): below its top,
 * `.git` aside, every leading component is lstat'd, and one that is not a real
 * directory (a link, dangling or not, or a file) is replaced by one rather than
 * followed, and a file replaces a link at its own path instead of writing
 * through it. Components above the top are followed, as git follows them.
 * Commands that only read the worktree or write `.git` pass no worktree.
 */
function createGitFs(vfs, worktree = null, promisor) {
    // Path normalization is shared with esbuild-service via @nimbus-sh/core/vfs/path.js.
    // isomorphic-git constructs paths like `dir + '/' + filepath` which can
    // produce `/home/user/project/.` or paths with `..` segments — those are
    // collapsed before VFS lookup. The bounded `..` pop won't escape root.
    const normalizePath = normalizeVfsPath;
    const top = worktree === null ? null : normalizePath(worktree);
    const below = top ? `${top}/` : '';
    const gitdir = `${below}.git`;
    async function lstatOrNull(p) {
        try {
            return await vfs.lstat(p);
        }
        catch {
            return null;
        }
    }
    /** A path git's checkout owns: inside the worktree, not its top, not in its .git. */
    function checkedOut(p) {
        return top !== null && p.startsWith(below) && p !== gitdir && !p.startsWith(`${gitdir}/`);
    }
    /** `p`'s directories, down to `p` itself when `self`; see createGitFs for the worktree's rule. */
    async function ensureDirectories(p, self) {
        const parts = p.split('/');
        for (let i = 1; i <= (self ? parts.length : parts.length - 1); i++) {
            const dir = parts.slice(0, i).join('/');
            if (!dir)
                continue;
            if (!checkedOut(dir)) {
                if (!await vfs.exists(dir))
                    await vfs.mkdir(dir, { recursive: true });
                continue;
            }
            const st = await lstatOrNull(dir);
            if (st?.type === 'directory')
                continue;
            if (st)
                await vfs.unlink(dir);
            await vfs.mkdir(dir);
        }
    }
    // The inode as Node's fs.Stats: git's stat cache compares ctime, ino, uid and gid too.
    async function statsOf(filepath, follow) {
        const p = normalizePath(filepath);
        let st;
        if (!p) {
            const now = Date.now();
            st = { dev: 0, ino: 0, nlink: 1, type: 'directory', size: 0, atime: now, ctime: now, mtime: now, mode: 0o755, uid: 0, gid: 0 };
        }
        else {
            try {
                st = await (follow ? vfs.stat(p) : vfs.lstat(p));
            }
            catch {
                const err = new Error(`ENOENT: no such file or directory, ${follow ? 'stat' : 'lstat'} '${filepath}'`);
                err.code = 'ENOENT';
                err.errno = -2;
                throw err;
            }
        }
        const isDir = st.type === 'directory';
        const isLink = st.type === 'symlink';
        return {
            isFile: () => st.type === 'file',
            isDirectory: () => isDir,
            isSymbolicLink: () => isLink,
            size: st.size,
            mode: (isLink ? 0o120000 : isDir ? 0o040000 : 0o100000) | (st.mode & 0o7777),
            mtimeMs: st.mtime, mtime: new Date(st.mtime),
            ctimeMs: st.ctime, ctime: new Date(st.ctime),
            atimeMs: st.atime, atime: new Date(st.atime),
            uid: st.uid, gid: st.gid, dev: st.dev, ino: st.ino, nlink: st.nlink,
            type: isDir ? 'dir' : isLink ? 'symlink' : 'file',
        };
    }
    return {
        // Packed objects are read by range, never a whole pack (git/pack/store.ts).
        packs: packsSeam({
            readRange: async (path, offset, length) => await vfs.readRangeUncached(normalizePath(path), offset, length),
            readdir: async (dir) => {
                try {
                    return (await vfs.readdir(normalizePath(dir))).map((entry) => entry.name);
                }
                catch {
                    return [];
                }
            },
        }, { promisor }),
        promises: {
            async readFile(filepath, opts) {
                const p = normalizePath(filepath);
                let data;
                try {
                    data = await vfs.readFile(p);
                }
                catch {
                    const err = new Error(`ENOENT: no such file or directory, open '${filepath}'`);
                    err.code = 'ENOENT';
                    err.errno = -2;
                    throw err;
                }
                if (wantsUtf8(opts))
                    return dec.decode(data);
                return data;
            },
            async writeFile(filepath, data, opts) {
                const p = normalizePath(filepath);
                await ensureDirectories(p, false);
                // A file replaces a link or a directory at its own path (entry.c checkout_entry, remove_subtree).
                const existing = checkedOut(p) ? (await lstatOrNull(p))?.type : undefined;
                if (existing === 'symlink')
                    await vfs.unlink(p);
                else if (existing === 'directory')
                    await vfs.removeRecursive(p);
                if (typeof data === 'string') {
                    await vfs.writeFile(p, data);
                }
                else {
                    await vfs.writeFile(p, data instanceof Uint8Array ? data : new Uint8Array(data));
                }
            },
            async unlink(filepath) {
                const p = normalizePath(filepath);
                if (await lstatOrNull(p))
                    await vfs.unlink(p);
            },
            async readdir(filepath) {
                const p = normalizePath(filepath);
                if (!p)
                    return []; // root level — not typically needed by isomorphic-git
                if (!await vfs.exists(p))
                    return [];
                return (await vfs.readdir(p)).map(e => e.name);
            },
            async mkdir(filepath, opts) {
                await ensureDirectories(normalizePath(filepath), true);
            },
            async rmdir(filepath) {
                const p = normalizePath(filepath);
                const st = await lstatOrNull(p);
                if (!st)
                    return;
                // rmdir(2) of a link is ENOTDIR: it never removes the directory the link names.
                if (st.type !== 'directory') {
                    throw Object.assign(new Error(`ENOTDIR: not a directory, rmdir '${filepath}'`), { code: 'ENOTDIR', errno: -20 });
                }
                await vfs.rmdir(p);
            },
            async stat(filepath) {
                return statsOf(filepath, true);
            },
            async lstat(filepath) {
                return statsOf(filepath, false);
            },
            async chmod() { },
            async symlink(target, filepath) {
                const p = normalizePath(filepath);
                await ensureDirectories(p, false);
                // Checkout retargets a link in place, as the clone facet's adapter does.
                const st = await lstatOrNull(p);
                if (st?.type === 'directory' && checkedOut(p))
                    await vfs.removeRecursive(p);
                else if (st && st.type !== 'directory')
                    await vfs.unlink(p);
                await vfs.symlink(target, p);
            },
            async readlink(filepath) {
                return vfs.readlink(normalizePath(filepath));
            },
        },
    };
}
function getDir(ctx) {
    return '/' + (ctx.cwd || '/home/user').replace(/^\/+/, '');
}
/**
 * The options git accepts BEFORE the subcommand. `-C <path>` runs the
 * command as if started from <path>; repeated, each is relative to the
 * previous (`git -C a -C b` runs in `a/b`). `--no-pager` and `-P` are
 * accepted and mean nothing here, there is no pager. Any other leading
 * option is refused: swallowing it would run the next word as a subcommand.
 */
export function parseGitGlobals(args, cwd) {
    let dir = cwd;
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-C') {
            const path = args[++i];
            if (path === undefined)
                throw new Error("option '-C' requires a value");
            dir = path.startsWith('/') ? path : dir + '/' + path;
            dir = '/' + dir.split('/').filter((seg) => seg && seg !== '.').join('/');
        }
        else if (arg.startsWith('-C') && arg.length > 2) {
            const path = arg.slice(2);
            dir = path.startsWith('/') ? path : dir + '/' + path;
            dir = '/' + dir.split('/').filter((seg) => seg && seg !== '.').join('/');
        }
        else if (arg === '--no-pager' || arg === '-P') {
            // no pager to disable
        }
        else if (arg.startsWith('-') && arg !== '--version' && arg !== '-v' && arg !== '--help' && arg !== '-h') {
            throw new Error(`unknown option '${arg}'\nusage: git [-C <path>] [--no-pager] <command> [<args>]`);
        }
        else {
            break;
        }
    }
    return { sub: args[i], subArgs: args.slice(i + 1), dir };
}
function getFlag(args, flag) {
    const idx = args.indexOf(flag);
    if (idx >= 0)
        return args[idx + 1] || undefined;
    const prefix = `${flag}=`;
    return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || undefined;
}
export const CLONE_USAGE = 'usage: git clone [-q | --quiet] [--depth <n>] [--no-shallow] [--filter=<spec>] [--branch <name> | -b <name>] [--bg] <url> [dir]';
const SIZE_SUFFIX = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
const FETCH_DEPTH_FLAGS = ['--depth', '--deepen', '--unshallow'];
/** git's INFINITE_DEPTH (shallow.h): --unshallow asks for this much. */
const INFINITE_DEPTH = 0x7fffffff;
/**
 * `git fetch --depth <n> | --deepen <n> | --unshallow`, as cf-git's fetch
 * takes them: a depth from the remote's tips, or (relative) from the
 * repository's current shallow boundary.
 */
export function parseFetchDepth(args) {
    let found;
    for (let i = 0; i < args.length; i++) {
        const [flag, inline] = args[i].split('=', 2);
        if (!FETCH_DEPTH_FLAGS.includes(flag))
            continue;
        if (found !== undefined)
            throw new Error('--depth, --deepen and --unshallow are mutually exclusive');
        if (flag === '--unshallow') {
            found = { depth: INFINITE_DEPTH, relative: false };
            continue;
        }
        const value = inline ?? args[++i];
        const depth = Number(value);
        if (!Number.isSafeInteger(depth) || depth < 1)
            throw new Error(`${flag} ${value ?? ''} is not a positive number`.trimEnd());
        found = { depth, relative: flag === '--deepen' };
    }
    return found;
}
/**
 * A partial clone's filter (list-objects-filter-options.c), normalized as
 * git normalizes it: blob:limit's size in bytes. The filters Nimbus
 * fetches with; any other is refused by name rather than ignored.
 */
export function parseCloneFilter(spec) {
    if (spec === 'blob:none')
        return spec;
    const limit = /^blob:limit=(\d+)([kmg]?)$/i.exec(spec);
    if (limit)
        return 'blob:limit=' + Number(limit[1]) * SIZE_SUFFIX[limit[2].toLowerCase()];
    const tree = /^tree:(\d+)$/.exec(spec);
    if (tree)
        return 'tree:' + Number(tree[1]);
    throw new Error(`invalid filter-spec '${spec}': git clone here takes blob:none, blob:limit=<n>[kmg] or tree:<depth>`);
}
/**
 * Every flag is either handled or refused loudly. Silently skipping unknown
 * flags corrupted positionals for value-taking ones (`--branch dev URL`
 * parsed `dev` as the URL) and silently no-opped `--filter=blob:none` — a
 * "blobless" clone that was not blobless.
 */
/** git init's usage line, as git 2.53 prints it for a second directory (usage()). */
const INIT_USAGE_LINE = [
    'usage: git init [-q | --quiet] [--bare] [--template=<template-directory>]',
    '         [--separate-git-dir <git-dir>] [--object-format=<format>]',
    '         [--ref-format=<format>]',
    '         [-b <branch-name> | --initial-branch=<branch-name>]',
    '         [--shared[=<permissions>]] [<directory>]',
    '',
].join('\n');
/** git init's usage, as git 2.53 prints it after an option it does not know (usage_with_options()). */
const INIT_USAGE = [
    'usage: git init [-q | --quiet] [--bare] [--template=<template-directory>]',
    '                [--separate-git-dir <git-dir>] [--object-format=<format>]',
    '                [--ref-format=<format>]',
    '                [-b <branch-name> | --initial-branch=<branch-name>]',
    '                [--shared[=<permissions>]] [<directory>]',
    '',
    '    --[no-]template <template-directory>',
    '                          directory from which templates will be used',
    '    --[no-]bare           create a bare repository',
    '    --shared[=<permissions>]',
    '                          specify that the git repository is to be shared amongst several users',
    '    -q, --[no-]quiet      be quiet',
    '    --[no-]separate-git-dir <gitdir>',
    '                          separate git dir from working tree',
    '    -b, --[no-]initial-branch <name>',
    '                          override the name of the initial branch',
    '    --[no-]object-format <hash>',
    '                          specify the hash algorithm to use',
    '    --[no-]ref-format <format>',
    '                          specify the reference format to use',
    '', '',
].join('\n');
/**
 * `git init`'s arguments, as git's parse-options takes them: -q, --bare,
 * the initial branch (`-b <name>`, `--initial-branch[=]<name>`,
 * `--no-initial-branch`) and one directory; short options cluster (`-qq`,
 * `-qbmain`, `-qb main`: b takes the rest of the cluster, else the next
 * argument). The branch's name is never the directory (`git init -b main`
 * initialized ./main). git's other options are refused as unsupported.
 */
export function parseInitArgs(args) {
    let quiet = false;
    let bare = false;
    let branch;
    let directory;
    let dashdash = false;
    const unknown = (what) => ({ error: `error: unknown ${what}\n${INIT_USAGE}`, code: 129 });
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            if (directory !== undefined)
                return { error: INIT_USAGE_LINE, code: 129 };
            directory = arg;
        }
        else if (arg === '--') {
            dashdash = true;
        }
        else if (arg.startsWith('--')) {
            const [name, value] = arg.includes('=') ? [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg.slice(2), undefined];
            if (name === 'quiet' || name === 'no-quiet' || name === 'bare' || name === 'no-bare' || name === 'no-initial-branch') {
                if (value !== undefined)
                    return { error: `error: option \`${name}' takes no value\n`, code: 129 };
                if (name === 'no-initial-branch')
                    branch = undefined;
                else if (name.endsWith('quiet'))
                    quiet = name === 'quiet';
                else
                    bare = name === 'bare';
            }
            else if (name === 'initial-branch') {
                if (value !== undefined)
                    branch = value;
                else if (i + 1 < args.length)
                    branch = args[++i];
                else
                    return { error: "error: option `initial-branch' requires a value\n", code: 129 };
            }
            else if (/^(no-)?(template|separate-git-dir|object-format|ref-format|shared)$/.test(name)) {
                return { error: `fatal: git init --${name} is not supported here\n`, code: 128 };
            }
            else {
                return unknown(`option \`${name}'`);
            }
        }
        else {
            // A cluster of short options.
            for (let k = 1; k < arg.length; k++) {
                const flag = arg[k];
                if (flag === 'q') {
                    quiet = true;
                }
                else if (flag === 'b') {
                    if (k + 1 < arg.length)
                        branch = arg.slice(k + 1);
                    else if (i + 1 < args.length)
                        branch = args[++i];
                    else
                        return { error: "error: switch `b' requires a value\n", code: 129 };
                    break;
                }
                else {
                    return unknown(`switch \`${flag}'`);
                }
            }
        }
    }
    return { quiet, bare, branch, directory };
}
export function parseCloneArgs(args) {
    let depthFlag;
    let branch;
    let noShallow = false;
    let isBg = false;
    let quiet = false;
    let filter;
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const name = eq > 0 ? arg.slice(0, eq) : arg;
        const takeValue = () => {
            if (eq > 0)
                return arg.slice(eq + 1);
            const value = args[++i];
            if (value === undefined) {
                throw new Error(`option '${name}' requires a value\n${CLONE_USAGE}`);
            }
            return value;
        };
        if (name === '--depth')
            depthFlag = takeValue();
        else if (name === '--branch' || name === '-b')
            branch = takeValue();
        else if (arg === '--no-shallow')
            noShallow = true;
        else if (arg === '--bg' || arg === '&')
            isBg = true;
        else if (arg === '-q' || arg === '--quiet')
            quiet = true;
        // Progress is already the default; there is no more of it to ask for.
        else if (arg === '-v' || arg === '--verbose') { /* accepted */ }
        else if (name === '--filter')
            filter = parseCloneFilter(takeValue());
        else if (arg.startsWith('-')) {
            throw new Error(`unknown option '${arg}'\n${CLONE_USAGE}`);
        }
        else {
            positionals.push(arg);
        }
    }
    return {
        url: positionals[0],
        dest: positionals[1],
        depth: depthFlag ? parseInt(depthFlag) || 1 : (noShallow ? undefined : 1),
        noShallow,
        isBg,
        branch,
        quiet,
        filter,
    };
}
/** fetch, pull and push: `-q`/`--quiet` wherever it appears; the other words keep their order. */
function takeQuiet(args) {
    const rest = args.filter((arg) => arg !== '-q' && arg !== '--quiet');
    return { quiet: rest.length !== args.length, rest };
}
/** commit's -m (repeatable), -q and -a, bundled as git allows (`-qm msg`, `-mmsg`); other options stay ignored. */
function parseCommitArgs(args) {
    const messages = [];
    let quiet = false;
    let all = false;
    let cleanup = null;
    let allowEmptyMessage = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--')
            break;
        if (arg === '--quiet')
            quiet = true;
        else if (arg === '--all')
            all = true;
        else if (arg === '--allow-empty-message')
            allowEmptyMessage = true;
        else if (arg === '--cleanup')
            cleanup = args[++i] ?? '';
        else if (arg.startsWith('--cleanup='))
            cleanup = arg.slice('--cleanup='.length);
        else if (arg === '--message')
            messages.push(args[++i] ?? '');
        else if (arg.startsWith('--message='))
            messages.push(arg.slice('--message='.length));
        else if (/^-[^-]/.test(arg)) {
            for (let j = 1; j < arg.length; j++) {
                if (arg[j] === 'q')
                    quiet = true;
                else if (arg[j] === 'a')
                    all = true;
                else if (arg[j] === 'm') {
                    messages.push(j + 1 < arg.length ? arg.slice(j + 1) : args[++i] ?? '');
                    break;
                }
            }
        }
    }
    return { messages, quiet, all, cleanup, allowEmptyMessage };
}
/**
 * The message `-m` options make (builtin/commit.c opt_parse_m): each value
 * ends in a newline, and one after another is joined by a blank line; an
 * empty value adds nothing.
 */
function joinMessageOptions(values) {
    let buf = '';
    for (const value of values) {
        if (buf.length)
            buf += '\n';
        buf += value;
        if (buf.length && !buf.endsWith('\n'))
            buf += '\n';
    }
    return buf;
}
/**
 * The cleanup mode a commit message gets (builtin/commit.c): --cleanup, else
 * commit.cleanup. With no editor, as for -m, `default` and `scissors` are
 * `whitespace`. Null for a mode git does not know.
 */
function commitCleanupMode(value) {
    if (value === undefined || value === 'default' || value === 'scissors' || value === 'whitespace')
        return 'whitespace';
    if (value === 'strip' || value === 'verbatim')
        return value;
    return null;
}
function isNotFound(error) {
    return error instanceof Error && 'code' in error && error.code === 'NotFoundError';
}
// ── Output ───────────────────────────────────────────────────────────────
/** Emit a binary string: its bytes verbatim where the sink keeps bytes, else as UTF-8 text. */
async function writeBinary(stream, bin) {
    if (!bin)
        return;
    const bytes = bytesFromBinary(bin);
    if (stream.writeBytes)
        await stream.writeBytes(bytes);
    else
        await stream.write(dec.decode(bytes));
}
// ── Staging ──────────────────────────────────────────────────────────────
/** What one command's worktree work cost, by its filesystem (one per command): NIMBUS_GIT_COUNTERS=1 prints it. */
const commandCounters = new WeakMap();
/** The engine one command's repositories write their objects' waves into, by its filesystem (one per command). */
const commandEngines = new WeakMap();
/** The repository at `root` as the worktree commands read it: its index, worktree and objects (through `fs`'s pack store). */
function worktreeRepo(ctx, git, vfs, fs, gitdir, root) {
    let counters = commandCounters.get(fs);
    if (!counters) {
        counters = newCounters();
        // NIMBUS_GIT_COUNTERS=why also says why the first entries read had to be.
        if (ctx.env.NIMBUS_GIT_COUNTERS === 'why')
            counters.why = [];
        commandCounters.set(fs, counters);
    }
    return new WorktreeRepo(vfs, git, fs, root, gitdir, ctx.env, counters, commandEngines.get(fs) ?? null);
}
/**
 * add_to_index: the worktree's file or link at `path` as an index entry, its
 * blob written (unless the repository holds it) and its stat recorded. A
 * nested repository is its HEAD commit, a gitlink. Null when there is nothing
 * there to add.
 */
async function indexEntryFor(wrepo, git, dc, path, objects) {
    const tree = await wrepo.worktree();
    const st = await wrepo.fs.lstat(path);
    if (st === null || st.type === 'other')
        return null;
    if (st.type === 'directory') {
        const oid = await git.resolveRef({ fs: wrepo.gitFs, gitdir: `${wrepo.root}/${path}/.git`, ref: 'HEAD' });
        return { path, mode: 0o160000, oid, stat: st };
    }
    const oid = await objects.write('blob', await worktreeBlob(tree, path, st.type));
    const at = dc.find(path);
    return { path, mode: modeFromStat(st, at >= 0 ? dc.mode(at) : undefined, tree.filemode), oid, stat: st };
}
/**
 * `commit -a`'s staging of tracked changes: the refresh, the removals and the
 * additions in one index write, as git's, a path at a time (1,000 concurrent
 * deflates reset the isolate).
 */
async function stageTracked(ctx, wrepo, git) {
    const dc = await wrepo.readIndex();
    const scan = await scanWorktree(await wrepo.worktree(), dc, { untracked: 'no', excludes: null, uncleanIsDirty: true, unmerged: true });
    for (const line of scan.errors.tracked)
        await ctx.stderr.write(`${line}\n`);
    const removed = new Set();
    const added = new NewEntries();
    const objects = await wrepo.objectWriter();
    for (const [i, dirty] of scan.dirty) {
        const entry = dirty.change === 'D' ? null : await indexEntryFor(wrepo, git, dc, dc.path(i), objects);
        if (entry)
            added.add(entry);
        else
            removed.add(i);
    }
    // An unmerged path is resolved as add -u resolves it: with what the worktree holds, or by its removal.
    for (const { path, lo, hi, stat } of scan.unmerged) {
        const entry = stat === null || stat.type === 'directory' ? null : await indexEntryFor(wrepo, git, dc, path, objects);
        if (entry)
            added.add(entry);
        else
            for (let k = lo; k < hi; k++)
                removed.add(k);
    }
    // The blobs are there before the index that names them.
    await objects.flush();
    if (removed.size || added.count || dc.refreshed)
        await wrepo.writeIndex(dc, { removed, added });
}
/**
 * Before a command reads the trees and blobs of `commits` (a checkout, a
 * reset, a merge), fetch what a partial clone lacks in two requests, as git
 * prefetches a checkout's blobs: the commits' root trees with their subtrees
 * (a tree:<depth> clone has neither), then every blob of those trees the
 * repository does not hold. Nothing is walked outside a partial clone.
 */
async function prefetchCommits(git, fs, gitdir, commits, partial) {
    if (commits.length === 0 || !await partial(gitdir))
        return;
    const cache = {};
    const roots = [];
    for (const oid of commits)
        roots.push((await git.readCommit({ fs, gitdir, oid, cache })).commit.tree);
    await fs.packs.prefetch(gitdir, roots);
    const blobs = new Set();
    const pending = [...roots];
    const seen = new Set();
    while (pending.length > 0) {
        const tree = pending.pop();
        if (seen.has(tree))
            continue;
        seen.add(tree);
        for (const entry of (await git.readTree({ fs, gitdir, oid: tree, cache })).tree) {
            if (entry.type === 'tree')
                pending.push(entry.oid);
            else if (entry.type === 'blob')
                blobs.add(entry.oid);
        }
    }
    await fs.packs.prefetch(gitdir, blobs);
}
// ── Repository discovery ─────────────────────────────────────────────────
const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git\n';
const NOT_A_WORK_TREE = 'fatal: this operation must be run in a work tree\n';
/** setup_git_directory's walk: from the cwd up, a `.git` inside each level, else the level itself as a git directory. */
async function discoverRepo(vfs, cwd) {
    const isGitDir = async (key) => {
        const sub = (name) => (key ? `${key}/${name}` : name);
        return await vfs.isFile(sub('HEAD')) && await vfs.isDirectory(sub('objects')) && await vfs.isDirectory(sub('refs'));
    };
    const segments = normalizeVfsPath(cwd).split('/').filter(Boolean);
    for (let depth = segments.length; depth >= 0; depth--) {
        const dir = segments.slice(0, depth).join('/');
        const prefix = segments.slice(depth).join('/');
        const dotGit = dir ? `${dir}/.git` : '.git';
        if (await isGitDir(dotGit))
            return { gitdir: `/${dotGit}`, worktree: `/${dir}`, prefix };
        if (await isGitDir(dir))
            return { gitdir: `/${dir}`, worktree: null, prefix };
    }
    return null;
}
function ambiguousArgument(arg) {
    return `fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.\n`
        + "Use '--' to separate paths from revisions, like this:\n"
        + "'git <command> [<revision>...] -- [<file>...]'\n";
}
/** A revision as rev-parse reads one: a ref, or a full or uniquely abbreviated object name. */
async function resolveRevision(git, fs, gitdir, rev, cache) {
    const name = rev === '@' ? 'HEAD' : rev;
    if (/[~^:{}\\]|\.\.|^@/.test(name))
        throw new Error(`unsupported revision syntax '${rev}'`);
    try {
        return await git.resolveRef({ fs, gitdir, ref: name });
    }
    catch (e) {
        if (!isNotFound(e))
            throw e;
    }
    if (!/^[0-9a-f]{4,39}$/.test(name))
        return null;
    try {
        return await git.expandOid({ fs, gitdir, oid: name, cache });
    }
    catch (e) {
        if (!isNotFound(e))
            throw e;
        return null;
    }
}
/** --abbrev-ref: the short name of the ref a revision spells, null when it spells none. */
async function abbreviatedRef(git, fs, gitdir, rev) {
    if (rev === 'HEAD' || rev === '@')
        return (await git.currentBranch({ fs, gitdir })) ?? 'HEAD';
    try {
        const full = await git.expandRef({ fs, gitdir, ref: rev });
        return full.replace(/^refs\/remotes\/(.+)\/HEAD$/, '$1').replace(/^refs\/(?:heads|tags|remotes)\//, '');
    }
    catch (e) {
        if (!isNotFound(e))
            throw e;
        return null;
    }
}
async function revParse(ctx, git, fs, vfs, args) {
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    const cache = {};
    let verify = false;
    let quiet = false;
    let abbrevRef = false;
    let out = '';
    const verified = [];
    const show = async (rev, oid) => {
        if (!abbrevRef)
            return `${oid}\n`;
        const name = await abbreviatedRef(git, fs, repo.gitdir, rev);
        return name === null ? '' : `${name}\n`;
    };
    const fail = async (message, code) => {
        if (out)
            await ctx.stdout.write(out);
        if (message)
            await ctx.stderr.write(message);
        return code;
    };
    const noSingleRevision = () => (quiet ? fail('', 1) : fail('fatal: Needed a single revision\n', 128));
    for (const arg of args) {
        switch (arg) {
            case '--verify':
                verify = true;
                continue;
            case '-q':
            case '--quiet':
                quiet = true;
                continue;
            case '--abbrev-ref':
                abbrevRef = true;
                continue;
            case '--show-toplevel':
                if (!repo.worktree)
                    return fail(NOT_A_WORK_TREE, 128);
                out += `${repo.worktree}\n`;
                continue;
            case '--git-dir':
                // rev-parse names the git directory relative to the cwd only from the top.
                out += `${repo.prefix ? repo.gitdir : repo.worktree ? '.git' : '.'}\n`;
                continue;
            case '--is-inside-work-tree':
                out += `${repo.worktree ? 'true' : 'false'}\n`;
                continue;
        }
        if (arg.startsWith('-'))
            return fail(`fatal: rev-parse: unsupported option '${arg}'\n`, 129);
        const oid = await resolveRevision(git, fs, repo.gitdir, arg, cache);
        if (oid === null) {
            if (verify)
                return noSingleRevision();
            // A non-revision is echoed as a path, which must then exist.
            out += `${arg}\n`;
            if (await vfs.exists(normalizeVfsPath(arg.startsWith('/') ? arg : `${ctx.cwd}/${arg}`)))
                continue;
            return fail(ambiguousArgument(arg), 128);
        }
        if (verify)
            verified.push({ rev: arg, oid });
        else
            out += await show(arg, oid);
    }
    if (verify) {
        if (verified.length !== 1)
            return noSingleRevision();
        out += await show(verified[0].rev, verified[0].oid);
    }
    await ctx.stdout.write(out);
    return 0;
}
// ── Worktree inspection (ls-files, diff) ─────────────────────────────────
/** A repo-relative path as seen from `prefix`, climbing with '../' where it must. */
function relativeTo(path, prefix) {
    if (!prefix)
        return path;
    if (path.startsWith(`${prefix}/`))
        return path.slice(prefix.length + 1);
    const from = prefix.split('/');
    const to = path.split('/');
    let shared = 0;
    while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared])
        shared++;
    return '../'.repeat(from.length - shared) + to.slice(shared).join('/');
}
/** Literal pathspecs, relative to the cwd, as repo-relative paths; '' is the whole tree. */
function repoPaths(args, cwd, worktree) {
    const root = normalizeVfsPath(worktree);
    return args.map((arg) => {
        if (/[*?[]/.test(arg))
            throw new Error(`pathspec '${arg}': globs are not supported, name the paths`);
        const key = normalizeVfsPath(arg.startsWith('/') ? arg : `${cwd}/${arg}`);
        if (!root || key === root)
            return root ? '' : key;
        if (key.startsWith(`${root}/`))
            return key.slice(root.length + 1);
        throw new Error(`${arg}: '${arg}' is outside repository at '${worktree}'`);
    });
}
/** The index entries the pathspecs name (a path, or everything below it), in index order, each once. */
function entriesInSpecs(dc, specs) {
    if (specs.length === 0 || specs.includes(''))
        return Array.from({ length: dc.count }, (_, i) => i);
    const picked = new Set();
    for (const spec of specs) {
        for (let i = dc.find(spec); i >= 0 && i < dc.count && dc.path(i) === spec; i++)
            picked.add(i);
        const [lo, hi] = dc.rangeUnder(spec);
        for (let i = lo; i < hi; i++)
            picked.add(i);
    }
    return [...picked].sort((x, y) => x - y);
}
/**
 * add's tracked changes in index order, as the walk left them, one at a time:
 * each dirty entry, and each unmerged path (resolved with what the worktree
 * holds, or by its removal). Removals but with --no-all (`all` false).
 */
function* trackedChanges(scan, all) {
    const unmerged = [...scan.unmerged].sort((a, b) => a.lo - b.lo);
    let u = 0;
    const resolved = function* (at) {
        for (; u < unmerged.length && unmerged[u].lo < at; u++) {
            const { lo, hi, stat } = unmerged[u];
            if (stat !== null && stat.type !== 'directory')
                yield { at: lo, end: hi, action: 'add', stat, unmerged: true };
            else if (all !== false)
                yield { at: lo, end: hi, action: 'remove', stat: null, unmerged: true };
        }
    };
    for (const [i, dirty] of scan.dirty) {
        yield* resolved(i);
        if (dirty.change !== 'D')
            yield { at: i, end: i + 1, action: 'add', stat: null, unmerged: false };
        else if (all !== false)
            yield { at: i, end: i + 1, action: 'remove', stat: null, unmerged: false };
    }
    yield* resolved(Infinity);
}
const ADD_USAGE = 'usage: git add [-n | --dry-run] [-v | --verbose] [-f | --force] [-A | --all | --no-all] '
    + '[-u | --update] [--] <pathspec>...\n';
/** git add's options this git does not do: they are git's, so they are refused as unsupported, not unknown. */
const ADD_UNSUPPORTED = new Set(['i', 'p', 'e', 'N', 'U', '--interactive', '--patch', '--edit', '--intent-to-add',
    '--unified', '--inter-hunk-context', '--renormalize', '--refresh', '--ignore-errors', '--ignore-missing', '--sparse',
    '--chmod', '--pathspec-from-file', '--pathspec-file-nul']);
/**
 * `git add`: what git 2.x stages for its pathspecs. A pathspec takes the
 * changes, deletions and new files below it (as -A does); -u only tracked
 * paths, --no-all no deletions, -A or -u with no pathspec the whole tree.
 * -n prints what would be staged (`add 'p'`, `remove 'p'`, tracked paths
 * first, then new ones) and stages nothing; -v prints it and stages. A
 * pathspec that matches nothing fails before anything is staged; one that
 * names an ignored path is reported (exit 1) unless -f, the rest still added.
 */
async function addCommand(ctx, git, vfs, fs, args) {
    let dryRun = false;
    let verbose = false;
    let force = false;
    let all = null;
    let update = false;
    let dashdash = false;
    const pathArgs = [];
    for (const arg of args) {
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            pathArgs.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        const flags = arg.startsWith('--') ? [arg.split('=')[0]] : [...arg.slice(1)];
        for (const flag of flags) {
            switch (flag) {
                case 'n':
                case '--dry-run':
                    dryRun = true;
                    break;
                case 'v':
                case '--verbose':
                    verbose = true;
                    break;
                case 'f':
                case '--force':
                    force = true;
                    break;
                case 'A':
                case '--all':
                case '--no-ignore-removal':
                    all = true;
                    break;
                case '--no-all':
                case '--ignore-removal':
                    all = false;
                    break;
                case 'u':
                case '--update':
                    update = true;
                    break;
                default:
                    if (ADD_UNSUPPORTED.has(flag)) {
                        await ctx.stderr.write(`fatal: git add ${flag.length === 1 ? `-${flag}` : flag} is not supported here\n`);
                        return 128;
                    }
                    await ctx.stderr.write(flag.length === 1
                        ? `error: unknown switch \`${flag}'\n${ADD_USAGE}`
                        : `error: unknown option \`${flag.slice(2)}'\n${ADD_USAGE}`);
                    return 129;
            }
        }
    }
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    const root = repo.worktree;
    if (!root) {
        await ctx.stderr.write(NOT_A_WORK_TREE);
        return 128;
    }
    if (pathArgs.length === 0 && all !== true && !update) {
        await ctx.stderr.write("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n"
            + 'hint: Disable this message with "git config set advice.addEmptyPathspec false"\n');
        return 0;
    }
    const specs = pathArgs.length ? repoPaths(pathArgs, ctx.cwd, root) : [''];
    const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
    // The index is read and written under its lock: an add never writes over another writer's change.
    return await wrepo.withIndexLock(async () => {
        const dc = await wrepo.readIndex();
        const excludes = await wrepo.excludes(dc);
        // -u updates what the index holds and nothing else; -f takes the ignored files below each pathspec as well.
        const scan = await scanWorktree(await wrepo.worktree(), dc, {
            specs, untracked: update ? 'no' : 'all', excludes, ignoredToo: force, uncleanIsDirty: true, unmerged: true,
        });
        // A nested repository stays 'dir/' here, as git prints it; it is added as a gitlink.
        const untracked = scan.untracked.sort(comparePaths);
        const ignored = [];
        for (const [i, spec] of specs.entries()) {
            if (spec === '')
                continue;
            // A pathspec matches what the index holds there, or (but for -u) what is untracked there.
            const [lo, hi] = dc.rangeUnder(spec);
            if (dc.find(spec) >= 0 || hi > lo || untracked.some((path) => inSpecs([spec], path.replace(/\/$/, ''))))
                continue;
            if (update) {
                // "Known to git" is the index; git names the first pathspec it holds nothing under.
                await ctx.stderr.write(`error: pathspec '${pathArgs[i]}' did not match any file(s) known to git\n`);
                return 128;
            }
            const st = await wrepo.fs.lstat(spec);
            if (!st) {
                await ctx.stderr.write(`fatal: pathspec '${pathArgs[i]}' did not match any files\n`);
                return 128;
            }
            // Named but not listed: ignored (reported at the path the ignore rule names), or an empty directory.
            const parts = spec.split('/');
            for (let depth = 1; depth <= parts.length; depth++) {
                const prefix = parts.slice(0, depth).join('/');
                if (await excludes.isExcluded(prefix, depth < parts.length || st.type === 'directory')) {
                    if (!ignored.includes(prefix))
                        ignored.push(prefix);
                    break;
                }
            }
        }
        // read_directory's warnings, then diff-files' lstat failures, then add_files' advice.
        for (const line of [...scan.errors.untracked, ...scan.errors.tracked])
            await ctx.stderr.write(`${line}\n`);
        if (ignored.length) {
            await ctx.stderr.write(`The following paths are ignored by one of your .gitignore files:\n${ignored.map((p) => `${p}\n`).join('')}`
                + 'hint: Use -f if you really want to add them.\n'
                + 'hint: Disable this message with "git config set advice.addIgnoredFile false"\n');
        }
        // -n and -v print each path as it is staged; -n stages nothing.
        let out = '';
        const show = dryRun || verbose;
        const removed = new Set();
        // Each new entry is held as its bytes as soon as it is made (a file of Linux's 96,000 changed: 10 MiB, not 80).
        const added = new NewEntries();
        // The blobs it writes go in waves, published before the index that names them.
        const objects = await wrepo.objectWriter();
        const tree = await wrepo.worktree();
        // Tracked paths first, in index order, then the new ones, as git's add_files_to_cache and add_files go.
        for (const { at: i, end, action, stat: st, unmerged } of trackedChanges(scan, all)) {
            const path = dc.path(i);
            if (action === 'remove') {
                if (show)
                    out += `remove '${path}'\n`;
                if (!dryRun)
                    for (let k = i; k < end; k++)
                        removed.add(k);
                continue;
            }
            // Added again with what it already held, an entry is not named (add_to_index's was_same).
            if (dryRun) {
                // The walk kept only how the entry changed: its stat is taken again.
                const now = st ?? await wrepo.fs.lstat(path);
                const same = !unmerged && now !== null && modeFromStat(now, dc.mode(i), tree.filemode) === dc.mode(i)
                    && await worktreeBlobId(tree, path, now) === dc.oid(i);
                if (show && !same)
                    out += `add '${path}'\n`;
                continue;
            }
            const entry = await indexEntryFor(wrepo, git, dc, path, objects);
            if (show && (unmerged || !(entry && entry.oid === dc.oid(i) && entry.mode === dc.mode(i))))
                out += `add '${path}'\n`;
            if (entry)
                added.add(entry);
            else
                for (let k = i; k < end; k++)
                    removed.add(k);
        }
        let advised = false;
        for (const path of untracked) {
            const repository = path.endsWith('/');
            let entry = null;
            if (repository || !dryRun) {
                try {
                    entry = await indexEntryFor(wrepo, git, dc, repository ? path.slice(0, -1) : path, objects);
                }
                catch (error) {
                    if (!repository || !isNotFound(error))
                        throw error;
                    // A nested repository with no commit has nothing to add as a gitlink: nothing is staged.
                    if (show)
                        await writeBinary(ctx.stdout, binaryPath(out));
                    await ctx.stderr.write(`error: '${path}' does not have a commit checked out\nerror: unable to index file '${path}'\n`
                        + 'fatal: adding files failed\n');
                    return 128;
                }
            }
            if (show)
                out += `add '${path}'\n`;
            if (repository) {
                const name = path.slice(0, -1);
                let text = `warning: adding embedded git repository: ${name}\n`;
                if (!advised) {
                    advised = true;
                    text += ["You've added another git repository inside your current repository.",
                        'Clones of the outer repository will not contain the contents of',
                        'the embedded repository and will not know how to obtain it.',
                        'If you meant to add a submodule, use:', '', `\tgit submodule add <url> ${name}`, '',
                        'If you added this path by mistake, you can remove it from the', 'index with:', '', `\tgit rm --cached ${name}`, '',
                        'See "git help submodule" for more information.',
                        'Disable this message with "git config set advice.addEmbeddedRepo false"',
                    ].map((line) => (line ? `hint: ${line}\n` : 'hint:\n')).join('');
                }
                await ctx.stderr.write(text);
            }
            if (entry && !dryRun)
                added.add(entry);
        }
        if (show)
            await writeBinary(ctx.stdout, binaryPath(out));
        await objects.flush();
        // Its stat refreshes ride in the one index write that stages (git add writes once).
        if (!dryRun && (removed.size || added.count || dc.refreshed))
            await wrepo.writeIndex(dc, { removed, added });
        return ignored.length ? 1 : 0;
    });
}
const TAG_USAGE = 'usage: git tag [-a] [-f] [-m <msg> | -F <file>] <tagname> [<commit>]\n'
    + '   or: git tag -d <tagname>...\n'
    + '   or: git tag [-n[<num>]] [-l] [<pattern>...]\n';
/** git's `whitespace` cleanup of a message given with -m or -F: no trailing blanks, no runs or edges of empty lines. */
/** A `±hhmm` timezone for an offset in minutes east of UTC. */
function gitTimezone(minutesEast) {
    const sign = minutesEast < 0 ? '-' : '+';
    const abs = Math.abs(minutesEast);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}
// git's date.c tables, in its order: a name matches from its third letter on.
const GIT_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const GIT_WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
/** [name, hours east, daylight]: git adds the daylight hour ("This is bogus, but we like summer"). */
const GIT_ZONES = [
    ['IDLW', -12, 0], ['NT', -11, 0], ['CAT', -10, 0], ['HST', -10, 0], ['HDT', -10, 1], ['YST', -9, 0], ['YDT', -9, 1],
    ['PST', -8, 0], ['PDT', -8, 1], ['MST', -7, 0], ['MDT', -7, 1], ['CST', -6, 0], ['CDT', -6, 1], ['EST', -5, 0],
    ['EDT', -5, 1], ['AST', -3, 0], ['ADT', -3, 1], ['WAT', -1, 0], ['GMT', 0, 0], ['UTC', 0, 0], ['Z', 0, 0],
    ['WET', 0, 0], ['BST', 0, 1], ['CET', 1, 0], ['MET', 1, 0], ['MEWT', 1, 0], ['MEST', 1, 1], ['CEST', 1, 1],
    ['MESZ', 1, 1], ['FWT', 1, 0], ['FST', 1, 1], ['EET', 2, 0], ['EEST', 2, 1], ['WAST', 7, 0], ['WADT', 7, 1],
    ['CCT', 8, 0], ['JST', 9, 0], ['EAST', 10, 0], ['EADT', 10, 1], ['GST', 10, 0], ['NZT', 12, 0], ['NZST', 12, 0],
    ['NZDT', 12, 1], ['IDLE', 12, 0],
];
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c) => c !== undefined && /[A-Za-z]/.test(c);
const isAlnum = (c) => isDigit(c) || isAlpha(c);
/**
 * A GIT_COMMITTER_DATE as git's date.c parse_date_basic() reads it, ported
 * routine for routine (match_object_header_date, match_alpha, match_digit,
 * match_multi_number, set_date, match_tz, tm_to_time_t), so every form git
 * accepts is accepted and read the same way: `@<secs> ±hhmm` (git's own raw
 * form), a bare epoch of 9 or more digits, ISO 8601, RFC 2822 (`date -R`),
 * git's default `Thu Jan 2 03:04:05 2020 -0800`, dotted and slashed dates,
 * zone names, am/pm. Without a zone, the local one at that time, as mktime()
 * gives it. Null where git says "invalid date format": no time of day, a
 * year outside 1970-2099, a date it cannot place.
 */
function parseGitDate(text, nowSeconds = Math.floor(Date.now() / 1000)) {
    // match_object_header_date: "@<digits> ±hhmm", exactly.
    const header = /^@(\d+) ([+-])(\d{4})(?:\n|$)/.exec(text);
    if (header) {
        const hhmm = Number(header[3]);
        const minutes = (header[2] === '-' ? -1 : 1) * (Math.floor(hhmm / 100) * 60 + (hhmm % 100));
        return { seconds: Number(header[1]), zone: gitTimezone(minutes) };
    }
    const tm = { year: -1, mon: -1, mday: -1, hour: -1, min: -1, sec: -1, wday: -1 };
    let offset = null;
    let gmt = false;
    // tm_to_time_t: 1970-2099 only, and every field of the time of day given.
    const toTime = (t) => {
        const days = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        const year = t.year - 70;
        let day = t.mday;
        if (year < 0 || year > 129 || t.mon < 0 || t.mon > 11)
            return null;
        if (t.mon < 2 || (year + 2) % 4)
            day--;
        if (t.hour < 0 || t.min < 0 || t.sec < 0)
            return null;
        return (year * 365 + Math.floor((year + 1) / 4) + days[t.mon] + day) * 86_400 + t.hour * 3600 + t.min * 60 + t.sec;
    };
    const noDate = () => tm.year < 0 && tm.mon < 0 && tm.mday < 0 && tm.hour < 0 && tm.min < 0 && tm.sec < 0;
    const matchString = (at, word) => {
        let i = 0;
        for (; at + i < text.length; i++) {
            const c = text[at + i];
            if (c === word[i] || c.toUpperCase() === (word[i] ?? '').toUpperCase())
                continue;
            if (!isAlnum(c))
                break;
            return 0;
        }
        return i;
    };
    // set_date: month and day in range, the year placed as git places it, and
    // (for a guessed order) no more than ten days into the future.
    const setDate = (year, month, day, refuseFuture) => {
        if (!(month > 0 && month < 13 && day > 0 && day < 32))
            return false;
        const r = { ...tm, mon: month - 1, mday: day };
        if (year === -1) {
            if (!refuseFuture)
                return false;
            r.year = new Date(nowSeconds * 1000).getUTCFullYear() - 1900;
        }
        else if (year >= 1970 && year < 2100)
            r.year = year - 1900;
        else if (year > 70 && year < 100)
            r.year = year;
        else if (year < 38)
            r.year = year + 100;
        else
            return false;
        if (refuseFuture) {
            const specified = toTime({ ...r, hour: 0, min: 0, sec: 0 });
            if (specified !== null && nowSeconds + 10 * 86_400 < specified)
                return false;
        }
        tm.mon = r.mon;
        tm.mday = r.mday;
        if (year !== -1 || !refuseFuture)
            tm.year = r.year;
        return true;
    };
    const readNumber = (at) => {
        let end = at;
        while (isDigit(text[end]))
            end++;
        return [Number(text.slice(at, end)), end];
    };
    const matchMulti = (num, sep, at, end) => {
        let num3 = -1;
        let [num2, next] = readNumber(end + 1);
        if (text[next] === sep && isDigit(text[next + 1]))
            [num3, next] = readNumber(next + 1);
        if (sep === ':') {
            if (num3 < 0)
                num3 = 0;
            if (num < 25 && num2 >= 0 && num2 < 60 && num3 >= 0 && num3 <= 60) {
                tm.hour = num;
                tm.min = num2;
                tm.sec = num3;
                return next - at;
            }
            return 0;
        }
        if (num > 70 && (setDate(num, num2, num3, false) || setDate(num, num3, num2, false)))
            return next - at;
        if (sep !== '.' && setDate(num3, num, num2, true))
            return next - at;
        if (setDate(num3, num2, num, true))
            return next - at;
        if (sep === '.' && setDate(num3, num, num2, true))
            return next - at;
        return 0;
    };
    const matchDigit = (at) => {
        const [num, end] = readNumber(at);
        // Seconds since 1970: a number of 9 digits or more, before any date.
        if (num >= 100_000_000 && noDate()) {
            const d = new Date(num * 1000);
            Object.assign(tm, { year: d.getUTCFullYear() - 1900, mon: d.getUTCMonth(), mday: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes(), sec: d.getUTCSeconds() });
            gmt = true;
            return end - at;
        }
        if ((text[end] === ':' || text[end] === '.' || text[end] === '/' || text[end] === '-') && isDigit(text[end + 1])) {
            const matched = matchMulti(num, text[end], at, end);
            if (matched)
                return matched;
        }
        const n = end - at;
        if (n === 8 || n === 6) {
            const [a, b, c] = [Math.floor(num / 10000), Math.floor((num % 10000) / 100), num % 100];
            if (n === 8)
                setDate(a, b, c, false);
            else if (a < 25 && b < 60 && c <= 60) {
                tm.hour = a;
                tm.min = b;
                tm.sec = c;
                if (text[end] === '.' && isDigit(text[end + 1]))
                    return readNumber(end + 1)[1] - at;
            }
            return n;
        }
        if (n === 4) {
            if (num <= 1400 && offset === null)
                offset = Math.floor(num / 100) * 60 + (num % 100);
            else if (num > 1900 && num < 2100)
                tm.year = num - 1900;
            return n;
        }
        if (n > 2)
            return n;
        if (num > 0 && num < 32 && tm.mday < 0) {
            tm.mday = num;
            return n;
        }
        if (n === 2 && tm.year < 0) {
            if (num < 10 && tm.mday >= 0) {
                tm.year = num + 100;
                return n;
            }
            if (num >= 70) {
                tm.year = num;
                return n;
            }
        }
        if (num > 0 && num < 13 && tm.mon < 0)
            tm.mon = num - 1;
        return n;
    };
    const matchAlpha = (at) => {
        for (let i = 0; i < 12; i++) {
            const m = matchString(at, GIT_MONTHS[i]);
            if (m >= 3) {
                tm.mon = i;
                return m;
            }
        }
        for (let i = 0; i < 7; i++) {
            const m = matchString(at, GIT_WEEKDAYS[i]);
            if (m >= 3) {
                tm.wday = i;
                return m;
            }
        }
        for (const [name, hours, dst] of GIT_ZONES) {
            const m = matchString(at, name);
            if (m >= 3 || m === name.length) {
                if (offset === null)
                    offset = 60 * (hours + dst);
                return m;
            }
        }
        if (matchString(at, 'PM') === 2) {
            tm.hour = (tm.hour % 12) + 12;
            return 2;
        }
        if (matchString(at, 'AM') === 2) {
            tm.hour = tm.hour % 12;
            return 2;
        }
        // ISO 8601's 'T' before a time.
        if (text[at] === 'T' && isDigit(text[at + 1]) && tm.hour === -1) {
            tm.min = 0;
            tm.sec = 0;
            return 1;
        }
        let skip = 0;
        while (isAlpha(text[at + skip]))
            skip++;
        return skip;
    };
    const matchTz = (at) => {
        let [hour, end] = readNumber(at + 1);
        const n = end - (at + 1);
        let min = 0;
        if (n === 4) {
            min = hour % 100;
            hour = Math.floor(hour / 100);
        }
        else if (n !== 2)
            min = 99;
        else if (text[end] === ':') {
            [min, end] = readNumber(end + 1);
            if (end - (at + 1) !== 5)
                min = 99;
        }
        if (min < 60 && hour < 24)
            offset = (text[at] === '-' ? -1 : 1) * (hour * 60 + min);
        return end - at;
    };
    for (let at = 0; at < text.length && text[at] !== '\n';) {
        const c = text[at];
        let matched = 0;
        if (isAlpha(c))
            matched = matchAlpha(at);
        else if (isDigit(c))
            matched = matchDigit(at);
        else if ((c === '-' || c === '+') && isDigit(text[at + 1]))
            matched = matchTz(at);
        at += matched || 1;
    }
    let seconds = toTime(tm);
    if (seconds === null)
        return null;
    let minutesEast;
    if (offset === null) {
        // No zone given: the local one at that time, as mktime() reads the same fields.
        const local = new Date(tm.year + 1900, tm.mon, tm.mday, tm.hour, tm.min, tm.sec).getTime() / 1000;
        minutesEast = Math.round((seconds - local) / 60);
    }
    else
        minutesEast = offset;
    if (!gmt)
        seconds -= minutesEast * 60;
    return { seconds, zone: gitTimezone(minutesEast) };
}
/**
 * The author or committer identity git stamps an object with (ident.c):
 * GIT_<ROLE>_NAME and GIT_<ROLE>_EMAIL, else user.name and user.email from
 * the config, then the login name; and GIT_<ROLE>_DATE read by
 * parseGitDate, or now. A date git cannot read is its error.
 */
async function gitIdent(ctx, git, fs, dir, role) {
    const config = async (key) => {
        try {
            const value = await git.getConfig({ fs, dir, path: key });
            return typeof value === 'string' ? value : undefined;
        }
        catch {
            return undefined;
        }
    };
    const name = ctx.env[`GIT_${role}_NAME`] || await config('user.name') || ctx.env.USER || 'user';
    const email = ctx.env[`GIT_${role}_EMAIL`] || await config('user.email') || 'user@nimbus.dev';
    const raw = ctx.env[`GIT_${role}_DATE`];
    let seconds;
    let minutesEast;
    if (raw) {
        const parsed = parseGitDate(raw);
        if (!parsed)
            return { error: `fatal: invalid date format: ${raw}\n` };
        seconds = parsed.seconds;
        const zone = /^([+-])(\d{2})(\d{2})$/.exec(parsed.zone);
        minutesEast = (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
    }
    else {
        seconds = Math.floor(Date.now() / 1000);
        minutesEast = -new Date(seconds * 1000).getTimezoneOffset();
    }
    // Not -0: cf-git writes a negative zero offset as -0000, which is git's "zone unknown".
    return { name, email, timestamp: seconds, timezoneOffset: minutesEast === 0 ? 0 : -minutesEast };
}
/** An identity as a signature line: `Name <email> <seconds> ±hhmm`. */
function identLine(ident) {
    return `${ident.name} <${ident.email}> ${ident.timestamp} ${gitTimezone(-ident.timezoneOffset)}`;
}
/** Both identities a commit takes, or git's error for a date it cannot read. */
async function commitIdents(ctx, git, fs, dir) {
    const author = await gitIdent(ctx, git, fs, dir, 'AUTHOR');
    if ('error' in author)
        return author;
    const committer = await gitIdent(ctx, git, fs, dir, 'COMMITTER');
    if ('error' in committer)
        return committer;
    return { author, committer };
}
/**
 * git's stripspace (strbuf_stripspace): trailing whitespace, runs of blank
 * lines and blank lines at either end go, and with `stripComments` (the
 * `strip` cleanup, the default for a tag message) lines starting with the
 * comment character too. A non-empty result ends with a newline.
 */
function cleanupMessage(text, stripComments = true) {
    const lines = text.split('\n').filter((line) => !stripComments || !line.startsWith('#')).map((line) => line.replace(/\s+$/, ''));
    const out = [];
    for (const line of lines) {
        if (line === '' && (out.length === 0 || out[out.length - 1] === ''))
            continue;
        out.push(line);
    }
    while (out.length > 0 && out[out.length - 1] === '')
        out.pop();
    return out.length ? `${out.join('\n')}\n` : '';
}
/** A tag pattern (fnmatch: `*`, `?`, `[...]`) as a whole-name regular expression. */
function tagPattern(pattern) {
    let source = '';
    for (const ch of pattern) {
        source += ch === '*' ? '.*' : ch === '?' ? '.' : ch === '[' || ch === ']' ? ch : ch.replace(/[.*+?^${}()|\\/]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
}
/**
 * `git tag`: list (-l, patterns, -n<num> with each tag's message or its
 * commit's subject), create (lightweight, or annotated with -a, -m or -F,
 * a tag object as git writes it), replace (-f) and delete (-d), with git's
 * messages and exit codes.
 */
async function tagCommand(ctx, git, fs, vfs, args) {
    let annotate = false;
    let force = false;
    let del = false;
    let list = false;
    let lines = null;
    const messages = [];
    let messageFile = null;
    const operands = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            operands.push(...args.slice(i + 1));
            break;
        }
        if (arg === '-' || !arg.startsWith('-')) {
            operands.push(arg);
            continue;
        }
        if (arg === '--annotate') {
            annotate = true;
            continue;
        }
        if (arg === '--force') {
            force = true;
            continue;
        }
        if (arg === '--delete') {
            del = true;
            continue;
        }
        if (arg === '--list') {
            list = true;
            continue;
        }
        if (arg.startsWith('--message=')) {
            messages.push(arg.slice('--message='.length));
            continue;
        }
        if (arg === '--message') {
            messages.push(args[++i] ?? '');
            continue;
        }
        if (arg.startsWith('--file=')) {
            messageFile = arg.slice('--file='.length);
            continue;
        }
        if (arg === '--file') {
            messageFile = args[++i] ?? '';
            continue;
        }
        if (arg.startsWith('--')) {
            await ctx.stderr.write(`error: unknown option \`${arg.slice(2)}'\n${TAG_USAGE}`);
            return 129;
        }
        for (let j = 1; j < arg.length; j++) {
            const flag = arg[j];
            if (flag === 'a')
                annotate = true;
            else if (flag === 'f')
                force = true;
            else if (flag === 'd')
                del = true;
            else if (flag === 'l')
                list = true;
            else if (flag === 'n') {
                const digits = /^\d*/.exec(arg.slice(j + 1))?.[0] ?? '';
                lines = digits ? Number(digits) : 1;
                j += digits.length;
            }
            else if (flag === 'm' || flag === 'F') {
                const value = arg.slice(j + 1) || args[++i];
                if (value === undefined) {
                    await ctx.stderr.write(`error: switch \`${flag}' requires a value\n${TAG_USAGE}`);
                    return 129;
                }
                if (flag === 'm')
                    messages.push(value);
                else
                    messageFile = value;
                break;
            }
            else {
                await ctx.stderr.write(`error: unknown switch \`${flag}'\n${TAG_USAGE}`);
                return 129;
            }
        }
    }
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    const { gitdir } = repo;
    const dir = repo.worktree ?? ctx.cwd;
    const cache = {};
    const abbrev = (oid) => oid.slice(0, 7);
    if (del) {
        let code = 0;
        for (const name of operands) {
            let oid;
            try {
                oid = await git.resolveRef({ fs, gitdir, ref: `refs/tags/${name}` });
            }
            catch {
                await ctx.stderr.write(`error: tag '${name}' not found.\n`);
                code = 1;
                continue;
            }
            await git.deleteTag({ fs, dir, ref: name });
            await ctx.stdout.write(`Deleted tag '${name}' (was ${abbrev(oid)})\n`);
        }
        return code;
    }
    const creating = !list && lines === null && operands.length > 0;
    if (!creating) {
        const patterns = operands.map(tagPattern);
        const names = (await git.listTags({ fs, dir }))
            .filter((name) => patterns.length === 0 || patterns.some((pattern) => pattern.test(name)))
            .sort(comparePaths);
        let out = '';
        for (const name of names) {
            if (lines === null) {
                out += `${name}\n`;
                continue;
            }
            // The tag's own message, or for a lightweight tag its commit's (a tree or blob has none).
            let text = '';
            try {
                const oid = await git.resolveRef({ fs, gitdir, ref: `refs/tags/${name}` });
                // The raw object, split at its first blank line as git splits it: cf-git's
                // parsed form normalizes newlines first and misreads an empty message.
                const { type, object } = await git.readObject({ fs, dir, oid, cache, format: 'content' });
                if (type === 'tag' || type === 'commit') {
                    const raw = dec.decode(object);
                    const blank = raw.indexOf('\n\n');
                    text = blank < 0 ? '' : raw.slice(blank + 2).split('\n-----BEGIN PGP SIGNATURE-----')[0];
                }
            }
            catch { /* a broken ref lists bare */ }
            // The first <num> lines as they are, blank ones too, continuation lines indented.
            const shown = text.replace(/\n+$/, '').split('\n').slice(0, lines).map((line, i) => (i === 0 ? line : `    ${line}`));
            out += shown.length && lines > 0 ? `${name.padEnd(15)} ${shown.join('\n')}\n` : `${name}\n`;
        }
        await writeBinary(ctx.stdout, out);
        return 0;
    }
    const [name, target = 'HEAD', ...extra] = operands;
    if (extra.length > 0) {
        await ctx.stderr.write(`error: too many arguments\n${TAG_USAGE}`);
        return 129;
    }
    if (messageFile !== null) {
        try {
            messages.push(dec.decode(await vfs.readFile(normalizeVfsPath(messageFile.startsWith('/') ? messageFile : `${ctx.cwd}/${messageFile}`))));
        }
        catch {
            await ctx.stderr.write(`fatal: could not open or read '${messageFile}': No such file or directory\n`);
            return 128;
        }
    }
    if (annotate && messages.length === 0) {
        // git would open an editor, and this git has none: what git says with no editor to run.
        await ctx.stderr.write('error: Terminal is dumb, but EDITOR unset\nPlease supply the message using either -m or -F option.\n');
        return 1;
    }
    const object = await resolveRevision(git, fs, gitdir, target, cache);
    if (!object) {
        await ctx.stderr.write(`fatal: Failed to resolve '${target}' as a valid ref.\n`);
        return 128;
    }
    let previous = null;
    try {
        previous = await git.resolveRef({ fs, gitdir, ref: `refs/tags/${name}` });
    }
    catch { /* new */ }
    if (previous !== null && !force) {
        await ctx.stderr.write(`fatal: tag '${name}' already exists\n`);
        return 128;
    }
    let value;
    if (messages.length > 0) {
        const ident = await gitIdent(ctx, git, fs, dir, 'COMMITTER');
        if ('error' in ident) {
            await ctx.stderr.write(ident.error);
            return 128;
        }
        const tagger = identLine(ident);
        // The object as git writes it, byte for byte: the headers, a blank line,
        // then the cleaned message (nothing at all when it is empty). cf-git's
        // annotatedTag appends a newline after the message, which an empty one
        // must not have, and its parser then misreads the listing.
        const { type } = await git.readObject({ fs, dir, oid: object, cache: {}, format: 'parsed' });
        const body = `object ${object}\ntype ${type}\ntag ${name}\ntagger ${tagger}\n\n${cleanupMessage(messages.join('\n\n'))}`;
        value = await git.writeObject({ fs, dir, type: 'tag', object: new TextEncoder().encode(body), format: 'content' });
        await git.writeRef({ fs, dir, ref: `refs/tags/${name}`, value, force: true });
    }
    else {
        await git.tag({ fs, dir, ref: name, object, force: true });
        value = object;
    }
    if (previous !== null && previous !== value)
        await ctx.stdout.write(`Updated tag '${name}' (was ${abbrev(previous)})\n`);
    return 0;
}
const LS_FILES_USAGE = 'usage: git ls-files [-c | --cached] [-s | --stage] [-o | --others] [-m | --modified] [-d | --deleted] '
    + '[--exclude-standard] [-z] [--] [<path>...]\n';
async function lsFiles(ctx, git, vfs, fs, args) {
    let cached = false;
    let others = false;
    let modified = false;
    let deleted = false;
    let excludeStandard = false;
    let stage = false;
    let z = false;
    let dashdash = false;
    const pathArgs = [];
    for (const arg of args) {
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            pathArgs.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        for (const flag of arg.startsWith('--') ? [arg] : [...arg.slice(1)].map((c) => `-${c}`)) {
            switch (flag) {
                case '-c':
                case '--cached':
                    cached = true;
                    break;
                case '-o':
                case '--others':
                    others = true;
                    break;
                case '-m':
                case '--modified':
                    modified = true;
                    break;
                case '-d':
                case '--deleted':
                    deleted = true;
                    break;
                case '-z':
                    z = true;
                    break;
                case '--exclude-standard':
                    excludeStandard = true;
                    break;
                case '-s':
                case '--stage':
                    stage = true;
                    break;
                default:
                    await ctx.stderr.write(`error: unknown option '${flag.replace(/^-+/, '')}'\n${LS_FILES_USAGE}`);
                    return 129;
            }
        }
    }
    // With no selection ls-files shows the index; --stage shows it with each entry's mode, id and stage.
    if (!others && !modified && !deleted && !stage)
        cached = true;
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    const root = repo.worktree;
    if (!root) {
        await ctx.stderr.write(NOT_A_WORK_TREE);
        return 128;
    }
    // Without pathspecs ls-files covers the cwd's subtree.
    const specs = pathArgs.length ? repoPaths(pathArgs, ctx.cwd, root) : [repo.prefix];
    const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
    const dc = await wrepo.readIndex();
    const scan = others || modified || deleted
        ? await scanWorktree(await wrepo.worktree(), dc, {
            specs,
            untracked: others ? 'all' : 'no',
            excludes: excludeStandard ? await wrepo.excludes(dc) : null,
        })
        : null;
    for (const line of [...scan?.errors.tracked ?? [], ...scan?.errors.untracked ?? []])
        await ctx.stderr.write(`${line}\n`);
    let out = '';
    const flush = async () => {
        await writeBinary(ctx.stdout, out);
        out = '';
    };
    for (const path of (scan?.untracked ?? []).sort(comparePaths))
        out += pathLine(relativeTo(path, repo.prefix), z);
    let previous = null;
    for (const i of entriesInSpecs(dc, specs)) {
        const path = dc.path(i);
        const line = pathLine(relativeTo(path, repo.prefix), z);
        if (stage)
            out += `${dc.mode(i).toString(8).padStart(6, '0')} ${dc.oid(i)} ${dc.stage(i)}\t${line}`;
        // Otherwise a path once, however many stages it has.
        if (path === previous)
            continue;
        previous = path;
        const dirty = scan?.dirty.get(i);
        if (cached && !stage)
            out += line;
        // A directory where the file was is modified, not deleted: lstat finds something there.
        if (deleted && dirty?.change === 'D' && !dirty.directory)
            out += line;
        if (modified && dirty)
            out += line;
        if (out.length >= 1 << 16)
            await flush();
    }
    await flush();
    return 0;
}
/**
 * The index entries that restoring `restored` replaces (add_index_entry_with_check):
 * a file at one of a restored path's leading directories, or anything below a
 * restored path. Each restored path costs lookups, not a pass over the index.
 */
export function replacedIndexEntries(dc, restored) {
    const replaced = new Set();
    const take = (lo, hi) => {
        for (let i = lo; i < hi; i++)
            if (!restored.has(dc.path(i)))
                replaced.add(i);
    };
    for (const path of restored) {
        for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) {
            const lo = dc.find(path.slice(0, at));
            if (lo < 0)
                continue;
            let hi = lo + 1;
            while (hi < dc.count && dc.path(hi) === dc.path(lo))
                hi++;
            take(lo, hi);
        }
        take(...dc.rangeUnder(path));
    }
    return replaced;
}
/**
 * A checkout cf-git refused, as git reports one: its message on stderr, exit 1. A merge
 * that is not a fast-forward (`strategy`) refuses as its strategy does, with that line
 * after it and exit 2. Anything else propagates.
 */
async function refusal(ctx, error, strategy) {
    if (error instanceof UnmergedIndex) {
        await writeBinary(ctx.stdout, binaryPath(error.paths.map((path) => `${path}: needs merge\n`).join('')));
        await ctx.stderr.write(error.message);
        return 1;
    }
    if (!(error instanceof CheckoutRefused))
        throw error;
    await ctx.stderr.write(`${error.message}${strategy ? `Merge with strategy ${strategy} failed.\n` : ''}`);
    return strategy ? 2 : 1;
}
/** createGitFs's worktree rule (a link or file in a directory's way is replaced), as the checkout writer. */
function checkoutWriter(vfs, root) {
    const fs = createGitFs(vfs, root);
    return {
        writeFile: (path, data) => fs.promises.writeFile(path, data),
        symlink: (target, path) => fs.promises.symlink(target, path),
        unlink: (path) => fs.promises.unlink(path),
        rmdir: (path) => fs.promises.rmdir(path),
        mkdir: (path) => fs.promises.mkdir(path),
        chmod: async (path, mode) => { await vfs.chmod(normalizeVfsPath(path), mode); },
    };
}
/**
 * Move the worktree and index to commit `oid`: unforced as a branch switch
 * (or, `operation` 'merge', a merge's fast-forward) refuses what git refuses,
 * forced as reset --hard. HEAD is not touched; a refusal throws
 * CheckoutRefused or UnmergedIndex, whose messages are git's.
 */
async function moveWorktree(ctx, git, vfs, fs, repo, oid, { force = false, operation = 'checkout' } = {}) {
    const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, repo.worktree);
    await wrepo.withIndexLock(async () => {
        const dc = await wrepo.readIndex();
        const head = force ? null : await wrepo.headTree();
        const edit = await switchTrees({
            store: wrepo.store,
            tree: await wrepo.worktree(),
            dc,
            excludes: await wrepo.excludes(dc),
            root: repo.worktree,
            writer: checkoutWriter(vfs, repo.worktree),
            operation,
        }, head === EMPTY_TREE ? null : head, await treeOf(wrepo.store, oid), force);
        await wrepo.writeIndex(dc, edit);
    });
}
/**
 * `git checkout <branch>`: the worktree moved to the branch's commit, then
 * HEAD to the branch, or detached at a commit for any other revision. A name
 * only origin has as a branch becomes a local branch that tracks it, as
 * git's checkout DWIM makes one.
 */
async function switchBranch(ctx, git, vfs, fs, dir, ref) {
    const repo = await discoverRepo(vfs, dir);
    if (!repo?.worktree)
        throw new Error('this operation must be run in a work tree');
    const { gitdir } = repo;
    let oid;
    try {
        oid = await git.resolveRef({ fs, gitdir, ref });
    }
    catch (error) {
        if (!isNotFound(error))
            throw error;
        try {
            oid = await git.resolveRef({ fs, gitdir, ref: `origin/${ref}` });
        }
        catch {
            throw error;
        }
        await git.setConfig({ fs, gitdir, path: `branch.${ref}.remote`, value: 'origin' });
        await git.setConfig({ fs, gitdir, path: `branch.${ref}.merge`, value: `refs/heads/${ref}` });
        await git.writeRef({ fs, dir, ref: `refs/heads/${ref}`, value: oid, force: true });
    }
    await moveWorktree(ctx, git, vfs, fs, repo, oid);
    let full = '';
    try {
        full = await git.expandRef({ fs, gitdir, ref });
    }
    catch { /* a commit, not a ref */ }
    if (full.startsWith('refs/heads/')) {
        await git.writeRef({ fs, dir, ref: 'HEAD', value: full, force: true, symbolic: true });
        return;
    }
    // Detached, at the commit: an annotated tag's own object is not one.
    for (;;) {
        const { type, object } = await git.readObject({ fs, dir, oid, cache: {}, format: 'parsed' });
        if (type !== 'tag')
            break;
        oid = object.object;
    }
    await git.writeRef({ fs, dir, ref: 'HEAD', value: oid, force: true });
}
/**
 * `git checkout [<tree-ish>] -- <pathspec>...`: every tracked file the
 * pathspecs name, from the index, or from <tree-ish> into the index as well
 * (overlay mode: a path the tree lacks stays). A pathspec naming nothing fails
 * the command before any file is written, as in git. The files are written as
 * git's checkout writes them: see createGitFs's worktree rule.
 */
async function checkoutPaths(ctx, git, vfs, fs, source, pathArgs) {
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    const root = repo.worktree;
    if (!root) {
        await ctx.stderr.write(NOT_A_WORK_TREE);
        return 128;
    }
    const specs = repoPaths(pathArgs, ctx.cwd, root);
    // A pathspec ending in '/' names a directory: it matches what is below it, never a file or link there.
    const dirOnly = pathArgs.map((arg, i) => arg.endsWith('/') && specs[i] !== '');
    const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
    return await wrepo.withIndexLock(async () => {
        const dc = await wrepo.readIndex();
        const files = [];
        const matched = new Set();
        const take = (path, oid, mode) => {
            // A gitlink is never checked out.
            if ((mode & 0o170000) === 0o160000)
                return;
            const matching = specs.flatMap((spec, i) => spec === '' || path.startsWith(`${spec}/`) || (path === spec && !dirOnly[i]) ? [i] : []);
            if (matching.length === 0)
                return;
            for (const i of matching)
                matched.add(i);
            files.push({ path, oid, mode });
        };
        if (source === null) {
            for (const i of entriesInSpecs(dc, specs))
                if (dc.stage(i) === 0)
                    take(dc.path(i), dc.oid(i), dc.mode(i));
        }
        else {
            const oid = await resolveRevision(git, wrepo.gitFs, repo.gitdir, source, {});
            if (!oid) {
                await ctx.stderr.write(`fatal: invalid reference: ${source}\n`);
                return 128;
            }
            const within = (dir) => inSpecs(specs, dir) || specs.some((spec) => spec.startsWith(`${dir}/`));
            for await (const leaf of treeLeaves(wrepo.store, await treeOf(wrepo.store, oid), '', within)) {
                if (inSpecs(specs, leaf.path))
                    take(leaf.path, leaf.oid, leaf.mode);
            }
        }
        let unmatched = '';
        pathArgs.forEach((arg, i) => {
            if (!matched.has(i))
                unmatched += `error: pathspec '${arg}' did not match any file(s) known to git\n`;
        });
        if (unmatched) {
            await ctx.stderr.write(unmatched);
            return 1;
        }
        const writer = checkoutWriter(vfs, root);
        await wrepo.store.prefetch(files.map(({ oid }) => oid));
        const added = new NewEntries();
        for (const { path, oid, mode } of files) {
            const file = `${root}/${path}`;
            const { data } = await wrepo.store.read(oid);
            if (mode === 0o120000) {
                await writer.symlink(dec.decode(data), file);
            }
            else {
                await writer.writeFile(file, data);
                await writer.chmod(file, mode === 0o100755 ? 0o755 : 0o644);
            }
            added.add({ path, mode, oid, stat: await wrepo.fs.lstat(path) });
        }
        // The index takes each file's fresh stat data (and, from a tree, its blob). An entry a
        // restored path replaces goes, as add_index_entry_with_check replaces it: a file at
        // one of its leading directories, or anything below it.
        const removed = replacedIndexEntries(dc, new Set(files.map(({ path }) => path)));
        if (added.count || removed.size)
            await wrepo.writeIndex(dc, { removed, added });
        return 0;
    });
}
/**
 * diff-files, diff-index and diff-index --cached, as git's diff queue in
 * columns: the worktree walk for the worktree side, the tree and index walked
 * together for a tree. Only changed paths are held.
 */
async function changedPairs(wrepo, dc, base, specs, errors) {
    const pairs = new PairList();
    const tree = await wrepo.worktree();
    const indexSide = (i) => ({ oid: dc.oid(i), mode: dc.mode(i), worktree: false });
    // The worktree's side of entry i: its blob (hashed only if it changed) at the mode it is read with.
    const worktreeSide = async (i, dirty) => {
        if (!dirty)
            return { ...indexSide(i), worktree: true };
        // The walk kept only how the entry changed: its stat is taken again.
        const st = dirty.change === 'D' ? null : await tree.fs.lstat(dc.path(i));
        // A missing file, or a directory where the file was, is a deletion.
        if (st === null || st.type === 'directory' || st.type === 'other')
            return null;
        const oid = dirty.oid ?? await worktreeBlobId(tree, dc.path(i), st);
        return { oid, mode: modeFromStat(st, dc.mode(i), tree.filemode), worktree: true };
    };
    const scan = base.kind === 'tree' && base.cached ? null : await scanWorktree(tree, dc, { specs, untracked: 'no', excludes: null });
    for (const line of scan?.errors.tracked ?? [])
        await errors.write(`${line}\n`);
    const dirty = scan?.dirty ?? new DirtySet(0);
    if (base.kind === 'index') {
        for (const [i, change] of dirty)
            pairs.add(dc.path(i), indexSide(i), await worktreeSide(i, change));
        return pairs;
    }
    // Where the cache tree vouches for a subtree, the tree and the index agree there and the walk skips it;
    // a worktree change below it is then the index's side against the worktree's.
    const seen = new Set();
    await walkTreeAndIndex(wrepo.store, base.tree, dc, specs, async (path, leaf, lo, hi) => {
        // diff-index: a path the index lacks (or holds unmerged) is deleted whatever the worktree holds.
        const entry = hi - lo === 1 && dc.stage(lo) === 0 ? lo : -1;
        if (dirty.has(entry))
            seen.add(entry);
        const two = entry < 0 ? null : base.cached ? indexSide(entry) : await worktreeSide(entry, dirty.get(entry));
        pairs.add(path, leaf, two);
    }, { cacheTree: dc.cacheTree() });
    for (const [i, change] of dirty)
        if (!seen.has(i) && dc.stage(i) === 0)
            pairs.add(dc.path(i), indexSide(i), await worktreeSide(i, change));
    return pairs;
}
/**
 * The diff queue in git's order after rename detection, one pair at a time.
 * Modifications pass through as they are; the additions and deletions, the
 * only pairs renames are found among, are taken out as objects, matched, and
 * put back where git's diffcore_rename puts them: a rename at its
 * destination, an unused deletion at its own path.
 */
async function* diffQueue(pairs, minimumScore, read, noted) {
    const order = pairs.order();
    let others = [];
    for (const k of order)
        if (!pairs.modified(k))
            others.push(pairs.pair(k));
    if (minimumScore !== null && others.some((pair) => pair.one) && others.some((pair) => pair.two)) {
        const found = await detectRenames(others, read, { minimumScore });
        others = found.queue;
        noted.neededRenameLimit = found.neededRenameLimit;
    }
    const anchor = (pair) => (pair.two ?? pair.one).path;
    let next = 0;
    for (const k of order) {
        if (!pairs.modified(k))
            continue;
        const pair = pairs.pair(k);
        while (next < others.length && comparePaths(anchor(others[next]), pair.one.path) < 0)
            yield others[next++];
        yield pair;
    }
    while (next < others.length)
        yield others[next++];
}
/** Print pairs one at a time, each loaded only while it is rendered. */
async function writeDiff(ctx, pairs, output) {
    const stats = new StatList();
    let out = '';
    for await (const load of pairs) {
        const pair = await load();
        if (output.format === 'stat')
            stats.push(statFile(pair));
        else if (output.format === 'name-only')
            out += formatNameOnly(pair, output.z);
        else if (output.format === 'name-status')
            out += formatNameStatus(pair, output.z);
        else
            out += formatPatch(pair, output.context);
        if (out.length >= 1 << 16) {
            await writeBinary(ctx.stdout, out);
            out = '';
        }
    }
    if (output.format === 'stat') {
        for (const line of formatStat(stats, output.columns)) {
            out += line;
            if (out.length >= 1 << 16) {
                await writeBinary(ctx.stdout, out);
                out = '';
            }
        }
    }
    await writeBinary(ctx.stdout, out);
}
/** `git diff --no-index`: two paths, either of them /dev/null; exits 1 when they differ. */
async function diffNoIndex(ctx, git, vfs, paths, output) {
    if (paths.length !== 2) {
        await ctx.stderr.write('usage: git diff --no-index [<options>] <path> <path>\n');
        return 129;
    }
    const key = (path) => normalizeVfsPath(path.startsWith('/') ? path : `${ctx.cwd}/${path}`);
    const isDir = await Promise.all(paths.map(async (path) => path !== '/dev/null' && await vfs.isDirectory(key(path))));
    if (isDir[0] && isDir[1]) {
        await ctx.stderr.write('error: --no-index between two directories is not supported\n');
        return 129;
    }
    // fixup_paths: a directory against a file means that file's namesake inside it.
    if (isDir[0] !== isDir[1]) {
        const dirSide = isDir[0] ? 0 : 1;
        const file = paths[1 - dirSide];
        paths[dirSide] = `${paths[dirSide].replace(/\/+$/, '')}/${file.slice(file.lastIndexOf('/') + 1)}`;
    }
    const specs = [];
    for (const path of paths) {
        if (path === '/dev/null') {
            specs.push(absentSpec(path));
            continue;
        }
        let st;
        try {
            st = await vfs.lstat(key(path));
        }
        catch {
            await ctx.stderr.write(`error: Could not access '${path}'\n`);
            return 1;
        }
        const link = st.type === 'symlink';
        const data = link ? enc.encode(await vfs.readlink(key(path))) : await vfs.readFile(key(path));
        const { oid } = await git.hashBlob({ object: data });
        // canon_mode: the owner's execute bit alone decides 100755.
        const mode = link ? 0o120000 : st.mode & 0o100 ? 0o100755 : 0o100644;
        specs.push({ path, valid: true, oid, mode, data });
    }
    const [one, two] = specs;
    if (!one.valid && !two.valid)
        return 0;
    if (one.valid && two.valid && one.oid === two.oid && one.mode === two.mode)
        return 0;
    await writeDiff(ctx, [async () => ({ one, two })], output);
    return 1;
}
const DIFF_USAGE = 'usage: git diff [--cached] [<commit>] [--] [<path>...]\n'
    + '   or: git diff --no-index [--] <path> <path>\n'
    + 'options: --stat | --name-only | --name-status, -z, -U<n>, -M[<n>] | --no-renames\n';
async function diffCommand(ctx, git, fs, vfs, args, partial) {
    let cached = false;
    let noIndex = false;
    let dashdash = false;
    // Renames are on by default, as with git's diff.renames; null turns them off.
    let minimumScore = DEFAULT_RENAME_SCORE;
    const output = {
        format: 'patch',
        z: false,
        context: DEFAULT_CONTEXT,
        columns: parseInt(ctx.env.COLUMNS ?? '', 10) > 0 ? parseInt(ctx.env.COLUMNS, 10) : 80,
    };
    const positionals = [];
    const pathArgs = [];
    for (const arg of args) {
        if (dashdash) {
            pathArgs.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        if (arg === '-' || !arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }
        const context = /^(?:-U|--unified=)(\d+)$/.exec(arg);
        if (context) {
            output.context = Number(context[1]);
            continue;
        }
        const findRenames = /^(?:-M|--find-renames(?:=|$))(.*)$/.exec(arg);
        if (findRenames) {
            const score = parseRenameScore(findRenames[1]);
            if (score === null) {
                await ctx.stderr.write(`error: invalid argument to find-renames\n${DIFF_USAGE}`);
                return 129;
            }
            minimumScore = score || DEFAULT_RENAME_SCORE;
            continue;
        }
        switch (arg) {
            case '--cached':
            case '--staged':
                cached = true;
                continue;
            case '--no-index':
                noIndex = true;
                continue;
            case '-z':
                output.z = true;
                continue;
            case '--no-renames':
                minimumScore = null;
                continue;
            // A patch is the default, and nothing here colors or runs external tools.
            case '-p':
            case '-u':
            case '--patch':
            case '--no-ext-diff':
            case '--no-color': continue;
            case '--stat':
            case '--name-only':
            case '--name-status': {
                const format = arg.slice(2);
                if (output.format !== 'patch' && output.format !== format) {
                    await ctx.stderr.write(`fatal: options '--${output.format}' and '${arg}' cannot be used together\n`);
                    return 128;
                }
                output.format = format;
                continue;
            }
        }
        await ctx.stderr.write(`error: unknown option '${arg.replace(/^-+/, '')}'\n${DIFF_USAGE}`);
        return 129;
    }
    if (noIndex) {
        if (cached) {
            await ctx.stderr.write("fatal: options '--cached' and '--no-index' cannot be used together\n");
            return 128;
        }
        return diffNoIndex(ctx, git, vfs, [...positionals, ...pathArgs], output);
    }
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    const root = repo.worktree;
    if (!root) {
        await ctx.stderr.write(NOT_A_WORK_TREE);
        return 128;
    }
    const cache = {};
    const revs = [];
    for (const arg of positionals) {
        // Before `--` a word is a revision until one is not; then it and the rest must be paths.
        const oid = pathArgs.length && !dashdash ? null : await resolveRevision(git, fs, repo.gitdir, arg, cache);
        if (oid !== null) {
            revs.push(oid);
            continue;
        }
        if (dashdash) {
            await ctx.stderr.write(`fatal: bad revision '${arg}'\n`);
            return 128;
        }
        if (!await vfs.exists(normalizeVfsPath(arg.startsWith('/') ? arg : `${ctx.cwd}/${arg}`))) {
            await ctx.stderr.write(ambiguousArgument(arg));
            return 128;
        }
        pathArgs.push(arg);
    }
    if (revs.length > 1) {
        await ctx.stderr.write('fatal: diff between two commits is not supported; compare one commit with the worktree or the index\n');
        return 128;
    }
    const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
    const dc = await wrepo.readIndex();
    const base = cached
        ? { kind: 'tree', tree: revs.length ? await treeOf(wrepo.store, revs[0]) : await wrepo.headTree(), cached: true }
        : revs.length ? { kind: 'tree', tree: await treeOf(wrepo.store, revs[0]), cached: false } : { kind: 'index' };
    const pending = await changedPairs(wrepo, dc, base, repoPaths(pathArgs, ctx.cwd, root), ctx.stderr);
    // git diff writes back the stat it found stale on files whose content had not changed.
    await wrepo.updateIndexIfAble(dc);
    // The blobs this diff reads, fetched together where a partial clone lacks them (git's diff_queued_diff_prefetch).
    if ((output.format === 'patch' || output.format === 'stat' || minimumScore !== null) && await partial(repo.gitdir)) {
        await wrepo.store.prefetch(pending.storeOids());
    }
    const tree = await wrepo.worktree();
    const read = async (side) => side.worktree
        ? await worktreeBlob(tree, side.path, side.mode === 0o120000 ? 'symlink' : 'file')
        : (await wrepo.store.read(side.oid)).data;
    const noted = { neededRenameLimit: 0 };
    const withData = output.format === 'patch' || output.format === 'stat';
    const spec = async (side) => ({
        path: side.path,
        valid: true,
        oid: side.oid,
        mode: side.mode,
        data: withData ? await read(side) : new Uint8Array(0),
    });
    await writeDiff(ctx, (async function* () {
        for await (const { one, two, renameScore } of diffQueue(pending, minimumScore, read, noted)) {
            yield async () => ({
                one: one ? await spec(one) : absentSpec(two.path),
                two: two ? await spec(two) : absentSpec(one.path),
                renameScore,
            });
        }
    })(), output);
    const { neededRenameLimit } = noted;
    if (neededRenameLimit) {
        await ctx.stderr.write('warning: exhaustive rename detection was skipped due to too many files.\n'
            + `warning: you may want to set your diff.renameLimit variable to at least ${neededRenameLimit} and retry the command.\n`);
    }
    return 0;
}
// ── status, commit, reset ────────────────────────────────────────────────
const STATUS_USAGE = 'usage: git status [-s | --short] [--porcelain[=v1]] [-z] [-u[<mode>] | --untracked-files[=<mode>]]\n'
    + '                  [--renames | --no-renames] [--] [<pathspec>...]\n';
/** git status's options this git does not do: they are git's, so they are refused as unsupported, not unknown. */
const STATUS_UNSUPPORTED = new Set(['b', 'v', '--branch', '--long', '--verbose', '--show-stash', '--ignored', '--ignore-submodules',
    '--column', '--no-column', '--ahead-behind', '--no-ahead-behind', '--find-renames', '-M']);
/**
 * `git status`. The short form (-s) and porcelain v1 (--porcelain, or -z)
 * are git's byte for byte. With neither, the form is Nimbus's own: the short
 * lines, colored (staged-only green, the rest red), and "nothing to commit,
 * working tree clean" when there is nothing to show. Like git, it writes the
 * index back when it refreshed stat data or the index has racy entries.
 */
async function statusCommand(ctx, git, vfs, fs, args) {
    let format = 'nimbus';
    let z = false;
    let untracked = null;
    let renames = null;
    let dashdash = false;
    const pathArgs = [];
    const unsupported = async (flag) => {
        await ctx.stderr.write(`fatal: git status ${flag.length === 1 ? `-${flag}` : flag} is not supported here\n`);
        return 128;
    };
    const untrackedMode = async (mode) => {
        if (mode === 'no' || mode === 'normal' || mode === 'all') {
            untracked = mode;
            return true;
        }
        await ctx.stderr.write(`fatal: Invalid untracked files mode '${mode}'\n`);
        return false;
    };
    for (const arg of args) {
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            pathArgs.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        if (arg.startsWith('--')) {
            const [flag, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
            if (flag === '--short')
                format = 'short';
            else if (flag === '--porcelain' && (value === null || value === 'v1' || value === '1'))
                format = 'porcelain';
            else if (flag === '--porcelain')
                return await unsupported(arg);
            else if (flag === '--null')
                z = true;
            else if (flag === '--untracked-files') {
                if (!await untrackedMode(value ?? 'all'))
                    return 128;
            }
            else if (flag === '--renames')
                renames = true;
            else if (flag === '--no-renames')
                renames = false;
            else if (STATUS_UNSUPPORTED.has(flag))
                return await unsupported(flag);
            else {
                await ctx.stderr.write(`error: unknown option \`${arg.slice(2)}'\n${STATUS_USAGE}`);
                return 129;
            }
            continue;
        }
        for (let i = 1; i < arg.length; i++) {
            const flag = arg[i];
            if (flag === 's')
                format = 'short';
            else if (flag === 'z')
                z = true;
            else if (flag === 'u') {
                if (!await untrackedMode(arg.slice(i + 1) || 'all'))
                    return 128;
                break;
            }
            else if (STATUS_UNSUPPORTED.has(flag))
                return await unsupported(flag);
            else {
                await ctx.stderr.write(`error: unknown switch \`${flag}'\n${STATUS_USAGE}`);
                return 129;
            }
        }
    }
    // -z alone is porcelain v1.
    if (z && format === 'nimbus')
        format = 'porcelain';
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    const root = repo.worktree;
    if (!root) {
        await ctx.stderr.write(NOT_A_WORK_TREE);
        return 128;
    }
    const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
    if (untracked === null) {
        const configured = await wrepo.config('status.showuntrackedfiles');
        const flag = configBool(configured);
        untracked = flag === false ? 'no' : configured === 'all' ? 'all' : 'normal';
    }
    if (renames === null) {
        const configured = await wrepo.config('status.renames') ?? await wrepo.config('diff.renames');
        renames = configured === 'copies' || configured === 'copy' || (configBool(configured) ?? true);
    }
    const dc = await wrepo.readIndex();
    const status = await collectStatus(wrepo.store, await wrepo.worktree(), dc, await wrepo.headTree(), {
        specs: repoPaths(pathArgs, ctx.cwd, root),
        untracked,
        excludes: untracked === 'no' ? null : await wrepo.excludes(dc),
        renames,
    });
    for (const line of status.errors)
        await ctx.stderr.write(`${line}\n`);
    await wrepo.updateIndexIfAble(dc);
    const prefix = repo.prefix ? `${repo.prefix}/` : '';
    // Lines go out as they are made, 64 KiB at a time: a status of every file is never one string.
    let out = '';
    const emit = async (text) => {
        out += text;
        if (out.length >= 1 << 16) {
            await writeBinary(ctx.stdout, out);
            out = '';
        }
    };
    if (format !== 'nimbus') {
        for (const text of shortStatusLines({ changes: status.changes(), untracked: status.untracked }, { prefix: format === 'short' && !z ? prefix : '', z })) {
            await emit(text);
        }
        await writeBinary(ctx.stdout, out);
        return 0;
    }
    if (status.count === 0 && status.untracked.length === 0) {
        await ctx.stdout.write('nothing to commit, working tree clean\n');
        return 0;
    }
    // Nimbus's own form: the short lines, staged-only green, the rest red.
    const color = (change, text) => `${change !== null && !change.unmerged && change.worktree === ' ' ? '\x1b[32m' : '\x1b[31m'}${text.slice(0, -1)}\x1b[0m\n`;
    for (const change of status.changes()) {
        for (const text of shortStatusLines({ changes: [change], untracked: [] }, { prefix, z: false }))
            await emit(color(change, text));
    }
    for (const text of shortStatusLines({ changes: [], untracked: status.untracked }, { prefix, z: false }))
        await emit(color(null, text));
    await writeBinary(ctx.stdout, out);
    return 0;
}
/**
 * `git merge <theirs>` into the current branch (or HEAD when detached): the
 * merged tree from cf-git, then the worktree and index moved to it by the
 * one checkout policy, the branch last, so a merge git refuses ("would be
 * overwritten by merge") changes nothing. `git pull` merges through here.
 */
async function mergeCommand(ctx, git, fs, vfs, dir, theirs, quiet, partial) {
    const ours = await git.currentBranch({ fs, gitdir: `${dir}/.git`, fullname: true }) ?? 'HEAD';
    const repo = await discoverRepo(vfs, dir);
    if (!repo?.worktree) {
        await ctx.stderr.write(NOT_A_WORK_TREE);
        return 128;
    }
    if ((await worktreeRepo(ctx, git, vfs, fs, repo.gitdir, repo.worktree).readIndex()).unmergedPaths().length) {
        await ctx.stderr.write(unmergedRefusal('Merging'));
        return 128;
    }
    const idents = await commitIdents(ctx, git, fs, dir);
    if ('error' in idents) {
        await ctx.stderr.write(idents.error);
        return 128;
    }
    if (await partial(repo.gitdir)) {
        const theirsOid = await git.resolveRef({ fs, gitdir: repo.gitdir, ref: theirs });
        const oursOid = await git.resolveRef({ fs, gitdir: repo.gitdir, ref: ours });
        const bases = await git.findMergeBase({ fs, dir, oids: [oursOid, theirsOid] });
        await prefetchCommits(git, fs, repo.gitdir, [theirsOid, ...bases], partial);
    }
    const merged = await git.merge({ fs, dir, ours, theirs, ...idents, noUpdateBranch: true });
    if (!merged.alreadyMerged) {
        try {
            await moveWorktree(ctx, git, vfs, fs, repo, merged.oid, { operation: 'merge' });
        }
        catch (e) {
            return await refusal(ctx, e, merged.fastForward ? undefined : 'ort');
        }
        await git.writeRef({ fs, dir, ref: ours, value: merged.oid, force: true });
    }
    if (!quiet)
        await ctx.stdout.write(`Merged ${theirs}\n`);
    return 0;
}
/** die_resolve_conflict: what git says when unmerged entries stop a commit or a merge. */
function unmergedRefusal(action) {
    return `error: ${action} is not possible because you have unmerged files.\n`
        + "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n"
        + 'hint: as appropriate to mark resolution and make a commit.\n'
        + 'fatal: Exiting because of an unresolved conflict.\n';
}
/**
 * `git commit`'s tree and commit object: the index written as trees (only
 * those the repository lacks), the commit on HEAD's commit, and the branch
 * (or a detached HEAD) moved to it. Unmerged entries refuse, as git does.
 */
async function commitIndex(ctx, git, wrepo, message, idents) {
    const dc = await wrepo.readIndex();
    for (let i = 0; i < dc.count; i++) {
        if (dc.stage(i) === 0)
            continue;
        await ctx.stderr.write(unmergedRefusal('Committing'));
        return null;
    }
    const { oid: tree, cacheTree } = await writeTreeFromIndex(wrepo.store, dc);
    let parent = '';
    try {
        parent = `parent ${await git.resolveRef({ fs: wrepo.gitFs, gitdir: wrepo.gitdir, ref: 'HEAD' })}\n`;
    }
    catch { /* the first commit */ }
    const object = `tree ${tree}\n${parent}author ${identLine(idents.author)}\ncommitter ${identLine(idents.committer)}\n\n${message}`;
    const oid = await wrepo.store.write('commit', enc.encode(object));
    const branch = await git.currentBranch({ fs: wrepo.gitFs, gitdir: wrepo.gitdir, fullname: true });
    await git.writeRef({ fs: wrepo.gitFs, dir: wrepo.root, ref: branch ?? 'HEAD', value: oid, force: true });
    // The index keeps the trees it was written as (update_main_cache_tree), as git's commit writes it.
    dc.setCacheTree(cacheTree);
    if (dc.cacheTreeChanged)
        await wrepo.writeIndex(dc);
    return oid;
}
/**
 * reset_index: index entries for `specs` ('' everything) become `tree`'s,
 * then the whole index is refreshed and what still differs from the worktree
 * printed under "Unstaged changes after reset:", unless `quiet`, and the
 * index written once.
 */
async function resetIndex(ctx, wrepo, tree, specs, quiet) {
    await wrepo.withIndexLock(async () => {
        const dc = await indexFromTree(wrepo, tree, specs);
        const scan = await scanWorktree(await wrepo.worktree(), dc, { untracked: 'no', excludes: null });
        for (const line of scan.errors.tracked)
            await ctx.stderr.write(`${line}\n`);
        if (!quiet && scan.dirty.size) {
            let out = 'Unstaged changes after reset:\n';
            for (const [i, dirty] of scan.dirty)
                out += `${dirty.change}\t${dc.path(i)}\n`;
            await writeBinary(ctx.stdout, binaryPath(out));
        }
        await wrepo.writeIndex(dc);
    });
}
/**
 * read_from_tree: the index with `tree`'s entries for `specs`, an unchanged
 * one keeping its stat. The index read is dropped here, so a reset holds one
 * index, not two.
 */
async function indexFromTree(wrepo, tree, specs) {
    const old = await wrepo.readIndex();
    const removed = new Set();
    const added = new NewEntries();
    await walkTreeAndIndex(wrepo.store, tree, old, specs, (path, leaf, lo, hi) => {
        if (leaf && hi - lo === 1 && old.stage(lo) === 0 && old.oid(lo) === leaf.oid && old.mode(lo) === leaf.mode)
            return;
        for (let i = lo; i < hi; i++)
            removed.add(i);
        if (leaf)
            added.add({ path, mode: leaf.mode, oid: leaf.oid, stat: null });
    }, { cacheTree: old.cacheTree() });
    return removed.size || added.count ? DirCache.parse(old.encode({ removed, added }), old.timestamp) : old;
}
const RESET_USAGE = 'usage: git reset [--mixed | --soft | --hard] [-q] [<commit>]\n'
    + '   or: git reset [-q] [<tree-ish>] [--] <pathspec>...\n';
/** `git reset`: --soft moves HEAD, --mixed (the default) the index with it, --hard the worktree too; paths reset index entries. */
async function resetCommand(ctx, git, vfs, fs, args, prefetch) {
    let mode = 'mixed';
    let quiet = false;
    const dashdash = args.indexOf('--');
    const words = [];
    for (const [at, arg] of args.entries()) {
        if (dashdash >= 0 && at >= dashdash)
            break;
        if (arg === '--soft' || arg === '--mixed' || arg === '--hard')
            mode = arg === '--soft' ? 'soft' : arg === '--hard' ? 'hard' : 'mixed';
        else if (arg === '-q' || arg === '--quiet')
            quiet = true;
        else if (arg.startsWith('-')) {
            await ctx.stderr.write(`error: unknown option \`${arg.replace(/^-+/, '')}'\n${RESET_USAGE}`);
            return 129;
        }
        else
            words.push(arg);
    }
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    // Before `--` the first word is a revision when it names one; the rest are paths.
    let rev = 'HEAD';
    let oid = words.length ? await resolveRevision(git, fs, repo.gitdir, words[0], {}) : null;
    const pathArgs = [...(dashdash >= 0 ? args.slice(dashdash + 1) : [])];
    if (oid !== null)
        rev = words[0];
    else if (dashdash >= 0 && words.length) {
        await ctx.stderr.write(`fatal: bad revision '${words[0]}'\n`);
        return 128;
    }
    pathArgs.unshift(...(oid === null ? words : words.slice(1)));
    oid ??= await resolveRevision(git, fs, repo.gitdir, 'HEAD', {});
    if (oid === null) {
        await ctx.stderr.write("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n");
        return 128;
    }
    const root = repo.worktree;
    if (pathArgs.length) {
        if (mode !== 'mixed') {
            await ctx.stderr.write(`fatal: Cannot do ${mode} reset with paths.\n`);
            return 128;
        }
        if (!root) {
            await ctx.stderr.write(NOT_A_WORK_TREE);
            return 128;
        }
        const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
        await resetIndex(ctx, wrepo, await treeOf(wrepo.store, oid), repoPaths(pathArgs, ctx.cwd, root), quiet);
        return 0;
    }
    if (mode !== 'soft' && !root) {
        await ctx.stderr.write(NOT_A_WORK_TREE);
        return 128;
    }
    const { type, object } = await git.readObject({ fs, dir: root ?? repo.gitdir, oid, cache: {}, format: 'parsed' });
    if (type !== 'commit') {
        await ctx.stderr.write(`fatal: Could not parse object '${rev}'.\n`);
        return 128;
    }
    // The index and worktree become the target's (a forced checkout, type changes included) before the branch moves.
    if (mode === 'hard') {
        await prefetch(repo.gitdir, [oid]);
        await moveWorktree(ctx, git, vfs, fs, repo, oid, { force: true });
    }
    else if (mode === 'mixed') {
        const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
        await resetIndex(ctx, wrepo, await treeOf(wrepo.store, oid), [], quiet);
    }
    const branch = await git.currentBranch({ fs, gitdir: repo.gitdir, fullname: true });
    await git.writeRef({ fs, dir: root ?? repo.gitdir, ref: branch ?? 'HEAD', value: oid, force: true });
    if (mode === 'hard' && !quiet) {
        const subject = String(object.message ?? '').split('\n')[0];
        await writeBinary(ctx.stdout, binaryPath(`HEAD is now at ${oid.slice(0, 7)} ${subject}\n`));
    }
    return 0;
}
// ── Git subcommand implementations ──────────────────────────────────────
/**
 * The `git` command handler. Split out from registration so it can be
 * lazy-loaded (`await import('./commands.js')`) on first `git` use, keeping
 * this module and its ~106 KB network-facet dependency out of the cold
 * script-eval graph.
 */
export async function runGitCommand(ctx, vfs, doCtx, doEnv, 
/** The workspace's network (`workspace.network`): clone, fetch, pull, push and promisor fetches go out through it. */
network = ISOLATE_NETWORK) {
    let globals;
    try {
        globals = parseGitGlobals(ctx.args, getDir(ctx));
    }
    catch (e) {
        ctx.stderr.write(`git: ${e?.message}\n`);
        return 129;
    }
    const { sub, subArgs } = globals;
    // The directory as git's getcwd() sees it, every link resolved: a
    // worktree reached through a link (a mount's link into SQLite, say) is
    // the directory it names, whose top is not itself a link.
    let dir = globals.dir;
    try {
        dir = await ctx.vfs.realpath(dir);
    }
    catch { /* not there: the subcommand says so */ }
    // Every subcommand below reads `dir` and the clone's `getDir(ctx)`; `-C`
    // moves both, exactly as `git -C <path>` runs the command from <path>.
    ctx = { ...ctx, cwd: dir };
    if (sub === '--version' || sub === '-v') {
        ctx.stdout.write('git version 2.44.0 (isomorphic-git/cf-git)\n');
        return 0;
    }
    if (!sub || sub === '--help' || sub === '-h') {
        ctx.stdout.write('usage: git <command> [<args>]\n\n');
        ctx.stdout.write('Commands:\n');
        ctx.stdout.write('  init, clone, status, add, commit, log, branch,\n');
        ctx.stdout.write('  checkout, diff, ls-files, rev-parse, remote,\n');
        ctx.stdout.write('  fetch, pull, push, merge, reset, tag, config, --version\n');
        return 0;
    }
    // Lazy-load isomorphic-git only when actually needed.
    // Note: http transport isn't loaded here — network ops (clone/fetch/pull)
    // run inside the git-network-facet which imports its own http transport.
    let git;
    // This command's filesystem, once made: what its worktree work cost is kept by it.
    let commandFs = null;
    try {
        git = await getGit();
    }
    catch (e) {
        ctx.stderr.write(`git: failed to load git module: ${e?.message}\n`);
        return 1;
    }
    // `git init <path>` works on that path, every other subcommand on the cwd.
    const initArgs = sub === 'init' ? parseInitArgs(subArgs) : null;
    const initPath = initArgs !== null && !('error' in initArgs) ? initArgs.directory : undefined;
    const initDir = initPath === undefined ? dir : initPath.startsWith('/') ? initPath : dir + '/' + initPath;
    try {
        // The repository through the command's view of the namespace, as its
        // credential: SQLite paths reach the engine, mounted ones their mount.
        const repoVfs = projectFs(ctx.vfs);
        // A partial clone's promisor remote, by git directory, read once per command.
        const promisorRemotes = new Map();
        const promisorRemote = (gitdir) => {
            let found = promisorRemotes.get(gitdir);
            if (found === undefined) {
                promisorRemotes.set(gitdir, found = (async () => {
                    for (const { remote, url } of await git.listRemotes({ fs, gitdir })) {
                        const promisor = await git.getConfig({ fs, gitdir, path: `remote.${remote}.promisor` });
                        if (promisor === true || promisor === 'true')
                            return { name: remote, url };
                    }
                    return null;
                })());
            }
            return found;
        };
        const partial = async (gitdir) => doCtx !== undefined && await promisorRemote(gitdir) !== null;
        const promisor = async (gitdir, oids) => {
            const remote = await promisorRemote(gitdir);
            if (remote === null || !doCtx || !doEnv)
                return false;
            const top = gitdir.endsWith('/.git') ? gitdir.slice(0, -'/.git'.length) : gitdir;
            const target = await onEngine(top || '/');
            if (target === null)
                return false;
            await fetchMissingObjects(doCtx, doEnv, {
                pid: ctx.pid,
                dir: target,
                remote: remote.name,
                url: remote.url,
                oids,
                auth: { username: ctx.env.GIT_USERNAME || '', password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '' },
            }, network);
            return true;
        };
        const fs = createGitFs(repoVfs, null, promisor);
        commandFs = fs;
        // The engine, as this command's principal: a repository on it takes its objects in waves (WorktreeRepo.objectWriter).
        commandEngines.set(fs, {
            key: async (path) => await engineKey(ctx.vfs, vfs, path),
            writeStream: (stream) => vfs.as(ctx.cred).writeStream(stream),
        });
        // The network commands write through the engine's streamed batches, at
        // the repository's engine key; a mounted repository has none.
        const onEngine = async (target) => {
            const key = await engineKey(ctx.vfs, vfs, target);
            if (key === null)
                await ctx.stderr.write(`fatal: git ${sub} writes a repository only on the workspace filesystem; '${target}' is on a mounted one\n`);
            return key === null ? null : '/' + key;
        };
        // A clone still running owns its repository: git would not show one
        // half-made, and a command reading it now would take its shallow or
        // partial state for the finished clone's.
        if (sub !== 'init' && sub !== 'clone') {
            const repo = await discoverRepo(repoVfs, dir);
            if (repo !== null && await repoVfs.exists(`${repo.gitdir}/${GIT_CLONE_JOB_MARKER}`)) {
                await ctx.stderr.write(`fatal: '${repo.worktree ?? repo.gitdir}' is still being cloned\n`);
                return 128;
            }
        }
        switch (sub) {
            case 'init': {
                if (initArgs === null || 'error' in initArgs) {
                    ctx.stderr.write(initArgs?.error ?? INIT_USAGE);
                    return initArgs?.code ?? 129;
                }
                if (initPath) {
                    // Ensure the target directory exists
                    const stripped = initDir.replace(/^\/+/, '');
                    if (!await repoVfs.exists(stripped))
                        await repoVfs.mkdir(stripped, { recursive: true });
                }
                const gitDir = `${initDir}${initArgs.bare ? '' : '/.git'}`;
                // A repository whose HEAD is there is re-initialized, as git does: its HEAD (and branch) stay.
                if (await repoVfs.exists(`${gitDir}/HEAD`.replace(/^\/+/, ''))) {
                    if (initArgs.branch !== undefined)
                        ctx.stderr.write(`warning: re-init: ignored --initial-branch=${initArgs.branch}\n`);
                    if (!initArgs.quiet)
                        ctx.stdout.write(`Reinitialized existing Git repository in ${gitDir}/\n`);
                    return 0;
                }
                if (initArgs.branch !== undefined && !isValidRefName(`refs/heads/${initArgs.branch}`)) {
                    ctx.stderr.write(`fatal: invalid initial branch name: '${initArgs.branch}'\n`);
                    return 128;
                }
                await git.init({ fs, dir: initDir, bare: initArgs.bare, ...(initArgs.branch === undefined ? {} : { defaultBranch: initArgs.branch }) });
                if (!initArgs.quiet)
                    ctx.stdout.write(`Initialized empty Git repository in ${gitDir}/\n`);
                return 0;
            }
            case 'clone': {
                const { url, dest: destArg, depth, isBg, branch, quiet, filter } = parseCloneArgs(subArgs);
                const progress = quiet ? { write() { } } : ctx.stdout;
                if (!url) {
                    ctx.stderr.write(CLONE_USAGE + '\n');
                    return 1;
                }
                // hardening-r5: respect absolute paths. Pre-fix `git clone <url> /tmp/x`
                // resolved to `<cwd>//tmp/x` because the `subArgs[1]` branch
                // unconditionally prepended getDir(ctx). The clone "succeeded" into
                // <cwd>//tmp/x (note double slash) and the user's later `cd /tmp/x`
                // hit ENOENT. Real-world git treats absolute targets as absolute.
                let dest;
                if (destArg) {
                    dest = destArg.startsWith('/')
                        ? destArg
                        : getDir(ctx) + '/' + destArg;
                }
                else {
                    dest = dir + '/' + url.split('/').pop()?.replace('.git', '');
                }
                const target = await onEngine(dest);
                if (target === null)
                    return 128;
                if (!doCtx || !doEnv) {
                    ctx.stderr.write('[git] clone requires DO ctx + env (internal configuration error)\n');
                    return 1;
                }
                progress.write(`Cloning into '${dest}'...${depth ? ' (shallow, depth=' + depth + ')' : ''}\n`);
                // A clone's closed-world filesystem view is correct only while no
                // other session surface can mutate its destination subtree. Acquire
                // the lease before the facet performs its lstat/readdir emptiness
                // proof; the clone's W7 stream carries the opaque owner capability
                // through the trusted SupervisorRPC binding. Taken as the command's
                // credential: the clone writes as it, so a confined caller's /tmp is
                // held where those writes land, not at the shared tmp/ of that name.
                const mutationLease = vfs.as(ctx.cred).acquireExclusiveMutation(target, {
                    includeMissingAncestors: true,
                });
                // A piece of the clone that hung may still write: the facet runner
                // hands the lease to a new owner before it runs the piece again.
                let mutationOwner = mutationLease.owner;
                // Under the lease: whether a failed clone's cleanup keeps the destination (git's remove_junk).
                const cloneRootExisted = vfs.as(ctx.cred).exists(target);
                // Delegate to git-network-facet: heavy packfile processing runs in
                // a dynamic worker with its own CPU budget, not the supervisor DO.
                const doClone = async () => {
                    try {
                        const result = await execGitNetwork(doCtx, doEnv, {
                            op: 'clone',
                            pid: ctx.pid,
                            dir: target,
                            url,
                            ref: branch,
                            depth,
                            filter,
                            quiet,
                            exclusiveDestination: true,
                            exclusiveMutationRoot: mutationLease.root,
                            cloneRootExisted,
                            cloneAbortPieceMs: Number(ctx.env.NIMBUS_GIT_CLONE_ABORT_PIECE_MS) || undefined,
                            mutationOwner,
                            rotateMutationOwner: () => (mutationOwner = vfs.rotateExclusiveMutation(mutationOwner)),
                            // Verification/tuning knobs: smaller pieces make ordinary repos
                            // exercise many batches, history pieces and continuations.
                            blobsPerBatch: Number(ctx.env.NIMBUS_GIT_BLOBS_PER_BATCH) || undefined,
                            batchConcurrency: Number(ctx.env.NIMBUS_GIT_BATCH_CONCURRENCY) || undefined,
                            historyBlobsPerBatch: Number(ctx.env.NIMBUS_GIT_HISTORY_BLOBS_PER_BATCH) || undefined,
                            historyCommitsPerChunk: Number(ctx.env.NIMBUS_GIT_HISTORY_COMMITS_PER_CHUNK) || undefined,
                            historyBudgetUnits: Number(ctx.env.NIMBUS_GIT_HISTORY_BUDGET_UNITS) || undefined,
                            pieceTimeoutMs: Number(ctx.env.NIMBUS_GIT_PIECE_TIMEOUT_MS) || undefined,
                            historyConcurrency: Number(ctx.env.NIMBUS_GIT_HISTORY_CONCURRENCY) || undefined,
                            auth: {
                                username: ctx.env.GIT_USERNAME || '',
                                password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
                            },
                        }, network);
                        if (result.success) {
                            progress.write(`\n[git] clone complete (${result.filesWritten} files, ` +
                                `${(result.bytesWritten / 1024).toFixed(1)}KB in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
                        }
                        else {
                            ctx.stderr.write(`\n[git] clone failed: ${result.error}\n`);
                        }
                        return result.success;
                    }
                    finally {
                        vfs.releaseExclusiveMutation(mutationOwner);
                    }
                };
                if (isBg) {
                    const task = doClone();
                    doCtx.waitUntil(task);
                    progress.write('[git] clone running in background...\n');
                    return 0;
                }
                else {
                    return (await doClone()) ? 0 : 1;
                }
            }
            case 'status':
                return await statusCommand(ctx, git, repoVfs, fs, subArgs);
            case 'add':
                return await addCommand(ctx, git, repoVfs, fs, subArgs);
            case 'commit': {
                const { messages, quiet, all, cleanup, allowEmptyMessage } = parseCommitArgs(subArgs);
                let configured;
                if (cleanup === null) {
                    try {
                        const value = await git.getConfig({ fs, dir, path: 'commit.cleanup' });
                        if (typeof value === 'string')
                            configured = value;
                    }
                    catch { /* unset */ }
                }
                const requested = cleanup ?? configured;
                const mode = commitCleanupMode(requested);
                if (!mode) {
                    await ctx.stderr.write(`fatal: Invalid cleanup mode ${requested}\n`);
                    return 128;
                }
                const raw = messages.length ? joinMessageOptions(messages) : 'commit\n';
                const message = mode === 'verbatim' ? raw : cleanupMessage(raw, mode === 'strip');
                if (!message && !allowEmptyMessage) {
                    await ctx.stderr.write('Aborting commit due to empty commit message.\n');
                    return 1;
                }
                const repo = await discoverRepo(repoVfs, dir);
                if (!repo) {
                    await ctx.stderr.write(NOT_A_REPOSITORY);
                    return 128;
                }
                if (!repo.worktree) {
                    await ctx.stderr.write(NOT_A_WORK_TREE);
                    return 128;
                }
                const wrepo = worktreeRepo(ctx, git, repoVfs, fs, repo.gitdir, repo.worktree);
                const idents = await commitIdents(ctx, git, fs, dir);
                if ('error' in idents) {
                    await ctx.stderr.write(idents.error);
                    return 128;
                }
                // -a's staging and the commit of what it staged, under one hold of the index lock.
                const sha = await wrepo.withIndexLock(async () => {
                    if (all)
                        await stageTracked(ctx, wrepo, git);
                    return await commitIndex(ctx, git, wrepo, message, idents);
                });
                if (sha === null)
                    return 128;
                if (!quiet)
                    ctx.stdout.write(`[${sha.slice(0, 7)}] ${message.split('\n')[0]}\n`);
                return 0;
            }
            case 'rev-parse':
                return await revParse(ctx, git, fs, repoVfs, subArgs);
            case 'ls-files':
                return await lsFiles(ctx, git, repoVfs, fs, subArgs);
            case 'log': {
                const maxCount = parseInt(getFlag(subArgs, '-n') || getFlag(subArgs, '--max-count') || '10');
                const oneline = subArgs.includes('--oneline');
                const commits = await git.log({ fs, dir, depth: maxCount });
                for (const c of commits) {
                    if (oneline) {
                        ctx.stdout.write(`\x1b[33m${c.oid.slice(0, 7)}\x1b[0m ${c.commit.message.split('\n')[0]}\n`);
                    }
                    else {
                        ctx.stdout.write(`\x1b[33mcommit ${c.oid}\x1b[0m\n`);
                        ctx.stdout.write(`Author: ${c.commit.author.name} <${c.commit.author.email}>\n`);
                        ctx.stdout.write(`Date:   ${new Date(c.commit.author.timestamp * 1000).toDateString()}\n\n`);
                        ctx.stdout.write(`    ${c.commit.message}\n\n`);
                    }
                }
                return 0;
            }
            case 'branch': {
                if (subArgs[0] === '--show-current') {
                    // Empty output on a detached HEAD, like git.
                    const current = await git.currentBranch({ fs, dir });
                    if (current)
                        ctx.stdout.write(`${current}\n`);
                    return 0;
                }
                const unknown = subArgs.find((a) => a.startsWith('-') && !['-a', '--list', '-d', '-D'].includes(a));
                if (unknown) {
                    ctx.stderr.write(`error: unknown option '${unknown}'\nusage: git branch [-a | --list | --show-current | -d <name> | -D <name> | <name>]\n`);
                    return 129;
                }
                if (subArgs.length === 0 || subArgs[0] === '-a' || subArgs[0] === '--list') {
                    const branches = await git.listBranches({ fs, dir });
                    const current = await git.currentBranch({ fs, dir });
                    for (const b of branches) {
                        ctx.stdout.write(b === current ? `\x1b[32m* ${b}\x1b[0m\n` : `  ${b}\n`);
                    }
                    if (subArgs.includes('-a')) {
                        try {
                            const remotes = await git.listBranches({ fs, dir, remote: 'origin' });
                            for (const b of remotes)
                                ctx.stdout.write(`  \x1b[31mremotes/origin/${b}\x1b[0m\n`);
                        }
                        catch { }
                    }
                }
                else if (subArgs.includes('-d') || subArgs.includes('-D')) {
                    const name = subArgs.find(a => !a.startsWith('-'));
                    if (name) {
                        await git.deleteBranch({ fs, dir, ref: name });
                        ctx.stdout.write(`Deleted branch ${name}\n`);
                    }
                }
                else {
                    const name = subArgs[0];
                    await git.branch({ fs, dir, ref: name });
                    ctx.stdout.write(`Created branch ${name}\n`);
                }
                return 0;
            }
            case 'checkout': {
                // `--` with paths after it restores those paths; a bare `--` only ends the options.
                const dashdash = subArgs.indexOf('--');
                const options = dashdash >= 0 ? subArgs.slice(0, dashdash) : subArgs;
                if (dashdash >= 0 && dashdash < subArgs.length - 1) {
                    const source = options.find(a => !a.startsWith('-'));
                    return await checkoutPaths(ctx, git, repoVfs, fs, source ?? null, subArgs.slice(dashdash + 1));
                }
                const quiet = options.includes('-q') || options.includes('--quiet');
                const ref = options.find(a => !a.startsWith('-'));
                // `git checkout` and `git checkout HEAD` switch to where HEAD already is: nothing changes.
                if ((!ref || ref === 'HEAD') && !options.includes('-b'))
                    return 0;
                if (!ref) {
                    ctx.stderr.write("error: switch `b' requires a value\n");
                    return 129;
                }
                const create = options.includes('-b');
                if (create)
                    await git.branch({ fs, dir, ref });
                try {
                    const target = await resolveRevision(git, fs, `${dir}/.git`, ref, {});
                    if (target !== null)
                        await prefetchCommits(git, fs, `${dir}/.git`, [target], partial);
                    await switchBranch(ctx, git, repoVfs, fs, dir, ref);
                }
                catch (e) {
                    return await refusal(ctx, e);
                }
                if (!quiet)
                    ctx.stdout.write(create ? `Switched to a new branch '${ref}'\n` : `Switched to branch '${ref}'\n`);
                return 0;
            }
            case 'diff':
                return await diffCommand(ctx, git, fs, repoVfs, subArgs, partial);
            case 'remote': {
                if (subArgs[0] === 'add' && subArgs[1] && subArgs[2]) {
                    await git.addRemote({ fs, dir, remote: subArgs[1], url: subArgs[2] });
                    ctx.stdout.write(`Remote '${subArgs[1]}' added\n`);
                }
                else if (subArgs[0] === 'remove' || subArgs[0] === 'rm') {
                    await git.deleteRemote({ fs, dir, remote: subArgs[1] });
                    ctx.stdout.write(`Remote '${subArgs[1]}' removed\n`);
                }
                else {
                    const remotes = await git.listRemotes({ fs, dir });
                    for (const r of remotes) {
                        ctx.stdout.write(subArgs.includes('-v') ? `${r.remote}\t${r.url} (fetch)\n` : `${r.remote}\n`);
                    }
                }
                return 0;
            }
            case 'fetch': {
                const target = await onEngine(dir);
                if (target === null)
                    return 128;
                const { quiet, rest: fetchArgs } = takeQuiet(subArgs);
                let deepen;
                try {
                    deepen = parseFetchDepth(fetchArgs);
                }
                catch (e) {
                    ctx.stderr.write(`fatal: ${e.message}\n`);
                    return 128;
                }
                const rest = fetchArgs.filter((arg, i) => !FETCH_DEPTH_FLAGS.includes(arg.split('=')[0]) &&
                    !(i > 0 && ['--depth', '--deepen'].includes(fetchArgs[i - 1])));
                const remote = rest[0] || 'origin';
                if (!doCtx || !doEnv) {
                    ctx.stderr.write('[git] fetch requires DO ctx + env (internal configuration error)\n');
                    return 1;
                }
                if (!quiet)
                    ctx.stdout.write(`Fetching from ${remote}...\n`);
                const result = await execGitNetwork(doCtx, doEnv, {
                    op: 'fetch',
                    pid: ctx.pid,
                    dir: target,
                    remote,
                    quiet,
                    depth: deepen?.depth,
                    relative: deepen?.relative,
                    auth: {
                        username: ctx.env.GIT_USERNAME || '',
                        password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
                    },
                }, network);
                if (result.success) {
                    if (!quiet)
                        ctx.stdout.write(`\n[git] fetch complete (${result.filesWritten} files in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
                    return 0;
                }
                else {
                    ctx.stderr.write(`\n[git] fetch failed: ${result.error}\n`);
                    return 1;
                }
            }
            case 'pull': {
                // git pull is a fetch of the branch, then a merge of it: the merge through the session's one
                // checkout policy, as `git merge` runs it.
                const target = await onEngine(dir);
                if (target === null)
                    return 128;
                const { quiet, rest } = takeQuiet(subArgs);
                const remote = rest[0] || 'origin';
                const branch = rest[1] || await git.currentBranch({ fs, dir }) || 'main';
                if (!doCtx || !doEnv) {
                    ctx.stderr.write('[git] pull requires DO ctx + env (internal configuration error)\n');
                    return 1;
                }
                const pullIdents = await commitIdents(ctx, git, fs, dir);
                if ('error' in pullIdents) {
                    await ctx.stderr.write(pullIdents.error);
                    return 128;
                }
                if (!quiet)
                    ctx.stdout.write(`Pulling from ${remote}/${branch}...\n`);
                const started = Date.now();
                const result = await execGitNetwork(doCtx, doEnv, {
                    op: 'fetch',
                    pid: ctx.pid,
                    dir: target,
                    remote,
                    ref: branch,
                    quiet,
                    auth: {
                        username: ctx.env.GIT_USERNAME || '',
                        password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
                    },
                }, network);
                if (!result.success) {
                    ctx.stderr.write(`\n[git] pull failed: ${result.error}\n`);
                    return 1;
                }
                const merged = await mergeCommand(ctx, git, fs, repoVfs, dir, `${remote}/${branch}`, true, partial);
                if (merged === 0 && !quiet)
                    ctx.stdout.write(`\n[git] pull complete (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
                return merged;
            }
            case 'push': {
                const target = await onEngine(dir);
                if (target === null)
                    return 128;
                const { quiet, rest } = takeQuiet(subArgs);
                const remote = rest[0] || 'origin';
                const branch = rest[1] || await git.currentBranch({ fs, dir }) || 'main';
                if (!doCtx || !doEnv) {
                    ctx.stderr.write('[git] push requires DO ctx + env (internal configuration error)\n');
                    return 1;
                }
                if (!quiet)
                    ctx.stdout.write(`Pushing to ${remote}/${branch}...\n`);
                const result = await execGitNetwork(doCtx, doEnv, {
                    op: 'push',
                    pid: ctx.pid,
                    dir: target,
                    remote,
                    ref: branch,
                    quiet,
                    auth: {
                        username: ctx.env.GIT_USERNAME || '',
                        password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
                    },
                }, network);
                if (result.success) {
                    if (!quiet)
                        ctx.stdout.write(`\n[git] push complete (${(result.elapsed / 1000).toFixed(1)}s)\n`);
                    return 0;
                }
                else {
                    ctx.stderr.write(`\n[git] push failed: ${result.error}\n`);
                    return 1;
                }
            }
            case 'merge': {
                const theirs = subArgs.find(a => !a.startsWith('-'));
                if (!theirs) {
                    ctx.stderr.write('usage: git merge <branch>\n');
                    return 1;
                }
                const quiet = subArgs.includes('-q') || subArgs.includes('--quiet');
                return await mergeCommand(ctx, git, fs, repoVfs, dir, theirs, quiet, partial);
            }
            case 'reset':
                return await resetCommand(ctx, git, repoVfs, fs, subArgs, (gitdir, commits) => prefetchCommits(git, fs, gitdir, commits, partial));
            case 'tag':
                return await tagCommand(ctx, git, fs, repoVfs, subArgs);
            case 'config': {
                const key = subArgs.find(a => !a.startsWith('-'));
                const value = subArgs[subArgs.indexOf(key || '') + 1];
                if (key && value) {
                    const [section, ...rest] = key.split('.');
                    await git.setConfig({ fs, dir, path: key, value });
                    ctx.stdout.write(`${key}=${value}\n`);
                }
                else if (key) {
                    try {
                        const val = await git.getConfig({ fs, dir, path: key });
                        ctx.stdout.write(`${val}\n`);
                    }
                    catch {
                        ctx.stderr.write(`config: key '${key}' not set\n`);
                        return 1;
                    }
                }
                else {
                    ctx.stderr.write('usage: git config <key> [value]\n');
                    return 1;
                }
                return 0;
            }
            default:
                ctx.stderr.write(`git: '${sub}' is not a git command. See 'git --help'.\n`);
                return 1;
        }
    }
    catch (e) {
        // The reader went away (`git diff | head`): git dies of SIGPIPE, silently.
        if (e?.code === 'EPIPE')
            return 141;
        ctx.stderr.write(`fatal: ${e?.message || e}\n`);
        return 128;
    }
    finally {
        const counters = commandFs && commandCounters.get(commandFs);
        if (counters && ctx.env.NIMBUS_GIT_COUNTERS)
            await ctx.stderr.write(`[git] ${JSON.stringify(counters)}\n`);
    }
}
