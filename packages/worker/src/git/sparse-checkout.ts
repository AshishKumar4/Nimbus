/**
 * git/sparse-checkout.ts — `git sparse-checkout` (builtin/sparse-checkout.c),
 * in cone mode: list, set, add, reapply, disable and init.
 *
 * The cone lives in info/sparse-checkout (pack/sparse.ts writes and reads
 * it) and is switched on by core.sparseCheckout and core.sparseCheckoutCone
 * in config.worktree (extensions.worktreeConfig set first, as git's
 * init_worktree_config does). Changing it moves the worktree as git's
 * update_working_directory does, before the new file is written: the cone
 * applied to every index entry (worktree/checkout.ts updateSparsity), what
 * is left named, then each directory outside the cone that holds nothing
 * tracked removed, unless untracked or ignored files are in it
 * (clean_tracked_sparse_directories). A sparse checkout that is not cone
 * mode is refused, as the rest of this git refuses it.
 */

import { FULL_CONE, coneMatcher, coneOf, coneSparseCheckout, parseConeSparseCheckout, type SparseMatcher } from './pack/sparse.js';
import { quotePath } from './unified-diff.js';
import { updateSparsity, type CheckoutWriter } from './worktree/checkout.js';
import { S_IFGITLINK, S_IFMT, compareBytes, type DirCache } from './worktree/dircache.js';
import { configBool, type WorktreeRepo } from './worktree/repo.js';
import { scanWorktree } from './worktree/walk.js';

export interface SparseCheckoutContext {
  wrepo: WorktreeRepo;
  /** The worktree's top, absolute. */
  root: string;
  /** The command's directory below the top, '' or ending in '/' (git's prefix). */
  prefix: string;
  writer: CheckoutWriter;
  stdout(text: string): Promise<void>;
  stderr(text: string): Promise<void>;
}

const USAGE = 'usage: git sparse-checkout (init | list | set | add | reapply | disable | check-rules | clean) [<options>]\n';

const CONE_HELP: [string, string] = ['--[no-]cone', 'initialize the sparse-checkout in cone mode'];
const SPARSE_INDEX_HELP: [string, string] = ['--[no-]sparse-index', 'toggle the use of a sparse index'];
const SKIP_CHECKS_HELP: [string, string] = ['--skip-checks', 'skip some sanity checks on the given paths that might give false positives'];
const STDIN_HELP = 'read patterns from standard in';

/** Each subcommand's synopsis and options, as its parse_options usage prints them. */
const SUBCOMMANDS: Record<string, { usage: string; options: Array<[string, string]> }> = {
  list: { usage: 'git sparse-checkout list', options: [] },
  init: { usage: 'git sparse-checkout init [--cone] [--[no-]sparse-index]', options: [CONE_HELP, SPARSE_INDEX_HELP] },
  set: {
    usage: 'git sparse-checkout set [--[no-]cone] [--[no-]sparse-index] [--skip-checks] (--stdin | <patterns>)',
    options: [CONE_HELP, SPARSE_INDEX_HELP, SKIP_CHECKS_HELP, ['--stdin', STDIN_HELP]],
  },
  add: { usage: 'git sparse-checkout add [--skip-checks] (--stdin | <patterns>)', options: [SKIP_CHECKS_HELP, ['--[no-]stdin', STDIN_HELP]] },
  reapply: { usage: 'git sparse-checkout reapply [--[no-]cone] [--[no-]sparse-index]', options: [CONE_HELP, SPARSE_INDEX_HELP] },
  disable: { usage: 'git sparse-checkout disable', options: [] },
};

/** usage_with_options: the synopsis, a blank line, then each option in its column (and a blank line after them). */
function usageText(sub: string): string {
  const { usage, options } = SUBCOMMANDS[sub];
  const table = options.map(([flag, help]) => `    ${flag.padEnd(22)}${help}\n`).join('');
  return `usage: ${usage}\n\n${table}${table ? '\n' : ''}`;
}
const NOT_CONE = 'fatal: a sparse checkout without cone mode is not supported\n';
const encoder = new TextEncoder();

