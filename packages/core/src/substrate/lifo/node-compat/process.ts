import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import type { CommandOutputStream } from '../commands/types.js';
import { createProcessWarnings, type WarningConstructor, type WarningOptions } from '../../../_shared/node-warning.js';
import { standardStream } from './standard-streams.js';
import { NODE_VERSION, NODE_VERSIONS } from '../../../constants.js';
import { nodeError } from '../../../_shared/node-error.js';

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
 * A program's process: an emitter, as Node's is. Its stdout and stderr are
 * made when the program first reaches them: a Writable costs the engine's
 * stream module, which a program that only logs never loads.
 */
export class LifoProcess extends EventEmitter {
  readonly #output: CommandOutputStream;
  readonly #errorOutput: CommandOutputStream;
  #stdout: Writable | undefined;
  #stderr: Writable | undefined;

  constructor(output: CommandOutputStream, errorOutput: CommandOutputStream) {
    super();
    this.#output = output;
    this.#errorOutput = errorOutput;
  }

  get stdout(): Writable {
    return this.#stdout ??= standardStream(this.#output, 1);
  }

  get stderr(): Writable {
    return this.#stderr ??= standardStream(this.#errorOutput, 2);
  }
}

/** Who a program's process is: its pid and credential in the session. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
  /** Its mask as it started: the invoking process's. */
  readonly umask: number;
  /**
   * umask(2): the mask the program creates with from now on. The program is
   * a child of the shell, with its own copy of the mask: the shell's is not
   * changed.
   */
  setUmask(mask: number): void;
}

export interface ProcessOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  identity: ProcessIdentity;
}

/**
 * A mode argument as Node's parseFileMode reads it: an octal string of
 * digits alone, or an unsigned 32-bit integer. Anything else is refused with
 * Node's error, before anything changes.
 */
function parseFileMode(given: unknown, name: string): number {
  let value = given;
  if (typeof value === 'string') {
    if (!/^[0-7]+$/.test(value)) {
      throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument '${name}' must be a 32-bit unsigned integer or an octal string. Received ${JSON.stringify(value)}`);
    }
    // Then checked as a number is (validateUint32): '40000000000' is 2 ** 32, out of range.
    value = Number.parseInt(value, 8);
  }
  if (typeof value !== 'number') {
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type number. Received ${value === null ? 'null' : `type ${typeof value}`}`);
  }
  if (!Number.isInteger(value)) {
    throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be an integer. Received ${value}`);
  }
  if (value < 0 || value > 0xffff_ffff) {
    throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be >= 0 && <= 4294967295. Received ${value}`);
  }
  return value;
}

export function createProcess(opts: ProcessOptions) {
  const startTime = Date.now();
  const { identity } = opts;
  let mask = identity.umask & 0o777;
  // Unset until the program sets them, as in a Node run without their options.
  const unflagged: WarningFlags = {};
  // Node's warnings, written on the program's stderr.
  const warnings = createProcessWarnings(() => proc, (text) => { opts.stderr.write(`${text}\n`); });

  const proc = Object.assign(new LifoProcess(opts.stdout, opts.stderr), {
    argv: ['/usr/bin/node', ...opts.argv],
    argv0: 'node',
    env: { ...opts.env },
    cwd: () => opts.cwd,
    chdir: (_dir: string) => { throw new Error('process.chdir() is not supported in Lifo'); },
    exit: (code = 0) => {
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
    // One release, core's (constants.ts), as `node --version` reports it.
    version: NODE_VERSION,
    versions: { ...NODE_VERSIONS },
    pid: identity.pid,
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
    // The process's credential: root's under sudo.
    getuid: () => identity.uid,
    getgid: () => identity.gid,
    geteuid: () => identity.uid,
    getegid: () => identity.gid,
    getgroups: () => [...identity.groups],
    /** Its mask; a new one (a number or an octal string) is what it creates with from now on, and the one before is answered. */
    umask: (next?: unknown): number => {
      const previous = mask;
      if (next === undefined) return previous;
      // umask(2) keeps the permission bits of what it is given.
      mask = parseFileMode(next, 'mask') & 0o777;
      identity.setUmask(mask);
      return previous;
    },
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

  // Node's own 'warning' listener, unless warnings are off.
  if (warnings.installs) proc.on('warning', warnings.onWarning);

  return proc;
}
