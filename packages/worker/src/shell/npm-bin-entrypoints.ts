import { CRED_KERNEL, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { ProcessView, X_OK, type ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import { projectFs, type ProjectFs } from '../runtime/project-fs.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { FacetManager, StagedArtifactExecResult } from '../facets/manager.js';
import {
  resolveNpmBin, resolveNpmBinPath,
  type NpmBinResolution,
  isStagedArtifactTarget, stagedArtifactId,
} from '../npm/bin-links.js';
import { bundleProfileForNpmBin } from '@nimbus-sh/core/runtime/bundle-profile.js';
import { OPENCODE_TREE_SITTER_DIAG_ARG } from '../runtime/opencode-facet-runner.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { resolveContext, type ResolveContext } from '@nimbus-sh/core/substrate/lifo/commands/registry.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { z } from 'zod/v4';

type Output = { write(data: string): void };


type CommandContext = {
  pid: number;
  cred: VfsCred;
  args?: string[];
  stdout: Output;
  stderr: Output;
  cwd?: string;
  env?: Record<string, string>;
  /** The command's view of the namespace, as its credential. */
  vfs: ProcessView;
  [key: string]: unknown;
};

type FallbackCommandHandler = (ctx: CommandContext) => Promise<number> | number;
type NodeCommandHandler = (ctx: CommandContext) => Promise<number> | number;
type HintableCommandHandler = FallbackCommandHandler & { __nimbusRuntimeInstallHint?: boolean };

/** Whether `command` is the stub a known runtime that is not installed resolves to: no registered command. */
export function isRuntimeInstallHint(command: object): boolean {
  return '__nimbusRuntimeInstallHint' in command && command.__nimbusRuntimeInstallHint === true;
}

type RegistryLike = {
  resolve(name: string, from?: ResolveContext): Promise<unknown> | unknown;
};

type RuntimeCommandHint = { installSpec: string } | null;

const NpmBinPackageMetadataSchema = z.object({
  name: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  nimbus: z.object({
    terminal: z.enum(['auto', 'attached', 'detached']).optional(),
  }).optional(),
}).passthrough();

type NpmBinPackageMetadata = z.infer<typeof NpmBinPackageMetadataSchema>;

export function installNpmBinFallbackResolver(
  registry: RegistryLike,
  deps: {
    /** The session's namespace: bins are found in it, as the running command when one runs. */
    filesystem: ProcessFiles;
    getCwd(): string;
    processes: SessionProcessSupervisor;
    getFacetManager(): FacetManager;
    terminal?: Output | null;
    notifyTerminalEvent(event: { type: 'spawn' | 'exit'; pid: number; command: string; longRunning?: boolean; attachedTty?: boolean; code?: number }): void;
    runtimeCommandHint(name: string): Promise<RuntimeCommandHint>;
    emitShellExecDone(pid: number, command: string, exitCode: number, durationMs: number): void;
  },
): void {
  const upstreamResolve = registry.resolve.bind(registry);
  // Bins are probed through the caller's view, the one the command that
  // runs looks its bin up again through; a resolution without a caller sees
  // the namespace as the kernel.
  const kernelView = new ProcessView(deps.filesystem.openHost(CRED_KERNEL).fs);
  // A lookup the namespace cannot answer (a mount that fails under the cwd)
  // finds no bin: the name resolves as it would with none, and only the
  // command it names fails.
  const probe = async (lookup: () => Promise<NpmBinResolution | null>): Promise<NpmBinResolution | null> => {
    try { return await lookup(); } catch { return null; }
  };

  registry.resolve = async function resolveWithNpmBins(name: string, from?: ResolveContext): Promise<unknown> {
    const context = from ?? resolveContext(deps.getCwd() || '/home/user', undefined, kernelView);
    const cwd = context.cwd;
    const inspector = projectFs(context.view);
    // An npm bin shim by path (a launcher's `exec`, or the file a search of
    // PATH found for a bare name) is the same program as the bare name: same
    // runtime choice, TTY and lifecycle. The command that runs looks the
    // shim up again through its own view, at the same path.
    if (name.startsWith('/') || name.startsWith('./') || name.startsWith('../')) {
      const bin = await probe(() => resolveNpmBinPath(inspector, cwd, name));
      if (!bin) return await upstreamResolve(name, context);
      return binHandler(bin.name, async (vfs) => await resolveNpmBinPath(vfs, cwd, name), true);
    }

    // Registered commands, then PATH (searched upstream), then the bins of
    // the node_modules directories from the cwd up.
    const upstream = await upstreamResolve(name, context);
    if (upstream) return upstream;

    if (!context.search || !await probe(() => resolveNpmBin(inspector, cwd, name))) {
      let hint: RuntimeCommandHint = null;
      try { hint = await deps.runtimeCommandHint(name); } catch { hint = null; }
      if (!hint) return undefined;
      const hintHandler: HintableCommandHandler = async (ctx: CommandContext): Promise<number> => {
        ctx.stderr.write(`${name}: command not found\n`);
        ctx.stderr.write(`hint: install it with: nimbus install ${hint!.installSpec}\n`);
        return 127;
      };
      hintHandler.__nimbusRuntimeInstallHint = true;
      return hintHandler;
    }

    return binHandler(name, async (vfs) => await resolveNpmBin(vfs, cwd, name), false);
  };

  /**
   * The command that runs an npm bin. `executesShim`: the shim file is what
   * was invoked (by its path, or found on PATH), so the caller must be
   * allowed to execute it, as execve checks; a bare name found in the cwd's
   * node_modules/.bin runs the package's program, as npm's own lookup does,
   * whatever mode an older install left its shim with.
   */
  function binHandler(
    name: string,
    lookup: (vfs: ProjectFs) => Promise<NpmBinResolution | null>,
    executesShim: boolean,
  ): (ctx: CommandContext) => Promise<number> {
    return async (ctx: CommandContext): Promise<number> => {
      const invocationCwd = ctx.cwd || '/home/user';
      // The bin as this command sees it, through its own view; what it runs
      // is resolved through that view too.
      const vfs = projectFs(ctx.vfs);
      const from = resolveContext(invocationCwd, ctx.env, ctx.vfs);
      let bin: NpmBinResolution | null;
      try {
        bin = await lookup(vfs);
      } catch (error) {
        ctx.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 126;
      }
      if (!bin) {
        ctx.stderr.write(`${name}: command not found\n`);
        return 127;
      }
      if (executesShim) {
        try {
          await ctx.vfs.access('/' + bin.shimPath, X_OK);
        } catch (error) {
          if (!isVfsError(error, 'EACCES') && !isVfsError(error, 'EPERM')) throw error;
          ctx.stderr.write(`/${bin.shimPath}: Permission denied\n`);
          return 126;
        }
      }

      const argv = Array.isArray(ctx.args) ? ctx.args.map(String) : [];

      // Staged-artifact sentinel (e.g. opencode): the runnable bundle lives in
      // the static-assets layer, not the VFS. Dispatch it through the
      // FacetManager's ESM-mainModule path instead of the node CJS runner.
      if (isStagedArtifactTarget(bin.targetPath)) {
        const artifact = stagedArtifactId(bin.targetPath);
        const disposition = classifyStagedArtifact(artifact, argv);
        return await runStagedArtifact(
          deps, name, artifact, argv, invocationCwd, ctx, disposition,
        );
      }

      // A PATH script for another interpreter (`#!/bin/sh`) is not a node
      // program: run it the way a path-shaped invocation of it runs.
      const runtimeName = await npmBinRuntimeForTarget(vfs, bin.targetPath);
      if (runtimeName === null) {
        const execCmd = await upstreamResolve('/' + bin.shimPath, from);
        if (typeof execCmd !== 'function') {
          ctx.stderr.write(`${name}: command not found\n`);
          return 127;
        }
        return await (execCmd as NodeCommandHandler)(ctx);
      }

      const bundleProfile = bundleProfileForNpmBin(bin);
      const metadata = await readNpmBinPackageMetadata(vfs, bin.packagePath);
      const attachedTty = looksAttachedTtyNpmBin(metadata, argv, ctx.env);
      const longRunning = attachedTty || looksLongRunningNpmBin(name, argv);
      const runtimeCmd = await upstreamResolve(runtimeName, from);
      if (typeof runtimeCmd !== 'function') {
        ctx.stderr.write(`${name}: ${runtimeName} command unavailable\n`);
        return 1;
      }
      const runRuntime = runtimeCmd as NodeCommandHandler;

      const shellLine = `${name} ${argv.join(' ')}`.trim();
      const entry = deps.processes.spawn(
        shellLine, [name, ...argv], invocationCwd,
        { longRunning, attachedTty, parentPid: ctx.pid },
      );
      const pid = entry.pid;
      const startedAt = Date.now();
      if (longRunning) deps.processes.openInput(pid);

      const label = longRunning ? 'started (long-running)' : 'started';
      deps.terminal?.write(`\x1b[2m[bin ${label}: pid=${pid} cmd="${shellLine}"]\x1b[0m\r\n`);
      deps.notifyTerminalEvent({ type: 'spawn', pid, command: shellLine, longRunning, attachedTty });

      // Output goes to the pid's log ring and the caller's streams; nothing
      // abandons this invocation — it runs until the program exits.
      const writeThrough = (stream: 'stdout' | 'stderr', target: Output) => (data: string) => {
        const text = String(data);
        try { deps.processes.appendOutput(pid, stream, text); } catch {}
        try { target.write(text); } catch {}
      };

      let exitCode = 1;
      try {
        // A user-invoked bin is a foreground program: the shell waits for its
        // real exit — no dispatch timeout. Ctrl-C ends it through the
        // terminator the exec path registers on the pid.
        exitCode = await runRuntime({
          ...ctx,
          args: ['/' + bin.targetPath, ...argv],
          stdout: { write: writeThrough('stdout', ctx.stdout) },
          stderr: { write: writeThrough('stderr', ctx.stderr) },
          __nimbusBinSpawn: {
            skipSpawn: true,
            callerPid: pid,
            command: shellLine,
            forceLongRunning: longRunning,
            attachedTty,
          },
          __nimbusBundleProfile: bundleProfile,
        });
      } catch (e: unknown) {
        writeThrough('stderr', ctx.stderr)(`bin error: ${formatError(e)}\n`);
        exitCode = 1;
      } finally {
        const handedOffToLongRunningFacet = longRunning && exitCode === 0;
        if (!handedOffToLongRunningFacet) {
          try { deps.processes.exit(pid, exitCode); } catch {}
          try {
            if (!deps.processes.getExit(pid)) deps.processes.markExit(pid, exitCode);
          } catch {}
          deps.notifyTerminalEvent({ type: 'exit', pid, code: exitCode, command: shellLine });
          deps.emitShellExecDone(pid, shellLine, exitCode, Date.now() - startedAt);
        }
      }
      return exitCode;
    };
  }
}

async function runStagedArtifact(
  deps: {
    getFacetManager(): FacetManager;
    terminal?: Output | null;
    notifyTerminalEvent(event: { type: 'spawn' | 'exit'; pid: number; command: string; longRunning?: boolean; attachedTty?: boolean; code?: number }): void;
    emitShellExecDone(pid: number, command: string, exitCode: number, durationMs: number): void;
  },
  name: string,
  artifact: string,
  argv: string[],
  cwd: string,
  ctx: CommandContext,
  disposition: StagedArtifactDisposition,
): Promise<number> {
  const shellLine = `${name} ${argv.join(' ')}`.trim();
  const startedAt = Date.now();
  const fm = deps.getFacetManager();
  // Piped stdin is not yet wired for staged artifacts; the interactive TUI reads
  // keystrokes from the live ProcessInputStore via the attached-TTY stdin pump.
  // The program carries the exec id of the command that runs it.
  const base = { argv, env: ctx.env ?? {}, cwd, command: shellLine, invokerPid: ctx.pid };
  let result: StagedArtifactExecResult;
  try {
    // Same contract as the node-bin path: a user-invoked program runs to
    // its own exit; the shell does not bound the wait.
    result = await stagedArtifactWork(fm, artifact, base, disposition);
  } catch (e: unknown) {
    ctx.stderr.write(`${name}: ${formatError(e)}\n`);
    return 1;
  }
  // Resident dispositions (dual / server / attached): the facet(s) are now
  // resident, streaming live and reporting their own exit through the
  // supervisor. Surface the long-running spawn and hand off — the same
  // lifecycle as a long-running attached node bin.
  if (disposition !== 'oneshot') {
    deps.terminal?.write(`\x1b[2m[bin started (long-running): pid=${result.pid} cmd="${shellLine}"]\x1b[0m\r\n`);
    deps.notifyTerminalEvent({
      type: 'spawn', pid: result.pid, command: shellLine, longRunning: true,
      attachedTty: disposition !== 'server',
    });
    return 0;
  }
  if (result.stdout) ctx.stdout.write(result.stdout);
  if (result.stderr) ctx.stderr.write(result.stderr);
  // execStagedArtifact owns the process-table entry; it returns the
  // authoritative pid so we surface the terminal/exec-done lifecycle events
  // against the real pid (same signals as the node-bin path).
  deps.notifyTerminalEvent({ type: 'exit', pid: result.pid, code: result.exitCode, command: shellLine });
  deps.emitShellExecDone(result.pid, shellLine, result.exitCode, Date.now() - startedAt);
  return result.exitCode;
}

function stagedArtifactWork(
  fm: FacetManager,
  artifact: string,
  base: { argv: string[]; env: Record<string, string>; cwd: string; command: string; invokerPid: number },
  disposition: StagedArtifactDisposition,
): Promise<StagedArtifactExecResult> {
  switch (disposition) {
    case 'dual':
      return fm.execStagedArtifactDual(artifact, base);
    case 'server':
      return fm.execStagedArtifactServer(artifact, base);
    case 'attached':
      return fm.execStagedArtifact(artifact, { ...base, stdin: '', attachedTty: true });
    case 'oneshot':
      return fm.execStagedArtifact(artifact, { ...base, stdin: '', attachedTty: false });
    default: {
      const _exhaustive: never = disposition;
      throw new Error(`unknown staged-artifact disposition: ${String(_exhaustive)}`);
    }
  }
}

/**
 * How a staged-artifact (opencode) invocation runs. opencode's TUI + in-process
 * server exceed the fixed 128 MiB isolate cap when co-resident, so the OS runs
 * the interactive TUI as a MULTI-ISOLATE process pair: a headless `opencode
 * serve` facet + an `opencode attach` client facet, each in its own isolate with
 * its own 128 MiB cap, joined by the session loopback port registry.
 *
 *   - 'dual'     bare `opencode` (interactive TUI): transparently split into a
 *                resident serve facet + an attached-TTY attach facet.
 *   - 'server'   `opencode serve` / `opencode web`: a headless long-running HTTP
 *                server → resident keyed+routeable facet (never grabs the TTY).
 *   - 'attached' `opencode attach <url>`: the interactive TUI client → resident
 *                attached-TTY facet.
 *   - 'oneshot'  everything else (`run`, `models`, `--version`/`--help`, the
 *                Nimbus tree-sitter diagnostic): fresh isolate, buffered result.
 */
export type StagedArtifactDisposition = 'dual' | 'server' | 'attached' | 'oneshot';

export function classifyStagedArtifact(
  artifact: string,
  argv: string[],
): StagedArtifactDisposition {
  if (artifact !== 'opencode') return 'oneshot';
  if (argv.some(isNonInteractiveBinArg)) return 'oneshot';
  if (argv.includes(OPENCODE_TREE_SITTER_DIAG_ARG)) return 'oneshot';
  const sub = argv.find((a) => !a.startsWith('-'));
  if (sub === undefined) return 'dual'; // bare `opencode` → serve + attach
  if (OPENCODE_SERVER_SUBCOMMANDS.has(sub)) return 'server';
  if (OPENCODE_TUI_SUBCOMMANDS.has(sub)) return 'attached';
  return 'oneshot';
}

const OPENCODE_SERVER_SUBCOMMANDS = new Set(['serve', 'web']);
const OPENCODE_TUI_SUBCOMMANDS = new Set(['attach']);

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

/** null when the target's `#!` names an interpreter other than node or bun; no `#!` runs as node. */
async function npmBinRuntimeForTarget(vfs: ProjectFs, targetPath: string): Promise<'node' | 'bun' | null> {
  const firstLine = await readFirstLine(vfs, targetPath);
  if (!firstLine?.startsWith('#!')) return 'node';
  return shebangRuntime(firstLine);
}

async function readFirstLine(vfs: ProjectFs, path: string): Promise<string | null> {
  try {
    const text = await vfs.readFileString(path);
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return null;
  }
}

function shebangRuntime(line: string | null): 'node' | 'bun' | null {
  if (!line?.startsWith('#!')) return null;
  const words = shebangWords(line.slice(2));
  const command = words[0]?.endsWith('/env') ? words[1] : words[0];
  if (!command) return null;
  const slash = command.lastIndexOf('/');
  const name = slash >= 0 ? command.slice(slash + 1) : command;
  return name === 'bun' ? 'bun' : name === 'node' ? 'node' : null;
}

function shebangWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

const LONG_RUNNING_BIN_NAMES = new Set([
  'vite', 'vinext', 'next', 'astro', 'nuxt', 'remix', 'serve', 'http-server',
  'wrangler', 'nodemon', 'tsx', 'ts-node-dev', 'webpack-dev-server',
  'parcel', 'rollup', 'esbuild', 'turbo',
]);

const NON_INTERACTIVE_BIN_FLAGS = new Set([
  '--help',
  '-h',
  'help',
  '--version',
  '-v',
  'version',
]);

const ATTACHED_TTY_KEYWORDS = new Set([
  'tui',
  'terminal',
  'interactive',
  'coding-agent',
  'agent-cli',
  'ai-agent',
  'chat',
  'prompt',
]);

const ATTACHED_TTY_DEPENDENCIES = new Set([
  'ink',
  '@inkjs/ui',
  'blessed',
  'blessed-contrib',
  'react-blessed',
  'inquirer',
  '@inquirer/prompts',
  'enquirer',
  'prompts',
]);

const ATTACHED_TTY_DEPENDENCY_PREFIXES = [
  '@opentui/',
];

/**
 * Whether this invocation stays resident. Only the keyed long-running facet
 * exposes a re-resolvable route stub, so getting this wrong for a server means
 * its port is never reachable — it runs in the one-shot facet until the facet
 * lifetime expires and reports the limit it hit.
 *
 * A server-shaped CLI serves by default; the exception is the subcommand that
 * ends. `build` is that verb, and it means the same thing in every one of
 * these CLIs: produce an artifact, exit. `preview` does not end — it binds a
 * port and serves the built output, exactly as `dev` binds one and serves the
 * source.
 *
 * The exclusion stays narrow because the two errors are not symmetric. A
 * missed server costs a dead port for one facet lifetime; a resident process
 * that exits 0 is never reaped (`handedOffToLongRunningFacet` above), so it
 * stays `running` in `ps` for the life of the session. Only verbs that
 * certainly terminate belong here.
 */
export function looksLongRunningNpmBin(binName: string, argv: string[]): boolean {
  if (LONG_RUNNING_BIN_NAMES.has(binName)) {
    for (const arg of argv) {
      if (isNonInteractiveBinArg(arg)) return false;
      if (arg === 'build') return false;
    }
    return true;
  }
  return argv.some((arg) => arg === '--watch' || arg === '-w' || arg === '--serve' || arg === '--dev');
}

function looksAttachedTtyNpmBin(
  metadata: NpmBinPackageMetadata | null,
  argv: string[],
  env: Record<string, string> | undefined,
): boolean {
  if (argv.some(isNonInteractiveBinArg)) return false;
  if (env?.NIMBUS_ATTACHED_TTY === '1') return true;
  const explicit = metadata?.nimbus?.terminal;
  if (explicit === 'attached') return true;
  if (explicit === 'detached') return false;
  if (!metadata) return false;
  return hasAttachedTtyKeyword(metadata) || hasAttachedTtyDependency(metadata);
}

function isNonInteractiveBinArg(arg: string): boolean {
  return NON_INTERACTIVE_BIN_FLAGS.has(arg.trim().toLowerCase());
}

async function readNpmBinPackageMetadata(vfs: ProjectFs, packagePath: string): Promise<NpmBinPackageMetadata | null> {
  try {
    const manifestPath = normalizeVfsPath(`${packagePath}/package.json`);
    const parsed = NpmBinPackageMetadataSchema.safeParse(
      JSON.parse(await vfs.readFileString(manifestPath)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function hasAttachedTtyKeyword(metadata: NpmBinPackageMetadata): boolean {
  for (const keyword of metadata.keywords ?? []) {
    if (ATTACHED_TTY_KEYWORDS.has(keyword.trim().toLowerCase())) return true;
  }
  return false;
}

function hasAttachedTtyDependency(metadata: NpmBinPackageMetadata): boolean {
  for (const dependencies of [
    metadata.dependencies,
    metadata.optionalDependencies,
    metadata.peerDependencies,
  ]) {
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (isAttachedTtyDependency(name)) return true;
    }
  }
  return false;
}

function isAttachedTtyDependency(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (ATTACHED_TTY_DEPENDENCIES.has(normalized)) return true;
  return ATTACHED_TTY_DEPENDENCY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
