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
import { GIT_WASI_ENV } from '@nimbus-sh/core/runtime/os-contracts.js';
import { engineKey, X_OK } from '@nimbus-sh/core/runtime/process-files.js';
import { WaveIngest } from '@nimbus-sh/core/runtime/wave-ingest.js';
import { projectFs } from '../runtime/project-fs.js';
import { execGitNetwork, runGraphFilters } from './network-facet.js';
import { createGitFs } from './git-fs.js';
import { generation } from '@nimbus-sh/fabric/generation.js';
import { exitCodeForAbortSignal, SESSION_DESTROYED } from '@nimbus-sh/core/substrate/lifo/shell/signals.js';
import { bridgeCleanupFs, cleanUpClone, deleteCloneJob, GIT_CLONE_JOB_MARKER, setCloneJobPhase, writeCloneJob, } from './clone-job.js';
import { noSuchRemoteText, remoteFailureText, selectRemoteCredentials, urlCredentials } from './pack/remote-failure.js';
import { base64Utf8 } from '@nimbus-sh/core/_shared/crypto.js';
import { GitGlobalsError, configBool, parseConfigParameter, withConfigOverrides, withGlobalConfig, withWorktreeConfig } from './config-params.js';
import { gitBackend, UnsupportedGitOperation } from './routing.js';
import { packsSeam } from './pack/store.js';
import { PromisorFetchError, fetchMissingObjects } from './promisor.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
import { errnoCodeOf, fsError, isVfsError, strerror } from '@nimbus-sh/core/vfs/vfs-error.js';
import { dec, enc, nameDec } from '@nimbus-sh/core/_shared/bytes.js';
import { DEFAULT_CONTEXT, DEFAULT_RENAME_SCORE, absentSpec, binaryPath, bytesFromBinary, detectRenames, formatNameOnly, formatNameStatus, formatPatch, formatStat, parseRenameScore, pathLine, statFile, StatList, } from './unified-diff.js';
import { CheckoutRefused, UnmergedIndex, switchTrees } from './worktree/checkout.js';
import { parseSparseCheckoutArgs, sparseCheckout } from './sparse-checkout.js';
import { invalidPathError, verifyPath } from './worktree/verify-path.js';
import { DirCache, IndexFormatError, IndexReadError, NewEntries, comparePaths } from './worktree/dircache.js';
import { isValidRefName } from './worktree/refname.js';
import { wildmatch } from './worktree/wildmatch.js';
import { PairList } from './worktree/pairs.js';
import { WorktreeRepo } from './worktree/repo.js';
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
 * cf-git's `fs` over the repository's filesystem (git-fs.ts).
 *
 * With a `worktree`, the backend writes that worktree the way git's checkout
 * does (entry.c create_directories, has_symlink_leading_path): below its top,
 * `.git` aside, every leading component is lstat'd, and one that is not a real
 * directory (a link, dangling or not, or a file) is replaced by one rather than
 * followed, and a file replaces a link at its own path instead of writing
 * through it. Components above the top are followed, as git follows them.
 * Commands that only read the worktree or write `.git` pass no worktree.
 */
function sessionGitFs(vfs, worktree = null, promisor) {
    const top = worktree === null ? null : normalizeVfsPath(worktree);
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
    /** `p`'s directories, down to `p` itself when `self`; see sessionGitFs for the worktree's rule. */
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
    const backend = {
        stat(p, follow) {
            if (!p) {
                const now = Date.now();
                return Promise.resolve({ type: 'dir', size: 0, mode: 0o755, mtimeMs: now, ctimeMs: now, atimeMs: now, uid: 0, gid: 0, dev: 0, ino: 0, nlink: 1 });
            }
            // The engine answers some paths at once, its view the rest by promise; either may fail.
            let st;
            try {
                st = follow ? vfs.stat(p) : vfs.lstat(p);
            }
            catch {
                return Promise.resolve(null);
            }
            return Promise.resolve(st).then((st) => ({
                type: st.type === 'directory' ? 'dir' : st.type === 'symlink' ? 'symlink' : 'file',
                size: st.size,
                mode: st.mode,
                mtimeMs: st.mtime, ctimeMs: st.ctime, atimeMs: st.atime,
                uid: st.uid, gid: st.gid, dev: st.dev, ino: st.ino, nlink: st.nlink,
            }), () => null);
        },
        // Null where nothing is there; a file there that cannot be read (EACCES, EIO) says so.
        readFile(p) {
            const absent = (error) => {
                const code = errnoCodeOf(error);
                if (code === 'ENOENT' || code === 'ENOTDIR')
                    return null;
                throw error;
            };
            let data;
            try {
                data = vfs.readFile(p);
            }
            catch (error) {
                return Promise.resolve(error).then(absent);
            }
            return Promise.resolve(data).then((bytes) => bytes, absent);
        },
        // A file made has the mode its caller asked for (a checkout's: the index's),
        // so it is never more open than that; one there keeps its own.
        async writeFile(p, data, mode) {
            await ensureDirectories(p, false);
            // A file replaces a link or a directory at its own path (entry.c checkout_entry, remove_subtree).
            const existing = checkedOut(p) ? (await lstatOrNull(p))?.type : undefined;
            if (existing === 'symlink')
                await vfs.unlink(p);
            else if (existing === 'directory')
                await vfs.removeRecursive(p);
            await vfs.writeFile(p, data, mode === undefined ? undefined : { mode });
        },
        async unlink(p) {
            if (await lstatOrNull(p))
                await vfs.unlink(p);
        },
        async readdir(p) {
            if (!p)
                return []; // root level — not typically needed by isomorphic-git
            if (!await vfs.exists(p))
                return [];
            return (await vfs.readdir(p)).map((entry) => entry.name);
        },
        async mkdir(p) {
            await ensureDirectories(p, true);
        },
        async rmdir(p, filepath, recursive) {
            const st = await lstatOrNull(p);
            if (!st)
                return;
            if (recursive) {
                // A link or a file goes itself; a directory with all it holds.
                if (st.type === 'directory')
                    await vfs.removeRecursive(p);
                else
                    await vfs.unlink(p);
                return;
            }
            // rmdir(2) of a link is ENOTDIR: it never removes the directory the link names.
            if (st.type !== 'directory')
                throw fsError('ENOTDIR', 'rmdir', filepath);
            await vfs.rmdir(p);
        },
        async symlink(target, p) {
            await ensureDirectories(p, false);
            // Checkout retargets a link in place, as the network facet's backend does.
            const st = await lstatOrNull(p);
            if (st?.type === 'directory' && checkedOut(p))
                await vfs.removeRecursive(p);
            else if (st && st.type !== 'directory')
                await vfs.unlink(p);
            await vfs.symlink(target, p);
        },
        async readlink(p) {
            return vfs.readlink(p);
        },
    };
    // Packed objects are read by range, never a whole pack (git/pack/store.ts).
    return createGitFs(backend, packsSeam({
        readRange: async (path, offset, length) => await vfs.readRangeUncached(normalizeVfsPath(path), offset, length),
        readdir: async (dir) => {
            try {
                return (await vfs.readdir(normalizeVfsPath(dir))).map((entry) => entry.name);
            }
            catch {
                return [];
            }
        },
    }, { promisor }));
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
    const config = new Map();
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-c') {
            const text = args[++i];
            if (text === undefined)
                throw new GitGlobalsError(`-c expects a configuration string\n${GIT_USAGE}\n`, 129);
            const [key, value] = parseConfigParameter(text);
            config.set(key, [...(config.get(key) ?? []), value]);
        }
        else if (arg === '-C') {
            const path = args[++i];
            if (path === undefined)
                throw new GitGlobalsError("git: option '-C' requires a value\n", 129);
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
            throw new UnsupportedGitOperation(`git: unknown option '${arg}'\n${GIT_USAGE}\n`, 129);
        }
        else {
            break;
        }
    }
    return { sub: args[i], subArgs: args.slice(i + 1), dir, config };
}
const GIT_USAGE = 'usage: git [-C <path>] [-c <name>=<value>] [--no-pager] <command> [<args>]';
function unsupportedOption(command, option) {
    throw new UnsupportedGitOperation(`fatal: git ${command} ${option} is not supported here\n`, 128);
}
function requiredValue(args, at, option) {
    const value = args[at];
    if (value === undefined)
        throw new GitGlobalsError(`error: option '${option}' requires a value\n`, 129);
    return value;
}
export const CLONE_USAGE = 'usage: git clone [-q | --quiet] [--depth <n>] [--no-shallow] [--filter=<spec>] [--sparse] [--branch <name> | -b <name>] [--bg] <url> [dir]';
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
    let seen = false;
    for (let i = 0; i < args.length; i++) {
        const [flag, inline] = args[i].split('=', 2);
        if (!FETCH_DEPTH_FLAGS.includes(flag))
            continue;
        if (seen)
            throw new Error('--depth, --deepen and --unshallow are mutually exclusive');
        seen = true;
        found = fetchDepth(flag, flag === '--unshallow' ? undefined : inline ?? args[++i]);
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
    if (/^object:type=(blob|tree|commit|tag)$/.test(spec) || /^sparse:oid=.+$/.test(spec))
        unsupportedOption('clone', `--filter=${spec}`);
    if (spec.startsWith('combine:')) {
        const filters = spec.slice('combine:'.length).split('+');
        let valid = filters.length > 0 && filters[0] !== '';
        for (const filter of filters) {
            try {
                parseCloneFilter(decodeURIComponent(filter));
            }
            catch (error) {
                if (!(error instanceof UnsupportedGitOperation))
                    valid = false;
            }
        }
        if (valid)
            unsupportedOption('clone', `--filter=${spec}`);
    }
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
    const unknown = (what) => { throw new UnsupportedGitOperation(`error: unknown ${what}\n${INIT_USAGE}`, 129); };
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
                unsupportedOption('init', `--${name}`);
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
    let sparse = false;
    const positionals = [];
    let dashdash = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (dashdash) {
            positionals.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
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
        else if (arg === '--sparse')
            sparse = true;
        else if (arg === '--no-sparse')
            sparse = false;
        else if (arg.startsWith('-')) {
            throw new UnsupportedGitOperation(`fatal: unknown option '${arg}'\n${CLONE_USAGE}\n`, 128);
        }
        else {
            positionals.push(arg);
        }
    }
    if (positionals.length > 2)
        throw new GitGlobalsError(CLONE_USAGE + '\n', 129);
    return {
        url: positionals[0],
        dest: positionals[1],
        depth: depthFlag !== undefined ? cloneDepth(depthFlag) : (noShallow ? undefined : 1),
        noShallow,
        isBg,
        branch,
        quiet,
        filter,
        sparse,
    };
}
/** commit's -m (repeatable), -q and -a, bundled as git allows (`-qm msg`, `-mmsg`). */
function parseCommitArgs(args) {
    const messages = [];
    let quiet = false;
    let all = false;
    let cleanup = null;
    let allowEmptyMessage = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            if (i + 1 < args.length)
                unsupportedOption('commit', 'pathspecs');
            break;
        }
        if (arg === '--quiet')
            quiet = true;
        else if (arg === '--all')
            all = true;
        else if (arg === '--allow-empty-message')
            allowEmptyMessage = true;
        else if (arg === '--allow-empty') { /* Empty-tree commits are supported. */ }
        else if (arg === '--cleanup')
            cleanup = requiredValue(args, ++i, arg);
        else if (arg.startsWith('--cleanup='))
            cleanup = arg.slice('--cleanup='.length);
        else if (arg === '--message')
            messages.push(requiredValue(args, ++i, arg));
        else if (arg.startsWith('--message='))
            messages.push(arg.slice('--message='.length));
        else if (/^-[^-]/.test(arg)) {
            for (let j = 1; j < arg.length; j++) {
                if (arg[j] === 'q')
                    quiet = true;
                else if (arg[j] === 'a')
                    all = true;
                else if (arg[j] === 'm') {
                    messages.push(j + 1 < arg.length ? arg.slice(j + 1) : requiredValue(args, ++i, '-m'));
                    break;
                }
                else
                    unsupportedOption('commit', `-${arg[j]}`);
            }
        }
        else
            unsupportedOption('commit', arg);
    }
    // With no -m, git takes the message from an editor (GIT_EDITOR, core.editor, VISUAL, EDITOR): real git's.
    if (messages.length === 0)
        unsupportedOption('commit', 'without -m (its message from an editor)');
    return { messages, quiet, all, cleanup, allowEmptyMessage };
}
function parseLogArgs(args) {
    let maxCount = 10;
    let oneline = false;
    const count = (value) => {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
            throw new GitGlobalsError(`fatal: invalid count '${value}'\n`, 128);
        }
        maxCount = Number(value);
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            if (i + 1 < args.length)
                unsupportedOption('log', 'pathspecs');
            break;
        }
        if (arg === '--oneline')
            oneline = true;
        else if (arg === '-n' || arg === '--max-count')
            count(requiredValue(args, ++i, arg));
        else if (arg.startsWith('--max-count='))
            count(arg.slice('--max-count='.length));
        else if (/^-n=?\d+$/.test(arg))
            count(arg.slice(2).replace(/^=/, ''));
        else if (/^-\d+$/.test(arg))
            count(arg.slice(1));
        else
            unsupportedOption('log', arg);
    }
    return { maxCount, oneline };
}
function parseBranchArgs(args) {
    let showCurrent = false;
    let list = false;
    let all = false;
    let del = false;
    const operands = [];
    let dashdash = false;
    for (const arg of args) {
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            operands.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        if (arg === '--show-current')
            showCurrent = true;
        else if (arg === '--list')
            list = true;
        else if (arg === '-a') {
            list = true;
            all = true;
        }
        else if (arg === '-D')
            del = true;
        else {
            throw new UnsupportedGitOperation(`error: unknown option '${arg}'\nusage: git branch [-a | --list | --show-current | -D <name> | <name>]\n`, 129);
        }
    }
    if ((showCurrent && (list || del || operands.length)) || (list && (del || operands.length)) || operands.length > 1) {
        unsupportedOption('branch', 'this operation');
    }
    if (del && operands.length === 0)
        throw new GitGlobalsError('fatal: branch name required\n', 128);
    return { showCurrent, list: list || (!del && operands.length === 0), all, del, name: operands[0] };
}
function parseCheckoutArgs(args) {
    let quiet = false;
    let create;
    let ignoreSkipWorktree = false;
    const operands = [];
    let paths = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            paths = args.slice(i + 1);
            break;
        }
        if (arg === '-' || !arg.startsWith('-')) {
            operands.push(arg);
            continue;
        }
        if (arg === '--quiet') {
            quiet = true;
            continue;
        }
        if (arg === '--ignore-skip-worktree-bits') {
            ignoreSkipWorktree = true;
            continue;
        }
        if (arg.startsWith('--'))
            unsupportedOption('checkout', arg);
        for (let j = 1; j < arg.length; j++) {
            const flag = arg[j];
            if (flag === 'q')
                quiet = true;
            else if (flag === 'b') {
                if (create !== undefined)
                    throw new GitGlobalsError("error: switch `b' specified twice\n", 129);
                create = j + 1 < arg.length ? arg.slice(j + 1) : requiredValue(args, ++i, '-b');
                break;
            }
            else
                unsupportedOption('checkout', `-${flag}`);
        }
    }
    if (operands.length > 1 || (create !== undefined && (operands.length || paths.length)))
        unsupportedOption('checkout', 'start-point or paths with -b');
    if (ignoreSkipWorktree && paths.length === 0)
        unsupportedOption('checkout', '--ignore-skip-worktree-bits without paths');
    const ref = create ?? operands[0];
    if (create === undefined && ref !== undefined)
        validateRevision(ref);
    return { quiet, create: create !== undefined, ref, paths, ignoreSkipWorktree };
}
function parseRemoteArgs(args) {
    let verbose = false;
    let dashdash = false;
    const operands = [];
    for (const arg of args) {
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            operands.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        if (arg === '--verbose' || /^-v+$/.test(arg))
            verbose = true;
        else
            unsupportedOption('remote', arg);
    }
    const operation = operands[0];
    if (operation === undefined)
        return { operation: 'list', verbose, name: '', url: '' };
    if (operation === 'add' && operands.length === 3)
        return { operation, verbose, name: operands[1], url: operands[2] };
    if ((operation === 'remove' || operation === 'rm') && operands.length === 2)
        return { operation: 'remove', verbose, name: operands[1], url: '' };
    if (operation === 'add' || operation === 'remove' || operation === 'rm') {
        throw new GitGlobalsError(`usage: git remote ${operation} <name>${operation === 'add' ? ' <url>' : ''}\n`, 129);
    }
    unsupportedOption('remote', operation);
}
/** A C long's value as glibc's strtol saturates it, then an int's: its low 32 bits. */
function cInt(value) {
    const LONG_MAX = (1n << 63n) - 1n;
    return Number(BigInt.asIntN(32, value > LONG_MAX ? LONG_MAX : value < -LONG_MAX - 1n ? -LONG_MAX - 1n : value));
}
/**
 * An explicit `--depth` as git reads it into an int: positive by atoi
 * (builtin/clone.c, fetch.c), then whole by strtol in base 0 (transport.c),
 * whose value it is: '010' is 8, 4294967297 is 1, and a hexadecimal one is
 * not positive by atoi. One that comes to 0 or less asks for no shallow
 * boundary (fetch-pack sends no deepen): undefined.
 */
