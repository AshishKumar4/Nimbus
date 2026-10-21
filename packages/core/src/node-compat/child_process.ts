/**
 * Node's `child_process`, written once over a start face (Kinu ask 67):
 * each child is a program started by its argv (NodeStart, ExecDelegate's
 * start contract), its input a byte stream with backpressure, its output
 * read as its reader takes it, its end waitpid's. `exec` starts `/bin/sh -c`
 * its line, as Node's does. With no start face (lifo's node, until its realm
 * can wait) every start is refused ENOSYS, as a spawn the system cannot make.
 * The synchronous forms cannot wait for a child and refuse
 * (ERR_NIMBUS_SYNC_CHILD_PROCESS, the hosted node's code and reason).
 */
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { operandPath } from '../substrate/lifo/utils/path.js';
import { errnoOf } from '../vfs/vfs-error.js';
import { invalidArgType, invalidArgValue, nodeError } from '../_shared/node-error.js';
import type { ExitStatus, StartedProgram } from '../runtime/program-start.js';
import type { NodeStart } from './faces.js';

type Stdio = 'pipe' | 'ignore' | 'inherit';

export interface SpawnOptions {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  stdio?: Stdio | readonly (Stdio | null | undefined)[];
  /** `exec`'s shell (true: `/bin/sh`), or none. */
  shell?: boolean | string;
  timeout?: number;
  killSignal?: string | number;
  signal?: AbortSignal;
  argv0?: string;
  detached?: boolean;
  windowsHide?: boolean;
}

export interface ExecOptions extends SpawnOptions {
  encoding?: string | null;
  maxBuffer?: number;
}

type Output = string | Buffer;
type ExecCallback = (error: Error | null, stdout: Output, stderr: Output) => void;

/** Linux's numbers for the signals a child may be sent by number, as `kill(15)` names SIGTERM. */
const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 10: 'SIGUSR1', 12: 'SIGUSR2', 13: 'SIGPIPE',
  14: 'SIGALRM', 15: 'SIGTERM', 17: 'SIGCHLD', 18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP', 21: 'SIGTTIN', 22: 'SIGTTOU', 28: 'SIGWINCH',
};
const SIGNAL_SET = new Set(Object.values(SIGNAL_NAMES));

