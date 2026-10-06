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
 * Standard input reads as empty.
 *
 * The image is read once per session, uncached (3.7 MB of runtime blob that
 * would otherwise displace the user's working set); facets are opened per
 * invocation, because the supervisor capability a facet holds is bound to the
 * pid it was opened for.
 */

import type { RuntimeManifest } from './runtime-manifest.js';
import { withHostView } from './process-files.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { FacetBindings, FacetHost } from './facet-host.js';
import { CRED_KERNEL, gateSyncLaunch, requireVfsCred, type NimbusFilesystemAuthority } from './os-contracts.js';
import type { WasiCred } from './wasi/types.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { WASI_ABI_NAMESPACE, WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';

/** The runner key a git runtime manifest's entrypoint names. */
export const GIT_RUNNER = 'git-runner';

/** Where the installed runtime keeps the image and the system configuration. */
const GIT_WASM = 'share/git/git.wasm';
const GIT_SYSTEM_CONFIG = 'share/git/gitconfig';

/**
 * The environment git sees: the caller's, minus what names the host's world
 * (PATH entries, a terminal), plus where its configuration is. GIT_* and the
 * identity and locale variables pass through as the user set them.
 */
const PASSED_ENV = /^(GIT_|HOME$|USER$|LOGNAME$|TZ$|LANG$|LC_|EMAIL$|NO_COLOR$)/;

export function makeGitRunnerFactory(deps: {
  facets: FacetHost;
  filesystem: NimbusFilesystemAuthority;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command {
  return function gitRunnerFactory(manifest, installRoot, binName) {
    const installed = (rel: string): string | null =>
      manifest.files.some((f) => f.path === rel) ? `${installRoot}/${rel}` : null;
    const wasmPath = installed(GIT_WASM);
    const systemConfig = installed(GIT_SYSTEM_CONFIG);
    let image: Promise<ArrayBuffer> | null = null;

    return async function gitBinHandler(ctx: CommandContext): Promise<number> {
      const argv: string[] = ctx.args || [];
      const cwd: string = ctx.cwd || '/home/user';
      const notHydrated = await gateSyncLaunch(ctx.vfs.process, cwd, null, argv);
      if (notHydrated !== null) { ctx.stderr.write(`${binName}: ${notHydrated}\n`); return 1; }
      if (wasmPath === null || systemConfig === null) {
        ctx.stderr.write(`${binName}: ${GIT_WASM} or ${GIT_SYSTEM_CONFIG} missing from the install\n`);
        return 127;
      }
      const { uid, gid, groups } = requireVfsCred(ctx.cred, binName);
      const cred: WasiCred = { uid, gid, groups: [...groups] };

      try {
        image ??= withHostView(deps.filesystem, CRED_KERNEL, (runtimeVfs) => runtimeVfs.readArrayBufferUncached(wasmPath));
        await image;
      } catch (error) {
        image = null;
        ctx.stderr.write(`${binName}: reading ${wasmPath}: ${errorMessage(error)}\n`);
        return 1;
      }

      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(ctx.env ?? {})) {
        if (typeof value === 'string' && PASSED_ENV.test(name)) env[name] = value;
      }
      env.GIT_CONFIG_SYSTEM = `/${normalizeVfsPath(systemConfig)}`;
      env.HOME ??= '/home/user';

      const facet = deps.facets.open({
        tag: 'git-runner',
        concurrency: 1,
        syscalls: { vfs: ctx.vfs.process, pid: ctx.pid },
        preamble: GIT_RUNNER_PREAMBLE,
        wasmModules: { 'git.wasm': await image },
      });
      const args: GitFacetArgs = {
        argv: ['git', '-C', `/${normalizeVfsPath(cwd)}`, ...argv],
        env,
        cred,
      };
      let result: GitFacetResult;
      try {
        result = await facet.submit(gitFacetCall, args, { timeoutMs: GIT_TIMEOUT_MS, signal: ctx.signal });
      } catch (error) {
        if (ctx.signal.aborted) return 130;
        ctx.stderr.write(`${binName}: ${errorMessage(error)}\n`);
        return 1;
      }
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      if (ctx.env?.NIMBUS_WASI_FS_STATS === '1') ctx.stderr.write(`[wasi-fs] git ${JSON.stringify(result.fsStats ?? null)}\n`);
      if (result.error) {
        ctx.stderr.write(`${binName}: ${result.error}\n`);
        return result.exitCode || 1;
      }
      return result.exitCode;
    };
  };
}

/** A git command may run as long as a facet invocation may. */
const GIT_TIMEOUT_MS = 300_000;

interface GitFacetArgs {
  argv: string[];
  env: Record<string, string>;
  cred: WasiCred;
}

interface GitFacetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  /** git's filesystem calls and who answered them (wasi/resident-filesystem.ts). */
  fsStats?: ResidentFilesystemStats | null;
}

/** Runs in the facet: hands the compiled image and the capability to the preamble's __gitRun. */
async function gitFacetCall(args: GitFacetArgs, facetEnv: FacetBindings): Promise<GitFacetResult> {
  const modules = Reflect.get(globalThis, '__NIMBUS_WASM') as Record<string, unknown> | undefined;
  const gitMod = modules?.['git.wasm'];
  const run = Reflect.get(globalThis, '__gitRun') as ((a: unknown) => Promise<GitFacetResult>) | undefined;
  if (!gitMod || typeof run !== 'function') {
    return { exitCode: 127, stdout: '', stderr: '', error: 'git-runner: the facet has no git image or no __gitRun' };
  }
  return await run({ ...args, gitMod, supervisor: facetEnv?.SUPERVISOR });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Facet preamble ───────────────────────────────────────────────────

const GIT_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: git-runner preamble ────────────────────────────────────────
globalThis.__gitRun = async function __gitRun(args) {
  const stdout = [];
  const stderr = [];
  // The session root at '/', every path git is given absolute.
  __wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred: args.cred });
  // After initFS, which drops any supervisor a pooled isolate still held.
  __wasiAdoptSupervisor(args.supervisor || null);

  let memory = null;
  const wasi = __wasiMakeImports({
    abi: 'preview1',
    argv: args.argv,
    env: args.env,
    getMemory: () => memory,
    stdoutWrite: (s) => { stdout.push(s); },
    stderrWrite: (s) => { stderr.push(s); },
  });
  let instance;
  try {
    const r = await WebAssembly.instantiate(args.gitMod, { ${WASI_ABI_NAMESPACE.preview1}: wasi.wasiImport });
    instance = r instanceof WebAssembly.Instance ? r : r.instance;
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: '', error: 'git.wasm instantiate failed: ' + (e && e.message) };
  }
  memory = instance.exports.memory;
  const run = await __wasiRunStartAsync(instance, { memory });
  return {
    exitCode: run.exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    error: run.error,
    fsStats: typeof __wasiFsStats === 'function' ? __wasiFsStats() : null,
  };
};
// ── END: git-runner preamble ──────────────────────────────────────────
`;

export const GIT_RUNNER_PREAMBLE = `${WASI_INSTANCE_PREAMBLE_SRC}\n${GIT_RUNNER_PREAMBLE_TAIL}`;
