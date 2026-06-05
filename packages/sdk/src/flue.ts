/**
 * @nimbus-sh/sdk/flue - Flue sandbox connector for Nimbus sandboxes.
 *
 * Flue owns the agent harness. Nimbus owns the sandbox. This adapter maps a
 * `NimbusSandbox` handle to Flue's `SandboxFactory`/`SandboxApi` contract
 * without making `@flue/runtime` a hard dependency of the core SDK.
 */

import type { NimbusExecResult, NimbusFileStat, NimbusSandbox } from './sandbox.js';

export interface NimbusFlueFileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date;
}

export interface NimbusFlueSessionEnv {
  exec(command: string, options?: NimbusFlueExecOptions): Promise<NimbusFlueShellResult>;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<NimbusFlueFileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cwd: string;
  resolvePath(path: string): string;
}

export interface NimbusFlueShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface NimbusFlueExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface NimbusFlueSandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<NimbusFlueFileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(command: string, options?: NimbusFlueExecOptions): Promise<NimbusFlueShellResult>;
}

export interface NimbusFlueRuntime<SessionEnv = NimbusFlueSessionEnv> {
  createSandboxSessionEnv(api: NimbusFlueSandboxApi, cwd: string): SessionEnv;
}

export interface NimbusFlueFactory<SessionEnv = NimbusFlueSessionEnv> {
  createSessionEnv(options: { id: string; cwd?: string }): Promise<SessionEnv>;
}

export interface NimbusFlueOptions<SessionEnv = NimbusFlueSessionEnv> {
  cwd?: string;
  runtime?: NimbusFlueRuntime<SessionEnv>;
}

export function nimbusFlue<SessionEnv = NimbusFlueSessionEnv>(
  sandbox: NimbusSandbox,
  options: NimbusFlueOptions<SessionEnv> = {},
): NimbusFlueFactory<SessionEnv> {
  return {
    async createSessionEnv({ cwd }): Promise<SessionEnv> {
      const runtime = options.runtime ?? await loadFlueRuntime<SessionEnv>();
      return runtime.createSandboxSessionEnv(
        new NimbusFlueApi(sandbox),
        cwd ?? options.cwd ?? '/home/user',
      );
    },
  };
}

export class NimbusFlueApi implements NimbusFlueSandboxApi {
  constructor(private readonly sandbox: NimbusSandbox) {}

  async readFile(path: string): Promise<string> {
    const content = await this.sandbox.files.read(path);
    if (content == null) throw enoent(path);
    return content;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const content = await this.sandbox.files.readBytes(path);
    if (content == null) throw enoent(path);
    return content;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sandbox.files.write(path, content);
  }

  async stat(path: string): Promise<NimbusFlueFileStat> {
    const stat = await this.sandbox.files.stat(path);
    if (!stat) throw enoent(path);
    return toFlueStat(stat);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.sandbox.files.list(path);
    return entries.map((entry) => entry.name);
  }

  async exists(path: string): Promise<boolean> {
    return this.sandbox.files.exists(path);
  }

  async mkdir(path: string, _options: { recursive?: boolean } = {}): Promise<void> {
    await this.sandbox.files.mkdir(path);
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    if (options.force && !(await this.sandbox.files.exists(path))) return;
    await this.sandbox.files.delete(path, { recursive: options.recursive });
  }

  async exec(command: string, options: NimbusFlueExecOptions = {}): Promise<NimbusFlueShellResult> {
    const result = await this.sandbox.exec(command, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: secondsToMilliseconds(options.timeout),
    });
    if (options.signal?.aborted) throw abortError(options.signal);
    return toShellResult(result);
  }
}

async function loadFlueRuntime<SessionEnv>(): Promise<NimbusFlueRuntime<SessionEnv>> {
  try {
    const specifier = '@flue/runtime';
    const runtime = await import(specifier);
    if (typeof runtime.createSandboxSessionEnv === 'function') {
      return runtime as NimbusFlueRuntime<SessionEnv>;
    }
  } catch {
    // Error below gives callers the exact integration action.
  }
  throw new Error(
    'nimbusFlue requires @flue/runtime. Install Flue or pass { runtime: { createSandboxSessionEnv } }.',
  );
}

function toFlueStat(stat: NimbusFileStat): NimbusFlueFileStat {
  const type = String(stat.type);
  return {
    isFile: type === 'file',
    isDirectory: type === 'directory',
    isSymbolicLink: false,
    size: Number(stat.size) || 0,
    mtime: new Date(Number(stat.mtime) || Date.now()),
  };
}

function toShellResult(result: NimbusExecResult): NimbusFlueShellResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function secondsToMilliseconds(timeout: number | undefined): number | undefined {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.max(1, Math.round(timeout * 1000));
}

function enoent(path: string): Error {
  const error = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
  error.code = 'ENOENT';
  return error;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}
