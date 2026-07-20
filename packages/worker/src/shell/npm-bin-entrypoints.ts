import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { FacetManager, StagedArtifactExecResult } from '../facets/manager.js';
import {
  resolveNpmBin, resolveNpmBinFromPath,
  isStagedArtifactTarget, stagedArtifactId,
} from '../npm/bin-links.js';
import { bundleProfileForNpmBin } from '../runtime/bundle-profile.js';
import { OPENCODE_TREE_SITTER_DIAG_ARG } from '../runtime/opencode-facet-runner.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { DEFAULT_PATH } from '../constants.js';
import { z } from 'zod/v4';

type Output = { write(data: string): void };

type CommandContext = {
  args?: string[];
  stdout: Output;
  stderr: Output;
  cwd?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
};

type FallbackCommandHandler = (ctx: CommandContext) => Promise<number> | number;
type NodeCommandHandler = (ctx: CommandContext) => Promise<number> | number;
type HintableCommandHandler = FallbackCommandHandler & { __nimbusRuntimeInstallHint?: boolean };

type RegistryLike = {
  resolve(name: string): Promise<unknown> | unknown;
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
    vfs: SqliteVFS;
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

  registry.resolve = async function resolveWithNpmBins(name: string): Promise<unknown> {
    const upstream = await upstreamResolve(name);
    if (upstream) return upstream;

    const cwd = deps.getCwd() || '/home/user';
    if (!resolveNpmBinForInvocation(deps.vfs, cwd, DEFAULT_PATH, name)) {
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

    return async (ctx: CommandContext): Promise<number> => {
      const invocationCwd = ctx.cwd || '/home/user';
      const bin = resolveNpmBinForInvocation(
        deps.vfs,
        invocationCwd,
        ctx.env?.PATH || DEFAULT_PATH,
        name,
      );
      if (!bin) {
        ctx.stderr.write(`${name}: command not found\n`);
        return 127;
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

      const bundleProfile = bundleProfileForNpmBin(bin);
      const metadata = readNpmBinPackageMetadata(deps.vfs, bin.packagePath);
      const attachedTty = looksAttachedTtyNpmBin(metadata, argv, ctx.env);
      const longRunning = attachedTty || looksLongRunningNpmBin(name, argv);
      const runtimeName = npmBinRuntimeForTarget(deps.vfs, bin.targetPath);
      const runtimeCmd = await upstreamResolve(runtimeName);
      if (typeof runtimeCmd !== 'function') {
        ctx.stderr.write(`${name}: ${runtimeName} command unavailable\n`);
        return 1;
      }
      const runRuntime = runtimeCmd as NodeCommandHandler;

      const shellLine = `${name} ${argv.join(' ')}`.trim();
      const entry = deps.processes.spawn(
        shellLine, [name, ...argv], invocationCwd,
        { longRunning, attachedTty },
      );
      const pid = entry.pid;
      const startedAt = Date.now();
      if (longRunning) deps.processes.openInput(pid);

      const label = longRunning ? 'started (long-running)' : 'started';
      deps.terminal?.write(`\x1b[2m[bin ${label}: pid=${pid} cmd="${shellLine}"]\x1b[0m\r\n`);
      deps.notifyTerminalEvent({ type: 'spawn', pid, command: shellLine, longRunning, attachedTty });

      const writeThrough = (stream: 'stdout' | 'stderr', target: Output) => (data: string) => {
        const text = String(data);
        try { deps.processes.appendOutput(pid, stream, text); } catch {}
        try { target.write(text); } catch {}
      };

      let exitCode = 1;
      try {
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
  };
}

function resolveNpmBinForInvocation(
  vfs: SqliteVFS,
  cwd: string,
  envPath: string,
  name: string,
) {
  return resolveNpmBinFromPath(vfs, cwd, envPath, name)
    ?? resolveNpmBin(vfs, cwd, name);
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
  const base = { argv, env: ctx.env ?? {}, cwd, command: shellLine } as const;
  let result: StagedArtifactExecResult;
  try {
    switch (disposition) {
      case 'dual':
        result = await fm.execStagedArtifactDual(artifact, base);
        break;
      case 'server':
        result = await fm.execStagedArtifactServer(artifact, base);
        break;
      case 'attached':
        result = await fm.execStagedArtifact(artifact, { ...base, stdin: '', attachedTty: true });
        break;
      case 'oneshot':
        result = await fm.execStagedArtifact(artifact, { ...base, stdin: '', attachedTty: false });
        break;
      default: {
        const _exhaustive: never = disposition;
        throw new Error(`unknown staged-artifact disposition: ${String(_exhaustive)}`);
      }
    }
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

function npmBinRuntimeForTarget(vfs: SqliteVFS, targetPath: string): 'node' | 'bun' {
  const firstLine = readFirstLine(vfs, targetPath);
  return shebangRuntime(firstLine) ?? 'node';
}

function readFirstLine(vfs: SqliteVFS, path: string): string | null {
  try {
    const text = vfs.readFileString(path);
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
  'vite', 'next', 'astro', 'nuxt', 'remix', 'serve', 'http-server',
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

function looksLongRunningNpmBin(binName: string, argv: string[]): boolean {
  if (LONG_RUNNING_BIN_NAMES.has(binName)) {
    for (const arg of argv) {
      if (isNonInteractiveBinArg(arg)) return false;
      if (arg === 'build' || arg === 'preview') return false;
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

function readNpmBinPackageMetadata(vfs: SqliteVFS, packagePath: string): NpmBinPackageMetadata | null {
  try {
    const manifestPath = normalizeVfsPath(`${packagePath}/package.json`);
    const parsed = NpmBinPackageMetadataSchema.safeParse(
      JSON.parse(vfs.readFileString(manifestPath)),
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
