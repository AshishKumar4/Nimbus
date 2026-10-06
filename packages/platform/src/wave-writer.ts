/**
 * wave-writer.ts — a producer's writes into the session, as W7 waves.
 *
 * The one W7 producer: git's network facet (a clone's files, fetch and
 * pull's objects and refs), npm's install facet (package files), and the
 * session's own bulk writes (npm bin shims, the clang sysroot). Each write
 * is a record: a file, a link, a directory, or a removal. The writer buffers
 * records into a wave and publishes the wave through one writeBatchStream()
 * call. A wave closes before it would pass W7's owned-path bounds (count and
 * bytes: files, removals and the directories above them, up to the root) or
 * its byte budget; a file larger than the budget travels in a wave of its
 * own, and one streamed from a source is never held whole.
 *
 * Pipelining: one wave is in flight while the next one buffers. A wave
 * starts only once its predecessor has published, so a producer waits only
 * when it fills a second wave, and a failed wave is the last this writer
 * sends: the failure names its wave, and every later call rejects with it.
 * Waves publish in order, so a record written after another is durable only
 * if that one is: a completion marker written last proves what came before.
 *
 * Lost transport (lost-call.ts, the one policy for it): a wave whose call
 * failed before the session answered (isLostFencedCall), or that nothing
 * read for LOST_STREAM_STALL_MS before its end, or that stayed unanswered
 * LOST_STREAM_ANSWER_MS after it, is sent again after a backoff, at most
 * LOST_CALL_RESEND_BACKOFF_MS.length times. The abandoned attempt's stream
 * is errored so it reads nothing more, and every attempt carries its fence
 * (writer, wave, attempt): the session refuses an attempt older than one it
 * has seen, so a late original never applies over its re-send.
 * Re-sending is safe: a wave is the same paths and bytes, replacing. A shed
 * wave never ran; the platform's advice is not to retry an overloaded
 * object, but these waves are few and backed off, and npm measured the
 * re-send recover a 119-package install that otherwise lost 31 packages to
 * one shed. A wave the session answered (ok: false) is its verdict and is
 * never retried, nor is a wave with a streamed source (its source is spent).
 *
 * Fault domains: with `failPerOwner`, a record's `meta` is its owner (an
 * npm package), and a failed wave whose records all have owners fails those
 * owners (their later records reject, their buffered ones are not sent)
 * while the writer goes on for the rest. Otherwise, and for a failed wave
 * carrying anything unowned (a directory or removal record, the pin, a
 * record without meta), the failed wave is the last one sent.
 *
 * Admitting a record costs its own new directories, never a recount of the
 * wave: the owned set grows as records arrive, and a directory chain walk
 * stops at the first directory already owned (whose chain is owned).
 * Records may be written concurrently (an install writes several packages
 * at once): each is admitted and buffered in call order.
 *
 * Several writers may publish into one session at once (a clone's parallel
 * producers); each is its own stream, and the session takes them
 * concurrently.
 */

import {
  encodeWriteBatchStream,
  W7_MAX_OWNED_PATH_BYTES,
  W7_MAX_PATHS_PER_BATCH,
  type BatchChunkEntry,
  type BatchInodeEntry,
  type BatchStreamEntry,
  type BatchWritePayload,
} from './w7-frame.js';
import { CHUNK_SIZE } from './limits.js';
import {
  LOST_CALL_RESEND_BACKOFF_MS,
  LOST_STREAM_ANSWER_MS,
  LOST_STREAM_STALL_MS,
  isLostFencedCall,
  lostCallAttributes,
} from './lost-call.js';
import { disposeRpcResource } from './rpc-dispose.js';

/** Paths a wave holds back from W7's bound, for its pinned marker and the marker's directories. */
export const WAVE_PATHS = W7_MAX_PATHS_PER_BATCH - 8;
export const WAVE_PATH_BYTES = W7_MAX_OWNED_PATH_BYTES - 4 * 1024;
/** Buffered content bytes that close a wave. */
export const WAVE_BYTES = 4 * 1024 * 1024;


/**
 * Which attempt of which wave of which writer a stream is: the session
 * refuses an attempt older than one it has seen from the same writer, so an
 * attempt the writer gave up on never applies after its re-send.
 */
export interface WaveFence {
  writer: string;
  wave: number;
  attempt: number;
}

