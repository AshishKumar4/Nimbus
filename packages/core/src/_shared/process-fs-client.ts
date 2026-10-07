/**
 * process-fs-client.ts — a process's filesystem mutations, sent to the
 * session as numbered calls in W7 waves (spike/delegation/MEMO.md, P4b).
 *
 * The one write path of a process: node's fs and a WASI program's syscalls
 * both log here. Each mutation is a syscall record (W7Call, rename,
 * truncate, setattr) the session applies with its own operation of that
 * name, its semantics and its refusals: nothing is an upsert, and nothing
 * makes a parent the program did not make.
 *
 * Intake is synchronous: an op takes the next place in the log and a copy
 * of its bytes in the turn it is made, so the log is program order across
 * every file. Waves carry the log in that order, one in flight at a time:
 * an op made while none is in flight goes out at the end of its turn (a
 * lone op is a wave of one, with no timer), and whatever is made while a
 * wave is out goes in the next, up to W7's bounds.
 *
 * Every wave is numbered under the process's writer epoch (WaveSequence):
 * the session keeps the writer's cursor with each commit, so a wave whose
 * answer was lost is sent again (the lost-call policy, sendWaveAttempts)
 * and answered, never applied twice. A refused op is the session's answer:
 * the op is dropped and the log goes on from the next one. A caller that
 * awaits its op gets the errno; one the program was already told succeeded
 * (a synchronous call: `acknowledged`) is a durability failure, reported at
 * the next effect (takeFailures) and by settle(), which throws naming it.
 * An op whose fate the session cannot answer (its writer epoch gone, a
 * failure that is no verdict) is one too, and the ops after it are sent
 * under a new epoch.
 *
 * Grants (delegations): once a subtree has had GRANT_AFTER mutations, the
 * client takes it (the deepest directory holding them, never the root, a
 * home directory itself or a store the session refuses), and the runtime
 * decides the mutations there itself (holder(), number()): the program is
 * answered at once and the op is logged acknowledged. Nothing of the
 * process's is in flight while a grant is taken: a wave the session began
 * before the subtree was the process's would recall it from the process
 * itself. A recall is answered by sending the log (every op, in order) and
 * then saying so; a grant unused for its idle period is given back, and
 * every one at settle(). A process's calls hold all its delegations
 * (ProcessFiles' process view), so its waves name none. A subtree the
 * session refused is not asked for again.
 */

import { encodeWriteBatch, type W7Attrs, type W7Call } from '@nimbus-sh/platform/w7-frame.js';
import type { ExclusiveMutationGrant, RecallKind } from '../runtime/os-contracts.js';
import { WAVE_BYTES, WAVE_PATHS, WAVE_PATH_BYTES, sendWaveAttempts, waveAttemptsOf, type WaveFence, type WaveTimers } from '@nimbus-sh/platform/wave-writer.js';
import { WAVE_EPOCH_TTL_MS } from '@nimbus-sh/platform/lost-call.js';
import { SYSCALL_VERDICTS, type VfsErrorCode } from '../vfs/vfs-error.js';
import type { WaveMutation, WriteBatchStreamResult, WriteStreamReceipt } from '../vfs/sqlite-vfs.js';

/** One mutation, as the session applies it: a call, or a rename, truncate or attribute change. */
export type ProcessFsOp =
  | { type: 'call'; call: W7Call }
  | { type: 'rename'; from: string; to: string }
  | { type: 'truncate'; path: string; size: number }
  | { type: 'setattr'; path: string; attrs: W7Attrs };

/** What the client asks of the session. */
export interface ProcessFsSession {
  /**
   * A writer epoch (openWaveWriter); null when the session fences nothing
   * (nothing between them loses a call). `first`: the run's first, which the
   * binding may answer with the epoch minted with it.
   */
  openWriter(first: boolean): Promise<string | null>;
  /** One attempt of one wave (SupervisorRPC.writeBatchStream). */
  writeBatchStream(stream: ReadableStream<Uint8Array>, fence?: WaveFence, owner?: string): Promise<unknown>;
  /** Delegations; absent, the process holds none and the session decides every op. */
  readonly grants?: ProcessFsGrantSession;
}

/** The session's delegation calls (fsAcquireExclusiveMutation with `delegate`, fsAwaitRecall, fsRecalled, fsReleaseExclusiveMutation). */
export interface ProcessFsGrantSession {
  acquire(path: string, delegate: { reads: boolean; inos: number; bytes: number }): Promise<ExclusiveMutationGrant>;
  release(owner: string): Promise<void>;
  awaitRecall(owner: string, waitMs: number): Promise<RecallKind | null>;
  recalled(owner: string, kind: RecallKind): Promise<void>;
}

