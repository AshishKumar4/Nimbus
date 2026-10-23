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

import { installedPath, type RuntimeManifest } from './runtime-manifest.js';
import { hostImage } from './process-files.js';
import { nameDec } from '../_shared/bytes.js';
import type { Command, CommandContext, CommandOutputStream } from '../substrate/lifo/commands/types.js';
import { takesOwnSignals, type FacetHost, type FacetImage } from './facet-host.js';
import { warmFacetKeys } from './warm-facets.js';
import { GIT_CALL_TASK } from './compiled-bodies.generated.js';
import type { GitFacetArgs, GitFacetResult } from './git-facet-task.js';
import { CRED_KERNEL, GIT_WASI_ENV, gateSyncLaunch, requireVfsCred, type NimbusFilesystemAuthority } from './os-contracts.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { openRuntimeStdio } from './runtime-stdio.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import { WASI_ABI_NAMESPACE, WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
import { makeGitFsmonitor, type GitFsmonitorState } from './git-fsmonitor.js';

/** Where the installed runtime keeps the image and the system configuration. */
const GIT_WASM = 'share/git/git.wasm';
const GIT_SYSTEM_CONFIG = 'share/git/gitconfig';



export function makeGitRunnerFactory(deps: {
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
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command {
  const fsmonitor = makeGitFsmonitor(deps.fsmonitorState);
  const warmKeys = warmFacetKeys(deps.session, 'git');
  const takesSignals = takesOwnSignals(deps.facets, deps.takesSignals);
  return function gitRunnerFactory(manifest, installRoot, binName, binKind) {
    if (binKind === 'fsmonitor') return async (ctx) => {
      if (ctx.args.length !== 2 || ctx.args[0] !== '2') {
        await ctx.stderr.write(`${binName}: expected fsmonitor protocol 2 and a revision token\n`);
        return 2;
      }
      try {
        const mounts = deps.filesystem.mounts?.(ctx.cred);
        const bytes = await fsmonitor.query({
          fs: ctx.vfs.process, cwd: ctx.cwd, cred: ctx.cred, token: ctx.args[1],
          mounts: mounts ? mounts.filter((mount) => mount.mountPoint !== '/' || mount.type !== 'nimbus-sqlite').map((mount) => mount.mountPoint) : null,
        });
        await writeOut(ctx.stdout, bytes);
        return 0;
      } catch (error) {
        await ctx.stderr.write(`${binName}: ${errorMessage(error)}\n`);
        return 1;
      }
    };
    const wasmPath = installedPath(manifest, installRoot, GIT_WASM);
    const systemConfig = installedPath(manifest, installRoot, GIT_SYSTEM_CONFIG);

    return async function gitBinHandler(ctx: CommandContext): Promise<number> {
      const started = Date.now();
      const argv: string[] = ctx.args || [];
      const cwd: string = ctx.cwd || '/home/user';
      const notHydrated = await gateSyncLaunch(ctx.vfs.process, cwd, null, argv);
      if (notHydrated !== null) { ctx.stderr.write(`${binName}: ${notHydrated}\n`); return 1; }
      if (wasmPath === null || systemConfig === null) {
        ctx.stderr.write(`${binName}: ${GIT_WASM} or ${GIT_SYSTEM_CONFIG} missing from the install\n`);
        return 127;
      }
      const cred = requireVfsCred(ctx.cred, binName);

      let image: FacetImage;
      try {
        image = await hostImage(deps.filesystem, CRED_KERNEL, wasmPath);
      } catch (error) {
        ctx.stderr.write(`${binName}: opening ${wasmPath}: ${errorMessage(error)}\n`);
        return 1;
      }

      // The caller's environment, as a process's children get it (custom
      // variables, the broker's depth bound), and where git's configuration is.
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(ctx.env ?? {})) if (typeof value === 'string') env[name] = value;
      env.GIT_CONFIG_SYSTEM = `/${normalizeVfsPath(systemConfig)}`;
      env.HOME ??= '/home/user';
      env[GIT_WASI_ENV] = '1';

      let stdio: ReturnType<typeof openRuntimeStdio>;
      try {
        stdio = openRuntimeStdio(deps, ctx, ['git', ...argv].join(' '), { takesSignals });
      } catch (error) {
        ctx.stderr.write(`${binName}: ${errorMessage(error)}\n`);
        return 1;
      }
      const warm = warmKeys.take();
      const facet = deps.facets.open({
        tag: 'git-runner',
        concurrency: 1,
        syscalls: stdio.syscalls,
        preamble: GIT_RUNNER_PREAMBLE,
        wasmModules: { 'git.wasm': image },
        warm,
      });
      const args: GitFacetArgs = {
        argv: ['git', '-C', `/${normalizeVfsPath(cwd)}`, ...argv],
        env,
        cred,
        pid: stdio.pid,
        restartsWaits: deps.restartsWaits,
        takesSignals,
      };
      let outcome = 1;
      try {
        let result: GitFacetResult;
        const submitted = Date.now();
        try {
          result = await facet.submit(GIT_CALL_TASK, args, { timeoutMs: GIT_TIMEOUT_MS, signal: stdio.signal });
        } catch (error) {
          // The facet may still be running, or be gone: its key is not used again.
          if (stdio.signal.aborted) return (outcome = 130);
          ctx.stderr.write(`${binName}: ${errorMessage(error)}\n`);
          return (outcome = 1);
        }
        warmKeys.give(warm, { reusable: result.reusable, error: result.error, killed: stdio.signal.aborted });
        const returned = Date.now();
        if (ctx.env?.NIMBUS_WASI_FS_STATS === '1') {
          // Milliseconds from the command's start: the host's clock, and the facet's where it moved.
          const at = (time: number | undefined) => (time === undefined ? null : time - started);
          const phases = { submitted: at(submitted), entered: at(result.clock?.entered), instantiated: at(result.clock?.instantiated), exited: at(result.clock?.exited), returned: at(returned) };
          ctx.stderr.write(`[wasi-fs] git ${JSON.stringify({ ...result.fsStats, phases })}\n`);
        }
        if (result.error) {
          ctx.stderr.write(`${binName}: ${result.error}\n`);
          return (outcome = result.exitCode || 1);
        }
        return (outcome = result.exitCode);
      } finally {
        // The call's pool and its capability go; a warm facet's isolate stays for the next git.
        facet.dispose();
        await stdio.finish(outcome);
      }
    };
  };
}

/** A git command may run as long as a facet invocation may. */
const GIT_TIMEOUT_MS = 300_000;

/** Bytes to a sink that takes them as they are, else as text decoded once, whole. */
async function writeOut(sink: CommandOutputStream, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0) return;
  if (sink.writeBytes) await sink.writeBytes(bytes);
  else await sink.write(nameDec.decode(bytes));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Facet preamble ───────────────────────────────────────────────────

const GIT_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: git-runner preamble ────────────────────────────────────────
globalThis.__gitRun = async function __gitRun(args) {
  const entered = Date.now();
  // The session root at '/', every path git is given absolute.
  __wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred: args.cred, pid: args.pid });
  // After initFS, which drops any supervisor a pooled isolate still held.
  __wasiAdoptSupervisor(args.supervisor || null);

  // git's process's byte channels: its output as it writes it, its input as the caller's is pumped to it.
  const output = __wasiSupervisorOutput(args.supervisor);
  let memory = null;
  const wasi = __wasiMakeImports({
    abi: 'preview1',
    argv: args.argv,
    env: args.env,
    getMemory: () => memory,
    stdoutBytes: output.stdoutBytes,
    stderrBytes: output.stderrBytes,
    stdinRead: (maxBytes) => args.supervisor.cpReadStdin(args.pid, 8000, undefined, maxBytes),
    restartsWaits: args.restartsWaits === true,
    takesSignals: args.takesSignals === true,
  });
  let instance;
  try {
    const r = await WebAssembly.instantiate(args.gitMod, {
      ${WASI_ABI_NAMESPACE.preview1}: wasi.wasiImport,
      nimbus_proc: wasi.procImport,
      nimbus_fs: wasi.fsImport,
    });
    instance = r instanceof WebAssembly.Instance ? r : r.instance;
  } catch (e) {
    return { exitCode: 1, error: 'git.wasm instantiate failed: ' + (e && e.message) };
  }
  memory = instance.exports.memory;
  const instantiated = Date.now();
  const run = await __wasiRunStartAsync(instance, { memory });
  const exited = Date.now();
  // git waits for its children; one it left running runs on without it.
  wasi.procDispose();
  const lost = await output.drain();
  // Its output's reader went away (\`git show | head\`): git dies of SIGPIPE at its next write, silently, as it does natively.
  const piped = output.brokenPipe() && !run.error;
  return {
    exitCode: piped ? 141 : run.exitCode,
    error: piped ? undefined : run.error || (lost ? 'output lost: ' + lost : undefined),
    fsStats: typeof __wasiFsStats === 'function' ? __wasiFsStats() : null,
    reusable: typeof __wasiReusable === 'function' && __wasiReusable(),
    clock: { entered, instantiated, exited },
  };
};
// ── END: git-runner preamble ──────────────────────────────────────────
`;

export const GIT_RUNNER_PREAMBLE = `${WASI_INSTANCE_PREAMBLE_SRC}\n${GIT_RUNNER_PREAMBLE_TAIL}`;
