import { EventEmitter } from 'node:events';
import type { CommandOutputStream } from '../commands/types.js';
import { captureStack, invalidArgType } from '../../../_shared/node-error.js';

export class ProcessExitError extends Error {
  exitCode: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = 'ProcessExitError';
    this.exitCode = code;
  }
}

/** A function a warning's stack starts above (process.emitWarning's `ctor`). */
type WarningConstructor = (...args: never[]) => unknown;

/** process.emitWarning's options form. */
export interface WarningOptions {
  type?: string;
  code?: string;
  detail?: string;
  ctor?: WarningConstructor;
}

/** The flags Node's warnings read off the process, which a program sets. */
interface WarningFlags {
  noDeprecation?: boolean;
  throwDeprecation?: boolean;
  traceDeprecation?: boolean;
  traceProcessWarnings?: boolean;
}

export interface ProcessOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
}

export function createProcess(opts: ProcessOptions) {
  const startTime = Date.now();
  // Unset until the program sets them, as in a Node run without their options.
  const unflagged: WarningFlags = {};

  // An emitter, as Node's process is.
  const proc = Object.assign(new EventEmitter(), {
    argv: ['/usr/bin/node', ...opts.argv],
    argv0: 'node',
    env: { ...opts.env },
    cwd: () => opts.cwd,
    chdir: (_dir: string) => { throw new Error('process.chdir() is not supported in Lifo'); },
    exit: (code = 0) => {
      if (code !== 0) {
        opts.stderr.write(`[process.exit] code=${code}\n`);
      }
      throw new ProcessExitError(code);
    },
    stdout: {
      write: (data: string) => { opts.stdout.write(data); return true; },
      isTTY: false,
      fd: 1,
      bytesWritten: 0,
      columns: 80,
      on: () => {},
      once: () => {},
    },
    stderr: {
      write: (data: string) => { opts.stderr.write(data); return true; },
      isTTY: false,
      fd: 2,
      bytesWritten: 0,
      columns: 80,
      on: () => {},
      once: () => {},
    },
    stdin: {
      isTTY: false,
      fd: 0,
      on: () => {},
      once: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      read: () => null,
    },
    platform: 'linux' as string,
    arch: 'x64' as string,
    version: 'v22.14.0',
    versions: {
      node: '22.14.0',
      lifo: '0.1.0',
    },
    pid: 1,
    ppid: 0,
    title: 'node',
    execPath: '/usr/bin/node',
    hrtime: Object.assign(
      (prev?: [number, number]): [number, number] => {
        const now = performance.now();
        const sec = Math.floor(now / 1000);
        const nano = Math.floor((now % 1000) * 1e6);
        if (prev) {
          let ds = sec - prev[0];
          let dn = nano - prev[1];
          if (dn < 0) { ds--; dn += 1e9; }
          return [ds, dn];
        }
        return [sec, nano];
      },
      {
        bigint: (): bigint => BigInt(Math.floor(performance.now() * 1e6)),
      },
    ),
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      queueMicrotask(() => fn(...args));
    },
    memoryUsage: () => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      return {
        rss: m?.usedJSHeapSize ?? 0,
        heapTotal: m?.totalJSHeapSize ?? 0,
        heapUsed: m?.usedJSHeapSize ?? 0,
        external: 0,
        arrayBuffers: 0,
      };
    },
    uptime: () => (Date.now() - startTime) / 1000,
    release: { name: 'node' },
    config: {},
    emitWarning: (warning: string | Error, type?: string | WarningOptions | WarningConstructor, code?: string | WarningConstructor, ctor?: WarningConstructor): void => {
      emitWarning(warning, type, code, ctor);
    },
    // POSIX identity stubs (needed by many npm packages)
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    umask: (mask?: number) => mask ?? 0o22,
    // process.binding() stub — low-level Node.js internal, used by execa/errname etc.
    binding: (name: string) => {
      if (name === 'uv') {
        return {
          errname: (code: number) => `UV_UNKNOWN_${code}`,
          UV_EOF: -4095,
        };
      }
      if (name === 'natives') return {};
      if (name === 'constants') return { os: {}, fs: {}, crypto: {} };
      return {};
    },
    // Feature detection flags
    allowedNodeEnvironmentFlags: new Set<string>(),
    features: { inspector: false, debug: false, uv: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false },
    ...unflagged,
  });

  /** Node's process.emitWarning (lib/internal/process/warning.js): the warning is told to 'warning' listeners on the next tick. */
  function emitWarning(warning: string | Error, type?: string | WarningOptions | WarningConstructor, code?: string | WarningConstructor, ctor?: WarningConstructor): void {
    if (proc.noDeprecation && type === 'DeprecationWarning') return;
    let name = type;
    let detail: string | undefined;
    if (typeof type === 'object' && type !== null && !Array.isArray(type)) {
      ctor = type.ctor;
      code = type.code;
      if (typeof type.detail === 'string') detail = type.detail;
      name = type.type || 'Warning';
    } else if (typeof type === 'function') {
      ctor = type;
      code = undefined;
      name = 'Warning';
    }
    if (name !== undefined && typeof name !== 'string') throw invalidArgType('type', 'string', name);
    if (typeof code === 'function') {
      ctor = code;
      code = undefined;
    } else if (code !== undefined && typeof code !== 'string') {
      throw invalidArgType('code', 'string', code);
    }
    let told: Error;
    if (typeof warning === 'string') {
      told = Object.assign(new Error(warning), { name: String(name || 'Warning') }, code === undefined ? {} : { code }, detail === undefined ? {} : { detail });
      captureStack(told, ctor ?? proc.emitWarning);
    } else if (warning instanceof Error) {
      told = warning;
    } else {
      throw invalidArgType('warning', ['Error', 'string'], warning);
    }
    if (told.name === 'DeprecationWarning') {
      if (proc.noDeprecation) return;
      if (proc.throwDeprecation) {
        proc.nextTick(() => { throw told; });
        return;
      }
    }
    proc.nextTick(() => proc.emit('warning', told));
  }

  // Node's own 'warning' listener (onWarning), unless NODE_NO_WARNINGS=1:
  // each warning on stderr, the hint at how to trace one written once.
  let hintWritten = false;
  const writeWarning = (warning: unknown): void => {
    if (!(warning instanceof Error)) return;
    const isDeprecation = warning.name === 'DeprecationWarning';
    if (isDeprecation && proc.noDeprecation) return;
    const trace = proc.traceProcessWarnings || (isDeprecation && proc.traceDeprecation);
    let message = `(${proc.release.name}:${proc.pid}) `;
    if ('code' in warning && warning.code) message += `[${String(warning.code)}] `;
    message += trace && warning.stack ? warning.stack : String(warning);
    if ('detail' in warning && typeof warning.detail === 'string') message += `\n${warning.detail}`;
    if (!trace && !hintWritten) {
      const argv0 = String(proc.argv0 || 'node').replace(/^.*\//, '').replace(/\.exe$/, '');
      message += `\n(Use \`${argv0} ${isDeprecation ? '--trace-deprecation' : '--trace-warnings'} ...\` to show where the warning was created)`;
      hintWritten = true;
    }
    opts.stderr.write(`${message}\n`);
  };
  if (proc.env.NODE_NO_WARNINGS !== '1') proc.on('warning', writeWarning);

  return proc;
}