/** A subtree the process holds: what its runtime decides there is the session's answer. */
export interface ProcessFsGrant {
  /** Its root, a storage key. */
  readonly root: string;
  readonly owner: string;
  /** The umask the session applies to the process's creates. */
  readonly umask: number;
}

/** The session's stat of a file a data call published (its receipt, less the path). */
export type ProcessFsReceipt = Omit<WriteStreamReceipt, 'path'>;

/** An op committed: the stat of the file its data call published, when it published one. */
export interface ProcessFsAnswer {
  receipt?: ProcessFsReceipt;
  /** The op's path's revision right before it and the session's right after (WaveMutation), when it committed on the session's own filesystem. */
  mutation?: { before: number; after: number };
  /** What a session call of its own (ProcessFsClient.call) answered. */
  value?: unknown;
}

/** An op the program was told succeeded that the session refused, or whose fate it could not answer. */
export interface ProcessFsFailure {
  /** The call's name: writeFile, mkdir, rename, … */
  op: string;
  path: string;
  errno: string;
  message: string;
}

export interface ProcessFsClientOptions {
  readonly session: ProcessFsSession;
  /**
   * Timers captured before a program's shims replace the global ones: the
   * resend backoff and a wave's watch run on them, never on the program's.
   */
  readonly timers?: WaveTimers;
  /** The clock (ms) the writer epoch's age is read on. */
  readonly now?: () => number;
  /**
   * Bytes of synchronous ops (`acknowledged`) the client holds unanswered
   * before one more fails ENOMEM: a synchronous loop sends nothing until it
   * yields, so its bytes are all held until then.
   */
  readonly syncCapBytes?: number;
  /** Told of every call the client makes to the session (the invocation budget). */
  readonly charge?: (call: string) => void;
  /** The lost-call policy's timings; tests shorten them. */
  readonly retry?: { backoffMs: readonly number[]; stallMs: number; answerDeadlineMs: number };
  /** Mutations in a subtree before the client takes it (GRANT_AFTER). */
  readonly grantAfter?: number;
  /** A grant unused this long is given back (GRANT_IDLE_MS). */
  readonly grantIdleMs?: number;
  /** Inode numbers a first grant of a subtree reserves (GRANT_INOS); each renewal doubles it. */
  readonly grantInos?: number;
  /** How long one recall poll waits before asking again. */
  readonly recallPollMs?: number;
  /** Every key that is a home directory itself: never taken. */
  readonly isHomeRoot?: (key: string) => boolean;
  /**
   * Told when a grant ends or is shared (recalled, idle, settled), its log
   * sent: what the runtime decided under `root` is the session's to answer
   * now.
   */
  readonly released?: (root: string) => void;
  /**
   * Called first by every flush (a recall's too): the runtime logs what it
   * still holds unlogged (a file's latest bytes), so the flush sends it.
   */
  readonly drain?: () => void;
}

export interface ProcessFsClient {
  /**
   * Log `op` (its place in the log taken now; its bytes are the client's
   * from now on: the caller hands over a buffer nothing writes to again) and
   * answer once the session has it: resolved when committed, rejected with
   * its errno when refused. `acknowledged`: the program was already told
   * it succeeded (a synchronous call), so its refusal is a failure to
   * report and the answer never rejects. A synchronous op past the client's
   * cap throws ENOMEM here, logged nowhere.
   */
  submit(op: ProcessFsOp, options?: { acknowledged?: boolean }): Promise<ProcessFsAnswer>;
  /**
   * A mutation no call record carries (a tree's removal, a copy), made by
   * `run` as one session call in its place in the log: once every op logged
   * before it is answered, and before any logged after it is sent.
   * Answers what `run` answers; a failure of an acknowledged one is reported.
   */
  call<T>(name: string, path: string, run: () => Promise<T>, options?: { acknowledged?: boolean }): Promise<T>;
  /** Resolves once every op logged so far is answered (not those logged after: a writing process is never idle). */
  flush(): Promise<void>;
  /** The end of the run: everything answered; throws naming every failure not yet taken. */
  settle(): Promise<void>;
  /** The failures not yet reported, taken (the next effect reports them). */
  takeFailures(): ProcessFsFailure[];
  /**
   * A change the program was told succeeded, refused or unanswered where the
   * runtime awaited it on the program's behalf (a synchronous call's own
   * work): reported with the client's own (takeFailures, settle).
   */
  noteFailure(failure: ProcessFsFailure): void;
  /** Bytes logged and not yet answered. */
  readonly pendingBytes: number;
  /**
   * A window for `bytes` a writer is about to log, granted in the order
   * asked once the bytes granted and not yet given back leave room for them
   * under PROCESS_FS_ROOM_BYTES (or when none are): a writer with many to
   * send (a drain of parked writes) logs them a window at a time, so they
   * are never all held twice. Answers the window's release, for when the
   * bytes are answered.
   */
  room(bytes: number): Promise<() => void>;
  /**
   * The grant a mutation at `key` is decided under now (held, not shared),
   * or undefined: the session decides it. Counts the mutation toward taking
   * the subtree.
   */
  holder(key: string): ProcessFsGrant | undefined;
  /** A number for a name made under `grant` (from its reserved range), or undefined once the range is spent. */
  number(grant: ProcessFsGrant): number | undefined;
  /** Draw `bytes` of the storage `grant` reserved; false when it has too few left (the session decides). */
  draw(grant: ProcessFsGrant, bytes: number): boolean;
  /** The grant holding `key` (held, not shared), without counting a mutation. */
  held(key: string): ProcessFsGrant | undefined;
  /** Whether `key` is in a subtree the process holds or shares: what is decided there is not known elsewhere yet. */
  holds(key: string): boolean;
  /** Whether any op is logged and not yet answered. */
  pending(): boolean;
  stats(): ProcessFsStats;
}

