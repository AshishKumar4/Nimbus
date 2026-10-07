/**
 * Git's command-family policy. A route is chosen before execution, never
 * because the chosen runtime or a remote helper failed. JavaScript keeps the
 * commands it implements; real Git supplies its capability gaps. A supported
 * family moves only after latency and session-memory gates pass.
 */

export type GitFamily =
  | 'clone' | 'init' | 'status' | 'diff' | 'add' | 'commit' | 'checkout'
  | 'reset' | 'history' | 'refs' | 'merge' | 'rebase' | 'stash' | 'sparse'
  | 'transport' | 'other';

export type GitFamilyPolicy =
  | { readonly backend: 'javascript'; readonly reason: 'streamed-clone' | 'javascript-coverage' }
  | { readonly backend: 'javascript'; readonly reason: 'latency-regression'; readonly javascriptMs: number; readonly wasiMs: number }
  | { readonly backend: 'wasi'; readonly reason: 'javascript-capability-gap' };

const javascript = Object.freeze({ backend: 'javascript', reason: 'javascript-coverage' } as const);
const wasi = Object.freeze({ backend: 'wasi', reason: 'javascript-capability-gap' } as const);
const regression = (javascriptMs: number, wasiMs: number): GitFamilyPolicy =>
  Object.freeze({ backend: 'javascript', reason: 'latency-regression', javascriptMs, wasiMs });

/**
 * Measured 2026-10-07 on an isolated Cloudflare Preview, Express depth 1 at
 * 9efc29e280018dafc1f0617f3a3d28f4e463b7be; this lane's Git2.53 wasm SHA256
 * 8da15abaf11b5d1f47c85d091a483655442dc6cd807733c8b6a24c02dde2dbaf.
 * Median wall milliseconds, three samples after one warm-up, same README
 * edit/branch-transition workloads: JS/WASI status35/4798, diff27/2217,
 * add31/2207, commit33/4213, checkout56/4330. Every latency gate failed on
 * the smallest required repository; no larger-repo run or memory-pass claim.
 * A separate clean-status trace was3498/3106ms with FS wait3476/3101ms:
 * 295 lookup RPCs and open73/fstat74/close73. P4b's delegated read snapshots,
 * not a Git-only batching path, must remove this cost before re-measuring.
 */
export const GIT_FAMILY_POLICY: Readonly<Record<GitFamily, GitFamilyPolicy>> = Object.freeze({
  clone: Object.freeze({ backend: 'javascript', reason: 'streamed-clone' } as const),
  init: javascript,
  status: regression(35, 4798),
  diff: regression(27, 2217),
  add: regression(31, 2207),
  commit: regression(33, 4213),
  checkout: regression(56, 4330),
  reset: javascript,
  history: javascript,
  refs: javascript,
  merge: javascript,
  rebase: wasi,
  stash: wasi,
  sparse: wasi,
  transport: javascript,
  other: wasi,
});

// Exactly the existing JavaScript front door's commands, not every command
// in their family: e.g. basic `log` stays JS but `show`/`blame` are real Git;
// `checkout` stays JS but `switch`/`restore` are real Git. Coverage memo:
// spike/git-real/RESULTS.md (rebase, stash, notes/reflog, sparse checkout,
// worktree, cherry-pick/revert, grep/clean, format-patch, maintenance, ...).
const JAVASCRIPT_COMMANDS = new Set([
  undefined, '--version', '-v', '--help', '-h',
  'init', 'clone', 'status', 'add', 'commit', 'rev-parse', 'ls-files', 'log',
  'branch', 'checkout', 'diff', 'remote', 'fetch', 'pull', 'push', 'merge',
  'reset', 'tag', 'config',
]);

