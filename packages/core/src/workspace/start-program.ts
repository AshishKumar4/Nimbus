/**
 * A program started by its argv through the workspace's child broker (Kinu
 * ask 67): the start contract (runtime/program-start.ts) a mount's exec
 * delegate meets, met by a session. It is placed by its cwd as every start
 * is (ask 66), runs as the child of a process of its own, and is the
 * broker's child in every other way: its stdin a byte queue a write waits
 * on, its output read as its reader takes it, its signals the broker's.
 */
import type { ChildProcessManager, ChildExitStatus } from '../runtime/child-process-manager.js';
import type { ExecChunk } from '../runtime/exec-stream.js';
import type { ExitStatus, Program, StartedProgram } from '../runtime/program-start.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { VfsCred } from '../runtime/os-contracts.js';
import { exitCodeForSignal } from '../substrate/lifo/shell/signals.js';
import { errnoOf, fsError } from '../vfs/vfs-error.js';

/** How long one wait on the broker lasts before it is made again. */
const WAIT_MS = 5000;

export interface ProgramHost {
  readonly children: ChildProcessManager;
  readonly processes: SessionProcessSupervisor;
  readonly cred: Readonly<VfsCred>;
}

/** A started program, and its pid in the session's process table. */
export interface StartedSessionProgram extends StartedProgram {
  readonly pid: number;
}

/**
 * `program` started (ExecDelegate.start's contract): resolved once it runs,
 * rejected with Node's spawn error (`code`, `errno`, `syscall: 'spawn
 * <file>'`, `path`) when it could not start, ECANCELED when `cancel`
 * aborted while it was pending (whatever had started is killed first).
 */
export async function startProgram(host: ProgramHost, program: Program, cancel: AbortSignal): Promise<StartedSessionProgram> {
  const [file, ...args] = program.argv;
  if (file === undefined || file === '') throw new TypeError('startProgram: argv[0] must name a program');
  if (cancel.aborted) throw canceled(file);
  const { children, processes } = host;
  // Its parent: a process of its own, as an exec's, which ends with it.
  const parent = processes.spawn(program.argv.join(' '), [...program.argv], program.cwd, { cred: host.cred });
  let childPid: number;
  try {
    ({ childPid } = await children.spawn({
      command: file, args, env: { ...program.env }, cwd: program.cwd, stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid,
    }));
  } catch (error) {
    processes.exit(parent.pid, 127);
    throw spawnError(program.argv, error);
  }
  const stopPending = (): void => { children.kill(childPid, 'SIGKILL'); };
  cancel.addEventListener('abort', stopPending, { once: true });
  let heard: ChildExitStatus;
  try {
    do heard = await children.wait(childPid, WAIT_MS, false);
    while (!heard.done && heard.started !== true);
  } finally {
    cancel.removeEventListener('abort', stopPending);
  }
  const ended = settleExit(children, processes, parent.pid, childPid, heard);
  if (cancel.aborted) {
    stopPending();
    await ended;
    throw canceled(file);
  }
  if (heard.done && heard.spawnError !== undefined) {
    await ended;
    throw spawnError(program.argv, { code: heard.spawnError });
  }
  void pumpInput(children, childPid, program.stdin);
  return { pid: childPid, output: outputOf(children, childPid), exit: ended, kill: (signal) => { children.kill(childPid, signal); } };
}

/** The child's exit as waitpid says it, once it comes; its parent ends with it. */
async function settleExit(
  children: ChildProcessManager,
  processes: SessionProcessSupervisor,
  parentPid: number,
  childPid: number,
  heard: ChildExitStatus,
): Promise<ExitStatus> {
  let status = heard;
  while (!status.done) status = await children.wait(childPid, WAIT_MS);
  const exit: ExitStatus = status.signal === null || status.signal === undefined
    ? { code: status.exitCode ?? 1, signal: null }
    : { code: null, signal: status.signal };
  processes.exit(parentPid, exit.signal === null ? exit.code : exitCodeForSignal(exit.signal.replace(/^SIG/, '')));
  return exit;
}

/** `stdin`'s bytes into the child's, each write waiting for room, then its end; none: ended at once. */
async function pumpInput(children: ChildProcessManager, childPid: number, stdin: ReadableStream<Uint8Array> | null): Promise<void> {
  if (stdin === null) return children.stdinEnd(childPid);
  const reader = stdin.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      // A child gone takes no more: what is left is not read.
      if (!(await children.stdinWrite(childPid, next.value)).ok) {
        await reader.cancel();
        return;
      }
    }
    await children.stdinEnd(childPid);
  } catch {
    // Its writer failed: the child sees its input end there.
    await children.stdinEnd(childPid);
  }
}

/** The child's stdout and stderr as one stream of chunks, each read as it comes; read only as its reader takes it. */
function outputOf(children: ChildProcessManager, childPid: number): ReadableStream<ExecChunk> {
  const cursors = new Map<1 | 2, number>([[1, 0], [2, 0]]);
  const reading = new Map<1 | 2, Promise<{ fd: 1 | 2; chunks: Uint8Array[]; closed: boolean; maxSeq: number }>>();
  const read = (fd: 1 | 2) => children.readOutput(childPid, fd, cursors.get(fd) ?? 0, WAIT_MS)
    .then((result) => ({ fd, chunks: result.chunks.map((chunk) => chunk.data), closed: result.closed, maxSeq: result.maxSeq }));
  reading.set(1, read(1));
  reading.set(2, read(2));
  return new ReadableStream<ExecChunk>({
    async pull(controller) {
      for (;;) {
        if (reading.size === 0) return controller.close();
        const next = await Promise.race(reading.values());
        cursors.set(next.fd, next.maxSeq);
        if (next.closed && next.chunks.length === 0) reading.delete(next.fd);
        else reading.set(next.fd, read(next.fd));
        const name = next.fd === 1 ? 'stdout' : 'stderr';
        for (const data of next.chunks) if (data.byteLength > 0) controller.enqueue({ stream: name, data });
        if (next.chunks.length > 0) return;
      }
    },
    cancel() {
      children.closeOutput(childPid, 1);
      children.closeOutput(childPid, 2);
    },
  }, { highWaterMark: 0 });
}

function canceled(file: string): Error {
  return fsError('ECANCELED', `spawn ${file}`, file);
}

/** Node's spawn error for `argv`: its code and errno, `syscall: 'spawn <file>'`, `path`, `spawnargs`. */
function spawnError(argv: readonly string[], cause: unknown): Error {
  const file = argv[0] ?? '';
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'EIO';
  const error = new Error(`spawn ${file} ${code}`);
  return Object.assign(error, { code, errno: errnoOf(code) ?? -5, syscall: `spawn ${file}`, path: file, spawnargs: argv.slice(1) });
}
