import { EventEmitter } from 'node:events';
import realm from 'node:process';
import type { Writable } from 'node:stream';
import type { CommandOutputStream } from '../commands/types.js';
import { createProcessWarnings, type WarningConstructor, type WarningOptions } from '../../../_shared/node-warning.js';

export class ProcessExitError extends Error {
  exitCode: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = 'ProcessExitError';
    this.exitCode = code;
  }
}

/** The flags Node's warnings read off the process, which a program sets. */
interface WarningFlags {
  noDeprecation?: boolean;
  throwDeprecation?: boolean;
  traceDeprecation?: boolean;
  traceProcessWarnings?: boolean;
}

/**
 * process.stdout or process.stderr: a Writable over the program's output, as
 * Node's is a stream. Each write reaches the output as it is made, so it
 * keeps its place among the console's.
 */
function outputStream(output: CommandOutputStream, fd: number): Writable {
  const decoder = new TextDecoder();
  const { Writable } = realm.getBuiltinModule('node:stream');
  return Object.assign(new Writable({
    decodeStrings: false,
    write(chunk, _encoding, callback) {
      if (typeof chunk === 'string') output.write(chunk);
      else if (output.writeBytes) output.writeBytes(chunk);
      else output.write(decoder.decode(chunk));
      callback();
    },
  }), { isTTY: false, fd, columns: 80 });
}

export interface ProcessOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  /** Told process.stdout and process.stderr, each when the program first reaches it. */
  standardStream?: (stream: Writable) => void;
}

export function createProcess(opts: ProcessOptions) {
  const startTime = Date.now();
  // Unset until the program sets them, as in a Node run without their options.
  const unflagged: WarningFlags = {};
  // Node's warnings, written on the program's stderr.
  const warnings = createProcessWarnings(() => proc, (text) => { opts.stderr.write(`${text}\n`); });

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
      warnings.emitWarning(warning, type, code, ctor);
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

  // stdout and stderr, made when the program first reaches them: a Writable
  // costs the engine's stream module, which a program that only logs never loads.
  const standard = (output: CommandOutputStream, fd: number): PropertyDescriptor => {
    let stream: Writable | undefined;
    return {
      configurable: true,
      enumerable: true,
      get: () => {
        if (stream === undefined) {
          stream = outputStream(output, fd);
          opts.standardStream?.(stream);
        }
        return stream;
      },
    };
  };
  Object.defineProperties(proc, { stdout: standard(opts.stdout, 1), stderr: standard(opts.stderr, 2) });

  // Node's own 'warning' listener, unless warnings are off.
  if (warnings.installs) proc.on('warning', warnings.onWarning);

  return proc;
}