/** A refusal: git's die(), its message, exit 128. */
class Fatal extends Error {}

/** The subcommand's options, as parse_options takes them: each known flag, then the rest; null after an unknown one. */
function parseOptions(args: readonly string[], known: readonly string[]): { flags: Set<string>; rest: string[]; unknown?: string } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let ended = false;
  for (const arg of args) {
    if (ended || !arg.startsWith('-') || arg === '-') rest.push(arg);
    else if (arg === '--') ended = true;
    else if (known.includes(arg)) flags.add(arg);
    else return { flags, rest, unknown: arg };
  }
  return { flags, rest };
}

/** A flag pair as OPT_BOOL reads it: 1, 0, or -1 when neither is given (the last one wins). */
function tristate(args: readonly string[], on: string, off: string): number {
  let value = -1;
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === on) value = 1;
    else if (arg === off) value = 0;
  }
  return value;
}

/**
 * normalize_path_copy on a repo-relative path: empty and '.' components
 * dropped, '..' taking the one before back; null when it climbs above the
 * top. One leading slash is kept.
 */
function normalizePath(path: string): string | null {
  const lead = path.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return lead + out.join('/');
}

/**
 * prefix_path: `path` as the repository names it, given from the directory
 * `prefix` below the top `root`: a relative one joined to the prefix, an
 * absolute one with the top taken off (abspath_part_inside_repo, by name: the
 * top is the worktree's own path, every link resolved); null when it is
 * outside the repository.
 */
function prefixPath(prefix: string, root: string, path: string): string | null {
  if (!path.startsWith('/')) return normalizePath(prefix + path);
  const absolute = normalizePath(path);
  const top = root.replace(/\/+$/, '');
  if (absolute === null) return null;
  if (absolute === top || top === '') return absolute.slice(top.length).replace(/^\/+/, '');
  return absolute.startsWith(top + '/') ? absolute.slice(top.length + 1) : null;
}

/**
 * sanitize_paths in cone mode: each directory given below the command's
 * directory, then (but with --skip-checks) refused when it is a pattern or a
 * file the index holds.
 */
function sanitize(dirs: readonly string[], prefix: string, root: string, skipChecks: boolean, dc: DirCache): string[] {
  const out = dirs.map((dir) => {
    if (!prefix) return dir;
    const inside = prefixPath(prefix, root, dir);
    if (inside === null) throw new Fatal(`fatal: '${dir}' is outside repository at '${root}'\n`);
    return inside;
  });
  if (skipChecks) return out;
  for (const dir of out) {
    if (dir.startsWith('/')) throw new Fatal('fatal: specify directories rather than patterns (no leading slash)\n');
    if (dir.startsWith('!')) throw new Fatal("fatal: specify directories rather than patterns.  If your directory starts with a '!', pass --skip-checks\n");
    if (/[*?[\]]/.test(dir)) throw new Fatal("fatal: specify directories rather than patterns.  If your directory really has any of '*?[]\\' in it, pass --skip-checks\n");
  }
  for (const dir of out) {
    const at = dc.find(dir);
    if (at >= 0 && dc.stage(at) === 0) throw new Fatal(`fatal: '${dir}' is not a directory; to treat it as a directory anyway, rerun with --skip-checks\n`);
  }
  return out;
}

/** strbuf_to_cone_pattern: each directory trimmed of blanks and trailing slashes, normalized; the empty ones dropped. */
function coneDirectories(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of dirs) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    const normal = normalizePath(trimmed);
    if (normal === null) throw new Fatal(`fatal: could not normalize path ${trimmed}\n`);
    const dir = normal.replace(/^\/+/, '');
    if (dir) out.push(dir);
  }
  return out;
}

/** The sparse-checkout file, or null when there is none. */
async function readPatterns(wrepo: WorktreeRepo): Promise<string | null> {
  try {
    return new TextDecoder().decode(await wrepo.vfs.readFile(`${wrepo.gitdir}/info/sparse-checkout`));
  } catch {
    return null;
  }
}

