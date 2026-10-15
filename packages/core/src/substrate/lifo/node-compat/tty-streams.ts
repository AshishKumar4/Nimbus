import realm from 'node:process';
import type { Readable, Writable } from 'node:stream';
import type { CommandOutputStream } from '../commands/types.js';
import { nodeError, nodeSystemError } from '../../../_shared/node-error.js';
import { asStandardStream, joinStandardInput, outputSink, standardStream, type StandardInput } from './standard-streams.js';

/** Which of a program's standard descriptors is the terminal, and its modes. */
export interface ProgramTerminal {
  /** Whether `fd` (0, 1 or 2) is the terminal. */
  isatty(fd: number): boolean;
  /** termios raw mode, on or off: the terminal's keys go to the program as they are typed. */
  setRawMode(on: boolean): void;
}

/** A program's standard descriptors, as its process and its tty module see them. */
export interface ProgramStdio {
  readonly stdout: CommandOutputStream;
  readonly stderr: CommandOutputStream;
  /** fd 0, a piece at a time; absent, fd 0 is at its end. */
  readonly input?: StandardInput;
  /** Absent, no descriptor is the terminal. */
  readonly terminal?: ProgramTerminal;
  /** The window's size, COLUMNS x LINES, as the shell's own commands read it. */
  readonly env: Record<string, string>;
}

/** The tty module, as Node's is: its streams and isatty. */
export interface TtyModule {
  readonly ReadStream: new (fd: number) => Readable;
  readonly WriteStream: new (fd: number) => Writable;
  isatty(fd: number): boolean;
}

/** A program's tty module and its standard streams, each made once, when first reached. */
export interface ProgramTty {
  readonly module: TtyModule;
  stdin(): Readable;
  stdout(): Writable;
  stderr(): Writable;
}

const programs = new WeakMap<ProgramStdio, ProgramTty>();

/**
 * The tty module of the program `stdio` is, its streams joined to its
 * descriptors: a WriteStream writes to the descriptor it is made on, in order
 * with process.stdout, a ReadStream reads fd 0, and isatty answers for each.
 * One per program, so that its process's streams are its module's (in a
 * terminal, process.stdout is a tty.WriteStream). Its classes are the engine's
 * stream classes, made when the program first reaches them.
 */
export function ttyOf(stdio: ProgramStdio): ProgramTty {
  let tty = programs.get(stdio);
  if (tty === undefined) programs.set(stdio, tty = createTty(stdio));
  return tty;
}

function createTty(stdio: ProgramStdio): ProgramTty {
  let module: TtyModule | undefined;
  let stdin: Readable | undefined;
  let stdout: Writable | undefined;
  let stderr: Writable | undefined;
  const isatty = (fd: number): boolean => Number.isInteger(fd) && fd >= 0 && fd <= 2 && stdio.terminal?.isatty(fd) === true;
  const ttyModule = (): TtyModule => module ??= ttyClasses(stdio, isatty);
  const standardOutput = (fd: 1 | 2): Writable => {
    if (!isatty(fd)) return standardStream(fd === 1 ? stdio.stdout : stdio.stderr, fd);
    return asStandardStream(new (ttyModule().WriteStream)(fd), fd);
  };
  return {
    get module() { return ttyModule(); },
    stdin: () => stdin ??= isatty(0)
      ? Object.assign(new (ttyModule().ReadStream)(0), { fd: 0 })
      : Object.assign(joinStandardInput(new (realm.getBuiltinModule('node:stream').Readable)(), stdio.input), { fd: 0 }),
    stdout: () => stdout ??= standardOutput(1),
    stderr: () => stderr ??= standardOutput(2),
  };
}

/** A descriptor as Node's tty streams take it: a whole number, else ERR_INVALID_FD. */
function checkFd(fd: number): number {
  if (typeof fd !== 'number' || (fd >> 0) !== fd || fd < 0) throw nodeError(RangeError, 'ERR_INVALID_FD', `"fd" must be a positive integer: ${String(fd)}`);
  return fd;
}

/** What uv_tty_init answers for a descriptor that is not one of the program's standard three. */
function ttyInitFailed(): Error {
  return nodeSystemError('ERR_TTY_INIT_FAILED', 'TTY initialization failed', { errno: -22, code: 'EINVAL', message: 'invalid argument', syscall: 'uv_tty_init' });
}

function ttyClasses(stdio: ProgramStdio, isatty: (fd: number) => boolean): TtyModule {
  const { Readable, Writable } = realm.getBuiltinModule('node:stream');
  const readline = realm.getBuiltinModule('node:readline');
  const windowSize = (): [number, number] => [Number(stdio.env.COLUMNS) || 80, Number(stdio.env.LINES) || 24];

  class ReadStream extends Readable {
    readonly isTTY = true;
    isRaw = false;

    constructor(fd: number) {
      if (checkFd(fd) !== 0) throw ttyInitFailed();
      super();
      joinStandardInput(this, stdio.input);
    }

    setRawMode(mode: boolean): this {
      const raw = Boolean(mode);
      stdio.terminal?.setRawMode(raw);
      this.isRaw = raw;
      return this;
    }
  }

  class WriteStream extends Writable {
    readonly isTTY = true;
    // The window's, on the terminal; none on a pipe, as Node has none there.
    columns: number | undefined;
    rows: number | undefined;

    constructor(fd: number) {
      if (checkFd(fd) > 2) throw ttyInitFailed();
      super(outputSink(fd === 1 ? stdio.stdout : fd === 2 ? stdio.stderr : undefined));
      if (isatty(fd)) [this.columns, this.rows] = windowSize();
    }

    // As Node's tty.WriteStream: each cursor method is readline's, on this stream.
    clearLine(dir: -1 | 0 | 1, cb?: () => void): boolean {
      return readline.clearLine(this, dir, cb);
    }

    clearScreenDown(cb?: () => void): boolean {
      return readline.clearScreenDown(this, cb);
    }

    cursorTo(x: number, y?: number | (() => void), cb?: () => void): boolean {
      return typeof y === 'function' ? readline.cursorTo(this, x, undefined, y) : readline.cursorTo(this, x, y, cb);
    }

    moveCursor(dx: number, dy: number, cb?: () => void): boolean {
      return readline.moveCursor(this, dx, dy, cb);
    }

    getColorDepth(): number {
      return 8; // 256 colours – reasonable default for a virtual terminal
    }

    hasColors(count?: number): boolean {
      if (count === undefined) return true;
      return count <= 256;
    }

    getWindowSize(): [number, number] {
      return windowSize();
    }
  }

  return { ReadStream, WriteStream, isatty };
}
