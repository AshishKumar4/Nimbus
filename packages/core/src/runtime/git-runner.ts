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
import { withHostView } from './process-files.js';
import type { Command, CommandContext, CommandOutputStream } from '../substrate/lifo/commands/types.js';
import type { FacetBindings, FacetHost } from './facet-host.js';
import { CRED_KERNEL, gateSyncLaunch, requireVfsCred, type NimbusFilesystemAuthority } from './os-contracts.js';
import type { WasiCred } from './wasi/types.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { WASI_ABI_NAMESPACE, WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
import { makeGitFsmonitor } from './git-fsmonitor.js';

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
  const fsmonitor = makeGitFsmonitor();
  return function gitRunnerFactory(manifest, installRoot, binName, binKind) {
    if (binKind === 'fsmonitor') return async (ctx) => {
      if (ctx.args.length !== 2 || ctx.args[0] !== '2') {
        await ctx.stderr.write(`${binName}: expected fsmonitor protocol 2 and a revision token\n`);
        return 2;
      }
      try {
        const bytes = await fsmonitor.query({ fs: ctx.vfs.process, cwd: ctx.cwd, cred: ctx.cred, token: ctx.args[1] });
        await writeOut(ctx.stdout, bytes);
        return 0;
      } catch (error) {
        await ctx.stderr.write(`${binName}: ${errorMessage(error)}\n`);
        return 1;
      }
    };
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
        pid: ctx.pid,
        // Another process's child: its output goes to that parent's queues as git prints it.
        live: (ctx as { __nimbusBinSpawn?: unknown }).__nimbusBinSpawn !== undefined,
      };
      let result: GitFacetResult;
      try {
        result = await facet.submit(gitFacetCall, args, { timeoutMs: GIT_TIMEOUT_MS, signal: ctx.signal });
      } catch (error) {
        if (ctx.signal.aborted) return 130;
        ctx.stderr.write(`${binName}: ${errorMessage(error)}\n`);
        return 1;
      }
      await writeOut(ctx.stdout, result.stdout);
      await writeOut(ctx.stderr, result.stderr);
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
  /** The session pid git runs as: the parent of the children it starts. */
  pid: number;
  /** Its output goes to the session as it is written (SupervisorRPC stdout/stderr), not back in the result. */
  live: boolean;
}

interface GitFacetResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
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
    return { exitCode: 127, stdout: new Uint8Array(0), stderr: new Uint8Array(0), error: 'git-runner: the facet has no git image or no __gitRun' };
  }
  return await run({ ...args, gitMod, supervisor: facetEnv?.SUPERVISOR });
}

/** Bytes to a sink that takes them as they are, else as text decoded once, whole. */
async function writeOut(sink: CommandOutputStream, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0) return;
  if (sink.writeBytes) await sink.writeBytes(bytes);
  else await sink.write(new TextDecoder().decode(bytes));
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
  const joined = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
  };
  // The session root at '/', every path git is given absolute.
  __wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred: args.cred, pid: args.pid });
  // After initFS, which drops any supervisor a pooled isolate still held.
  __wasiAdoptSupervisor(args.supervisor || null);

  // Live to the session, or kept for the caller.
  const live = args.live && args.supervisor ? __wasiSupervisorOutput(args.supervisor) : null;
  let memory = null;
  const wasi = __wasiMakeImports({
    abi: 'preview1',
    argv: args.argv,
    env: args.env,
    getMemory: () => memory,
    stdoutBytes: live ? live.stdoutBytes : (b) => { stdout.push(b); },
    stderrBytes: live ? live.stderrBytes : (b) => { stderr.push(b); },
    stdinRead: args.supervisor ? (maxBytes) => args.supervisor.cpReadStdin(args.pid, 8000, undefined, maxBytes) : undefined,
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
    return { exitCode: 1, stdout: new Uint8Array(0), stderr: new Uint8Array(0), error: 'git.wasm instantiate failed: ' + (e && e.message) };
  }
  memory = instance.exports.memory;
  const run = await __wasiRunStartAsync(instance, { memory });
  // git waits for its children; one it left running runs on without it.
  wasi.procDispose();
  const lost = live ? await live.drain() : null;
  return {
    exitCode: run.exitCode,
    stdout: joined(stdout),
    stderr: joined(stderr),
    error: run.error || (lost ? 'output lost: ' + lost : undefined),
    fsStats: typeof __wasiFsStats === 'function' ? __wasiFsStats() : null,
  };
};
// ── END: git-runner preamble ──────────────────────────────────────────
`;

export const GIT_RUNNER_PREAMBLE = `${WASI_INSTANCE_PREAMBLE_SRC}\n${GIT_RUNNER_PREAMBLE_TAIL}`;