/** core.sparseCheckout and core.sparseCheckoutCone, as this worktree reads them. */
async function modes(wrepo: WorktreeRepo): Promise<{ sparse: boolean; cone: boolean }> {
  return {
    sparse: await wrepo.isSparse(),
    cone: configBool(await wrepo.worktreeSetting('core.sparseCheckoutCone')) === true,
  };
}

/** set_config: the worktree's sparse checkout on in cone mode, or off (`off`: index.sparse off with it). */
async function setConfig(wrepo: WorktreeRepo, on: boolean): Promise<void> {
  await wrepo.initWorktreeConfig();
  await wrepo.setWorktreeSetting('core.sparseCheckout', on ? 'true' : 'false');
  await wrepo.setWorktreeSetting('core.sparseCheckoutCone', on ? 'true' : 'false');
  if (!on) await wrepo.setWorktreeSetting('index.sparse', 'false');
}

/**
 * update_modes: cone mode recorded when it is asked for (`cone` 1) or the
 * worktree is not sparse yet; non-cone mode and a sparse index refused;
 * --no-sparse-index recorded.
 */
async function updateModes(wrepo: WorktreeRepo, cone: number, sparseIndex: number): Promise<void> {
  const current = await modes(wrepo);
  if (cone === 0 || (cone === -1 && current.sparse && !current.cone)) throw new Fatal(NOT_CONE);
  if (sparseIndex === 1) throw new Fatal('fatal: a sparse index (--sparse-index) is not supported here\n');
  if (cone !== -1 || !current.sparse) await setConfig(wrepo, true);
  if (sparseIndex === 0) await wrepo.setWorktreeSetting('index.sparse', 'false');
}

/**
 * convert_to_sparse's directories (sparse-index.c convert_to_sparse_rec):
 * each top-most one outside the cone (a file directly in it would be) whose
 * every entry is skip-worktree, merged, and not a gitlink.
 */
function sparseDirectories(dc: DirCache, sparse: SparseMatcher): string[] {
  const out: string[] = [];
  const visit = (dir: string, lo: number, hi: number) => {
    // path_matches_pattern_list's directory rule: a file named '-' in it stands for it.
    if (dir && !sparse.includes(`${dir}/-`)) {
      let whole = true;
      for (let i = lo; i < hi && whole; i++) {
        whole = dc.stage(i) === 0 && dc.skipWorktree(i) && (dc.mode(i) & S_IFMT) !== S_IFGITLINK;
      }
      if (whole) {
        out.push(dir);
        return;
      }
    }
    const base = dir ? dir.length + 1 : 0;
    for (let i = lo; i < hi;) {
      const slash = dc.path(i).indexOf('/', base);
      if (slash < 0) {
        i++;
        continue;
      }
      const sub = dc.path(i).slice(0, slash);
      const [subLo, subHi] = dc.rangeUnder(sub, i, hi);
      visit(sub, subLo, subHi);
      i = subHi;
    }
  };
  if (dc.unmergedPaths().length === 0) visit('', 0, dc.count);
  return out;
}

/**
 * clean_tracked_sparse_directories: each directory outside the cone that
 * the index holds only skip-worktree entries below, and the worktree still
 * has, removed with what is in it; one holding untracked files is named and
 * kept. Ignored files do not keep one (fill_directory puts them in
 * dir.ignored, not dir.entries): they go with it.
 */
async function cleanSparseDirectories(ctx: SparseCheckoutContext, sparse: SparseMatcher): Promise<void> {
  const { wrepo, writer, root } = ctx;
  const dc = await wrepo.readIndex();
  const tree = await wrepo.worktree();
  const excludes = await wrepo.excludes(dc);
  for (const dir of sparseDirectories(dc, sparse)) {
    if (await tree.fs.lstat(dir) === null) continue;
    const scan = await scanWorktree(tree, dc, { specs: [dir], untracked: 'all', excludes });
    if (scan.untracked.length > 0) {
      await ctx.stderr(`warning: directory '${dir}/' contains untracked files, but is not in the sparse-checkout cone\n`);
      continue;
    }
    // remove_dir_recursively: what is left is ignored files and directories (nothing tracked).
    const remove = async (path: string): Promise<void> => {
      for (const { name, type } of await tree.fs.list(path)) {
        const child = `${path}/${name}`;
        if (type === 'directory') await remove(child);
        else await writer.unlink(`${root}/${child}`);
      }
      await writer.rmdir(`${root}/${path}`);
    };
    try {
      await remove(dir);
    } catch {
      await ctx.stderr(`warning: failed to remove directory '${dir}/'\n`);
    }
  }
}