function parseDepth(value) {
    const leading = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(value)?.[1];
    if (leading === undefined || cInt(BigInt(leading)) < 1)
        throw new Error(`depth ${value} is not a positive number`);
    const whole = /^[ \t\n\v\f\r]*([+-]?)(?:(0[0-7]*)|([1-9]\d*))$/.exec(value);
    if (whole === null)
        throw new Error(`transport: invalid depth option '${value}'`);
    const magnitude = whole[2] !== undefined ? BigInt(`0o${whole[2]}`) : BigInt(whole[3]);
    const depth = cInt(whole[1] === '-' ? -magnitude : magnitude);
    return depth >= 1 ? depth : undefined;
}
function cloneDepth(value) {
    try {
        return parseDepth(value);
    }
    catch (error) {
        throw new GitGlobalsError(`fatal: ${error instanceof Error ? error.message : String(error)}\n`, 128);
    }
}
function fetchDepth(flag, value) {
    if (flag === '--unshallow')
        return { depth: INFINITE_DEPTH, relative: false };
    if (flag === '--depth') {
        const depth = parseDepth(value ?? '');
        return depth === undefined ? undefined : { depth, relative: false };
    }
    const depth = Number(value);
    if (!Number.isSafeInteger(depth) || depth < 1)
        throw new Error(`${flag} ${value ?? ''} is not a positive number`.trimEnd());
    return { depth, relative: flag === '--deepen' };
}
function parseTransportArgs(command, args, env) {
    let quiet = false;
    let dashdash = false;
    let deepen;
    // One of --depth, --deepen, --unshallow was given (a depth of 0 or less among them asks for no deepen).
    let deepenGiven = false;
    const operands = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            operands.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        if (arg === '--quiet' || /^-q+$/.test(arg)) {
            quiet = true;
            continue;
        }
        const eq = arg.indexOf('=');
        const flag = eq < 0 ? arg : arg.slice(0, eq);
        if (command === 'fetch' && FETCH_DEPTH_FLAGS.includes(flag)) {
            if (deepenGiven)
                throw new GitGlobalsError('fatal: --depth, --deepen and --unshallow are mutually exclusive\n', 128);
            deepenGiven = true;
            if (flag === '--unshallow' && eq >= 0)
                unsupportedOption(command, arg);
            const value = flag === '--unshallow' ? undefined : eq < 0 ? requiredValue(args, ++i, flag) : arg.slice(eq + 1);
            try {
                deepen = fetchDepth(flag, value);
            }
            catch (error) {
                throw new GitGlobalsError(`fatal: ${error instanceof Error ? error.message : String(error)}\n`, 128);
            }
        }
        else
            unsupportedOption(command, arg);
    }
    if (operands.length > (command === 'fetch' ? 1 : 2))
        unsupportedOption(command, 'refspecs');
    // A pull's merge takes its message from an editor as git merge's does.
    if (command === 'pull' && mergeAutoEdit(env))
        unsupportedOption(command, 'with GIT_MERGE_AUTOEDIT (its message from an editor)');
    const branch = operands[1];
    if (branch !== undefined && /[:*^]|^\+/.test(branch))
        unsupportedOption(command, `refspec '${branch}'`);
    return { quiet, deepen, remote: operands[0] ?? 'origin', branch };
}
/**
 * Whether git's merge takes its commit message from an editor
 * (builtin/merge.c default_edit_option): GIT_MERGE_AUTOEDIT says so. Real
 * git here never sees a terminal (its stdio is no tty), so nothing else
 * does. A value git cannot read is git's to refuse.
 */
