import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { resolveNpmBin, resolveNpmBinFromPath } from '../npm/bin-links.js';
import { bundleProfileForNpmBin } from '../runtime/bundle-profile.js';
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

type ProcessTableLike = {
  spawn(command: string, argv: string[], cwd: string): { pid: number };
  setLongRunning?(pid: number): void;
  setAttachedTty?(pid: number): void;
  exit(pid: number, code: number): void;
};

type ProcessInputLike = {
  open(pid: number): void;
};

type ProcessLogsLike = {
  append(pid: number, stream: 'stdout' | 'stderr', data: string): void;
  markExit(pid: number, code: number): void;
  getExit(pid: number): unknown;
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
    processTable: ProcessTableLike;
    processInput?: ProcessInputLike | null;
    processLogs: ProcessLogsLike;
    terminal?: Output | null;
    notifyTerminalEvent(event: { type: 'spawn' | 'exit'; pid: number; command: string; longRunning?: boolean; code?: number }): void;
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
      const entry = deps.processTable.spawn(shellLine, [name, ...argv], invocationCwd);
      const pid = entry.pid;
      const startedAt = Date.now();
      if (longRunning) {
        deps.processTable.setLongRunning?.(pid);
        deps.processInput?.open(pid);
      }
      if (attachedTty) deps.processTable.setAttachedTty?.(pid);

      const label = longRunning ? 'started (long-running)' : 'started';
      deps.terminal?.write(`\x1b[2m[bin ${label}: pid=${pid} cmd="${shellLine}"]\x1b[0m\r\n`);
      deps.notifyTerminalEvent({ type: 'spawn', pid, command: shellLine, longRunning });

      const writeThrough = (stream: 'stdout' | 'stderr', target: Output) => (data: string) => {
        const text = String(data);
        try { deps.processLogs.append(pid, stream, text); } catch {}
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
          try { deps.processTable.exit(pid, exitCode); } catch {}
          try {
            if (!deps.processLogs.getExit(pid)) deps.processLogs.markExit(pid, exitCode);
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
  if (env?.NIMBUS_ATTACHED_TTY === '1' || env?.FORCE_TTY === '1') return true;
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