/**
 * update_working_directory: `sparse` applied to the index and worktree,
 * unless the index is unborn; then, for a cone, the directories it left
 * emptied of anything tracked cleaned up. Under the index lock the
 * subcommand holds (sparseCheckout).
 */
async function updateWorkingDirectory(ctx: SparseCheckoutContext, sparse: SparseMatcher, cone: boolean): Promise<void> {
  const { wrepo, root, writer } = ctx;
  const unborn = await wrepo.withIndexLock(async () => {
    const dc = await wrepo.readIndex();
    if (dc.count === 0 && dc.timestamp === 0) return true;
    const edit = await updateSparsity({ store: wrepo.store, tree: await wrepo.worktree(), dc, root, writer, warn: ctx.stderr }, sparse);
    await wrepo.writeIndex(dc, edit);
    return false;
  });
  if (!unborn && cone) await cleanSparseDirectories(ctx, sparse);
}

/** write_patterns_and_update: the worktree moved to the cone of `dirs`, then the file that says so written. */
async function writePatternsAndUpdate(ctx: SparseCheckoutContext, dirs: readonly string[]): Promise<number> {
  const { wrepo } = ctx;
  const ignoreCase = configBool(await wrepo.worktreeSetting('core.ignorecase')) === true;
  await updateWorkingDirectory(ctx, coneMatcher(coneOf(dirs), ignoreCase), true);
  await wrepo.vfs.mkdir(`${wrepo.gitdir}/info`, { recursive: true });
  await wrepo.vfs.writeFile(`${wrepo.gitdir}/info/sparse-checkout`, encoder.encode(coneSparseCheckout(dirs)));
  return 0;
}

/** The recorded cone's directories, or a refusal when it is not one. */
async function recordedDirectories(wrepo: WorktreeRepo): Promise<string[]> {
  const text = await readPatterns(wrepo);
  if (text === null) throw new Fatal('fatal: unable to load existing sparse-checkout patterns\n');
  const cone = parseConeSparseCheckout(text);
  if (cone === null) throw new Fatal('fatal: existing sparse-checkout patterns do not use cone mode\n');
  return [...cone.recursive];
}

/** byte order (strcmp), as string_list_sort sorts. */
function byBytes(a: string, b: string): number {
  return compareBytes(encoder.encode(a), encoder.encode(b));
}

/** The subcommands that change the sparse checkout: each holds the repository's lock throughout. */
const CHANGES = new Set(['set', 'add', 'reapply', 'disable', 'init']);

/**
 * `git sparse-checkout <subcommand> [<options>]`. One that changes the
 * sparse checkout holds the repository's index lock from its first read of
 * the configuration to the publication of its patterns, as git holds
 * info/sparse-checkout.lock across write_patterns_and_update: two run at
 * once, the second sees the first's whole result, never its patterns over
 * the other's worktree.
 */
export async function sparseCheckout(ctx: SparseCheckoutContext, args: readonly string[]): Promise<number> {
  const sub = args[0];
  return sub !== undefined && CHANGES.has(sub)
    ? await ctx.wrepo.withIndexLock(() => runSubcommand(ctx, args))
    : await runSubcommand(ctx, args);
}