function mergeAutoEdit(env) {
    const value = env.GIT_MERGE_AUTOEDIT;
    return value !== undefined && !['', 'false', 'no', 'off', '0'].includes(value.toLowerCase());
}
function parseMergeArgs(args, env) {
    let quiet = false;
    let noEdit = false;
    let dashdash = false;
    const operands = [];
    for (const arg of args) {
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            operands.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        if (arg === '--quiet' || /^-q+$/.test(arg))
            quiet = true;
        else if (arg === '--no-edit')
            noEdit = true;
        else
            unsupportedOption('merge', arg);
    }
    if (!noEdit && mergeAutoEdit(env))
        unsupportedOption('merge', 'with GIT_MERGE_AUTOEDIT (its message from an editor)');
    if (operands.length > 1)
        unsupportedOption('merge', 'multiple heads');
    if (operands.length === 0)
        throw new GitGlobalsError('usage: git merge <branch>\n', 1);
    validateRevision(operands[0]);
    return { theirs: operands[0], quiet };
}
function parseConfigArgs(args) {
    let get = false;
    let unset = false;
    let dashdash = false;
    const operands = [];
    for (const arg of args) {
        // A set's value is opaque, even if it spells a scope or another action.
        if (operands.length === 1 && !get && !unset) {
            operands.push(arg);
            continue;
        }
        if (dashdash || arg === '-' || !arg.startsWith('-')) {
            operands.push(arg);
            continue;
        }
        if (arg === '--') {
            dashdash = true;
            continue;
        }
        if (arg === '--get')
            get = true;
        else if (arg === '--unset')
            unset = true;
        else
            unsupportedOption('config', arg);
    }
    if (operands.length === 0)
        throw new GitGlobalsError('usage: git config <key> [value]\n', 1);
    if (!operands[0].includes('.'))
        unsupportedOption('config', operands[0]);
    if (get && unset)
        throw new GitGlobalsError('error: only one action at a time\n', 129);
    if (operands.length > (get || unset ? 1 : 2))
        unsupportedOption('config', 'value patterns or multiple values');
    return { key: operands[0], value: get || unset ? undefined : operands[1], unset };
}
function parseCommandArgs(sub, args, env) {
    switch (sub) {
        case 'init': {
            const parsed = parseInitArgs(args);
            if ('error' in parsed)
                throw new GitGlobalsError(parsed.error, parsed.code);
            return { sub, parsed };
        }
        case 'clone': return { sub, parsed: parseCloneArgs([...args]) };
        case 'status': return { sub, parsed: parseStatusArgs(args) };
        case 'add': return { sub, parsed: parseAddArgs(args) };
        case 'commit': return { sub, parsed: parseCommitArgs(args) };
        case 'rev-parse': return { sub, parsed: parseRevParseArgs(args) };
        case 'ls-files': return { sub, parsed: parseLsFilesArgs(args) };
        case 'log': return { sub, parsed: parseLogArgs(args) };
        case 'branch': return { sub, parsed: parseBranchArgs(args) };
        case 'checkout': return { sub, parsed: parseCheckoutArgs(args) };
        case 'diff': return { sub, parsed: parseDiffArgs(args, env.COLUMNS) };
        case 'remote': return { sub, parsed: parseRemoteArgs(args) };
        case 'fetch':
        case 'pull':
        case 'push': return { sub, parsed: parseTransportArgs(sub, args, env) };
        case 'merge': return { sub, parsed: parseMergeArgs(args, env) };
        case 'reset': return { sub, parsed: parseResetArgs(args) };
        case 'tag': return { sub, parsed: parseTagArgs(args) };
        case 'config': return { sub, parsed: parseConfigArgs(args) };
        case 'sparse-checkout': return { sub, parsed: parseSparseCheckoutArgs(args) };
        default: throw new UnsupportedGitOperation(`git: '${sub}' is not a git command. See 'git --help'.\n`, 1);
    }
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
        await stream.write(nameDec.decode(bytes));
}
// ── Staging ──────────────────────────────────────────────────────────────
/** What one command's worktree work cost, by its filesystem (one per command): NIMBUS_GIT_COUNTERS=1 prints it. */
const commandCounters = new WeakMap();
/** The engine one command's repositories write their objects' waves into, by its filesystem (one per command). */
const commandEngines = new WeakMap();
const commandRepos = new WeakMap();
/** The repository at `root` as the worktree commands read it: its index, worktree and objects (through `fs`'s pack store). */
function worktreeRepo(ctx, git, vfs, fs, gitdir, root) {
    let repos = commandRepos.get(fs);
    if (repos === undefined) {
        repos = new Map();
        commandRepos.set(fs, repos);
    }
    const existing = repos.get(gitdir);
    if (existing !== undefined)
        return existing;
    let counters = commandCounters.get(fs);
    if (!counters) {
        counters = newCounters();
        // NIMBUS_GIT_COUNTERS=why also says why the first entries read had to be.
        if (ctx.env.NIMBUS_GIT_COUNTERS === 'why')
            counters.why = [];
        commandCounters.set(fs, counters);
    }
    const repo = new WorktreeRepo(vfs, git, fs, root, gitdir, ctx.env, counters, commandEngines.get(fs) ?? null);
    repos.set(gitdir, repo);
    return repo;
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
    // add_files_to_cache without include_sparse: what is outside a sparse checkout's cone is not staged.
    const sparse = await wrepo.sparseMatcher();
    const removed = new Set();
    const added = new NewEntries();
    const objects = await wrepo.objectWriter();
    for (const [i, dirty] of scan.dirty) {
        if (sparse !== null && !sparse.includes(dc.path(i)))
            continue;
        const entry = dirty.change === 'D' ? null : await indexEntryFor(wrepo, git, dc, dc.path(i), objects);
        if (entry)
            added.add(entry);
        else
            removed.add(i);
    }
    // An unmerged path is resolved as add -u resolves it: with what the worktree holds, or by its removal.
    for (const { path, lo, hi, stat } of scan.unmerged) {
        if (sparse !== null && !sparse.includes(path))
            continue;
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
 * repository does not hold. In a sparse checkout (`sparse`), only the blobs
 * the cone writes: git prefetches the entries it updates, never a
 * skip-worktree one. Nothing is walked outside a partial clone.
 */
async function prefetchCommits(git, fs, gitdir, commits, partial, sparse = null) {
    if (commits.length === 0 || !await partial(gitdir))
        return;
    const cache = {};
    const roots = [];
    for (const oid of commits)
        roots.push((await git.readCommit({ fs, gitdir, oid, cache })).commit.tree);
    await fs.packs.prefetch(gitdir, roots);
    const blobs = new Set();
    const pending = roots.map((oid) => ({ oid, prefix: '' }));
    const seen = new Set();
    while (pending.length > 0) {
        const { oid: tree, prefix } = pending.pop();
        // A tree seen at one path is seen at another only outside a sparse checkout: its cone is by path.
        const key = sparse === null ? tree : prefix + '\0' + tree;
        if (seen.has(key))
            continue;
        seen.add(key);
        for (const entry of (await git.readTree({ fs, gitdir, oid: tree, cache })).tree) {
            const path = prefix + entry.path;
            if (entry.type === 'tree') {
                if (sparse === null || sparse.directory(path))
                    pending.push({ oid: entry.oid, prefix: path + '/' });
            }
            else if (entry.type === 'blob' && (sparse === null || sparse.includes(path))) {
                blobs.add(entry.oid);
            }
        }
    }
    await fs.packs.prefetch(gitdir, blobs);
}
// ── Repository discovery ─────────────────────────────────────────────────
const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git\n';
const NOT_A_WORK_TREE = 'fatal: this operation must be run in a work tree\n';
/** setup_git_directory's walk: from the cwd up, a `.git` inside each level, else the level itself as a git directory. */
async function discoverRepo(vfs, cwd) {
    // git's is_git_directory: HEAD, and objects and refs here or in the common
    // directory it names. Null for none; else whether it names one (GitRepo.linked).
    const gitDirAt = async (key) => {
        const sub = (name) => (key ? `${key}/${name}` : name);
        if (!await vfs.isFile(sub('HEAD')))
            return null;
        if (await vfs.isFile(sub('commondir')))
            return true;
        return await vfs.isDirectory(sub('objects')) && await vfs.isDirectory(sub('refs')) ? false : null;
    };
    const segments = normalizeVfsPath(cwd).split('/').filter(Boolean);
    for (let depth = segments.length; depth >= 0; depth--) {
        const dir = segments.slice(0, depth).join('/');
        const prefix = segments.slice(depth).join('/');
        const dotGit = dir ? `${dir}/.git` : '.git';
        const linked = await gitDirAt(dotGit);
        if (linked !== null)
            return { gitdir: `/${dotGit}`, worktree: `/${dir}`, prefix, linked };
        // A .git file (gitdir: ...): git's repository is where it points, never an enclosing one's.
        if (await vfs.isFile(dotGit))
            return { gitdir: `/${dotGit}`, worktree: `/${dir}`, prefix, linked: true };
        const bare = await gitDirAt(dir);
        if (bare !== null)
            return { gitdir: `/${dir}`, worktree: null, prefix, linked: bare };
    }
    return null;
}
/**
 * The repository formats the built-in implements, as git 2.53's setup.c
 * check_repository_format_gently reads them: format version 0 or 1;
 * extensions it honors (sha1 objects, files refs, worktreeConfig, a partial
 * clone's promisor, precious objects: it deletes none) or that change
 * nothing (noop, relativeWorktrees: it makes no linked worktree). Any
 * other extension a version 1 repository declares, a v1-only one in a
 * version 0 repository (git refuses both), and a layout it does not
 * implement (GitRepo.linked) are real git's: refused before anything is
 * read or written, so the front door hands the invocation over, or names
 * the refusal without real git. A version 0 repository's unknown
 * extensions are ignored, as git ignores them.
 */
const V0_EXTENSIONS = {
    noop: () => true,
    preciousobjects: () => true,
    partialclone: () => true,
    worktreeconfig: () => true,
};
const V1_EXTENSIONS = {
    'noop-v1': () => true,
    objectformat: (value) => value.toLowerCase() === 'sha1',
    compatobjectformat: () => false,
    refstorage: (value) => value.toLowerCase() === 'files',
    relativeworktrees: () => true,
};
/**
 * The hooks (githooks(5)) git runs for what each built-in command does:
 * the built-in runs none, so a repository where one of its command's is
 * executable is real git's, handed over before any effect
 * (assertNoHooks). Every index write runs post-index-change and every ref
 * update reference-transaction. status and diff are not here: the refresh
 * they write back is kept only if able (updateIndexIfAble), and is not
 * where writing it would run post-index-change.
 */
const COMMAND_HOOKS = {
    add: ['post-index-change'],
    commit: ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction'],
    checkout: ['post-checkout', 'post-index-change', 'reference-transaction'],
    reset: ['post-index-change', 'reference-transaction'],
    merge: ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge', 'post-index-change', 'reference-transaction'],
    pull: ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge', 'post-index-change', 'reference-transaction'],
    fetch: ['reference-transaction'],
    push: ['pre-push', 'reference-transaction'],
    branch: ['reference-transaction'],
    tag: ['reference-transaction'],
    remote: ['reference-transaction'],
    'sparse-checkout': ['post-index-change'],
};
/**
 * The first of `hooks` git would run or report, null for none: where git
 * looks for them (core.hooksPath, from -c, the repository's and the global
 * config, a relative one from `top`, the directory hooks run in; else
 * $GIT_DIR/hooks), each found as git's find_hook finds it, by access(X_OK)
 * on its path as the command's principal. One there and executable runs;
 * one access refuses otherwise (EACCES: git says it ignored the hook) is
 * real git's to report. Only one that is not there is none.
 */
async function executableHook(ctx, git, fs, gitdir, top, hooks) {
    const value = await git.getConfig({ fs, gitdir, path: 'core.hooksPath' });
    const configured = typeof value === 'string' && value !== '' ? value : undefined;
    let dir = `${gitdir}/hooks`;
    if (configured !== undefined) {
        const home = ctx.env.HOME ?? '';
        const expanded = configured === '~' ? home : configured.startsWith('~/') ? home + configured.slice(1) : configured;
        dir = expanded.startsWith('/') ? expanded : `${top}/${expanded}`;
    }
    // The directory's listing, where it can be read, says at once which hooks
    // are not there; a directory that is not there holds none. One that
    // cannot be listed (searchable, not readable) is looked in by path.
    let listed = null;
    try {
        listed = new Set((await ctx.vfs.readdir(normalizeVfsPath(dir))).map((entry) => entry.name));
    }
    catch (error) {
        if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR'))
            return null;
    }
    for (const hook of hooks) {
        if (listed !== null && !listed.has(hook))
            continue;
        try {
            await ctx.vfs.access(normalizeVfsPath(`${dir}/${hook}`), X_OK);
        }
        catch (error) {
            if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR'))
                continue;
        }
        return hook;
    }
    return null;
}
/** Refuse, before any effect, a command whose hooks (COMMAND_HOOKS) the repository makes executable. */
async function assertNoHooks(ctx, git, fs, repo, sub) {
    const hooks = COMMAND_HOOKS[sub];
    if (hooks === undefined)
        return;
    const hook = await executableHook(ctx, git, fs, repo.gitdir, repo.worktree ?? repo.gitdir, hooks);
    if (hook !== null)
        throw new UnsupportedGitOperation(`fatal: git ${sub} with a ${hook} hook is not supported here\n`, 128);
}
/**
 * assertRepositoryImplemented's verdicts on a repository's config file, by
 * session, credential and git directory, each with the identity of the
 * content it was read from (contentStamp): a repository whose config is
 * unchanged is not read again for its format. One whose identity cannot be
 * told (a mount's, without revisions) is read every time.
 */
const formatVerdicts = new WeakMap();
/**
 * What names `path`'s content: the file it resolves to, by device, inode
 * and revision, and a link at the path by its own. Two files of one
 * revision (written in one transaction) are told apart by their inodes, and
 * a link switched between them by its own revision. Null where nothing is
 * there or a revision cannot be told (0: a mount's).
 */
async function contentStamp(ctx, path) {
    try {
        const own = await ctx.vfs.process.stat(path, { followSymlinks: false });
        if (own === null || own.revision === 0)
            return null;
        const stamp = `${own.dev}:${own.ino}:${own.revision}`;
        if (own.type !== 'symlink')
            return stamp;
        const target = await ctx.vfs.process.stat(path, { followSymlinks: true });
        return target === null || target.revision === 0 ? null : `${stamp}>${target.dev}:${target.ino}:${target.revision}`;
    }
    catch {
        return null;
    }
}
/** assertRepositoryImplemented, its verdict kept while the repository's config file is unchanged (formatVerdicts). */
async function assertRepositoryFormat(ctx, session, git, fs, repo) {
    if (repo.linked)
        return await assertRepositoryImplemented(git, fs, repo);
    const stamp = await contentStamp(ctx, `${repo.gitdir}/config`);
    const key = `${ctx.cred.uid}:${ctx.cred.gid}:${ctx.cred.groups.join(',')}:${repo.gitdir}`;
    let verdicts = formatVerdicts.get(session);
    if (verdicts === undefined)
        formatVerdicts.set(session, verdicts = new Map());
    const known = verdicts.get(key);
    if (stamp !== null && known?.stamp === stamp) {
        if (known.verdict instanceof UnsupportedGitOperation)
            throw known.verdict;
        return known.verdict;
    }
    let verdict;
    try {
        verdict = await assertRepositoryImplemented(git, fs, repo);
    }
    catch (error) {
        if (!(error instanceof UnsupportedGitOperation))
            throw error;
        verdict = error;
    }
    if (stamp !== null)
        verdicts.set(key, { stamp, verdict });
    if (verdict instanceof UnsupportedGitOperation)
        throw verdict;
    return verdict;
}
/** Refuse a repository whose format the built-in does not implement; answers whether it sets extensions.worktreeConfig. */
async function assertRepositoryImplemented(git, fs, repo) {
    const where = repo.worktree ?? repo.gitdir;
    if (repo.linked) {
        throw new UnsupportedGitOperation(`fatal: '${where}' is a linked worktree or submodule checkout, which is not supported here\n`, 128);
    }
    // The repository's own configuration: git reads its format nowhere else.
    const value = async (path) => {
        const got = await git.getConfig({ fs, gitdir: repo.gitdir, path });
        return got === undefined || got === null ? undefined : String(got);
    };
    const version = Number(await value('core.repositoryformatversion') ?? 0);
    if (!(version === 0 || version === 1)) {
        throw new UnsupportedGitOperation(`fatal: repository format version ${version} is not supported here\n`, 128);
    }
    // Every extension the repository declares: git 2.53 refuses an unknown one in a version 1 repository, and ignores it in version 0.
    let worktreeConfig = false;
    for (const name of await git.getConfigNames({ fs, gitdir: repo.gitdir, section: 'extensions' })) {
        const set = await value(`extensions.${name}`) ?? '';
        if (name === 'worktreeconfig') {
            worktreeConfig = configBool(await git.getConfig({ fs, gitdir: repo.gitdir, path: 'extensions.worktreeConfig' })) === true;
        }
        const v1Only = Object.hasOwn(V1_EXTENSIONS, name);
        const honored = V0_EXTENSIONS[name] ?? V1_EXTENSIONS[name];
        if (honored === undefined) {
            if (version === 0)
                continue;
            throw new UnsupportedGitOperation(`fatal: a repository with extensions.${name} is not supported here\n`, 128);
        }
        if (v1Only && version === 0) {
            throw new UnsupportedGitOperation(`fatal: extensions.${name} in a version 0 repository is not supported here\n`, 128);
        }
        if (!honored(set))
            throw new UnsupportedGitOperation(`fatal: a repository with extensions.${name} = ${set} is not supported here\n`, 128);
    }
    return { worktreeConfig };
}
function ambiguousArgument(arg) {
    return `fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.\n`
        + "Use '--' to separate paths from revisions, like this:\n"
        + "'git <command> [<revision>...] -- [<file>...]'\n";
}
/** A revision as rev-parse reads one: a ref, or a full or uniquely abbreviated object name. */
async function resolveRevision(git, fs, gitdir, rev, cache) {
    const name = rev === '@' ? 'HEAD' : rev;
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
function validateRevision(rev) {
    if (rev !== '@' && /[~^:{}\\]|\.\.|^@/.test(rev)) {
        throw new UnsupportedGitOperation(`fatal: unsupported revision syntax '${rev}'\n`, 128);
    }
}
function parseRevParseArgs(args) {
    const actions = [];
    let paths = false;
    for (const arg of args) {
        if (arg === '--')
            paths = true;
        if (paths) {
            actions.push({ kind: 'path', value: arg });
            continue;
        }
        switch (arg) {
            case '--verify':
                actions.push({ kind: 'verify' });
                break;
            case '-q':
            case '--quiet':
                actions.push({ kind: 'quiet' });
                break;
            case '--abbrev-ref':
                actions.push({ kind: 'abbrev-ref' });
                break;
            case '--show-toplevel':
                actions.push({ kind: 'toplevel' });
                break;
            case '--git-dir':
                actions.push({ kind: 'gitdir' });
                break;
            case '--is-inside-work-tree':
                actions.push({ kind: 'inside-work-tree' });
                break;
            default:
                if (arg.startsWith('-'))
                    throw new UnsupportedGitOperation(`fatal: rev-parse: unsupported option '${arg}'\n`, 129);
                validateRevision(arg);
                actions.push({ kind: 'revision', value: arg });
        }
    }
    return actions;
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
    for (const action of args) {
        switch (action.kind) {
            case 'path':
                out += `${action.value}\n`;
                continue;
            case 'verify':
                verify = true;
                continue;
            case 'quiet':
                quiet = true;
                continue;
            case 'abbrev-ref':
                abbrevRef = true;
                continue;
            case 'toplevel':
                if (!repo.worktree)
                    return fail(NOT_A_WORK_TREE, 128);
                out += `${repo.worktree}\n`;
                continue;
            case 'gitdir':
                // rev-parse names the git directory relative to the cwd only from the top.
                out += `${repo.prefix ? repo.gitdir : repo.worktree ? '.git' : '.'}\n`;
                continue;
            case 'inside-work-tree':
                out += `${repo.worktree ? 'true' : 'false'}\n`;
                continue;
        }
        const arg = action.value;
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
    + '[-u | --update] [--sparse] [--] <pathspec>...\n';
/** git add's options this git does not do: they are git's, so they are refused as unsupported, not unknown. */
const ADD_UNSUPPORTED = new Set(['i', 'p', 'e', 'N', 'U', '--interactive', '--patch', '--edit', '--intent-to-add',
    '--unified', '--inter-hunk-context', '--renormalize', '--refresh', '--ignore-errors', '--ignore-missing',
    '--chmod', '--pathspec-from-file', '--pathspec-file-nul']);
/** advise_on_updating_sparse_paths: the paths or pathspecs left alone outside a sparse checkout's cone. */
function sparsePathsAdvice(paths) {
    return 'The following paths and/or pathspecs matched paths that exist\n'
        + 'outside of your sparse-checkout definition, so will not be\n'
        + 'updated in the index:\n'
        + paths.map((path) => `${path}\n`).join('')
        + 'hint: If you intend to update such entries, try one of the following:\n'
        + 'hint: * Use the --sparse option.\n'
        + 'hint: * Disable or modify the sparsity rules.\n'
        + 'hint: Disable this message with "git config set advice.updateSparsePath false"\n';
}
/**
 * `git add`: what git 2.x stages for its pathspecs. A pathspec takes the
 * changes, deletions and new files below it (as -A does); -u only tracked
 * paths, --no-all no deletions, -A or -u with no pathspec the whole tree.
 * -n prints what would be staged (`add 'p'`, `remove 'p'`, tracked paths
 * first, then new ones) and stages nothing; -v prints it and stages. A
 * pathspec that matches nothing fails before anything is staged; one that
 * names an ignored path is reported (exit 1) unless -f, the rest still added.
 * In a sparse checkout, a path outside the cone (or skip-worktree) is left
 * alone, and named (exit 1) if a pathspec or a new file reaches it, unless
 * --sparse.
 */
function parseAddArgs(args) {
    let dryRun = false;
    let verbose = false;
    let force = false;
    let all = null;
    let update = false;
    let includeSparse = false;
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
        const flags = arg.startsWith('--') ? [arg] : [...arg.slice(1)];
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
                case '--sparse':
                    includeSparse = true;
                    break;
                default:
                    if (ADD_UNSUPPORTED.has(flag)) {
                        unsupportedOption('add', flag.length === 1 ? `-${flag}` : flag);
                    }
                    throw new UnsupportedGitOperation(flag.length === 1
                        ? `error: unknown switch \`${flag}'\n${ADD_USAGE}`
                        : `error: unknown option \`${flag.slice(2)}'\n${ADD_USAGE}`, 129);
            }
        }
    }
    return { dryRun, verbose, force, all, update, includeSparse, pathArgs };
}
async function addCommand(ctx, git, vfs, fs, parsed) {
    const { dryRun, verbose, force, all, update, includeSparse, pathArgs } = parsed;
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
        // Outside a sparse checkout's cone nothing is added or updated, but with --sparse.
        const sparse = await wrepo.sparseMatcher();
        const outside = (path) => sparse !== null && !sparse.includes(path);
        // -u updates what the index holds and nothing else; -f takes the ignored files below each pathspec as well.
        const scan = await scanWorktree(await wrepo.worktree(), dc, {
            specs, untracked: update ? 'no' : 'all', excludes, ignoredToo: force, uncleanIsDirty: true, unmerged: true,
        });
        // A nested repository stays 'dir/' here, as git prints it; it is added as a gitlink.
        const untracked = scan.untracked.sort(comparePaths);
        const ignored = [];
        // The pathspecs that reach only what the cone leaves out (find_pathspecs_matching_skip_worktree).
        const sparseSpecs = [];
        for (const [i, spec] of specs.entries()) {
            if (spec === '')
                continue;
            // A pathspec matches what the index holds there in the cone, or (but for -u) what is untracked there.
            const matching = function* () {
                const at = dc.find(spec);
                if (at >= 0)
                    yield at;
                const [lo, hi] = dc.rangeUnder(spec);
                for (let k = lo; k < hi; k++)
                    yield k;
            };
            let held = false;
            let leftOut = false;
            for (const k of matching()) {
                if (!dc.skipWorktree(k) && !outside(dc.path(k))) {
                    held = true;
                    break;
                }
                leftOut = true;
            }
            if (held || untracked.some((path) => inSpecs([spec], path.replace(/\/$/, ''))))
                continue;
            if (!includeSparse && leftOut) {
                sparseSpecs.push(pathArgs[i]);
                continue;
            }
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
        // read_directory's warnings, the pathspecs left out of the cone, diff-files' lstat failures, then add_files' advice.
        for (const line of scan.errors.untracked)
            await ctx.stderr.write(`${line}\n`);
        if (sparseSpecs.length)
            await ctx.stderr.write(sparsePathsAdvice(sparseSpecs));
        for (const line of scan.errors.tracked)
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
            // update_callback: outside the cone a tracked path is not touched (and not named).
            if (!includeSparse && outside(path))
                continue;
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
        // add_files: a new file outside the cone is named, not added.
        const sparseFiles = [];
        for (const path of untracked) {
            const repository = path.endsWith('/');
            if (!includeSparse && outside(repository ? path.slice(0, -1) : path)) {
                sparseFiles.push(path);
                continue;
            }
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
        if (sparseFiles.length)
            await ctx.stderr.write(sparsePathsAdvice(sparseFiles));
        await objects.flush();
        // Its stat refreshes ride in the one index write that stages (git add writes once).
        if (!dryRun && (removed.size || added.count || dc.refreshed))
            await wrepo.writeIndex(dc, { removed, added });
        return ignored.length || sparseSpecs.length || sparseFiles.length ? 1 : 0;
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
        const value = await git.getConfig({ fs, dir, path: key });
        return typeof value === 'string' ? value : undefined;
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
/**
 * `git tag`: list (-l, patterns, -n<num> with each tag's message or its
 * commit's subject), create (lightweight, or annotated with -a, -m or -F,
 * a tag object as git writes it), replace (-f) and delete (-d), with git's
 * messages and exit codes.
 */
function parseTagArgs(args) {
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
            messages.push(requiredValue(args, ++i, arg));
            continue;
        }
        if (arg.startsWith('--file=')) {
            messageFile = arg.slice('--file='.length);
            continue;
        }
        if (arg === '--file') {
            messageFile = requiredValue(args, ++i, arg);
            continue;
        }
        if (arg.startsWith('--')) {
            throw new UnsupportedGitOperation(`error: unknown option \`${arg.slice(2)}'\n${TAG_USAGE}`, 129);
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
                    throw new GitGlobalsError(`error: switch \`${flag}' requires a value\n${TAG_USAGE}`, 129);
                }
                if (flag === 'm')
                    messages.push(value);
                else
                    messageFile = value;
                break;
            }
            else {
                throw new UnsupportedGitOperation(`error: unknown switch \`${flag}'\n${TAG_USAGE}`, 129);
            }
        }
    }
    if (messageFile === '-')
        unsupportedOption('tag', '--file=-');
    // An annotated tag made with no -m or -F takes its message from an editor: real git's.
    if (annotate && messages.length === 0 && messageFile === null && !del && !list && lines === null && operands.length > 0) {
        unsupportedOption('tag', '-a without -m or -F (its message from an editor)');
    }
    return { annotate, force, del, list, lines, messages, messageFile, operands };
}
async function tagCommand(ctx, git, fs, vfs, parsed) {
    const { annotate, force, del, list, lines, messages, messageFile, operands } = parsed;
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
        // Each a wildmatch over the whole name, any of them, as ref-filter's match_pattern takes them.
        const patterns = operands.map((pattern) => enc.encode(pattern));
        const names = (await git.listTags({ fs, dir }))
            .filter((name) => patterns.length === 0 || patterns.some((pattern) => wildmatch(pattern, enc.encode(name))))
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
        // Written as every object a command makes is: 0444 from its creation.
        const objects = await worktreeRepo(ctx, git, vfs, fs, gitdir, dir).objectWriter();
        value = await objects.write('tag', new TextEncoder().encode(body));
        await objects.flush();
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
function parseLsFilesArgs(args) {
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
                    throw new UnsupportedGitOperation(`error: unknown option '${flag.replace(/^-+/, '')}'\n${LS_FILES_USAGE}`, 129);
            }
        }
    }
    // With no selection ls-files shows the index; --stage shows it with each entry's mode, id and stage.
    if (!others && !modified && !deleted && !stage)
        cached = true;
    return { cached, others, modified, deleted, excludeStandard, stage, z, pathArgs };
}
async function lsFiles(ctx, git, vfs, fs, parsed) {
    const { cached, others, modified, deleted, excludeStandard, stage, z, pathArgs } = parsed;
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
/** sessionGitFs's worktree rule (a link or file in a directory's way is replaced), as the checkout writer. */
function checkoutWriter(vfs, root) {
    const fs = sessionGitFs(vfs, root);
    return {
        writeFile: (path, data, mode) => fs.promises.writeFile(path, data, { mode }),
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
            sparse: await wrepo.sparseMatcher(),
            protect: await wrepo.pathProtection(),
            // A checkout shows unpack-trees' warnings; a reset does not.
            warn: force ? undefined : async (text) => { await ctx.stderr.write(text); },
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
 * git's checkout writes them: see sessionGitFs's worktree rule. A
 * skip-worktree entry is not checked out (nor one from the tree that is the
 * same), but with --ignore-skip-worktree-bits (`ignoreSkipWorktree`).
 */
async function checkoutPaths(ctx, git, vfs, fs, source, pathArgs, ignoreSkipWorktree = false) {
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
        // An entry checked out with --ignore-skip-worktree-bits keeps its bit (checkout_entry writes the file only).
        const take = (path, oid, mode, skipWorktree = false) => {
            // A gitlink is never checked out.
            if ((mode & 0o170000) === 0o160000)
                return;
            const matching = specs.flatMap((spec, i) => spec === '' || path.startsWith(`${spec}/`) || (path === spec && !dirOnly[i]) ? [i] : []);
            if (matching.length === 0)
                return;
            for (const i of matching)
                matched.add(i);
            files.push({ path, oid, mode, skipWorktree });
        };
        // mark_ce_for_checkout_overlay: a skip-worktree entry is not matched.
        const skipped = (i) => !ignoreSkipWorktree && dc.skipWorktree(i);
        if (source === null) {
            for (const i of entriesInSpecs(dc, specs))
                if (dc.stage(i) === 0 && !skipped(i))
                    take(dc.path(i), dc.oid(i), dc.mode(i), dc.skipWorktree(i));
        }
        else {
            const oid = await resolveRevision(git, wrepo.gitFs, repo.gitdir, source, {});
            if (!oid) {
                await ctx.stderr.write(`fatal: invalid reference: ${source}\n`);
                return 128;
            }
            const within = (dir) => inSpecs(specs, dir) || specs.some((spec) => spec.startsWith(`${dir}/`));
            const protect = await wrepo.pathProtection();
            for await (const leaf of treeLeaves(wrepo.store, await treeOf(wrepo.store, oid), '', within)) {
                if (!inSpecs(specs, leaf.path))
                    continue;
                // update_some: the tree's entry the same as the index's keeps the index's, skip-worktree and all.
                const i = dc.find(leaf.path);
                const same = i >= 0 && dc.stage(i) === 0 && dc.oid(i) === leaf.oid && dc.mode(i) === leaf.mode && !dc.intentToAdd(i);
                if (same && skipped(i))
                    continue;
                // Any other is added to the index, which refuses a path verify_path refuses: its error, and it is not checked out.
                if (!same && !verifyPath(leaf.path, leaf.mode, protect)) {
                    await ctx.stderr.write(invalidPathError(leaf.path));
                    continue;
                }
                take(leaf.path, leaf.oid, leaf.mode, same && dc.skipWorktree(i));
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
        for (const { path, oid, mode, skipWorktree } of files) {
            const file = `${root}/${path}`;
            const { data } = await wrepo.store.read(oid);
            if (mode === 0o120000) {
                await writer.symlink(nameDec.decode(data), file);
            }
            else {
                const fileMode = mode === 0o100755 ? 0o755 : 0o644;
                await writer.writeFile(file, data, fileMode);
                await writer.chmod(file, fileMode);
            }
            added.add({ path, mode, oid, stat: await wrepo.fs.lstat(path), skipWorktree });
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
function parseDiffArgs(args, columns) {
    let cached = false;
    let noIndex = false;
    let patch = false;
    let dashdash = false;
    // Renames are on by default, as with git's diff.renames; null turns them off.
    let minimumScore = DEFAULT_RENAME_SCORE;
    const output = {
        format: 'patch',
        z: false,
        context: DEFAULT_CONTEXT,
        columns: parseInt(columns ?? '', 10) > 0 ? parseInt(columns ?? '', 10) : 80,
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
                throw new GitGlobalsError(`error: invalid argument to find-renames\n${DIFF_USAGE}`, 129);
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
                patch = true;
                continue;
            case '--no-ext-diff':
            case '--no-color': continue;
            case '--stat':
            case '--name-only':
            case '--name-status': {
                const format = arg === '--stat' ? 'stat' : arg === '--name-only' ? 'name-only' : 'name-status';
                if (output.format !== 'patch' && output.format !== format) {
                    throw new UnsupportedGitOperation(`fatal: options '--${output.format}' and '${arg}' cannot be used together\n`, 128);
                }
                output.format = format;
                continue;
            }
        }
        throw new UnsupportedGitOperation(`error: unknown option '${arg.replace(/^-+/, '')}'\n${DIFF_USAGE}`, 129);
    }
    if (noIndex && cached)
        throw new GitGlobalsError("fatal: options '--cached' and '--no-index' cannot be used together\n", 128);
    if (patch && output.format === 'stat')
        unsupportedOption('diff', 'combined patch and diffstat');
    if (!noIndex)
        for (const revision of positionals)
            validateRevision(revision);
    return { cached, noIndex, dashdash, minimumScore, output, positionals, pathArgs };
}
async function prepareDiff(ctx, git, fs, vfs, parsed) {
    if (parsed.noIndex)
        return;
    const { dashdash, positionals, pathArgs } = parsed;
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo)
        throw new GitGlobalsError(NOT_A_REPOSITORY, 128);
    const root = repo.worktree;
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
            throw new GitGlobalsError(`fatal: bad revision '${arg}'\n`, 128);
        }
        if (!await vfs.exists(normalizeVfsPath(arg.startsWith('/') ? arg : `${ctx.cwd}/${arg}`))) {
            throw new GitGlobalsError(ambiguousArgument(arg), 128);
        }
        pathArgs.push(arg);
    }
    if (revs.length > 1) {
        throw new UnsupportedGitOperation('fatal: diff between two commits is not supported; compare one commit with the worktree or the index\n', 128);
    }
    if (!root)
        throw new GitGlobalsError(NOT_A_WORK_TREE, 128);
    parsed.comparison = { gitdir: repo.gitdir, root, revs };
}
async function diffCommand(ctx, git, fs, vfs, parsed, partial) {
    const { cached, noIndex, minimumScore, output, positionals, pathArgs, comparison } = parsed;
    if (noIndex)
        return diffNoIndex(ctx, git, vfs, [...positionals, ...pathArgs], output);
    if (comparison === undefined)
        throw new Error('internal error: diff comparison not prepared');
    const { gitdir, root, revs } = comparison;
    const wrepo = worktreeRepo(ctx, git, vfs, fs, gitdir, root);
    const dc = await wrepo.readIndex();
    const base = cached
        ? { kind: 'tree', tree: revs.length ? await treeOf(wrepo.store, revs[0]) : await wrepo.headTree(), cached: true }
        : revs.length ? { kind: 'tree', tree: await treeOf(wrepo.store, revs[0]), cached: false } : { kind: 'index' };
    const pending = await changedPairs(wrepo, dc, base, repoPaths(pathArgs, ctx.cwd, root), ctx.stderr);
    // git diff writes back the stat it found stale on files whose content had not changed.
    await wrepo.updateIndexIfAble(dc, async () => await executableHook(ctx, git, fs, gitdir, root, ['post-index-change']) !== null);
    // The blobs this diff reads, fetched together where a partial clone lacks them (git's diff_queued_diff_prefetch).
    if ((output.format === 'patch' || output.format === 'stat' || minimumScore !== null) && await partial(gitdir)) {
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
function parseStatusArgs(args) {
    let format = 'nimbus';
    let z = false;
    let untracked = null;
    let renames = null;
    let dashdash = false;
    const pathArgs = [];
    const unsupported = (flag) => unsupportedOption('status', flag.length === 1 ? `-${flag}` : flag);
    const untrackedMode = (mode) => {
        if (mode === 'no' || mode === 'normal' || mode === 'all')
            untracked = mode;
        else
            throw new GitGlobalsError(`fatal: Invalid untracked files mode '${mode}'\n`, 128);
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
            if (value !== null && ['--short', '--null', '--renames', '--no-renames'].includes(flag))
                unsupported(arg);
            if (flag === '--short')
                format = 'short';
            else if (flag === '--porcelain' && (value === null || value === 'v1' || value === '1'))
                format = 'porcelain';
            else if (flag === '--porcelain')
                unsupported(arg);
            else if (flag === '--null')
                z = true;
            else if (flag === '--untracked-files')
                untrackedMode(value ?? 'all');
            else if (flag === '--renames')
                renames = true;
            else if (flag === '--no-renames')
                renames = false;
            else if (STATUS_UNSUPPORTED.has(flag))
                unsupported(flag);
            else
                throw new UnsupportedGitOperation(`error: unknown option \`${arg.slice(2)}'\n${STATUS_USAGE}`, 129);
            continue;
        }
        for (let i = 1; i < arg.length; i++) {
            const flag = arg[i];
            if (flag === 's')
                format = 'short';
            else if (flag === 'z')
                z = true;
            else if (flag === 'u') {
                untrackedMode(arg.slice(i + 1) || 'all');
                break;
            }
            else if (STATUS_UNSUPPORTED.has(flag))
                unsupported(flag);
            else
                throw new UnsupportedGitOperation(`error: unknown switch \`${flag}'\n${STATUS_USAGE}`, 129);
        }
    }
    // -z alone is porcelain v1.
    if (z && format === 'nimbus')
        format = 'porcelain';
    return { format, z, untracked, renames, pathArgs };
}
async function statusCommand(ctx, git, vfs, fs, parsed) {
    const { format, z, pathArgs } = parsed;
    let { untracked, renames } = parsed;
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
    const status = await collectStatus(wrepo.store, await wrepo.scannedWorktree(), dc, await wrepo.headTree(), {
        specs: repoPaths(pathArgs, ctx.cwd, root),
        untracked,
        excludes: untracked === 'no' ? null : await wrepo.excludes(dc),
        renames,
    });
    for (const line of status.errors)
        await ctx.stderr.write(`${line}\n`);
    await wrepo.updateIndexIfAble(dc, async () => await executableHook(ctx, git, fs, repo.gitdir, root, ['post-index-change']) !== null);
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
    const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, repo.worktree);
    if ((await wrepo.readIndex()).unmergedPaths().length) {
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
/** What git's remove_junk says of a clone whose checkout failed after its objects were in (builtin/clone.c junk_leave_repo_msg). */
const JUNK_LEAVE_REPO_WARNING = "warning: Clone succeeded, but checkout failed.\nYou can inspect what was checked out with 'git status'\nand retry with 'git restore --source=HEAD :/'\n\n";
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
 * index written once. False, nothing written, when git dies on a path
 * verify_path refuses (make_cache_entry).
 */
async function resetIndex(ctx, wrepo, tree, specs, quiet) {
    return await wrepo.withIndexLock(async () => {
        const dc = await indexFromTree(wrepo, tree, specs);
        if (typeof dc === 'string') {
            await ctx.stderr.write(`${invalidPathError(dc)}fatal: make_cache_entry failed for path '${dc}'\n`);
            return false;
        }
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
        return true;
    });
}
/**
 * read_from_tree: the index with `tree`'s entries for `specs`, an unchanged
 * one keeping its stat. A changed entry keeps its skip-worktree bit, and a
 * new one takes it outside a sparse checkout's cone (update_index_from_diff).
 * The index read is dropped here, so a reset holds one index, not two. A
 * path verify_path refuses is answered instead: git dies at the first.
 */
async function indexFromTree(wrepo, tree, specs) {
    const old = await wrepo.readIndex();
    const removed = new Set();
    const added = new NewEntries();
    const protect = await wrepo.pathProtection();
    const refused = [];
    // Read only for a new path: the cone of a sparse checkout, or null.
    let sparse;
    await walkTreeAndIndex(wrepo.store, tree, old, specs, async (path, leaf, lo, hi) => {
        if (refused.length > 0)
            return;
        if (leaf && hi - lo === 1 && old.stage(lo) === 0 && old.oid(lo) === leaf.oid && old.mode(lo) === leaf.mode)
            return;
        for (let i = lo; i < hi; i++)
            removed.add(i);
        if (!leaf)
            return;
        if (!verifyPath(path, leaf.mode, protect)) {
            refused.push(path);
            return;
        }
        let skipWorktree;
        if (hi > lo && old.stage(lo) === 0) {
            skipWorktree = old.skipWorktree(lo);
        }
        else {
            if (sparse === undefined)
                sparse = await wrepo.sparseMatcher();
            skipWorktree = sparse !== null && !sparse.includes(path);
        }
        added.add({ path, mode: leaf.mode, oid: leaf.oid, stat: null, skipWorktree });
    }, { cacheTree: old.cacheTree() });
    if (refused.length > 0)
        return refused[0];
    return removed.size || added.count ? DirCache.parse(old.encode({ removed, added }), old.timestamp) : old;
}
const RESET_USAGE = 'usage: git reset [--mixed | --soft | --hard] [-q] [<commit>]\n'
    + '   or: git reset [-q] [<tree-ish>] [--] <pathspec>...\n';
/** `git reset`: --soft moves HEAD, --mixed (the default) the index with it, --hard the worktree too; paths reset index entries. */
function parseResetArgs(args) {
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
            throw new UnsupportedGitOperation(`error: unknown option \`${arg.replace(/^-+/, '')}'\n${RESET_USAGE}`, 129);
        }
        else
            words.push(arg);
    }
    if (words.length)
        validateRevision(words[0]);
    return { mode, quiet, words, dashdash: dashdash >= 0, pathArgs: dashdash >= 0 ? args.slice(dashdash + 1) : [] };
}
async function resetCommand(ctx, git, vfs, fs, parsed, 
/** Fetch what a partial clone lacks of `commits`, as the worktree at `worktree` (null: bare) checks it out. */
prefetch) {
    const { mode, quiet, words, dashdash, pathArgs } = parsed;
    const repo = await discoverRepo(vfs, ctx.cwd);
    if (!repo) {
        await ctx.stderr.write(NOT_A_REPOSITORY);
        return 128;
    }
    // Before `--` the first word is a revision when it names one; the rest are paths.
    let rev = 'HEAD';
    let oid = words.length ? await resolveRevision(git, fs, repo.gitdir, words[0], {}) : null;
    if (oid !== null)
        rev = words[0];
    else if (dashdash && words.length) {
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
        return await resetIndex(ctx, wrepo, await treeOf(wrepo.store, oid), repoPaths(pathArgs, ctx.cwd, root), quiet) ? 0 : 128;
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
        await prefetch(repo.gitdir, repo.worktree ?? null, [oid]);
        try {
            await moveWorktree(ctx, git, vfs, fs, repo, oid, { force: true });
        }
        catch (error) {
            // reset_index's unpack_trees stops at the first path verify_path refuses, having written nothing.
            if (!(error instanceof CheckoutRefused) || error.refusal.invalid.length === 0)
                throw error;
            await ctx.stderr.write(`${invalidPathError(error.refusal.invalid[0])}fatal: Could not reset index file to revision '${rev}'.\n`);
            return 128;
        }
    }
    else if (mode === 'mixed') {
        const wrepo = worktreeRepo(ctx, git, vfs, fs, repo.gitdir, root);
        if (!await resetIndex(ctx, wrepo, await treeOf(wrepo.store, oid), [], quiet))
            return 128;
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
/**
 * One effective destination for precheck, transport and diagnostics. Remote
 * URLs are multi-valued: git uses their first value, not config's scalar
 * last-value rule. An empty value resets the list; -c appends after files.
 * Push prefers pushurl, falling back to url only when it has none.
 */
async function knownRemote(ctx, git, fs, dir, remote, operation) {
    if (remote.includes('://'))
        return remote;
    for (const field of operation === 'push' ? ['pushurl', 'url'] : ['url']) {
        let first;
        for (const value of await git.getConfigAll({ fs, dir, path: `remote.${remote}.${field}` })) {
            if (value === '')
                first = undefined;
            else if (typeof value === 'string' && first === undefined)
                first = value;
        }
        if (first !== undefined)
            return first;
    }
    await ctx.stderr.write(noSuchRemoteText(remote));
    return undefined;
}
function remoteCredentials(ctx, url) {
    return selectRemoteCredentials(url, { username: ctx.env.GIT_USERNAME || '', password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '' });
}
/**
 * A network command that failed: when the git server could not be reached,
 * or refused (pack/remote-failure.ts), git's message about the repository
 * at `url`, and git's 128 (a push whose request for the pack failed, 1);
 * else what failed, and 1.
 */
function networkFailureText(ctx, what, result, url) {
    if (result.gitFailure !== undefined)
        return { text: result.gitFailure, code: 128 };
    if (result.remoteFailure !== undefined && url !== undefined) {
        // The credentials offered, the session's or the URL's own; the secrets among them never printed.
        const inUrl = urlCredentials(url);
        const { username, password } = remoteCredentials(ctx, url);
        // And the Basic authorization they were sent as, which a server may echo.
        const secrets = [ctx.env.GIT_PASSWORD, ctx.env.GIT_TOKEN, inUrl.password,
            password ? base64Utf8(`${username}:${password}`) : '',
            inUrl.password ? base64Utf8(`${inUrl.username}:${inUrl.password}`) : '']
            .filter((secret) => Boolean(secret));
        const text = remoteFailureText(url, result.remoteFailure, { username, password: Boolean(password) }, secrets);
        return { text, code: what === 'push' && result.remoteFailure.kind === 'rpc' ? 1 : 128 };
    }
    return { text: `\n[git] ${what} failed: ${result.error}\n`, code: 1 };
}
async function networkFailure(ctx, what, result, url) {
    const { text, code } = networkFailureText(ctx, what, result, url);
    await ctx.stderr.write(text);
    return code;
}
/**
 * `path` in the namespace as `view` sees it, every link resolved: the
 * nearest name above it that is there, resolved, and the rest as given.
 */
async function namespacePath(view, path) {
    let at = '/' + normalizeVfsPath(path);
    let below = '';
    for (;;) {
        try {
            const real = await view.realpath(at);
            return below === '' ? real : `${real === '/' ? '' : real}/${below}`;
        }
        catch (error) {
            if (at === '/' || (!isVfsError(error, 'ENOENT') && !isVfsError(error, 'ENOTDIR')))
                throw error;
            const cut = at.lastIndexOf('/');
            below = below === '' ? at.slice(cut + 1) : `${at.slice(cut + 1)}/${below}`;
            at = at.slice(0, cut) || '/';
        }
    }
}
/** The first name on the way to `path` (a resolved namespace path) that is not there, or `path` itself when it is. */
async function firstMissing(view, path) {
    const parts = normalizeVfsPath(path).split('/');
    for (let i = 1; i <= parts.length; i++) {
        const prefix = '/' + parts.slice(0, i).join('/');
        if (await view.stat(prefix, { follow: false }) === null)
            return prefix;
    }
    return '/' + parts.join('/');
}
export async function runGitCommand(ctx, vfs, doCtx, doEnv, 
/** The workspace's network (`workspace.network`): clone, fetch, pull, push and promisor fetches go out through it. */
network = ISOLATE_NETWORK, 
/**
 * The session's filesystem authority: a host bridge on the namespace, for
 * the cleanup of a clone on a mount, and the namespace's ingestion of the
 * waves a repository's objects go in.
 */
filesystem, 
/** The session's process table: a background clone runs as a process of its own. */
processes, 
/**
 * This invocation, run by real git (`nimbus install git`) instead: what
 * this implementation lacks is real git's (routing.ts), and so is every
 * git real git starts (its environment says GIT_WASI_ENV).
 */
realGit) {
    if (realGit !== undefined && ctx.env[GIT_WASI_ENV] === '1')
        return realGit();
    let globals;
    try {
        globals = parseGitGlobals(ctx.args, getDir(ctx));
    }
    catch (e) {
        if (e instanceof UnsupportedGitOperation) {
            if (realGit !== undefined)
                return realGit();
            await ctx.stderr.write(e.diagnostic);
            return e.code;
        }
        if (e instanceof GitGlobalsError) {
            await ctx.stderr.write(e.lines);
            return e.code;
        }
        ctx.stderr.write(`git: ${e?.message}\n`);
        return 129;
    }
    const { sub, subArgs } = globals;
    if (realGit !== undefined && gitBackend(sub) === 'wasi')
        return realGit();
    let command = null;
    try {
        if (sub && !['--version', '-v', '--help', '-h'].includes(sub))
            command = parseCommandArgs(sub, subArgs, ctx.env);
        else if (subArgs.length)
            unsupportedOption('help', 'additional arguments');
    }
    catch (error) {
        if (error instanceof UnsupportedGitOperation) {
            if (realGit !== undefined)
                return realGit();
            await ctx.stderr.write(error.diagnostic);
            return error.code;
        }
        if (error instanceof GitGlobalsError) {
            await ctx.stderr.write(error.lines);
            return error.code;
        }
        await ctx.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        return 128;
    }
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
    let executing = false;
    // Its repository's worktree top, once found: where git names a file from.
    let top = null;
    try {
        git = await getGit();
    }
    catch (e) {
        ctx.stderr.write(`git: failed to load git module: ${e?.message}\n`);
        return 1;
    }
    // `git init <path>` works on that path, every other subcommand on the cwd.
    const initPath = command?.sub === 'init' ? command.parsed.directory : undefined;
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
            const place = await placeRepository(top || '/');
            await fetchMissingObjects(doCtx, doEnv, {
                pid: ctx.pid,
                dir: place.dir,
                onMount: place.mount,
                remote: remote.name,
                url: remote.url,
                oids,
                auth: remoteCredentials(ctx, remote.url),
            }, network);
            return true;
        };
        const fs = sessionGitFs(repoVfs, null, promisor);
        const fileGit = git;
        // The command's config reader: -c over the files, the global under the
        // repository's, and a repository's config.worktree where it sets
        // extensions.worktreeConfig (withWorktreeConfig). That layer is taken
        // only where config.worktree may be read: a clone or a sparse checkout
        // (which may set the extension) or a repository that sets it (the format
        // guard's reading, by gitdir). Any other command pays nothing for it.
        const worktreeConfigs = new Map();
        const reader = (worktree) => withConfigOverrides(worktree
            ? withWorktreeConfig(withGlobalConfig(fileGit, fs, ctx.env, dir), fileGit, fs, worktreeConfigs)
            : withGlobalConfig(fileGit, fs, ctx.env, dir), globals.config);
        git = reader(sub === 'clone' || sub === 'sparse-checkout');
        commandFs = fs;
        // The engine, as this command's principal: a repository on it takes its objects in waves (WorktreeRepo.objectWriter).
        commandEngines.set(fs, {
            key: async (path) => await engineKey(ctx.vfs, vfs, path),
            // Without the session's namespace (a bare engine), nothing is placed elsewhere.
            writeStream: (stream) => (filesystem?.waves ?? new WaveIngest(null)).writeStream(vfs.as(ctx.cred), stream),
        });
        // Where a network command writes a repository: its engine key, or on a
        // mount its path in the namespace (every link resolved), which the
        // facet's writes reach as the command's own would.
        const placeRepository = async (target) => {
            const key = await engineKey(ctx.vfs, vfs, target);
            if (key !== null)
                return { dir: '/' + key, mount: false };
            return { dir: await namespacePath(ctx.vfs, target), mount: true };
        };
        // A clone still running owns its repository: git would not show one
        // half-made, and a command reading it now would take its shallow or
        // partial state for the finished clone's.
        if (sub !== 'init' && sub !== 'clone') {
            const repo = await discoverRepo(repoVfs, dir);
            top = repo?.worktree ?? null;
            // The repository's format is its own config file's, as git reads it: no -c or global value stands in.
            if (repo !== null) {
                const { worktreeConfig } = await assertRepositoryFormat(ctx, vfs, await getGit(), fs, repo);
                worktreeConfigs.set(repo.gitdir, worktreeConfig);
                if (worktreeConfig)
                    git = reader(true);
            }
            if (repo !== null && command !== null)
                await assertNoHooks(ctx, git, fs, repo, command.sub);
            if (repo !== null && await repoVfs.exists(`${repo.gitdir}/${GIT_CLONE_JOB_MARKER}`)) {
                await ctx.stderr.write(`fatal: '${repo.worktree ?? repo.gitdir}' is still being cloned\n`);
                return 128;
            }
            if (repo?.worktree && command !== null) {
                let readsIndex = false;
                switch (command.sub) {
                    case 'status':
                    case 'commit':
                    case 'ls-files':
                    case 'merge':
                    case 'pull':
                    case 'sparse-checkout':
                        readsIndex = true;
                        break;
                    case 'add':
                        readsIndex = command.parsed.pathArgs.length > 0 || command.parsed.all === true || command.parsed.update;
                        break;
                    case 'checkout':
                        readsIndex = command.parsed.paths.length > 0 || command.parsed.create
                            || (command.parsed.ref !== undefined && command.parsed.ref !== 'HEAD');
                        break;
                    case 'reset':
                        readsIndex = command.parsed.mode !== 'soft';
                        break;
                    case 'diff':
                        readsIndex = !command.parsed.noIndex;
                        break;
                }
                if (readsIndex)
                    await worktreeRepo(ctx, git, repoVfs, fs, repo.gitdir, repo.worktree).prepare();
            }
        }
        if (command === null)
            return 1;
        if (command.sub === 'diff')
            await prepareDiff(ctx, git, fs, repoVfs, command.parsed);
        executing = true;
        switch (command.sub) {
            case 'init': {
                const initArgs = command.parsed;
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
                // -b, or init.defaultBranch (from `-c`, read over the files'), or git's master.
                let initialBranch = initArgs.branch;
                if (initialBranch === undefined) {
                    let configured;
                    configured = await git.getConfig({ fs, dir: initDir, path: 'init.defaultBranch' });
                    if (typeof configured === 'string')
                        initialBranch = configured;
                }
                if (initialBranch !== undefined && !isValidRefName(`refs/heads/${initialBranch}`)) {
                    ctx.stderr.write(`fatal: invalid initial branch name: '${initialBranch}'\n`);
                    return 128;
                }
                await git.init({ fs, dir: initDir, bare: initArgs.bare, ...(initialBranch === undefined ? {} : { defaultBranch: initialBranch }) });
                if (!initArgs.quiet)
                    ctx.stdout.write(`Initialized empty Git repository in ${gitDir}/\n`);
                return 0;
            }
            case 'clone': {
                const { url, dest: destArg, depth, isBg, branch, quiet, filter, sparse } = command.parsed;
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
                const place = await placeRepository(dest);
                const target = place.dir;
                if (!doCtx || !doEnv) {
                    ctx.stderr.write('[git] clone requires DO ctx + env (internal configuration error)\n');
                    return 1;
                }
                // A clone's emptiness proof and its writes hold only while no other
                // session surface can mutate its destination subtree. Acquire
                // the lease before the facet performs its lstat/readdir emptiness
                // proof; the clone's W7 stream carries the opaque owner capability
                // through the trusted SupervisorRPC binding. Taken as the command's
                // credential: the clone writes as it, so a confined caller's /tmp is
                // held where those writes land, not at the shared tmp/ of that name.
                // On a mount the lease's root is the first name missing on the way
                // to the destination as the namespace sees it (SQLite's own inodes do
                // not say), held at that path: the namespace refuses another's
                // mutations there by it, as it does on SQLite. A delegation it
                // overlaps is recalled first (withRecall). It goes when the clone's
                // process is stopped (stoppable): a destroy stops the clone first.
                // The names its checkout refuses beyond verify_path's own, as git's
                // clone reads them: `-c` and the user's global config. The
                // destination has no config yet, and the repository the command is
                // run in is not the clone's.
                const protect = await worktreeRepo(ctx, git, repoVfs, fs, `${dest}/.git`, dest).pathProtection();
                const leaseRoot = place.mount ? await firstMissing(ctx.vfs, target) : target;
                const mutationLease = await withRecall(() => vfs.as(ctx.cred).acquireExclusiveMutation(leaseRoot, { includeMissingAncestors: !place.mount, stoppable: true }));
                // A piece of the clone that hung may still write: the facet runner
                // hands the lease to a new owner before it runs the piece again.
                let mutationOwner = mutationLease.owner;
                // Delegate to git-network-facet: heavy packfile processing runs in
                // a dynamic worker with its own CPU budget, not the supervisor DO.
                // It owns the lease from when it is called, and releases it. `signal`
                // is its stop: a Ctrl-C or a kill removes the junk, as git's signal
                // handler does, then the record; a destroy leaves both to its wipe.
                const doClone = async (job, pid, signal) => {
                    let cloned = false;
                    try {
                        let result;
                        try {
                            result = await execGitNetwork(doCtx, doEnv, {
                                op: 'clone',
                                signal,
                                pid,
                                dir: target,
                                url,
                                ref: branch,
                                depth,
                                filter,
                                sparse,
                                protect,
                                quiet,
                                exclusiveDestination: true,
                                exclusiveMutationRoot: mutationLease.root,
                                onMount: place.mount,
                                cloneJobId: job.jobId,
                                onCloneCheckoutPhase: () => setCloneJobPhase(doCtx.storage, job, 'checkout'),
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
                                auth: remoteCredentials(ctx, url),
                            }, network);
                        }
                        catch (error) {
                            // What it wrote before it threw is cleaned up as a failure's.
                            result = { success: false, error: String(error?.message ?? error), cleanup: true, elapsed: 0, filesWritten: 0, bytesWritten: 0 };
                        }
                        if (result.success) {
                            await deleteCloneJob(doCtx.storage, job);
                            progress.write(`\n[git] clone complete (${result.filesWritten} files, ` +
                                `${(result.bytesWritten / 1024).toFixed(1)}KB in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
                            cloned = true;
                            return 0;
                        }
                        // A write git would have failed: git's words, and git's 128 (it dies); else what failed.
                        // A stopped clone ends as its signal says, silently, as git's does.
                        const code = result.cancelled !== undefined ? exitCodeForAbortSignal(signal)
                            : await networkFailure(ctx, 'clone', result, url);
                        // A destroy's wipe takes its junk and its record (or, if the wipe
                        // fails, the next start's recovery does): it writes nothing more.
                        if (result.cancelled?.reason === SESSION_DESTROYED)
                            return code;
                        if (result.cleanup !== true) {
                            await deleteCloneJob(doCtx.storage, job);
                            return code;
                        }
                        // As git's remove_junk: in the DO, under the clone's lease (its
                        // current owner: the facets were fenced), as the clone's credential.
                        // On a mount, through the namespace (a host bridge presenting the lease).
                        const host = place.mount ? filesystem?.openHost(ctx.cred) : undefined;
                        try {
                            const bridge = host?.fs.synchronous;
                            if (place.mount && bridge === undefined)
                                throw new Error('no namespace to clean it up through');
                            const cleaned = await cleanUpClone(bridge ? bridgeCleanupFs(bridge, mutationOwner) : vfs.as(ctx.cred, { mutationOwner }), doCtx.storage, job, {
                                sliceEntries: Number(ctx.env.NIMBUS_GIT_CLONE_CLEANUP_SLICE) || undefined,
                            });
                            if (cleaned.outcome === 'kept-repo')
                                ctx.stderr.write(JUNK_LEAVE_REPO_WARNING);
                        }
                        catch (error) {
                            // The record stays: the session finishes the cleanup when it next starts.
                            ctx.stderr.write(`[git] could not remove the failed clone at '${dest}': ${String(error?.message ?? error)}\n`);
                        }
                        finally {
                            await host?.dispose();
                        }
                        return code;
                    }
                    finally {
                        vfs.releaseExclusiveMutation(mutationOwner);
                        // A full clone's changed-path filters, once it has answered
                        // (git/pack/graph-filters.ts): in the background, never the
                        // clone's to wait for or to fail on.
                        if (cloned && depth === undefined) {
                            doCtx.waitUntil(runGraphFilters(doCtx, doEnv, {
                                pid,
                                dir: target,
                                onMount: place.mount,
                                pieceCommits: Number(ctx.env.NIMBUS_GIT_GRAPH_FILTER_PIECE_COMMITS) || undefined,
                                pieceBudgetMs: Number(ctx.env.NIMBUS_GIT_GRAPH_FILTER_PIECE_BUDGET_MS) || undefined,
                            }, network).then((outcome) => {
                                // Nothing waits for it: why it left the chain as it is goes to the session's log.
                                if (outcome.skipped === 'locked' || outcome.skipped === 'moved') {
                                    console.warn('[git] commit-graph after clone', JSON.stringify({ dir: target, skipped: outcome.skipped }));
                                }
                            }, (error) => {
                                console.warn('[git] commit-graph after clone', JSON.stringify({ dir: target, error: String(error?.message ?? error) }));
                            }));
                        }
                    }
                };
                // Until doClone owns the lease, this does: a refusal or a failed record releases it.
                let handedOff = false;
                try {
                    // The destination is absent or an empty directory, proven under the
                    // lease before the record is written: a cleanup removes only what
                    // the clone made. git's refusal otherwise.
                    // Asked of the namespace, as the command sees it: a mount's destination is the mount's.
                    const existing = await ctx.vfs.stat(target, { follow: false });
                    const rootExisted = existing !== null;
                    if (existing !== null && (existing.type !== 'directory' || (await ctx.vfs.readdir(target)).length > 0)) {
                        await ctx.stderr.write(`fatal: destination path '${destArg || dest.slice(dest.lastIndexOf('/') + 1)}' already exists and is not an empty directory.\n`);
                        return 128;
                    }
                    // The clone's durable record (git/clone-job.ts), under the lease and
                    // before it writes anything: what its cleanup removes, and as whom,
                    // if it fails, or the session restarts before it is done.
                    const job = {
                        version: 1,
                        jobId: crypto.randomUUID(),
                        dir: target,
                        cred: ctx.cred,
                        rootExisted,
                        phase: 'transport',
                        generation: generation(doCtx),
                        startedAt: Date.now(),
                        root: mutationLease.root,
                        ...(place.mount ? { mount: true } : {}),
                    };
                    // Stopped before it wrote anything (its lease taken, its destination
                    // proven): it ends, its record never written.
                    if (ctx.signal.aborted)
                        return exitCodeForAbortSignal(ctx.signal);
                    try {
                        await writeCloneJob(doCtx.storage, job);
                    }
                    catch (error) {
                        await ctx.stderr.write(`fatal: could not record the clone: ${String(error?.message ?? error)}\n`);
                        return 128;
                    }
                    progress.write(`Cloning into '${dest}'...${depth ? ' (shallow, depth=' + depth + ')' : ''}\n`);
                    if (!isBg) {
                        handedOff = true;
                        return await doClone(job, ctx.pid, ctx.signal);
                    }
                    // A background clone is a job of its own: a process the session's
                    // work runs behind until the clone ends, so a kill of it, or a
                    // destroy, stops it as it stops the command's.
                    if (processes === undefined) {
                        ctx.stderr.write('[git] a background clone needs the session\'s process table (internal configuration error)\n');
                        return 1;
                    }
                    const background = processes.spawn('git', ctx.args, getDir(ctx), { parentPid: ctx.pid });
                    const stop = new AbortController();
                    const stopped = processes.holdWork(background.pid, (reason) => stop.abort(reason));
                    const task = doClone(job, background.pid, stop.signal).then((code) => processes.exit(background.pid, code), () => processes.exit(background.pid, 1)).finally(stopped);
                    handedOff = true;
                    doCtx.waitUntil(task);
                    progress.write(`[git] clone running in background (pid ${background.pid})...\n`);
                    return 0;
                }
                finally {
                    if (!handedOff)
                        vfs.releaseExclusiveMutation(mutationOwner);
                }
            }
            case 'status':
                return await statusCommand(ctx, git, repoVfs, fs, command.parsed);
            case 'add':
                return await addCommand(ctx, git, repoVfs, fs, command.parsed);
            case 'commit': {
                const { messages, quiet, all, cleanup, allowEmptyMessage } = command.parsed;
                let configured;
                if (cleanup === null) {
                    const value = await git.getConfig({ fs, dir, path: 'commit.cleanup' });
                    if (typeof value === 'string')
                        configured = value;
                }
                const requested = cleanup ?? configured;
                const mode = commitCleanupMode(requested);
                if (!mode) {
                    await ctx.stderr.write(`fatal: Invalid cleanup mode ${requested}\n`);
                    return 128;
                }
                const raw = joinMessageOptions(messages);
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
                return await revParse(ctx, git, fs, repoVfs, command.parsed);
            case 'ls-files':
                return await lsFiles(ctx, git, repoVfs, fs, command.parsed);
            case 'sparse-checkout': {
                const repo = await discoverRepo(repoVfs, dir);
                if (!repo) {
                    await ctx.stderr.write(NOT_A_REPOSITORY);
                    return 128;
                }
                if (!repo.worktree) {
                    await ctx.stderr.write(NOT_A_WORK_TREE);
                    return 128;
                }
                const root = normalizeVfsPath(repo.worktree);
                const here = normalizeVfsPath(dir);
                return await sparseCheckout({
                    wrepo: worktreeRepo(ctx, git, repoVfs, fs, repo.gitdir, repo.worktree),
                    root: repo.worktree,
                    // git's prefix: the command's directory below the top.
                    prefix: here.startsWith(`${root}/`) ? `${here.slice(root.length + 1)}/` : '',
                    writer: checkoutWriter(repoVfs, repo.worktree),
                    realpath: async (path) => {
                        try {
                            return await ctx.vfs.realpath(path);
                        }
                        catch (error) {
                            if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR'))
                                return null;
                            throw error;
                        }
                    },
                    stdout: async (text) => { await ctx.stdout.write(text); },
                    stderr: async (text) => { await ctx.stderr.write(text); },
                }, command.parsed);
            }
            case 'log': {
                const { maxCount, oneline } = command.parsed;
                if (maxCount === 0)
                    return 0;
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
                const { showCurrent, list, all, del, name } = command.parsed;
                if (showCurrent) {
                    // Empty output on a detached HEAD, like git.
                    const current = await git.currentBranch({ fs, dir });
                    if (current)
                        ctx.stdout.write(`${current}\n`);
                    return 0;
                }
                if (list) {
                    const branches = await git.listBranches({ fs, dir });
                    const current = await git.currentBranch({ fs, dir });
                    for (const b of branches) {
                        ctx.stdout.write(b === current ? `\x1b[32m* ${b}\x1b[0m\n` : `  ${b}\n`);
                    }
                    if (all) {
                        try {
                            const remotes = await git.listBranches({ fs, dir, remote: 'origin' });
                            for (const b of remotes)
                                ctx.stdout.write(`  \x1b[31mremotes/origin/${b}\x1b[0m\n`);
                        }
                        catch { }
                    }
                }
                else if (del) {
                    if (name) {
                        await git.deleteBranch({ fs, dir, ref: name });
                        ctx.stdout.write(`Deleted branch ${name}\n`);
                    }
                }
                else {
                    if (name === undefined)
                        return 1;
                    await git.branch({ fs, dir, ref: name });
                    ctx.stdout.write(`Created branch ${name}\n`);
                }
                return 0;
            }
            case 'checkout': {
                const { quiet, create, ref, paths, ignoreSkipWorktree } = command.parsed;
                if (paths.length)
                    return await checkoutPaths(ctx, git, repoVfs, fs, ref ?? null, paths, ignoreSkipWorktree);
                // `git checkout` and `git checkout HEAD` switch to where HEAD already is: nothing changes.
                if ((!ref || ref === 'HEAD') && !create)
                    return 0;
                if (!ref) {
                    ctx.stderr.write("error: switch `b' requires a value\n");
                    return 129;
                }
                if (create)
                    await git.branch({ fs, dir, ref });
                try {
                    const target = await resolveRevision(git, fs, `${dir}/.git`, ref, {});
                    if (target !== null) {
                        const sparse = await worktreeRepo(ctx, git, repoVfs, fs, `${dir}/.git`, dir).sparseMatcher();
                        await prefetchCommits(git, fs, `${dir}/.git`, [target], partial, sparse);
                    }
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
                return await diffCommand(ctx, git, fs, repoVfs, command.parsed, partial);
            case 'remote': {
                const { operation, verbose, name, url } = command.parsed;
                if (operation === 'add') {
                    await git.addRemote({ fs, dir, remote: name, url });
                    ctx.stdout.write(`Remote '${name}' added\n`);
                }
                else if (operation === 'remove') {
                    await git.deleteRemote({ fs, dir, remote: name });
                    ctx.stdout.write(`Remote '${name}' removed\n`);
                }
                else {
                    const remotes = await git.listRemotes({ fs, dir });
                    for (const r of remotes) {
                        ctx.stdout.write(verbose ? `${r.remote}\t${r.url} (fetch)\n` : `${r.remote}\n`);
                    }
                }
                return 0;
            }
            case 'fetch': {
                const place = await placeRepository(dir);
                const target = place.dir;
                const { quiet, deepen, remote } = command.parsed;
                const fetchUrl = await knownRemote(ctx, git, fs, dir, remote, 'fetch');
                if (fetchUrl === undefined)
                    return 128;
                if (!doCtx || !doEnv) {
                    ctx.stderr.write('[git] fetch requires DO ctx + env (internal configuration error)\n');
                    return 1;
                }
                if (!quiet)
                    ctx.stdout.write(`Fetching from ${remote}...\n`);
                const result = await execGitNetwork(doCtx, doEnv, {
                    op: 'fetch',
                    url: fetchUrl,
                    pid: ctx.pid,
                    signal: ctx.signal,
                    dir: target,
                    onMount: place.mount,
                    remote,
                    quiet,
                    depth: deepen?.depth,
                    relative: deepen?.relative,
                    auth: remoteCredentials(ctx, fetchUrl),
                }, network);
                if (result.success) {
                    if (!quiet)
                        ctx.stdout.write(`\n[git] fetch complete (${result.filesWritten} files in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
                    return 0;
                }
                else if (result.cancelled !== undefined) {
                    return exitCodeForAbortSignal(ctx.signal);
                }
                return await networkFailure(ctx, 'fetch', result, fetchUrl);
            }
            case 'pull': {
                // git pull is a fetch of the branch, then a merge of it: the merge through the session's one
                // checkout policy, as `git merge` runs it.
                const place = await placeRepository(dir);
                const target = place.dir;
                const { quiet, remote } = command.parsed;
                const branch = command.parsed.branch ?? await git.currentBranch({ fs, dir }) ?? 'main';
                // Its fetch, git's child, fails (128); pull says 1.
                const pullUrl = await knownRemote(ctx, git, fs, dir, remote, 'fetch');
                if (pullUrl === undefined)
                    return 1;
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
                    url: pullUrl,
                    pid: ctx.pid,
                    signal: ctx.signal,
                    dir: target,
                    onMount: place.mount,
                    remote,
                    ref: branch,
                    quiet,
                    auth: remoteCredentials(ctx, pullUrl),
                }, network);
                if (result.cancelled !== undefined)
                    return exitCodeForAbortSignal(ctx.signal);
                if (!result.success) {
                    // git's pull runs its fetch as a child: its message, and pull's own 1.
                    await networkFailure(ctx, 'pull', result, pullUrl);
                    return 1;
                }
                const merged = await mergeCommand(ctx, git, fs, repoVfs, dir, `${remote}/${branch}`, true, partial);
                if (merged === 0 && !quiet)
                    ctx.stdout.write(`\n[git] pull complete (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
                return merged;
            }
            case 'push': {
                const place = await placeRepository(dir);
                const target = place.dir;
                const { quiet, remote } = command.parsed;
                const branch = command.parsed.branch ?? await git.currentBranch({ fs, dir }) ?? 'main';
                const pushUrl = await knownRemote(ctx, git, fs, dir, remote, 'push');
                if (pushUrl === undefined)
                    return 128;
                if (!doCtx || !doEnv) {
                    ctx.stderr.write('[git] push requires DO ctx + env (internal configuration error)\n');
                    return 1;
                }
                if (!quiet)
                    ctx.stdout.write(`Pushing to ${remote}/${branch}...\n`);
                const result = await execGitNetwork(doCtx, doEnv, {
                    op: 'push',
                    url: pushUrl,
                    pid: ctx.pid,
                    signal: ctx.signal,
                    dir: target,
                    onMount: place.mount,
                    remote,
                    ref: branch,
                    quiet,
                    auth: remoteCredentials(ctx, pushUrl),
                }, network);
                if (result.success) {
                    if (!quiet)
                        ctx.stdout.write(`\n[git] push complete (${(result.elapsed / 1000).toFixed(1)}s)\n`);
                    return 0;
                }
                else if (result.cancelled !== undefined) {
                    return exitCodeForAbortSignal(ctx.signal);
                }
                return await networkFailure(ctx, 'push', result, pushUrl);
            }
            case 'merge': {
                const { theirs, quiet } = command.parsed;
                return await mergeCommand(ctx, git, fs, repoVfs, dir, theirs, quiet, partial);
            }
            case 'reset':
                return await resetCommand(ctx, git, repoVfs, fs, command.parsed, async (gitdir, worktree, commits) => await prefetchCommits(git, fs, gitdir, commits, partial, worktree === null ? null : await worktreeRepo(ctx, git, repoVfs, fs, gitdir, worktree).sparseMatcher()));
            case 'tag':
                return await tagCommand(ctx, git, fs, repoVfs, command.parsed);
            case 'config': {
                const { key, value, unset } = command.parsed;
                if (unset) {
                    const values = await fileGit.getConfigAll({ fs, dir, path: key });
                    if (values.length === 0)
                        return 5;
                    if (values.length > 1) {
                        await ctx.stderr.write(`warning: ${key} has multiple values\n`);
                        return 5;
                    }
                    await fileGit.setConfig({ fs, dir, path: key, value: undefined });
                }
                else if (value !== undefined) {
                    // Set: git says nothing.
                    await git.setConfig({ fs, dir, path: key, value });
                }
                else {
                    // A key not set is git's exit 1, and nothing printed.
                    const val = await git.getConfig({ fs, dir, path: key });
                    if (val === undefined)
                        return 1;
                    ctx.stdout.write(`${val === null ? '' : val}\n`);
                }
                return 0;
            }
            default: throw new Error('internal error: git command not dispatched');
        }
    }
    catch (e) {
        if (e instanceof UnsupportedGitOperation) {
            if (!executing && realGit !== undefined)
                return realGit();
            await ctx.stderr.write(e.diagnostic);
            return e.code;
        }
        if (e instanceof GitGlobalsError) {
            await ctx.stderr.write(e.lines);
            return e.code;
        }
        // A file git reads that cannot be read, named as git names it, from the top.
        const fromTop = (file) => (top !== null && file.startsWith(`${top}/`) ? file.slice(top.length + 1) : file);
        // A config file (cf-git's readConfigText): git's access_or_die.
        if (typeof e?.configFile === 'string') {
            await ctx.stderr.write(`fatal: unable to access '${fromTop(e.configFile)}': ${strerror(e.cause)}\n`);
            return 128;
        }
        // The index: git's do_read_index, its words for the step that failed (with the errno, but for its size).
        if (e instanceof IndexReadError) {
            await ctx.stderr.write(`fatal: ${fromTop(e.file)}: ${e.words}${e.step === 'size' ? '' : `: ${strerror(e.cause)}`}\n`);
            return 128;
        }
        // Its header: what verify_hdr found, then git dies.
        if (e instanceof IndexFormatError && e.detail !== undefined) {
            await ctx.stderr.write(`error: ${e.detail}\nfatal: ${e.message}\n`);
            return 128;
        }
        // The reader went away (`git diff | head`): git dies of SIGPIPE, silently.
        if (e?.code === 'EPIPE')
            return 141;
        // A partial clone's lazy fetch failed: its fetch's words, then git's (promisor_remote_get_direct).
        if (e instanceof PromisorFetchError) {
            const { text } = networkFailureText(ctx, 'fetch', e.result, e.request.url);
            await ctx.stderr.write(`${text}fatal: ${e.message}\n`);
            return 128;
        }
        ctx.stderr.write(`fatal: ${e?.message || e}\n`);
        return 128;
    }
    finally {
        const counters = commandFs && commandCounters.get(commandFs);
        if (executing && counters && ctx.env.NIMBUS_GIT_COUNTERS)
            await ctx.stderr.write(`[git] ${JSON.stringify(counters)}\n`);
    }
}
