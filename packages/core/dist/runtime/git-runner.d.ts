/**
 * git-runner.ts — real git (git.wasm, packages/worker/wasm/git) as a command.
 *
 * Each `git` invocation is one WASI process in a facet: git.wasm with the
 * session root as its only preopen, `-C <cwd>` for the directory the shell is
 * in (preview1 has no working directory of its own), the installed
 * share/git/gitconfig as its system configuration, and the caller's
 * credential, so its filesystem calls are answered from its own copy of the
 * namespace (wasi/resident-filesystem.ts) and its writes reach the session as
 * the caller's. What it prints comes back when it exits.
 *
 * What git does without a child process works as it does anywhere. What needs
 * one (a pager, an editor, hooks, the transports, `stash`, a real merge) fails
 * at the spawn with ENOSYS until the process ABI lands; git says which.
 * Standard input reads as empty. Output is passed on byte for byte (git's
 * output is not always UTF-8: cat-file, archive, a diff of a Latin-1 file).
 *
 * The image is read once per session, uncached (3.7 MB of runtime blob that
 * would otherwise displace the user's working set); facets are opened per
 * invocation, because the supervisor capability a facet holds is bound to the
 * pid it was opened for.
 */
import type { RuntimeManifest } from './runtime-manifest.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import type { FacetHost } from './facet-host.js';
import { type NimbusFilesystemAuthority } from './os-contracts.js';
/** The runner key a git runtime manifest's entrypoint names. */
export declare const GIT_RUNNER = "git-runner";
export declare function makeGitRunnerFactory(deps: {
    facets: FacetHost;
    filesystem: NimbusFilesystemAuthority;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
export declare const GIT_RUNNER_PREAMBLE: string;
//# sourceMappingURL=git-runner.d.ts.map