async function runSubcommand(ctx: SparseCheckoutContext, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { wrepo } = ctx;
  const unknown = async (option: string) => {
    await ctx.stderr(`error: unknown option \`${option.replace(/^-+/, '')}'\n${usageText(sub)}`);
    return 129;
  };
  try {
    switch (sub) {
      case 'list': {
        const current = await modes(wrepo);
        if (!current.sparse) throw new Fatal('fatal: this worktree is not sparse\n');
        const { unknown: bad } = parseOptions(rest, []);
        if (bad !== undefined) return await unknown(bad);
        const text = await readPatterns(wrepo);
        if (text === null) {
          await ctx.stderr('warning: this worktree is not sparse (sparse-checkout file may not exist)\n');
          return 0;
        }
        const cone = current.cone ? parseConeSparseCheckout(text) : null;
        if (cone === null) throw new Fatal(NOT_CONE);
        await ctx.stdout([...cone.recursive].sort(byBytes).map((dir) => `${quotePath(dir)}\n`).join(''));
        return 0;
      }
      case 'set':
      case 'add': {
        const known = sub === 'set'
          ? ['--cone', '--no-cone', '--sparse-index', '--no-sparse-index', '--skip-checks', '--stdin']
          : ['--skip-checks', '--stdin', '--no-stdin'];
        if (sub === 'add' && !await wrepo.isSparse()) throw new Fatal('fatal: no sparse-checkout to add to\n');
        const { flags, rest: dirs, unknown: bad } = parseOptions(rest, known);
        if (bad !== undefined) return await unknown(bad);
        if (flags.has('--stdin')) throw new Fatal(`fatal: git sparse-checkout ${sub} --stdin is not supported here\n`);
        if (sub === 'add') {
          if (!(await modes(wrepo)).cone) throw new Fatal(NOT_CONE);
        } else {
          await updateModes(wrepo, tristate(rest, '--cone', '--no-cone'), tristate(rest, '--sparse-index', '--no-sparse-index'));
        }
        const given = coneDirectories(sanitize(dirs, ctx.prefix, ctx.root, flags.has('--skip-checks'), await wrepo.readIndex()));
        return await writePatternsAndUpdate(ctx, sub === 'add' ? [...await recordedDirectories(wrepo), ...given] : given);
      }
      case 'reapply': {
        if (!await wrepo.isSparse()) throw new Fatal('fatal: must be in a sparse-checkout to reapply sparsity patterns\n');
        const { unknown: bad } = parseOptions(rest, ['--cone', '--no-cone', '--sparse-index', '--no-sparse-index']);
        if (bad !== undefined) return await unknown(bad);
        await updateModes(wrepo, tristate(rest, '--cone', '--no-cone'), tristate(rest, '--sparse-index', '--no-sparse-index'));
        const sparse = await wrepo.sparseMatcher();
        if (sparse === null) throw new Fatal(NOT_CONE);
        await updateWorkingDirectory(ctx, sparse, true);
        return 0;
      }
      case 'disable': {
        const { unknown: bad } = parseOptions(rest, []);
        if (bad !== undefined) return await unknown(bad);
        // Every entry back in the worktree, whatever the configuration says now; then sparse checkout off.
        await updateWorkingDirectory(ctx, coneMatcher(FULL_CONE), false);
        await setConfig(wrepo, false);
        return 0;
      }
      case 'init': {
        const { unknown: bad } = parseOptions(rest, ['--cone', '--no-cone', '--sparse-index', '--no-sparse-index']);
        if (bad !== undefined) return await unknown(bad);
        await updateModes(wrepo, tristate(rest, '--cone', '--no-cone'), tristate(rest, '--sparse-index', '--no-sparse-index'));
        // A sparse-checkout file there already is the cone.
        if (await readPatterns(wrepo) !== null) {
          const sparse = await wrepo.sparseMatcher();
          if (sparse === null) throw new Fatal(NOT_CONE);
          await updateWorkingDirectory(ctx, sparse, true);
          return 0;
        }
        return await writePatternsAndUpdate(ctx, []);
      }
      case 'clean':
      case 'check-rules':
        throw new Fatal(`fatal: git sparse-checkout ${sub} is not supported here\n`);
      case undefined:
        await ctx.stderr(`error: need a subcommand\n${USAGE}\n`);
        return 129;
      default:
        await ctx.stderr(`error: unknown subcommand: \`${sub}'\n${USAGE}\n`);
        return 129;
    }
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    await ctx.stderr(error.message);
    return 128;
  }
}