export interface ProcessFsStats {
  ops: number;
  waves: number;
  resends: number;
  epochs: number;
  refused: number;
  lost: number;
  maxWaveOps: number;
  grants: number;
  grantsRefused: number;
  recalls: number;
  released: number;
  widened: number;
  renewed: number;
}

/** A synchronous loop's bytes held at once, at most (ProcessFsClientOptions.syncCapBytes). */
export const PROCESS_FS_SYNC_CAP_BYTES = 64 * 1024 * 1024;

/** What a writer that waits for room (ProcessFsClient.room) lets the client hold unanswered: two waves' worth. */
export const PROCESS_FS_ROOM_BYTES = 2 * WAVE_BYTES;

/**
 * The most a process holds acknowledged (told it succeeded) and not yet
 * answered by the session before a change in a held subtree stops being
 * decided here and waits for its own answer: two waves' worth of ops and
 * bytes. What a process killed mid-run can lose of what it decided is at
 * most this (its synchronous calls' own bytes are bounded by the sync cap).
 */
export const DECIDED_BACKLOG_OPS = 2 * WAVE_PATHS;
export const DECIDED_BACKLOG_BYTES = 2 * WAVE_BYTES;

/** A data call's bytes per op: a larger one is sent as its first piece, then writes at offsets. */
const DATA_PIECE_BYTES = WAVE_BYTES;

/** The most subtrees one process holds at once; past it, two are widened to their common ancestor. */
export const MAX_DELEGATIONS_PER_PROCESS = 8;
/** Mutations in a subtree before the client takes it. */
export const GRANT_AFTER = 8;
/** A grant unused this long is given back. */
export const GRANT_IDLE_MS = 2_000;
/** Inode numbers a first grant of a subtree reserves; each renewal doubles it. */
const GRANT_INOS = 4096;
/** Storage bytes a grant reserves for what is decided under it. */
const GRANT_BYTES = 64 * 1024 * 1024;
/** How long one recall poll waits before asking again. */
const RECALL_POLL_MS = 20_000;

interface Grant extends ProcessFsGrant {
  nextIno: number;
  readonly endIno: number;
  readonly inos: number;
  bytesLeft: number;
  shared: boolean;
  /** Being given back (idle, renewed, widened, settled): nothing more is decided under it. */
  closing: boolean;
  ended: boolean;
  lastUsed: number;
}