/** Known operations inside a JS family that its implementation lacks. */
function needsRealGit(sub: string | undefined, args: string[]): boolean {
  if (!JAVASCRIPT_COMMANDS.has(sub)) return true;
  const end = args.indexOf('--');
  const options = end < 0 ? args : args.slice(0, end);
  const has = (names: string[]) => options.some((arg) => names.some((name) => arg === name || arg.startsWith(name + '=')
    || (name.length === 2 && name.startsWith('-') && arg.startsWith(name) && arg.length > 2)));
  if (sub === 'merge') {
    // The JS merge takes one revision and quiet only; it must not ignore
    // strategy selection, --ff-only, conflict continuation or an octopus.
    return options.some((arg) => arg.startsWith('-') && arg !== '-q' && arg !== '--quiet')
      || options.filter((arg) => !arg.startsWith('-')).length > 1;
  }
  if (sub === 'add') return has(['-p', '--patch', '-i', '--interactive', '-e', '--edit']);
  if (sub === 'commit') return has(['--amend', '--fixup', '--squash', '--interactive', '--patch', '-p', '-i']);
  if (sub === 'branch') return has(['-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-v', '-vv', '--verbose']);
  if (sub === 'checkout') return has(['-B', '-f', '--force', '--orphan', '--detach', '-p', '--patch', '--ours', '--theirs', '-m', '--merge']);
  if (sub === 'config') return has(['--global', '--system', '--list', '-l', '--unset', '--unset-all', '--get-all', '--get-regexp', '--add', '--replace-all']);
  if (sub === 'log') return has(['-p', '--patch', '--stat', '--graph', '-S', '-G', '-L', '--follow', '--format', '--pretty', '--all', '--reverse']);
  if (sub === 'pull') return has(['--rebase', '--no-rebase', '--ff-only', '--no-ff', '--squash', '-s', '--strategy', '-X', '--strategy-option']);
  return false;
}

const COMMAND_FAMILIES: Readonly<Record<string, GitFamily>> = Object.freeze({
  clone: 'clone',
  init: 'init',
  status: 'status',
  diff: 'diff',
  'diff-files': 'diff',
  'diff-index': 'diff',
  'diff-tree': 'diff',
  add: 'add',
  commit: 'commit',
  checkout: 'checkout',
  switch: 'checkout',
  restore: 'checkout',
  reset: 'reset',
  log: 'history',
  show: 'history',
  blame: 'history',
  'rev-list': 'history',
  branch: 'refs',
  tag: 'refs',
  remote: 'refs',
  config: 'refs',
  'rev-parse': 'refs',
  'show-ref': 'refs',
  'update-ref': 'refs',
  'symbolic-ref': 'refs',
  'for-each-ref': 'refs',
  'ls-files': 'refs',
  reflog: 'refs',
  merge: 'merge',
  'cherry-pick': 'merge',
  revert: 'merge',
  rebase: 'rebase',
  stash: 'stash',
  'sparse-checkout': 'sparse',
  fetch: 'transport',
  pull: 'transport',
  push: 'transport',
});

/** Unknown commands and aliases have an explicit policy too. */
export function classifyGitCommand(sub: string | undefined): GitFamily {
  return sub !== undefined && Object.hasOwn(COMMAND_FAMILIES, sub) ? COMMAND_FAMILIES[sub] : 'other';
}

export interface ParsedGitGlobals {
  sub: string | undefined;
  subArgs: string[];
  /** The directory the subcommand runs in, after every `-C`. */
  dir: string;
}

/**
 * The JavaScript front door's leading options. Keep one parser for it and
 * routing: unsupported options must be refused, not swallowed before clone
 * or reinterpreted as a subcommand. A WASI route will receive the original
 * argv rather than a reconstructed command line.
 */
export function parseGitGlobals(args: string[], cwd: string): ParsedGitGlobals {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-C') {
      const path = args[++i];
      if (path === undefined) throw new Error("option '-C' requires a value");
      dir = path.startsWith('/') ? path : dir + '/' + path;
      dir = '/' + dir.split('/').filter((seg) => seg && seg !== '.').join('/');
    } else if (arg.startsWith('-C') && arg.length > 2) {
      const path = arg.slice(2);
      dir = path.startsWith('/') ? path : dir + '/' + path;
      dir = '/' + dir.split('/').filter((seg) => seg && seg !== '.').join('/');
    } else if (arg === '--no-pager' || arg === '-P') {
      // no pager to disable
    } else if (arg.startsWith('-') && arg !== '--version' && arg !== '-v' && arg !== '--help' && arg !== '-h') {
      throw new Error(`unknown option '${arg}'\nusage: git [-C <path>] [--no-pager] <command> [<args>]`);
    } else {
      break;
    }
  }
  return { sub: args[i], subArgs: args.slice(i + 1), dir };
}

export interface GitInvocationRoute extends ParsedGitGlobals {
  family: GitFamily;
  policy: GitFamilyPolicy;
}

export function routeGitInvocation(args: string[], cwd: string): GitInvocationRoute {
  const parsed = parseGitGlobals(args, cwd);
  const family = classifyGitCommand(parsed.sub);
  // Selection is BEFORE execution. A refused/missing WASI runtime or helper
  // remains that backend's explicit error; it never re-enters JavaScript.
  const policy = needsRealGit(parsed.sub, parsed.subArgs) ? wasi
    : parsed.sub === undefined || parsed.sub?.startsWith('-') ? javascript : GIT_FAMILY_POLICY[family];
  return { ...parsed, family, policy };
}