/** A signal as Node's kill takes it, by name or number; another is ERR_UNKNOWN_SIGNAL. */
function signalName(signal: string | number | undefined): string {
  if (signal === undefined) return 'SIGTERM';
  const name = typeof signal === 'number' ? SIGNAL_NAMES[signal] : signal;
  if (name === undefined || !SIGNAL_SET.has(name)) throw nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${String(signal)}`);
  return name;
}

/** A start refused with `code`, as Node's spawn reports one: the 'error' event's error. */
function spawnError(code: string, file: string, spawnargs: readonly string[]): Error {
  const errno = errnoOf(code) ?? -1;
  return Object.assign(new Error(`spawn ${file} ${code}`), { errno, code, syscall: `spawn ${file}`, path: file, spawnargs: spawnargs.slice(1) });
}

/** Node's refusal of a synchronous child (the hosted node's): it cannot be run to completion without yielding. */
function refuseSync(api: string, command: string): never {
  throw nodeError(Error, 'ERR_NIMBUS_SYNC_CHILD_PROCESS', `child_process.${api} is not supported here: this process has no synchronous I/O `
    + 'primitive, so a child process cannot be run to completion without yielding to the event loop. Returning early would report '
    + 'success for a command that has not run. Use the asynchronous form instead — exec/execFile/spawn, or await '
    + `util.promisify(child_process.exec)(...). Command: ${command}`, { command });
}

/** Whether a spawn's second argument is its args (readonly arrays are arrays). */
function isArgList(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}

/** The three descriptors' modes, as Node normalizes `stdio`. */
function stdioOf(stdio: SpawnOptions['stdio']): readonly [Stdio, Stdio, Stdio] {
  const mode = (value: Stdio | null | undefined): Stdio => (value === 'ignore' || value === 'inherit' ? value : 'pipe');
  if (typeof stdio === 'string') return [mode(stdio), mode(stdio), mode(stdio)];
  if (stdio === undefined) return ['pipe', 'pipe', 'pipe'];
  return [mode(stdio[0]), mode(stdio[1]), mode(stdio[2])];
}

/**
 * A pipe into a child: a Writable whose writes the child's input stream
 * takes in order, each write's callback once the reader has taken it (so
 * `write` returns false, and 'drain' follows, as the child falls behind),
 * and its end after them.
 */
function inputPipe(): { writable: Writable; readable: ReadableStream<Uint8Array> } {
  const pending: { chunk: Uint8Array; taken: (error?: Error | null) => void }[] = [];
  let ended = false;
  let gone: Error | null = null;
  let wake: (() => void) | null = null;
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (pending.length === 0 && !ended) await new Promise<void>((resolve) => { wake = resolve; });
      const next = pending.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next.chunk);
      next.taken();
    },
    cancel() {
      // Its reader has gone (the child ended): what waits is not written, as a pipe's writer meets EPIPE.
      gone = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
      for (const write of pending.splice(0)) write.taken(gone);
    },
  }, { highWaterMark: 0 });
  const writable = new Writable({
    highWaterMark: 0,
    write(chunk, encoding, taken) {
      if (gone !== null) {
        taken(gone);
        return;
      }
      pending.push({ chunk: typeof chunk === 'string' ? Buffer.from(chunk, Buffer.isEncoding(encoding) ? encoding : 'utf8') : chunk, taken });
      wake?.();
    },
    final(done) {
      ended = true;
      wake?.();
      done();
    },
    destroy(error, done) {
      ended = true;
      wake?.();
      done(error);
    },
  });
  return { writable, readable };
}

/** Node's ChildProcess, over a started program. */
export class ChildProcess extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  connected = false;
  spawnfile = '';
  spawnargs: string[] = [];
  stdin: Writable | null = null;
  stdout: PassThrough | null = null;
  stderr: PassThrough | null = null;
  stdio: [Writable | null, PassThrough | null, PassThrough | null] = [null, null, null];
  /** The program once it runs; a kill sent before then waits for it. */
  private started: StartedProgram | null = null;
  private pendingKill: string | null = null;
  private exited = false;
  private closed = false;
  private outputsOpen = 0;

  /** kill(2): `signal` to the child, true if it may be sent; false once it has ended. */
  kill(signal?: string | number): boolean {
    const name = signalName(signal);
    if (this.exited) return false;
    this.killed = true;
    if (this.started === null) this.pendingKill = name;
    else this.started.kill(name);
    return true;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  /** Begins it: `start`'s answer, its output into its streams, its end. */
  run(start: Promise<StartedProgram & { readonly pid?: number }>): void {
    start.then((started) => {
      this.started = started;
      this.pid = started.pid;
      this.emit('spawn');
      if (this.pendingKill !== null) started.kill(this.pendingKill);
      void this.relay(started.output);
      started.exit.then((status) => this.end(status), (error: unknown) => this.fail(error));
    }, (error: unknown) => this.fail(error));
  }

  /** Its outputs open: what close waits for besides its exit. */
  openOutputs(count: number): void {
    this.outputsOpen = count;
  }

  /** One of its outputs has ended. */
  outputEnded(): void {
    this.outputsOpen--;
    this.maybeClose();
  }

  /**
   * Its output, each chunk into its stream (waiting while that stream is
   * full), each ended at its end. Output not piped (ignored, or inherited:
   * this process shares no descriptors with it) is read and let go.
   */
  private async relay(output: ReadableStream<{ stream: 'stdout' | 'stderr'; data: Uint8Array }>): Promise<void> {
    const reader = output.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const sink = next.value.stream === 'stdout' ? this.stdout : this.stderr;
        const { data } = next.value;
        if (sink !== null && !sink.destroyed && !sink.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) {
          await new Promise<void>((resolve) => {
            sink.once('drain', () => resolve());
            sink.once('close', () => resolve());
          });
        }
      }
    } catch {
      // Its output failed: what was read is all there is.
    } finally {
      this.stdout?.end();
      this.stderr?.end();
    }
  }

  /** Its end, waitpid's: 'exit', then 'close' once its outputs have ended. */
  private end(status: ExitStatus): void {
    this.exited = true;
    this.exitCode = status.code;
    this.signalCode = status.signal;
    this.stdin?.destroy();
    this.emit('exit', this.exitCode, this.signalCode);
    this.maybeClose();
  }

  /** A start refused (or an end not learned): the 'error' event, then 'close' with the negative errno, as Node's failed spawn. */
  private fail(error: unknown): void {
    if (this.exited) return;
    this.exited = true;
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    const failure = error instanceof Error && typeof code === 'string' ? error : spawnError('EIO', this.spawnfile, this.spawnargs);
    const errno = Reflect.get(failure, 'errno');
    this.exitCode = typeof errno === 'number' ? errno : -1;
    this.stdin?.destroy();
    this.emit('error', failure);
    this.stdout?.end();
    this.stderr?.end();
    // Node's: what a stream holds is read off so it ends.
    this.stdout?.resume();
    this.stderr?.resume();
    this.maybeClose();
  }

  private maybeClose(): void {
    if (this.closed || !this.exited || this.outputsOpen > 0) return;
    this.closed = true;
    this.emit('close', this.exitCode, this.signalCode);
  }
}

export interface ChildProcessOptions {
  /** Relative cwds are taken from it, and a child given none runs in it. */
  cwd: string;
}

/** Node's `child_process` over `start` (none: every start refused ENOSYS). */
export function createNodeChildProcess(start: NodeStart | undefined, { cwd }: ChildProcessOptions) {
  const cwdOf = (given: string | URL | undefined): string => {
    if (given === undefined) return cwd;
    const text = typeof given === 'string' ? given : fileURLToPath(given.href);
    return operandPath(cwd, text);
  };
  const envOf = (given: SpawnOptions['env']): Record<string, string> | undefined => {
    if (given === undefined) return undefined;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(given)) if (value !== undefined) env[name] = String(value);
    return env;
  };

  function spawn(file: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
    if (typeof file !== 'string') throw invalidArgType('file', 'string', file);
    if (file.length === 0) throw invalidArgValue('file', file, 'cannot be empty');
    const argList = isArgList(args) ? args.map(String) : [];
    const opts: SpawnOptions = (isArgList(args) ? options : args) ?? {};
    const shell = opts.shell === true ? '/bin/sh' : typeof opts.shell === 'string' ? opts.shell : null;
    const argv = shell === null ? [file, ...argList] : [shell, '-c', [file, ...argList].join(' ')];
    const stdio = stdioOf(opts.stdio);
    const child = new ChildProcess();
    child.spawnfile = argv[0];
    child.spawnargs = opts.argv0 === undefined ? [...argv] : [opts.argv0, ...argv.slice(1)];
    const input = stdio[0] === 'pipe' ? inputPipe() : null;
    child.stdin = input?.writable ?? null;
    child.stdout = stdio[1] === 'pipe' ? new PassThrough() : null;
    child.stderr = stdio[2] === 'pipe' ? new PassThrough() : null;
    child.stdio = [child.stdin, child.stdout, child.stderr];
    let open = 0;
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue;
      open++;
      stream.once('end', () => child.outputEnded());
    }
    child.openOutputs(open);
    const cancel = new AbortController();
    if (opts.timeout !== undefined && opts.timeout > 0) {
      const timer = setTimeout(() => child.kill(opts.killSignal), opts.timeout);
      const clear = (): void => clearTimeout(timer);
      child.once('exit', clear);
      child.once('error', clear);
    }
    if (opts.signal !== undefined) {
      const aborted = (): void => {
        cancel.abort(opts.signal?.reason);
        child.kill(opts.killSignal);
      };
      if (opts.signal.aborted) queueMicrotask(aborted);
      else opts.signal.addEventListener('abort', aborted, { once: true });
    }
    const starting = start === undefined
      ? Promise.reject(spawnError('ENOSYS', child.spawnfile, child.spawnargs))
      : start({ argv, cwd: cwdOf(opts.cwd), ...(opts.env === undefined ? {} : { env: envOf(opts.env) }), stdin: input?.readable ?? null }, cancel.signal);
    child.run(starting);
    return child;
  }

  /**
   * The callback exec and execFile give, as Node's (lib/child_process.js
   * execFile): once, at its close, with its output in `encoding` (none, or
   * 'buffer': Buffers), no error for an exit 0, else one saying how it
   * ended; past `maxBuffer` the child is killed and the error is
   * ERR_CHILD_PROCESS_STDIO_MAXBUFFER; a start refused is its error, at once.
   */
  function collect(child: ChildProcess, cmd: string, options: ExecOptions, callback: ExecCallback | undefined): void {
    const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
    const text = encoding !== null && encoding !== 'buffer' && Buffer.isEncoding(encoding) ? encoding : null;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const chunks: Record<'stdout' | 'stderr', Uint8Array[]> = { stdout: [], stderr: [] };
    const lengths = { stdout: 0, stderr: 0 };
    let failure: Error | null = null;
    let killed = false;
    let done = false;
    const outputs = (): [Output, Output] => {
      const join = (parts: Uint8Array[]): Output => (text === null ? Buffer.concat(parts) : Buffer.concat(parts).toString(text));
      return [join(chunks.stdout), join(chunks.stderr)];
    };
    const kill = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      killed = true;
      child.kill(options.killSignal);
    };
    for (const name of ['stdout', 'stderr'] as const) {
      child[name]?.on('data', (chunk: unknown) => {
        if (!(chunk instanceof Uint8Array) || lengths[name] > maxBuffer) return;
        lengths[name] += chunk.byteLength;
        if (lengths[name] > maxBuffer) {
          chunks[name].push(chunk.subarray(0, maxBuffer - (lengths[name] - chunk.byteLength)));
          failure = nodeError(RangeError, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', `${name} maxBuffer length exceeded`);
          kill();
        } else {
          chunks[name].push(chunk);
        }
      });
    }
    const finish = (code: number | null, signal: string | null): void => {
      if (done || callback === undefined) return;
      done = true;
      const [stdout, stderr] = outputs();
      if (failure === null && code === 0 && signal === null) {
        callback(null, stdout, stderr);
        return;
      }
      const ended = failure ?? Object.assign(new Error(`Command failed: ${cmd}\n${String(stderr)}`), { code, killed: child.killed || killed, signal });
      Reflect.set(ended, 'cmd', cmd);
      callback(ended, stdout, stderr);
    };
    child.on('close', (code: unknown, signal: unknown) => finish(typeof code === 'number' ? code : null, typeof signal === 'string' ? signal : null));
    child.on('error', (error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, null);
    });
  }

  type ExecArgs = [options?: ExecOptions | ExecCallback | null, callback?: ExecCallback];
  const execArgs = ([options, callback]: ExecArgs): [ExecOptions, ExecCallback | undefined] => (typeof options === 'function'
    ? [{}, options]
    : [options ?? {}, callback]);

  /** exec(2) of `/bin/sh -c command` (or `options.shell`'s), its output collected for `callback`. */
  function exec(command: string, ...rest: ExecArgs): ChildProcess {
    if (typeof command !== 'string') throw invalidArgType('command', 'string', command);
    const [options, callback] = execArgs(rest);
    const child = spawn(command, [], { ...options, shell: typeof options.shell === 'string' ? options.shell : true });
    collect(child, command, options, callback);
    return child;
  }

  /** `file` started with `args` (no shell), its output collected for `callback`; its arguments taken as Node's normalizeExecFileArgs takes them. */
  function execFile(
    file: string,
    args?: readonly string[] | ExecOptions | ExecCallback | null,
    options?: ExecOptions | ExecCallback | null,
    callback?: ExecCallback,
  ): ChildProcess {
    let argList: string[] = [];
    let rest: ExecArgs = [options, callback];
    if (isArgList(args)) argList = args.map(String);
    else if (typeof args === 'function') rest = [args];
    else if (args !== null && args !== undefined) rest = [args, typeof options === 'function' ? options : undefined];
    const [opts, done] = execArgs(rest);
    const child = spawn(file, argList, { ...opts, shell: opts.shell ?? false });
    collect(child, [file, ...argList].join(' '), opts, done);
    return child;
  }

  // util.promisify's (lib/child_process.js customPromiseExecFunction): its
  // stdout and stderr, or the error with both; the child is the promise's.
  const promised = (run: (settle: ExecCallback) => ChildProcess): Promise<{ stdout: Output; stderr: Output }> & { child: ChildProcess } => {
    let settle: ExecCallback = () => {};
    const promise = new Promise<{ stdout: Output; stderr: Output }>((resolve, reject) => {
      settle = (error, stdout, stderr) => {
        if (error === null) resolve({ stdout, stderr });
        else reject(Object.assign(error, { stdout, stderr }));
      };
    });
    return Object.assign(promise, { child: run(settle) });
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), {
    enumerable: false,
    value: (command: string, options?: ExecOptions | null) => promised((settle) => exec(command, options, settle)),
  });
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    enumerable: false,
    value: (file: string, args?: readonly string[] | ExecOptions | null, options?: ExecOptions | null) =>
      promised((settle) => (isArgList(args) ? execFile(file, args, options, settle) : execFile(file, args, settle))),
  });

  function fork(modulePath: string): never {
    throw nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `child_process.fork is not available here: no IPC channel joins a child to this process (${String(modulePath)})`);
  }

  const execSync = (command: string): never => refuseSync('execSync', String(command));
  const execFileSync = (file: string, args?: readonly string[]): never => refuseSync('execFileSync', [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' '));
  const spawnSync = (file: string, args?: readonly string[]): never => refuseSync('spawnSync', [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' '));

  return { ChildProcess, spawn, exec, execFile, fork, execSync, execFileSync, spawnSync };
}