function parentKey(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

function within(key: string, root: string): boolean {
  return root === '' || key === root || key.startsWith(`${root}/`);
}

function commonAncestor(left: string, right: string): string {
  const a = left.split('/');
  const b = right.split('/');
  const out: string[] = [];
  for (let index = 0; index < Math.min(a.length, b.length) && a[index] === b[index]; index++) out.push(a[index]!);
  return out.join('/');
}

interface Entry {
  /** A call record, or a session call of its own (ProcessFsClient.call). */
  op: ProcessFsOp | { type: 'run'; name: string; path: string; run: () => Promise<unknown> };
  /** Its number under the writer epoch it was first sent under; 0 until then. */
  seq: number;
  /** Its place in the log, from 1: entries are answered in this order. */
  order: number;
  bytes: number;
  paths: string[];
  acknowledged: boolean;
  resolve(answer: ProcessFsAnswer): void;
  reject(error: Error): void;
}

const GLOBAL_TIMERS: WaveTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function pathsOf(op: Entry['op']): string[] {
  switch (op.type) {
    case 'run': return [op.path];
    case 'call': return [op.call.path];
    case 'rename': return [op.from, op.to];
    case 'truncate': case 'setattr': return [op.path];
  }
}

/** A storage key as W7 takes it: no leading or doubled slash, no `.` or `..`, not the root. */
function canonical(path: string): boolean {
  return path !== '' && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !path.includes('\0');
}

function nameOf(op: Entry['op']): string {
  return op.type === 'call' ? op.call.call : op.type === 'run' ? op.name : op.type;
}

function fsError(errno: string, message: string, path: string): Error & { code: string; path: string } {
  return Object.assign(new Error(message), { code: errno, path });
}

/** A data call larger than a piece: its first piece as the call, the rest as writes at their offsets. */
function pieces(op: ProcessFsOp): ProcessFsOp[] {
  if (op.type !== 'call' || !('data' in op.call) || op.call.data.byteLength <= DATA_PIECE_BYTES) return [op];
  const call = op.call;
  const data = call.data;
  const out: ProcessFsOp[] = [{ type: 'call', call: { ...call, data: data.subarray(0, DATA_PIECE_BYTES) } }];
  // An append's later pieces follow it at the end; the others at their offsets after the first.
  for (let at = DATA_PIECE_BYTES; at < data.byteLength; at += DATA_PIECE_BYTES) {
    const piece = data.subarray(at, Math.min(data.byteLength, at + DATA_PIECE_BYTES));
    const ino = 'ino' in call ? call.ino : undefined;
    out.push(call.call === 'append' || call.call === 'appendFile'
      ? { type: 'call', call: { call: 'append', path: call.path, ...(ino === undefined ? {} : { ino }), data: piece } }
      : { type: 'call', call: { call: 'write', path: call.path, ...(ino === undefined ? {} : { ino }), offset: (call.call === 'write' ? call.offset : 0) + at, data: piece } });
  }
  return out;
}

export function processFsClient(options: ProcessFsClientOptions): ProcessFsClient {
  const { session } = options;
  const timers = options.timers ?? GLOBAL_TIMERS;
  const now = options.now ?? Date.now;
  const syncCap = options.syncCapBytes ?? PROCESS_FS_SYNC_CAP_BYTES;
  const charge = options.charge ?? (() => {});
  /** Logged, not yet sent; the first ones may carry numbers from a wave they came back from. */
  const queue: Entry[] = [];
  let inFlight: Entry[] | null = null;
  let scheduled = false;
  let pendingBytes = 0;
  let pendingSyncBytes = 0;
  let pendingSyncOps = 0;
  /** The writer epoch the log is numbered under, when it was opened, and its numbering. */
  let epoch: { writer: string | null; openedAt: number } | null = null;
  let nextSeq = 1;
  let ack = 0;
  let wave = 0;
  const failures: ProcessFsFailure[] = [];
  /** Entries logged, the last one answered (every one before it is), and the flushes waiting for a place in the log. */
  let logged = 0;
  let answered = 0;
  const marks: { mark: number; resolve(): void }[] = [];
  /** Bytes in granted windows, and the writers waiting for one, in the order they asked. */
  let windowed = 0;
  const roomWaiters: { bytes: number; resolve(release: () => void): void }[] = [];
  const grantRoom = (bytes: number): (() => void) => {
    windowed += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      windowed -= bytes;
      while (roomWaiters.length > 0 && (windowed === 0 || windowed + roomWaiters[0]!.bytes <= PROCESS_FS_ROOM_BYTES)) {
        const next = roomWaiters.shift()!;
        next.resolve(grantRoom(next.bytes));
      }
    };
  };
  const counters: ProcessFsStats = {
    ops: 0, waves: 0, resends: 0, epochs: 0, refused: 0, lost: 0, maxWaveOps: 0,
    grants: 0, grantsRefused: 0, recalls: 0, released: 0, widened: 0, renewed: 0,
  };
  const grantAfter = options.grantAfter ?? GRANT_AFTER;
  const grantIdleMs = options.grantIdleMs ?? GRANT_IDLE_MS;
  const recallPollMs = options.recallPollMs ?? RECALL_POLL_MS;
  const grants: Grant[] = [];
  /** Mutations per candidate subtree not yet held; subtrees the session refused, and the range each was last given. */
  const mutations = new Map<string, number>();
  const refusedRoots = new Set<string>();
  const rangeOf = new Map<string, number>();
  /** A grant being taken (no other is asked for meanwhile), and whether waves wait for it (while it is asked for). */
  let claiming: Promise<void> | null = null;
  let paused = false;
  /** The wave in flight, settled once its answer is applied. */
  let sending: Promise<void> | null = null;
  let idleTimer: unknown = null;
  let settling = false;

  const settled = (entry: Entry): void => {
    pendingBytes -= entry.bytes;
    if (entry.acknowledged) {
      pendingSyncBytes -= entry.bytes;
      pendingSyncOps--;
    }
    answered = Math.max(answered, entry.order);
    for (let at = marks.length - 1; at >= 0; at--) {
      if (marks[at]!.mark <= answered) marks.splice(at, 1)[0]!.resolve();
    }
  };

  const fail = (entry: Entry, errno: string, message: string): void => {
    settled(entry);
    const path = entry.paths[0] ?? '';
    if (entry.acknowledged) {
      failures.push({ op: nameOf(entry.op), path, errno, message });
      entry.resolve({});
    } else {
      entry.reject(fsError(errno, message, path));
    }
  };

  /** The epoch a new wave is numbered under: a fresh one before the first, and once half its life has passed with nothing unanswered. */
  const writerFor = async (): Promise<string | null> => {
    if (epoch !== null && (epoch.writer === null || now() - epoch.openedAt < WAVE_EPOCH_TTL_MS / 2)) return epoch.writer;
    charge('openWaveWriter');
    const openedAt = now();
    const writer = await session.openWriter(counters.epochs === 0);
    epoch = { writer, openedAt };
    counters.epochs++;
    nextSeq = 1;
    ack = 0;
    wave = 0;
    return writer;
  };

  /**
   * The ops of the next wave: in log order, up to W7's bounds, at least one,
   * and none logged after a flush that waits (its wave carries only what it
   * waits for, so it is answered in the time that takes).
   */
  const cut = (): Entry[] => {
    const limit = marks.reduce((least, waiting) => Math.min(least, waiting.mark), Infinity);
    const taken: Entry[] = [];
    const owned = new Set<string>();
    let pathBytes = 0;
    let bytes = 0;
    while (queue.length > 0) {
      const next = queue[0]!;
      // A session call of its own is never in a wave: it is made alone, in its place.
      if (next.op.type === 'run') {
        if (taken.length === 0) taken.push(queue.shift()!);
        break;
      }
      const fresh = next.paths.filter((path) => !owned.has(path));
      const freshBytes = fresh.reduce((sum, path) => sum + utf8Length(path), 0);
      if (taken.length > 0 && (next.order > limit || owned.size + fresh.length > WAVE_PATHS || pathBytes + freshBytes > WAVE_PATH_BYTES || bytes + next.bytes > WAVE_BYTES)) break;
      for (const path of fresh) owned.add(path);
      pathBytes += freshBytes;
      bytes += next.bytes;
      taken.push(queue.shift()!);
    }
    return taken;
  };

  const send = async (entries: Entry[]): Promise<void> => {
    const first = entries[0]!;
    if (first.op.type === 'run') {
      const { name, run } = first.op;
      charge(name);
      try {
        const value = await run();
        settled(first);
        first.resolve({ value });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        fail(first, typeof code === 'string' ? code : 'EIO', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    let writer: string | null;
    try {
      writer = await writerFor();
    } catch (error) {
      for (const entry of entries) fail(entry, 'EIO', `the session gave this process no writer: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const bytes = await encodeWriteBatch({ inodes: [], chunks: [], ops: entries.map((entry) => entry.op as ProcessFsOp) });
    // Numbered once, under the epoch they are first sent under; a re-send keeps them.
    for (const entry of entries) if (entry.seq === 0) entry.seq = nextSeq++;
    const firstSeq = entries[0]!.seq;
    counters.waves++;
    counters.maxWaveOps = Math.max(counters.maxWaveOps, entries.length);
    wave++;
    let result: unknown;
    try {
      charge('writeBatchStream');
      result = await sendWaveAttempts({
        supervisor: session,
        writer: async () => writer,
        open: waveAttemptsOf(bytes),
        streamed: false,
        wave,
        ...(writer === null ? {} : { sequence: { seq: firstSeq, ack } }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        resent: () => { counters.resends++; charge('writeBatchStream'); },
        timers,
      });
    } catch (error) {
      // Lost past every re-send, or refused before any op (the epoch gone): their fate is unknown.
      lostEpoch(entries, `the session did not answer this write: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // The session's own answer (SqliteVFS.writeStream's, through the binding).
    const answer = result as WriteBatchStreamResult;
    const error = answer.ok ? null : answer.error;
    // Unfenced, the session numbers nothing: committedOps says how far it went.
    const cursor = writer === null ? firstSeq - 1 + (answer.ok ? entries.length : answer.committedOps) : answer.sequence?.cursor;
    if (cursor === undefined) {
      lostEpoch(entries, `the session answered this write without its cursor: ${error?.message ?? 'no error'}`);
      return;
    }
    ack = Math.max(ack, cursor);
    const refused = writer === null
      ? (error?.errno !== undefined && SYSCALL_VERDICTS.has(error.errno as VfsErrorCode) ? { seq: cursor + 1, errno: error.errno, message: error.message } : null)
      : answer.sequence?.refused ?? null;
    let receipt = 0;
    const back: Entry[] = [];
    const mutations = new Map<number, WaveMutation>((answer.mutations ?? []).map((mutation) => [mutation.index, mutation]));
    for (const [index, entry] of entries.entries()) {
      if (refused !== null && entry.seq === refused.seq) {
        counters.refused++;
        fail(entry, refused.errno, refused.message);
        if (writer === null) ack = Math.max(ack, entry.seq);
        continue;
      }
      if (entry.seq <= cursor) {
        settled(entry);
        let answered: ProcessFsAnswer = {};
        const path = entry.op.type === 'call' && 'data' in entry.op.call ? entry.op.call.path : null;
        const published: WriteStreamReceipt | undefined = answer.receipts[receipt];
        if (path !== null && published?.path === path) {
          receipt++;
          const { path: _path, ...stat } = published;
          answered = { receipt: stat };
        }
        const mutation = mutations.get(index);
        if (mutation !== undefined) answered.mutation = { before: mutation.before, after: mutation.after };
        entry.resolve(answered);
        continue;
      }
      back.push(entry);
    }
    if (back.length === 0) return;
    if (answer.ok || refused !== null) {
      // After a refusal, nothing more in the wave was applied: they go again, first, as numbered.
      queue.unshift(...back);
      return;
    }
    lostEpoch(back, `the session could not apply this write: ${error?.message ?? 'no error'}`);
  };

  /**
   * Ops whose fate the session cannot answer: failures, and the epoch they
   * were numbered under is given up, so the ops after them are numbered
   * under a new one (the session would refuse them as a gap).
   */
  const lostEpoch = (entries: Entry[], message: string): void => {
    for (const entry of entries) {
      counters.lost++;
      fail(entry, 'EIO', message);
    }
    epoch = null;
    for (const entry of queue) entry.seq = 0;
  };

  const pump = (): void => {
    scheduled = false;
    if (inFlight !== null || paused) return;
    if (queue.length === 0) return;
    const entries = cut();
    inFlight = entries;
    sending = send(entries).finally(() => {
      inFlight = null;
      sending = null;
      pump();
    });
  };

  const schedule = (): void => {
    if (scheduled || inFlight !== null || paused) return;
    scheduled = true;
    queueMicrotask(pump);
  };

  /** Resolves once no wave is in flight (none starts while `paused`). */
  const quiet = async (): Promise<void> => {
    while (sending !== null) await sending;
  };

  const live = (): Grant[] => grants.filter((grant) => !grant.ended);

  const allowedRoot = (root: string): boolean => root !== '' && !(options.isHomeRoot?.(root) ?? false);

  /**
   * Give `grant` back: nothing more is decided under it from now, what was
   * (numbered from its range) is sent, then it is released, so no op names a
   * number of a lease the session no longer holds.
   */
  const close = async (grant: Grant): Promise<void> => {
    grant.closing = true;
    await client.flush();
    await end(grant);
  };

  /** Release `grant` (its log already sent: close). */
  const end = async (grant: Grant): Promise<void> => {
    if (grant.ended) return;
    grant.ended = true;
    const at = grants.indexOf(grant);
    if (at >= 0) grants.splice(at, 1);
    counters.released++;
    options.released?.(grant.root);
    try {
      charge('fsReleaseExclusiveMutation');
      await session.grants?.release(grant.owner);
    } catch {
      // Already ended by the session (revoked, or the process is ending).
    }
  };

  /** A grant's recalls, for as long as it lasts: send the log, then do what was asked. */
  const answerRecalls = async (grant: Grant): Promise<void> => {
    const port = session.grants!;
    while (!grant.ended) {
      let kind: RecallKind | null;
      try {
        charge('fsAwaitRecall');
        kind = await port.awaitRecall(grant.owner, recallPollMs);
      } catch {
        // ESTALE: the session ended it (revoked for an unanswered recall, or the process is ending).
        if (!grant.ended) {
          grant.ended = true;
          const at = grants.indexOf(grant);
          if (at >= 0) grants.splice(at, 1);
          options.released?.(grant.root);
        }
        return;
      }
      if (kind === null || grant.ended) continue;
      counters.recalls++;
      await client.flush();
      if (kind === 'share') {
        grant.shared = true;
        options.released?.(grant.root);
      }
      try {
        charge('fsRecalled');
        await port.recalled(grant.owner, kind);
      } catch {
        // Ended meanwhile.
      }
      if (kind === 'revoke') {
        grant.ended = true;
        const at = grants.indexOf(grant);
        if (at >= 0) grants.splice(at, 1);
        options.released?.(grant.root);
        return;
      }
    }
  };

  /** Give back every grant unused for the idle period; armed while any is held. */
  const armIdle = (): void => {
    if (idleTimer !== null || live().length === 0) return;
    idleTimer = timers.setTimeout(() => {
      idleTimer = null;
      const idle = live().filter((grant) => !grant.closing && now() - grant.lastUsed >= grantIdleMs);
      if (idle.length === 0 || settling) { armIdle(); return; }
      void Promise.all(idle.map(close)).then(armIdle);
    }, grantIdleMs);
  };

  /**
   * Take `root`: once nothing of the process's is in flight, ask the
   * session for it, numbering from a range twice the last one it gave this
   * subtree. Past MAX_DELEGATIONS_PER_PROCESS, the nearest grant and this
   * subtree become their common ancestor (when that may be taken).
   */
  const claim = (root: string): void => {
    const port = session.grants;
    if (port === undefined || claiming !== null || settling) return;
    claiming = (async () => {
      let target = root;
      const held = live();
      if (held.length >= MAX_DELEGATIONS_PER_PROCESS) {
        let best = '';
        for (const grant of held) {
          const shared = commonAncestor(grant.root, root);
          if (shared.length > best.length) best = shared;
        }
        if (!allowedRoot(best)) return;
        target = best;
      }
      // What the process holds under the new root is given back first: a lease never overlaps another of its own.
      // Its own grant of the same root among them: a renewal, with a range twice as large.
      const covered = live().filter((grant) => within(grant.root, target));
      if (covered.length > 0) {
        await Promise.all(covered.map(close));
        if (covered.some((grant) => grant.root !== target)) counters.widened++;
        else counters.renewed++;
      }
      // What was logged lands first (the directory may be one of its own mkdirs).
      await client.flush();
      paused = true;
      await quiet();
      const inos = rangeOf.has(target) ? rangeOf.get(target)! * 2 : (options.grantInos ?? GRANT_INOS);
      let granted: ExclusiveMutationGrant;
      try {
        charge('fsAcquireExclusiveMutation');
        granted = await port.acquire('/' + target, { reads: true, inos, bytes: GRANT_BYTES });
      } catch (error) {
        // EBUSY (another's lease), EPERM (the session's own), ENOSPC: the
        // session decides there, from now on. A directory not there (yet) may be asked for again.
        if ((error as { code?: unknown } | null)?.code !== 'ENOENT') refusedRoots.add(target);
        counters.grantsRefused++;
        return;
      }
      rangeOf.set(target, inos);
      const grant: Grant = {
        root: granted.root,
        owner: granted.owner,
        umask: granted.umask ?? 0o022,
        nextIno: granted.inos?.first ?? 0,
        endIno: granted.inos?.end ?? 0,
        inos,
        bytesLeft: granted.bytes ?? 0,
        shared: false,
        closing: false,
        ended: false,
        lastUsed: now(),
      };
      grants.push(grant);
      counters.grants++;
      void answerRecalls(grant);
      armIdle();
    })().finally(() => {
      claiming = null;
      paused = false;
      for (const key of [...mutations.keys()]) if (within(key, root) || within(root, key)) mutations.delete(key);
      schedule();
    });
  };

  const heldGrant = (key: string): Grant | undefined =>
    grants.find((grant) => !grant.ended && !grant.closing && !grant.shared && within(key, grant.root));

  const client: ProcessFsClient = {
    holder(key) {
      const held = heldGrant(key);
      if (held !== undefined) {
        // Decided here only while what it was told succeeded and the session
        // has not answered stays under the backlog bound; past it, the change
        // waits for its own answer (and so for the backlog's).
        if (pendingSyncOps >= DECIDED_BACKLOG_OPS || pendingSyncBytes >= DECIDED_BACKLOG_BYTES) return undefined;
        held.lastUsed = now();
        return held;
      }
      if (session.grants === undefined || settling) return undefined;
      // Shared, or another's: the session decides; a subtree it refused is not asked for again.
      if (grants.some((grant) => !grant.ended && within(key, grant.root))) return undefined;
      // Counted at each directory above it: the deepest one that has had
      // GRANT_AFTER mutations is taken (a loop writing across many
      // directories of one tree takes the tree, not each directory).
      let deepest: string | undefined;
      for (let root = parentKey(key); allowedRoot(root); root = parentKey(root)) {
        if ([...refusedRoots].some((refused) => within(root, refused))) break;
        const seen = (mutations.get(root) ?? 0) + 1;
        mutations.set(root, seen);
        if (seen >= grantAfter && deepest === undefined) deepest = root;
      }
      if (deepest !== undefined) claim(deepest);
      return undefined;
    },
    number(grant) {
      const held = grant as Grant;
      if (held.ended || held.closing || held.nextIno >= held.endIno) return undefined;
      // A quarter of its range left: renewed (given back and taken again,
      // its range doubled) while the rest is used. Asked once this turn's
      // decision has its name (its maker logs it before the grant closes).
      if (held.endIno - held.nextIno <= held.inos / 4) queueMicrotask(() => claim(held.root));
      return held.nextIno++;
    },
    draw(grant, bytes) {
      const held = grant as Grant;
      if (held.ended || held.bytesLeft < bytes) return false;
      held.bytesLeft -= bytes;
      return true;
    },
    held(key) {
      return heldGrant(key);
    },
    holds(key) {
      return grants.some((grant) => !grant.ended && within(key, grant.root));
    },
    pending() {
      return queue.length > 0 || inFlight !== null;
    },
    submit(op, submitOptions) {
      const acknowledged = submitOptions?.acknowledged === true;
      const named = pathsOf(op);
      for (const path of named) if (!canonical(path)) throw fsError('EINVAL', `EINVAL: not a filesystem path the session takes: '${path}'`, path);
      const parts = pieces(op);
      const bytes = parts.reduce((sum, part) => sum + (part.type === 'call' && 'data' in part.call ? part.call.data.byteLength : 0), 0);
      if (acknowledged && pendingSyncBytes + bytes > syncCap) {
        throw fsError('ENOMEM', `ENOMEM: ${pendingSyncBytes} bytes of synchronous writes are waiting for the session, and this one (${bytes}) would pass the ${syncCap}-byte cap; let the program yield (an await) for them to be sent`, pathsOf(op)[0] ?? '');
      }
      const answers = parts.map((part) => new Promise<ProcessFsAnswer>((resolve, reject) => {
        const partBytes = part.type === 'call' && 'data' in part.call ? part.call.data.byteLength : 0;
        queue.push({ op: part, seq: 0, order: ++logged, bytes: partBytes, paths: pathsOf(part), acknowledged, resolve, reject });
        pendingBytes += partBytes;
        if (acknowledged) {
          pendingSyncBytes += partBytes;
          pendingSyncOps++;
        }
        counters.ops++;
      }));
      schedule();
      // A piece refused rejects the call; its last piece's receipt answers it,
      // and its mutation spans them all.
      const answer = Promise.all(answers).then((all): ProcessFsAnswer => {
        const first = all[0]?.mutation;
        const last = all[all.length - 1];
        if (last === undefined) return {};
        const { mutation: _mutation, ...rest } = last;
        return first !== undefined && last.mutation !== undefined ? { ...rest, mutation: { before: first.before, after: last.mutation.after } } : rest;
      });
      if (acknowledged) answer.catch(() => {});
      return answer;
    },
    call<T>(name: string, path: string, run: () => Promise<T>, callOptions?: { acknowledged?: boolean }): Promise<T> {
      const acknowledged = callOptions?.acknowledged === true;
      const answer = new Promise<ProcessFsAnswer>((resolve, reject) => {
        queue.push({ op: { type: 'run', name, path, run }, seq: 0, order: ++logged, bytes: 0, paths: [path], acknowledged, resolve, reject });
        counters.ops++;
      });
      schedule();
      if (acknowledged) answer.catch(() => {});
      return answer.then((answered) => answered.value as T);
    },
    flush() {
      options.drain?.();
      const mark = logged;
      if (answered >= mark) return Promise.resolve();
      const flushed = new Promise<void>((resolve) => { marks.push({ mark, resolve }); });
      schedule();
      return flushed;
    },
    async settle() {
      settling = true;
      if (claiming !== null) await claiming;
      try {
        // Until nothing more is logged (a flush's drain may log more).
        while (answered < logged) await client.flush();
      } finally {
        if (idleTimer !== null) { timers.clearTimeout(idleTimer); idleTimer = null; }
        for (const grant of live()) await close(grant);
        settling = false;
      }
      const taken = client.takeFailures();
      if (taken.length > 0) {
        throw Object.assign(new Error(
          `${taken.length} filesystem change${taken.length === 1 ? '' : 's'} this process made did not reach the session:\n`
            + taken.map((failure) => `  ${failure.op} ${failure.path}: ${failure.errno}: ${failure.message}`).join('\n'),
        ), { code: 'EIO', failures: taken });
      }
    },
    takeFailures() {
      return failures.splice(0, failures.length);
    },
    noteFailure(failure) {
      failures.push(failure);
    },
    get pendingBytes() { return pendingBytes; },
    room(bytes) {
      if (roomWaiters.length === 0 && (windowed === 0 || windowed + bytes <= PROCESS_FS_ROOM_BYTES)) return Promise.resolve(grantRoom(bytes));
      return new Promise<() => void>((resolve) => { roomWaiters.push({ bytes, resolve }); });
    },
    stats() { return { ...counters }; },
  };
  return client;
}