/** The supervisor surface a writer publishes through. */
export interface WaveSupervisor {
  writeBatchStream(stream: ReadableStream<Uint8Array>, fence: WaveFence): Promise<unknown>;
}

/** A published file as the session will stat it: what a warm index entry needs. */
export interface WaveFileReceipt {
  path: string;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
}

export interface WaveReport {
  wave: number;
  files: number;
  bytes: number;
  rpcWallMs: number;
  receipts: WaveFileReceipt[];
}

/** What one wave carried, for the caller's own view of the paths it published. */
export interface WaveCut<Meta> {
  wave: number;
  mtimeMs: number;
  /** Each file and link, with what its caller attached to the record. */
  files: { path: string; meta: Meta | undefined }[];
  directories: string[];
}

export interface WaveWriterOptions<Meta = undefined> {
  supervisor: WaveSupervisor;
  /**
   * The directory a wave publishes up to, inclusive: a record's directories
   * above it are not the writer's. Null publishes every ancestor.
   */
  root: string | null;
  /** An existing worktree: only directories strictly below it are published. */
  worktreeRoot?: string | null;
  /** Record paths are relative to it (joined with '/'); omitted, they are VFS paths. */
  base?: string;
  /** Wall-clock time (ms) after which no new wave starts. */
  deadline?: number | null;
  /** Every inode's mtime; omitted, each wave stamps the time it was cut. */
  mtimeMs?: number;
  /** A directory's mode, as the caller knows it; omitted or undefined, 0o755. */
  directoryMode?: (path: string) => number | undefined;
  /** Called synchronously as a wave is cut, before it is sent. */
  onCut?: (cut: WaveCut<Meta>) => void;
  /** Called once per published wave, in order. */
  onWave?: (report: WaveReport) => void;
  /** A record's `meta` names its owner, and a failed wave fails only the owners it carried. */
  failPerOwner?: boolean;
  /** The lost-call policy's timings (lost-call.ts); tests shorten them. */
  retry?: { backoffMs: readonly number[]; stallMs: number; answerDeadlineMs: number };
  /** Called before each re-send of a lost wave, with its lost-call attributes (lost-call.ts). */
  onResend?: (lost: Record<string, string | number>) => void;
}

export interface WaveStats {
  waves: number;
  files: number;
  bytes: number;
  rpcWallMs: number;
  maxRpcWallMs: number;
  producerWaitMs: number;
  /** Paths probed by ownership accounting: linear in records, never wave × records. */
  ownershipVisits: number;
  maxWavePaths: number;
  maxWaveBytes: number;
  /** Waves sent again after their transport was lost. */
  retries: number;
}

type BufferedRecord<Meta> =
  | { kind: 'file' | 'symlink'; mode: number; bytes: Uint8Array; meta: Meta | undefined }
  | { kind: 'stream'; mode: number; size: number; source: AsyncIterable<Uint8Array>; meta: Meta | undefined };

interface Pin {
  path: string;
  bytes: Uint8Array;
  durable: boolean;
}

interface Tally {
  pathCount: number;
  pathBytes: number;
}

