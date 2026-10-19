/**
 * git-runner.ts — real git (git.wasm, packages/worker/wasm/git) as a command.
 *
 * Each `git` invocation is one WASI process in a facet: git.wasm with the
 * session root as its only preopen, `-C <cwd>` for the directory the shell is
 * in (preview1 has no working directory of its own), the installed
 * share/git/gitconfig as its system configuration, and the caller's
 * credential, so its filesystem calls are answered from its own copy of the
 * namespace (wasi/resident-filesystem.ts) and its writes reach the session as
 * the caller's. Like every runtime it is a process of its own
 * (runtime-stdio.ts openRuntimeStdio: its pid, descriptor scope and byte
 * channels, the caller's input pumped to it), or the process a broker
 * started for it as another's child; what it prints goes to the session as
 * it prints it, byte for byte (git's output is not always UTF-8: cat-file,
 * archive, a diff of a Latin-1 file).
 *
 * A child git starts (a hook, an alias's shell command, `git fetch` under
 * `git pull`, a remote helper) is an ordinary session process, started
 * through the session's child-process route (wasi/processes.ts, the
 * nimbus_proc imports git-wasi-compat.c calls), git's process its parent.
 *
 * The image is opened, not read (FacetImage): the host reads it, uncached,
 * only when it builds a facet, so the session holds none of its 3.7 MB
 * between gits. A git that ran to its end leaves its facet warm
 * (FacetSpec.warm) for the next one: the image compiled, and the resident
 * store of what it read, which the next process
 * of the same credential brings forward by one barrier instead of reading it
 * all again. One git at a time runs in a warm facet; a git started while
 * another runs (its child, or one beside it) takes another.
 */
import { type RuntimeManifest } from './runtime-manifest.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import type { FacetHost } from './facet-host.js';
import { type NimbusFilesystemAuthority } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import { type GitFsmonitorState } from './git-fsmonitor.js';
export declare function makeGitRunnerFactory(deps: {
    facets: FacetHost;
    filesystem: NimbusFilesystemAuthority;
    processes: SessionProcessSupervisor;
    fsmonitorState?: GitFsmonitorState;
    /** The installed image asks again a wait its host gave up on: its runner key's contract (GIT_RUNNER_CONTRACTS). */
    restartsWaits: boolean;
    /** The installed image takes the signals sent to its process: its runner key's contract (GIT_RUNNER_CONTRACTS). */
    takesSignals: boolean;
    /** The session the git processes run in: its warm facets are its own (warm-facets.ts). */
    session: string;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
export declare const GIT_RUNNER_PREAMBLE: string;
//# sourceMappingURL=git-runner.d.ts.map