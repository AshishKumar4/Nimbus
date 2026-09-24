/**
 * esbuild-cli.ts — the `esbuild` command.
 *
 * Runs the real esbuild CLI: the Go program inside esbuild.wasm, not a
 * reimplementation of its flags, so every flag, default, path rule and message
 * is esbuild's own. It runs as the calling process, from the caller's working
 * directory, in whatever isolate the host's `run` dispatches to. The runner
 * there is runtime/esbuild-cli/preamble.ts behind esbuild-wasm's wasm_exec.js,
 * which installs `globalThis.__esbuildCliRun(args, supervisor, output, module)`.
 * On workerd that is the session's esbuild facet, the one that also serves its
 * transforms, and the runner reaches it as a staged asset.
 *
 * Nothing about the build lives in the session's isolate. esbuild's Go heap
 * grows with the module graph and a WebAssembly memory never shrinks: a React
 * bundle takes the instance from 28 MiB to 76 MiB, which the session isolate
 * used to keep for the rest of its life.
 */
import type { Command, CommandContext, CommandInputStream, CommandOutputStream } from '../substrate/lifo/commands/types.js';
import type { EsbuildCliArgs, EsbuildCliOutput } from './esbuild-cli/types.js';
import { normalizeVfsPath } from '../vfs/path.js';

export type { EsbuildCliArgs, EsbuildCliOutput } from './esbuild-cli/types.js';

export interface EsbuildCommandDeps {
  /**
   * Runs one invocation where the host keeps esbuild, with filesystem
   * authority for `ctx.pid` and nothing more, and resolves to its exit
   * status. Its stdout and stderr go to `output` as they are written.
   */
  run(args: EsbuildCliArgs, ctx: CommandContext, output: EsbuildCliOutput): Promise<number>;
}

// The environment esbuild reads; esbuild-wasm's own launcher passes exactly these.
const ESBUILD_ENV = ['NO_COLOR', 'NODE_PATH', 'npm_config_user_agent', 'WT_SESSION'];

async function readStdin(stdin: CommandInputStream): Promise<Uint8Array> {
  if (!stdin.readBytes) return new TextEncoder().encode(await stdin.readAll());
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let chunk = await stdin.readBytes(65536); chunk !== null; chunk = await stdin.readBytes(65536)) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function emit(stream: CommandOutputStream, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0) return;
  if (stream.writeBytes) await stream.writeBytes(bytes);
  else await stream.write(new TextDecoder().decode(bytes));
}

export function makeEsbuildCommand(deps: EsbuildCommandDeps): Command {
  return async function esbuild(ctx: CommandContext): Promise<number> {
    const argv = ctx.args ?? [];
    const persistent = argv.find((arg) => /^--(watch|serve)(=|$)/.test(arg));
    if (persistent) {
      ctx.stderr.write(`esbuild: ${persistent.split('=')[0]} is not supported: each esbuild command runs one build and exits\n`);
      return 1;
    }
    const stdinIsTerminal = ctx.isFdTerminal?.(0) ?? ctx.stdin === undefined;
    // esbuild reads stdin only when it has no entry point; a bare `esbuild`
    // at a terminal prints its help, which the facet cannot tell it to do.
    const runArgv = argv.length === 0 && stdinIsTerminal ? ['--help'] : [...argv];
    const readsStdin = !argv.some((arg) => !arg.startsWith('-'));
    const stdin = readsStdin && !stdinIsTerminal && ctx.stdin ? await readStdin(ctx.stdin) : null;
    if ((ctx.isFdTerminal?.(2) ?? false) && !argv.some((arg) => /^--color(=|$)/.test(arg))) runArgv.push('--color=true');
    const env: Record<string, string> = {};
    for (const key of ESBUILD_ENV) {
      const value = ctx.env[key];
      if (value !== undefined) env[key] = value;
    }
    const args: EsbuildCliArgs = {
      argv: runArgv,
      cwd: `/${normalizeVfsPath(ctx.cwd || '/')}`,
      env,
      uid: ctx.cred.uid,
      gid: ctx.cred.gid,
      groups: [...ctx.cred.groups],
      umask: ctx.cred.umask,
      stdin,
    };

    try {
      return await deps.run(args, ctx, (fd, bytes) => emit(fd === 1 ? ctx.stdout : ctx.stderr, bytes));
    } catch (error) {
      ctx.stderr.write(`esbuild: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  };
}