export class WaveFailure extends Error {
  readonly wave: number;
  constructor(wave: number, cause: unknown) {
    super(`write wave ${wave} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'WaveFailure';
    this.wave = wave;
  }
}

const encoder = new TextEncoder();

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function waveResultError(result: unknown): Error | null {
  if (!isRecord(result)) return new Error('writeBatchStream failed: missing writeBatchStream result');
  if (result.ok === true) return null;
  const error = result.error;
  const detail = isRecord(error) && typeof error.message === 'string'
    ? error.message
    : 'missing writeBatchStream result';
  return new Error(
    'writeBatchStream failed after group ' + String(result.committedGroupSequence) +
      ' (' + String(result.committedPathCount) + ' committed paths): ' + detail,
  );
}

const RECEIPT_NUMBERS = ['ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'dev'] as const;

/** The session's stat of each published file, as it answered the wave. */
function parseReceipts(result: unknown): WaveFileReceipt[] {
  if (!isRecord(result) || result.receipts === undefined) return [];
  if (!Array.isArray(result.receipts)) throw new Error('writeBatchStream receipts are not a list');
  return result.receipts.map((value: unknown) => {
    if (!isRecord(value) || typeof value.path !== 'string') {
      throw new Error('writeBatchStream receipt is invalid');
    }
    const receipt: WaveFileReceipt = {
      path: value.path, ino: 0, mode: 0, size: 0, mtimeMs: 0, ctimeMs: 0, uid: 0, gid: 0, dev: 0,
    };
    for (const field of RECEIPT_NUMBERS) {
      const number = value[field];
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new Error(`writeBatchStream receipt for ${value.path} has no ${field}`);
      }
      receipt[field] = number;
    }
    return receipt;
  });
}

/**
 * A view of `bytes` that owns its buffer. The writer holds a record until
 * its wave publishes, and may send it again: a view would pin its whole
 * parent buffer for that long, and see whatever the caller wrote to it next.
 */
function ownedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
  return bytes.slice();
}

export class WaveWriter<Meta = undefined> {
  private readonly options: WaveWriterOptions<Meta>;
  private readonly records = new Map<string, BufferedRecord<Meta>>();
  private readonly directories = new Set<string>();
  private readonly deletes = new Set<string>();
  private bufferedBytes = 0;
  private symlinks = 0;
  /** Links in the wave in flight: sent, not yet published. */
  private inFlightSymlinks = 0;
  /** Every path the buffered wave publishes; a superset once a buffered record is removed. */
  private readonly owned = new Set<string>();
  /** The upward-closed part of `owned`: each one's chain, to the root, is owned too. */
  private readonly ownedDirectories = new Set<string>();
  private ownedPathBytes = 0;
  private pin: Pin | null = null;
  private inFlight: Promise<void> | null = null;
  private cutQueue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private failure: WaveFailure | null = null;
  /** Owners (records' `meta`) whose records a failed wave carried. */
  private readonly failedOwners = new Map<Meta, WaveFailure>();
  private readonly counters: WaveStats = {
    waves: 0,
    files: 0,
    bytes: 0,
    rpcWallMs: 0,
    maxRpcWallMs: 0,
    producerWaitMs: 0,
    ownershipVisits: 0,
    maxWavePaths: 0,
    maxWaveBytes: 0,
    retries: 0,
  };
  /** This writer, as its fences name it. */
  private readonly id = crypto.randomUUID();
  /** Mutations run one at a time, in call order: concurrent writers interleave by record. */
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(options: WaveWriterOptions<Meta>) {
    this.options = options;
  }

  // ── Records ──────────────────────────────────────────────────────────

  /** Run `mutate` once every mutation called before it has finished. */
  private exclusive<T>(mutate: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(mutate);
    this.mutations = run.catch(() => {});
    return run;
  }

  /**
   * A regular file. The writer takes `bytes`; a view sharing its buffer is
   * copied. `meta` rides with the record, back to the caller as it is cut.
   */
  file(path: string, mode: number, bytes: Uint8Array, meta?: Meta): Promise<void> {
    return this.exclusive(async () => {
      const key = this.key(path);
      this.assertOwnerHealthy(meta);
      await this.admit(key, bytes.byteLength, true);
      this.buffer(key, { kind: 'file', mode: mode & 0o111 ? 0o755 : 0o644, bytes: ownedBytes(bytes), meta });
      await this.cutIfFull();
    });
  }

  /** A symbolic link to `target`. */
  symlink(path: string, target: string, meta?: Meta): Promise<void> {
    return this.exclusive(async () => {
      const key = this.key(path);
      const bytes = encoder.encode(target);
      this.assertOwnerHealthy(meta);
      await this.admit(key, bytes.byteLength, true);
      this.buffer(key, { kind: 'symlink', mode: 0o777, bytes, meta });
      await this.cutIfFull();
    });
  }

  /**
   * A regular file of `size` bytes read from `chunks` as its wave drains:
   * the buffered wave is sent first, then this file travels alone, and the
   * call resolves once its source is consumed.
   */
  fileChunks(
    path: string,
    mode: number,
    size: number,
    chunks: AsyncIterable<Uint8Array>,
    meta?: Meta,
  ): Promise<void> {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`write wave: ${path}: invalid size ${size}`);
      const key = this.key(path);
      this.assertOwnerHealthy(meta);
      if (this.hasBuffered()) await this.cut();
      this.buffer(key, { kind: 'stream', mode: mode & 0o111 ? 0o755 : 0o644, size, source: chunks, meta });
      await this.cut();
      if (this.inFlight) await this.inFlight;
    });
  }

  /** A directory (an empty one, a gitlink): files' directories need no record. */
  directory(path: string): Promise<void> {
    return this.exclusive(async () => {
      const key = this.key(path);
      await this.admit(key, 0, true);
      this.directories.add(key);
      this.deletes.delete(key);
      const tally = this.tally();
      this.ownPath(key, true, tally);
      this.walkChain(key, true, tally);
      this.ownedPathBytes = tally.pathBytes;
      await this.cutIfFull();
    });
  }

  /**
   * Remove what stands at `path`, its subtree included. A buffered record at
   * the path is dropped; with `directory`, a buffered mkdir of it too.
   */
  remove(path: string, directory = false): Promise<void> {
    return this.exclusive(async () => {
      const key = this.key(path);
      await this.admit(key, 0, false);
      this.drop(key);
      if (directory) this.directories.delete(key);
      this.deletes.add(key);
      const tally = this.tally();
      this.ownPath(key, true, tally);
      this.ownedPathBytes = tally.pathBytes;
      await this.cutIfFull();
    });
  }

  /**
   * A file every wave re-asserts until a wave carrying it publishes (a
   * clone's ownership marker): parent directories publish independently of
   * files, so each wave leaves the marker's proof in place. `durable` says
   * these bytes are already published.
   */
  setPin(path: string, text: string, durable = false): void {
    this.pin = { path: this.key(path), bytes: encoder.encode(text), durable };
  }

  clearPin(path: string): void {
    if (this.pin && this.pin.path === this.key(path)) this.pin = null;
  }

  // ── The buffered wave, for a reader that must see it ─────────────────

  /** The bytes buffered at `path`, if a file or link is. */
  buffered(path: string): Uint8Array | undefined {
    const record = this.records.get(path);
    return record && record.kind !== 'stream' ? record.bytes : undefined;
  }

  /** The buffered file or link at `path`: its kind, size and the caller's `meta`. */
  bufferedRecord(path: string): { kind: 'file' | 'symlink'; size: number; meta: Meta | undefined } | undefined {
    const record = this.records.get(path);
    if (record === undefined) return undefined;
    return record.kind === 'stream'
      ? { kind: 'file', size: record.size, meta: record.meta }
      : { kind: record.kind, size: record.bytes.byteLength, meta: record.meta };
  }

  isBufferedDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  isBufferedDelete(path: string): boolean {
    return this.deletes.has(path);
  }

  bufferedPaths(): { files: Iterable<string>; directories: Iterable<string>; deletes: Iterable<string> } {
    return { files: this.records.keys(), directories: this.directories, deletes: this.deletes };
  }

  /** Whether a link is buffered or in flight: written, not yet published. */
  get hasUnpublishedSymlinks(): boolean {
    return this.symlinks > 0 || this.inFlightSymlinks > 0;
  }

  // ── Publication ──────────────────────────────────────────────────────

  /** Every record written before this call is durable; rejects with the first failed wave. */
  flush(): Promise<void> {
    return this.exclusive(async () => {
      await this.cut();
      if (this.inFlight) await this.inFlight;
      this.assertHealthy();
    });
  }

  /** The wave in flight has settled; nothing new is cut. */
  async settled(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.assertHealthy();
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  /** The failure of the wave that carried `owner`'s records, if one failed. */
  failureOf(owner: Meta): WaveFailure | undefined {
    return this.failedOwners.get(owner);
  }

  private assertOwnerHealthy(owner: Meta | undefined): void {
    this.assertHealthy();
    if (owner === undefined) return;
    const failure = this.failedOwners.get(owner);
    if (failure) throw failure;
  }

  get failed(): WaveFailure | null {
    return this.failure;
  }

  stats(): WaveStats {
    return { ...this.counters };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private key(path: string): string {
    return this.options.base ? this.options.base + '/' + path : path;
  }

  private tally(): Tally {
    return { pathCount: this.owned.size, pathBytes: this.ownedPathBytes };
  }

  private hasBuffered(): boolean {
    return this.records.size > 0 || this.directories.size > 0 || this.deletes.size > 0;
  }

  private ownPath(path: string, admit: boolean, tally: Tally): void {
    this.counters.ownershipVisits++;
    if (this.owned.has(path)) return;
    tally.pathCount++;
    tally.pathBytes += encoder.encode(path).byteLength;
    if (admit) this.owned.add(path);
  }

  /** collectDirectoryPaths' chain from `path` upward, to the first directory already owned. */
  private walkChain(path: string, admit: boolean, tally: Tally): void {
    const { root, worktreeRoot = null } = this.options;
    let current = path;
    while (current) {
      if (root && current !== root && !current.startsWith(root + '/')) break;
      if (worktreeRoot !== null && !current.startsWith(worktreeRoot + '/')) break;
      this.counters.ownershipVisits++;
      if (this.ownedDirectories.has(current)) break;
      if (admit) this.ownedDirectories.add(current);
      if (!this.owned.has(current)) {
        tally.pathCount++;
        tally.pathBytes += encoder.encode(current).byteLength;
        if (admit) this.owned.add(current);
      }
      if (current === root) break;
      current = parentOf(current);
    }
  }

  /** Cut waves until `path` (with its chain) and `bytes` fit beside what is buffered. */
  private async admit(path: string, bytes: number, withParents: boolean): Promise<void> {
    this.assertHealthy();
    while (this.hasBuffered()) {
      const tally = this.tally();
      this.ownPath(path, false, tally);
      if (withParents) this.walkChain(parentOf(path), false, tally);
      const replaced = this.records.get(path);
      const replacedBytes = replaced && replaced.kind !== 'stream' ? replaced.bytes.byteLength : 0;
      if (this.bufferedBytes - replacedBytes + bytes <= WAVE_BYTES &&
          tally.pathCount < WAVE_PATHS &&
          tally.pathBytes < WAVE_PATH_BYTES) return;
      await this.cut();
    }
    const tally = this.tally();
    this.ownPath(path, false, tally);
    if (withParents) this.walkChain(parentOf(path), false, tally);
    if (tally.pathCount > W7_MAX_PATHS_PER_BATCH) {
      throw new Error('write wave exceeds ' + W7_MAX_PATHS_PER_BATCH + ' owned paths');
    }
    if (tally.pathBytes > W7_MAX_OWNED_PATH_BYTES) {
      throw new Error('write wave exceeds ' + W7_MAX_OWNED_PATH_BYTES + ' owned path bytes');
    }
  }

  private buffer(path: string, record: BufferedRecord<Meta>): void {
    this.drop(path);
    this.deletes.delete(path);
    this.records.set(path, record);
    if (record.kind === 'symlink') this.symlinks++;
    if (record.kind !== 'stream') this.bufferedBytes += record.bytes.byteLength;
    const tally = this.tally();
    this.ownPath(path, true, tally);
    this.walkChain(parentOf(path), true, tally);
    this.ownedPathBytes = tally.pathBytes;
  }

  private drop(path: string): void {
    const previous = this.records.get(path);
    if (!previous) return;
    if (previous.kind === 'symlink') this.symlinks--;
    if (previous.kind !== 'stream') this.bufferedBytes -= previous.bytes.byteLength;
    this.records.delete(path);
  }

  private async cutIfFull(): Promise<void> {
    if (this.owned.size >= WAVE_PATHS ||
        this.ownedPathBytes >= WAVE_PATH_BYTES ||
        this.bufferedBytes >= WAVE_BYTES) {
      await this.cut();
    }
  }

  /**
   * Send the buffered wave once the one in flight has published. Cuts are
   * serialised, so at most one wave is in flight and one buffers.
   */
  private cut(): Promise<void> {
    const run = this.cutQueue.then(() => this.cutNow());
    this.cutQueue = run.catch(() => {});
    return run;
  }

  private async cutNow(): Promise<void> {
    if (this.inFlight) {
      const waitStarted = Date.now();
      await this.inFlight.catch(() => {});
      this.counters.producerWaitMs += Date.now() - waitStarted;
    }
    this.assertHealthy();
    // A wave that failed took its owners with it: their records still
    // buffered are not sent (an owner's later record must not publish
    // without its earlier ones).
    if (this.failedOwners.size > 0) {
      for (const [path, record] of [...this.records]) {
        if (record.meta !== undefined && this.failedOwners.has(record.meta)) this.drop(path);
      }
    }
    this.bufferPin();
    if (!this.hasBuffered()) return;
    // A wave already sent can still publish after the deadline; none starts after it.
    const { deadline = null } = this.options;
    if (deadline !== null && Date.now() >= deadline) {
      throw new Error('phase deadline reached before starting a new write wave');
    }
    const wave = ++this.sequence;
    const sentPin = this.pin;
    const mtime = this.options.mtimeMs ?? Date.now();
    const files: { path: string; meta: Meta | undefined }[] = [];
    const directories = this.publishedDirectories();
    const inodes: BatchInodeEntry[] = [];
    const chunks: BatchChunkEntry[] = [];
    const streams: BatchStreamEntry[] = [];
    let waveBytes = 0;
    for (const dir of directories) {
      inodes.push({
        path: dir, parentPath: parentOf(dir), kind: 'directory', isDir: true,
        size: 0, mtime, mode: this.options.directoryMode?.(dir) ?? 0o755, chunkCount: 0,
      });
    }
    for (const [path, record] of this.records) {
      files.push({ path, meta: record.meta });
      const size = record.kind === 'stream' ? record.size : record.bytes.byteLength;
      const chunkCount = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
      waveBytes += size;
      inodes.push({
        path, parentPath: parentOf(path),
        kind: record.kind === 'symlink' ? 'symlink' : 'file',
        isDir: false, size, mtime, mode: record.mode, chunkCount,
      });
      if (record.kind === 'stream') {
        streams.push({ path, source: record.source });
        continue;
      }
      // Views: the encoder copies a chunk's bytes into the buffers it
      // enqueues, so the record's bytes stay whole for a re-send.
      const data = record.bytes;
      for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
        chunks.push({ path, chunkId, data: data.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE) });
      }
    }
    const deletePaths = this.deletes.size > 0 ? [...this.deletes] : undefined;
    const ownedOnly = this.options.failPerOwner === true
      && files.length > 0
      && files.every((file) => file.meta !== undefined)
      && this.directories.size === 0
      && this.deletes.size === 0
      && (sentPin === null || !this.records.has(sentPin.path));
    const paths = this.owned.size;
    const symlinks = this.symlinks;
    this.options.onCut?.({ wave, mtimeMs: mtime, files, directories });
    // The payload holds the wave's bytes now; the buffer lets go of them so
    // the facet holds one copy while the stream drains.
    this.records.clear();
    this.directories.clear();
    this.deletes.clear();
    this.owned.clear();
    this.ownedDirectories.clear();
    this.ownedPathBytes = 0;
    this.bufferedBytes = 0;
    this.symlinks = 0;
    this.counters.maxWavePaths = Math.max(this.counters.maxWavePaths, paths);
    this.counters.maxWaveBytes = Math.max(this.counters.maxWaveBytes, waveBytes);

    this.inFlightSymlinks = symlinks;
    const sentAt = Date.now();
    const published = this.send({ inodes, chunks, deletePaths, streams }, wave).then((result) => {
      try {
        const error = waveResultError(result);
        if (error) throw error;
        const rpcWallMs = Date.now() - sentAt;
        if (sentPin !== null && this.pin === sentPin) sentPin.durable = true;
        this.inFlightSymlinks = 0;
        this.counters.waves++;
        this.counters.files += files.length;
        this.counters.bytes += waveBytes;
        this.counters.rpcWallMs += rpcWallMs;
        this.counters.maxRpcWallMs = Math.max(this.counters.maxRpcWallMs, rpcWallMs);
        this.options.onWave?.({ wave, files: files.length, bytes: waveBytes, rpcWallMs, receipts: parseReceipts(result) });
      } finally {
        disposeRpcResource(result);
      }
    }).catch((error: unknown) => {
      const failure = error instanceof WaveFailure ? error : new WaveFailure(wave, error);
      this.inFlightSymlinks = 0;
      // A wave whose every record has an owner fails those owners; the
      // writer goes on for the rest. Anything unowned in it (a directory,
      // a removal, the pin, a record without meta) fails the writer.
      if (ownedOnly) {
        for (const file of files) if (file.meta !== undefined) this.failedOwners.set(file.meta, failure);
        return;
      }
      if (this.failure === null) this.failure = failure;
      throw this.failure;
    }).finally(() => {
      if (this.inFlight === published) this.inFlight = null;
    });
    // Its failure reaches whoever waits next; it is never unobserved.
    published.catch(() => {});
    this.inFlight = published;
  }

  /**
   * Send one wave, again while its transport is lost (see the module's
   * comment), and answer with what the session answered.
   */
  private async send(payload: BatchWritePayload, wave: number): Promise<unknown> {
    const { backoffMs, stallMs, answerDeadlineMs } = this.options.retry
      ?? { backoffMs: LOST_CALL_RESEND_BACKOFF_MS, stallMs: LOST_STREAM_STALL_MS, answerDeadlineMs: LOST_STREAM_ANSWER_MS };
    for (let attempt = 0; ; attempt++) {
      const attemptStream = abortable(encodeWriteBatchStream(payload), stallMs, answerDeadlineMs);
      const fence: WaveFence = { writer: this.id, wave, attempt: attempt + 1 };
      const answer = this.options.supervisor.writeBatchStream(attemptStream.stream, fence);
      try {
        return await Promise.race([answer, attemptStream.lost]);
      } catch (error) {
        const lost = error instanceof WaveLost || isLostFencedCall(error);
        if (!lost || (payload.streams?.length ?? 0) > 0 || attempt >= backoffMs.length) throw error;
        // The abandoned attempt can read nothing more, and its late answer is dropped.
        attemptStream.abort(error);
        answer.then(disposeRpcResource, () => {});
        this.counters.retries++;
        this.options.onResend?.(lostCallAttributes({
          operation: 'writeBatchStream',
          attempt: attempt + 1,
          of: backoffMs.length,
          reason: error instanceof Error ? error.message : String(error),
        }));
        const base = backoffMs[attempt]!;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(base * (0.75 + Math.random() * 0.5)))));
      } finally {
        attemptStream.settle();
      }
    }
  }

  /** The directories the buffered records publish, shallowest first. */
  private publishedDirectories(): string[] {
    const dirs = new Set<string>();
    const { root, worktreeRoot = null } = this.options;
    const collect = (path: string): void => {
      let current = path;
      while (current) {
        if (root && current !== root && !current.startsWith(root + '/')) break;
        if (worktreeRoot !== null && !current.startsWith(worktreeRoot + '/')) break;
        if (dirs.has(current)) break;
        dirs.add(current);
        if (current === root) break;
        current = parentOf(current);
      }
    };
    for (const path of this.records.keys()) collect(parentOf(path));
    for (const dir of this.directories) collect(dir);
    return [...dirs].sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length;
      return depth || (left < right ? -1 : left > right ? 1 : 0);
    });
  }

  private bufferPin(): void {
    const pin = this.pin;
    if (!pin) return;
    // A durable pin asserts presence, not churn: re-writing identical bytes
    // re-arms the receiver's content GC for no change. Re-buffer only when a
    // buffered record claims the path.
    if (pin.durable && !this.records.has(pin.path) && !this.deletes.has(pin.path)) return;
    this.buffer(pin.path, { kind: 'file', mode: 0o644, bytes: pin.bytes.slice(), meta: undefined });
  }
}

/** An attempt the session never read or never answered: its call did not arrive, or its answer was lost. */
class WaveLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaveLost';
  }
}

/**
 * One attempt's stream, watched from the writer's side: `lost` rejects when
 * nothing has read it for `stallMs` before it ended, or no answer came
 * `answerDeadlineMs` after it ended; `abort` errors it so the attempt reads
 * nothing more.
 */
function abortable(stream: ReadableStream<Uint8Array>, stallMs: number, answerDeadlineMs: number): {
  stream: ReadableStream<Uint8Array>;
  lost: Promise<never>;
  abort(reason: unknown): void;
  settle(): void;
} {
  const reader = stream.getReader();
  let target: ReadableByteStreamController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let declareLost: (error: WaveLost) => void = () => {};
  const lost = new Promise<never>((_, reject) => { declareLost = reject; });
  lost.catch(() => {});
  const watch = (ms: number, message: string): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => declareLost(new WaveLost(message)), ms);
  };
  watch(stallMs, `writeBatchStream stalled: nothing read it for ${stallMs} ms`);
  const source: UnderlyingByteSource = {
    type: 'bytes',
    start(controller) {
      target = controller;
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        watch(answerDeadlineMs, `writeBatchStream unanswered ${answerDeadlineMs} ms after its stream ended`);
        controller.close();
        return;
      }
      watch(stallMs, `writeBatchStream stalled: nothing read it for ${stallMs} ms`);
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  };
  return {
    stream: new ReadableStream<Uint8Array>(source as never, { highWaterMark: 0 }),
    lost,
    abort(reason) {
      try { target?.error(reason); } catch { /* already closed */ }
      reader.cancel(reason).catch(() => {});
    },
    settle() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export function createWaveWriter<Meta = undefined>(options: WaveWriterOptions<Meta>): WaveWriter<Meta> {
  return new WaveWriter(options);
}
