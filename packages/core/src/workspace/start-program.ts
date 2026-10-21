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
import { feedProgramInput, type ExitStatus, type Program, type StartedSessionProgram } from '../runtime/program-start.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { VfsCred } from '../runtime/os-contracts.js';
import { exitCodeForSignal } from '../substrate/lifo/shell/signals.js';
import { errnoOf } from '../vfs/vfs-error.js';

/** How long one wait on the broker lasts before it is made again. */
const WAIT_MS = 5000;

export interface ProgramHost {
  readonly children: ChildProcessManager;
  readonly processes: SessionProcessSupervisor;
  readonly cred: Readonly<VfsCred>;
  /** The programs it started that have not ended. */
  readonly started: Set<number>;
}

/**
 * A program's input: the contract's (a stream to its end, or none: ended at
 * once), or `written`: left open for the session's process-input calls
 * (writeProcessInput, endProcessInput), as a caller across HTTP writes it.
 */
export type ProgramInput = Program['stdin'] | 'written';

/**
 * `program` started (ExecDelegate.start's contract): resolved once it runs,
 * rejected with Node's spawn error (`code`, `errno`, `syscall: 'spawn
 * <file>'`, `path`) when it could not start, ECANCELED when `cancel`
 * aborted while it was pending (whatever had started is killed first).
 */
export async function startProgram(
  host: ProgramHost,
  program: Omit<Program, 'stdin'> & { readonly stdin: ProgramInput },
  cancel: AbortSignal,
): Promise<StartedSessionProgram> {
  const [file, ...args] = program.argv;
  if (file === undefined || file === '') throw new TypeError('startProgram: argv[0] must name a program');
  if (cancel.aborted) throw spawnError(program.argv, { code: 'ECANCELED' });
  const { children, processes } = host;
  // What ended a minute ago goes as a launch begins (NimbusWorkspace.runProcess's rule).
  await processes.reap();
  // Its parent: a process of its own, as an exec's, which ends with it.
  const parent = processes.spawn(program.argv.join(' '), [...program.argv], program.cwd, { cred: host.cred });
  let childPid: number | null = null;
  const stopPending = (): void => { if (childPid !== null) children.kill(childPid, 'SIGKILL'); };
  cancel.addEventListener('abort', stopPending, { once: true });
  try {
    ({ childPid } = await children.spawn({
      command: file, args, env: { ...program.env }, cwd: program.cwd, stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid,
    }));
  } catch (error) {
    cancel.removeEventListener('abort', stopPending);
    processes.exit(parent.pid, 127);
    await processes.reapTree(parent.pid);
    throw spawnError(program.argv, error);
  }
  const pid = childPid;
  let heard: ChildExitStatus;
  try {
    // An abort that came while the broker placed it stops it now.
    if (cancel.aborted) stopPending();
    do heard = await children.wait(pid, WAIT_MS, false);
    while (!heard.done && heard.started !== true);
  } finally {
    cancel.removeEventListener('abort', stopPending);
  }
  const ended = settleExit(children, processes, parent.pid, pid, heard);
  // Its broker entry goes once its end is taken; its table rows once its output is read too.
  const forget = (): void => { children.release(pid); };
  const release = async (): Promise<void> => {
    await ended.catch(() => {});
    forget();
    await processes.reapTree(parent.pid);
  };
  if (cancel.aborted || (heard.done && heard.spawnError !== undefined)) {
    children.kill(pid, 'SIGKILL');
    await ended;
    await release();
    throw spawnError(program.argv, { code: cancel.aborted ? 'ECANCELED' : heard.spawnError });
  }
  host.started.add(pid);
  const unlist = (): void => { host.started.delete(pid); };
  ended.then(unlist, unlist);
  if (program.stdin !== 'written') void pumpInput(children, pid, program.stdin, ended);
  const output = outputOf(children, pid, release, () => { ended.then(forget, forget); });
  return { pid, output, exit: ended, kill: (signal) => { children.kill(pid, signal); } };
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

/** `stdin` into the child's input (feedProgramInput); none: ended at once. A write that fails ends it there. */
function pumpInput(children: ChildProcessManager, childPid: number, stdin: ReadableStream<Uint8Array> | null, ended: Promise<ExitStatus>): Promise<void> {
  if (stdin === null) return children.stdinEnd(childPid);
  const sink = { write: async (bytes: Uint8Array) => (await children.stdinWrite(childPid, bytes)).ok, end: () => children.stdinEnd(childPid) };
  return feedProgramInput(stdin, sink, ended).catch(() => children.stdinEnd(childPid));
}

/** One read of fd 1 or 2 as it came back. */
interface OutputRead { fd: 1 | 2; chunks: Uint8Array[]; closed: boolean; maxSeq: number }

/**
 * The child's stdout and stderr as one stream of chunks, in the order the
 * reads answered (neither starves the other), read only as its reader takes
 * them. Read to their end, `done` is waited for before the reader hears it;
 * given up, `abandoned` is told, and what it ran leaves the table as a job
 * that outlived its exec does, with the launch-time reap.
 */
function outputOf(children: ChildProcessManager, childPid: number, done: () => Promise<void>, abandoned: () => void): ReadableStream<ExecChunk> {
  const cursors = new Map<1 | 2, number>([[1, 0], [2, 0]]);
  const answered: OutputRead[] = [];
  let open = 2;
  let cancelled = false;
  let failed: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const read = (fd: 1 | 2): void => {
    children.readOutput(childPid, fd, cursors.get(fd) ?? 0, WAIT_MS).then((result) => {
      if (cancelled) return;
      answered.push({ fd, chunks: result.chunks.map((chunk) => chunk.data), closed: result.closed, maxSeq: result.maxSeq });
      wake?.();
    }, (error: unknown) => {
      failed = { error };
      wake?.();
    });
  };
  read(1);
  read(2);
  return new ReadableStream<ExecChunk>({
    async pull(controller) {
      for (;;) {
        if (cancelled) return;
        if (failed !== null) {
          controller.error(failed.error);
          return;
        }
        if (open === 0) {
          // Its rows go before its reader hears the end, as an exec's do before its result.
          try {
            await done();
          } catch (error) {
            controller.error(error);
            return;
          }
          controller.close();
          return;
        }
        const next = answered.shift();
        if (next === undefined) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        cursors.set(next.fd, next.maxSeq);
        if (next.closed && next.chunks.length === 0) open--;
        else read(next.fd);
        const name = next.fd === 1 ? 'stdout' : 'stderr';
        let gave = false;
        for (const data of next.chunks) {
          if (data.byteLength === 0) continue;
          controller.enqueue({ stream: name, data });
          gave = true;
        }
        if (gave) return;
      }
    },
    cancel() {
      cancelled = true;
      wake?.();
      children.closeOutput(childPid, 1);
      children.closeOutput(childPid, 2);
      abandoned();
    },
  }, { highWaterMark: 0 });
}

function spawnError(argv: readonly string[], cause: unknown): Error {
  const file = argv[0] ?? '';
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'EIO';
  const error = new Error(`spawn ${file} ${code}`);
  return Object.assign(error, { code, errno: errnoOf(code) ?? -5, syscall: `spawn ${file}`, path: file, spawnargs: argv.slice(1) });
}
