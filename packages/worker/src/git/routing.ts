/**
 * Git's command-family policy: which implementation answers a `git`
 * invocation, decided before it runs, never because the other one failed.
 * The built-in (JavaScript) git keeps the commands it implements; real git
 * (git.wasm, installed with `nimbus install git`) supplies what it lacks. A
 * family it implements moves to real git only on measured evidence.
 */

export type GitFamily =
  | 'clone' | 'init' | 'status' | 'diff' | 'add' | 'commit' | 'checkout'
  | 'reset' | 'history' | 'refs' | 'merge' | 'rebase' | 'stash' | 'sparse'
  | 'transport' | 'other';

export type GitFamilyPolicy =
  | { readonly backend: 'javascript'; readonly reason: 'streamed-clone' | 'javascript-coverage' }
  | { readonly backend: 'javascript'; readonly reason: 'latency-regression'; readonly javascriptMs: number; readonly wasiMs: number }
  | { readonly backend: 'wasi'; readonly reason: 'javascript-capability-gap' };

const javascript = { backend: 'javascript', reason: 'javascript-coverage' } as const;
const wasi = { backend: 'wasi', reason: 'javascript-capability-gap' } as const;

/**
 * Measured 2026-10-07 on an isolated Cloudflare Preview, Express depth 1:
 * median wall milliseconds of the same README edit and branch transitions,
 * JS/WASI. Every family past the latency gate stays JavaScript.
 */
export const GIT_FAMILY_POLICY: Readonly<Record<GitFamily, GitFamilyPolicy>> = {
  clone: { backend: 'javascript', reason: 'streamed-clone' },
  init: javascript,
  status: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 35, wasiMs: 4798 },
  diff: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 27, wasiMs: 2217 },
  add: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 31, wasiMs: 2207 },
  commit: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 33, wasiMs: 4213 },
  checkout: { backend: 'javascript', reason: 'latency-regression', javascriptMs: 56, wasiMs: 4330 },
  reset: javascript,
  history: javascript,
  refs: javascript,
  merge: javascript,
  rebase: wasi,
  stash: wasi,
  sparse: wasi,
  transport: javascript,
  other: wasi,
};

// Exactly the built-in git's commands, not every command in their family:
// basic `log` stays JS but `show`/`blame` are real git; `checkout` stays JS
// but `switch`/`restore` are real git.
const JAVASCRIPT_COMMANDS = new Set([
  undefined, '--version', '-v', '--help', '-h',
  'init', 'clone', 'status', 'add', 'commit', 'rev-parse', 'ls-files', 'log',
  'branch', 'checkout', 'diff', 'remote', 'fetch', 'pull', 'push', 'merge',
  'reset', 'tag', 'config',
]);

/** Known operations inside a built-in command that its implementation lacks. */
function needsRealGit(sub: string | undefined, args: readonly string[]): boolean {
  if (!JAVASCRIPT_COMMANDS.has(sub)) return true;
  const options: string[] = [];
  let operandsAfterDashDash = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { operandsAfterDashDash = args.length - i - 1; break; }
    options.push(arg);
    // A commit message is data even when it spells a capability flag or
    // `--`. Inspect the option, never its required value.
    if (sub === 'commit' && ['-m', '--message', '--cleanup'].includes(arg)) i++;
  }
  const has = (names: string[]) => options.some((arg) => names.some((name) => arg === name || arg.startsWith(name + '=')
    || (name.length === 2 && name.startsWith('-') && arg.startsWith(name) && arg.length > 2)));
  if (sub === 'merge') {
    // The built-in merge takes one revision and quiet only; it must not ignore
    // strategy selection, --ff-only, conflict continuation or an octopus.
    return options.some((arg) => arg.startsWith('-') && arg !== '-q' && arg !== '--quiet')
      || options.filter((arg) => !arg.startsWith('-')).length + operandsAfterDashDash > 1;
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

const COMMAND_FAMILIES: Readonly<Record<string, GitFamily>> = {
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
  'ls-remote': 'transport',
  fetch: 'transport',
  pull: 'transport',
  push: 'transport',
};

/** Unknown commands and aliases have an explicit family too. */
export function classifyGitCommand(sub: string | undefined): GitFamily {
  return sub !== undefined && Object.hasOwn(COMMAND_FAMILIES, sub) ? COMMAND_FAMILIES[sub] : 'other';
}

/** Which git answers subcommand `sub` with `args` (the words after it): the family's policy, or real git for what the built-in one lacks. */
export function gitBackend(sub: string | undefined, args: readonly string[]): GitFamilyPolicy['backend'] {
  if (needsRealGit(sub, args)) return 'wasi';
  // `git`, `git --version` and `git --help` are the built-in's own.
  return sub === undefined || sub.startsWith('-') ? 'javascript' : GIT_FAMILY_POLICY[classifyGitCommand(sub)].backend;
}
