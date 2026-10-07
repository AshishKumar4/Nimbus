/**
 * git-runner.ts — real git (git.wasm, packages/worker/wasm/git) as a command.
 *
 * Each `git` invocation is one WASI process in a facet: git.wasm with the
 * session root as its only preopen, `-C <cwd>` for the directory the shell is
 * in (preview1 has no working directory of its own), the installed
 * share/git/gitconfig as its system configuration, and the caller's
 * credential, so its filesystem calls are answered from its own copy of the
 * namespace (wasi/resident-filesystem.ts) and its writes reach the session as
 * the caller's. What it prints goes to the session as it prints it when it
 * runs as another process's child (a parent reading it, git's own children
 * among them); run from the shell, it comes back when git exits, until the
 * shell's relay of a process's output carries bytes (it carries text).
 *
 * A child git starts (a hook, an alias's shell command, `git fetch` under
 * `git pull`, a remote helper) is an ordinary session process, started
 * through the session's child-process route (wasi/processes.ts, the
 * nimbus_proc imports git-wasi-compat.c calls). Standard input reads as
 * empty. Output is passed on byte for byte (git's output is not always
 * UTF-8: cat-file, archive, a diff of a Latin-1 file).
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
export declare function makeGitRunnerFactory(deps: {
    facets: FacetHost;
    filesystem: NimbusFilesystemAuthority;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
export declare const GIT_RUNNER_PREAMBLE: string;
//# sourceMappingURL=git-runner.d.ts.map