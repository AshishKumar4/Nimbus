/**
 * Git's command-family policy. A route is chosen before execution, never
 * because the chosen runtime or a remote helper failed. The streamed clone
 * stays JavaScript; other families stay there until their latency and session
 * memory gates pass against the JavaScript implementation.
 */

export type GitFamily =
  | 'clone' | 'init' | 'status' | 'diff' | 'add' | 'commit' | 'checkout'
  | 'reset' | 'history' | 'refs' | 'merge' | 'rebase' | 'stash' | 'sparse'
  | 'transport' | 'other';

export type GitFamilyPolicy =
  | { readonly backend: 'javascript'; readonly reason: 'streamed-clone' | 'performance-unmeasured' }
  | { readonly backend: 'wasi'; readonly reason: 'gates-passed'; readonly evidence: string };

const unmeasured = Object.freeze({ backend: 'javascript', reason: 'performance-unmeasured' } as const);

/** No family has passed both remote performance gates yet. */
export const GIT_FAMILY_POLICY: Readonly<Record<GitFamily, GitFamilyPolicy>> = Object.freeze({
  clone: Object.freeze({ backend: 'javascript', reason: 'streamed-clone' } as const),
  init: unmeasured,
  status: unmeasured,
  diff: unmeasured,
  add: unmeasured,
  commit: unmeasured,
  checkout: unmeasured,
  reset: unmeasured,
  history: unmeasured,
  refs: unmeasured,
  merge: unmeasured,
  rebase: unmeasured,
  stash: unmeasured,
  sparse: unmeasured,
  transport: unmeasured,
  other: unmeasured,
});

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
  return { ...parsed, family, policy: GIT_FAMILY_POLICY[family] };
}
