/**
 * N17: lazy hydration in an import window (model Nimbus.Vfs.Hydration,
 * N17-001; CUTOVER.md v3 §3).
 *
 * A lazy import (SqliteVFS.importPage with `lazy`) commits its rows at once
 * and leaves the chunks it did not carry pending. This job brings their bytes
 * from the embedder's `fetch(hashes)`, front of the queue first, one step at
 * a time, and decides who waits for what:
 * - an asynchronous read of a path with pending chunks moves them to the front
 *   and waits until the path is local (then it reads the bytes);
 * - a synchronous read of one answers EIO naming the path (the engine's
 *   pendingChunkError) and moves its chunks to the front;
 * - a launch that reads synchronously (WASI) names the paths it needs; their
 *   chunks move to the front, in that order, and its gate opens when every
 *   one is local, or fails with EIO naming the first that is not once the
 *   deadline passes. A launch naming nothing pending opens at once.
 * Hydration is monotone: a local chunk never becomes pending again.
 */

import { HYDRATION_DEADLINE_MS } from '@nimbus-sh/platform/limits.js';
import type { VfsExportChunk } from '../vfs/sqlite-vfs.js';

/** What the job needs of the engine. */
export interface HydrationStore {
  pendingChunksOf(path: string): string[];
  /** Which of `hashes` are still pending. */
  pendingOf(hashes: readonly string[]): string[];
  hydrateChunks(chunks: Iterable<VfsExportChunk>): string[];
}

export interface HydratorOptions {
  /** The embedder's fetch: the bytes of `hashes`, each re-hashed on store. */
  fetch: (hashes: string[]) => Promise<Iterable<VfsExportChunk>>;
  /** Hashes one step asks for. The model's step is one. */
  batch?: number;
  deadlineMs?: number;
  now?: () => number;
  setTimer?: (fire: () => void, ms: number) => unknown;
  /**
   * 'background' (the default) runs steps whenever there is work; 'manual'
   * leaves every step to the caller (the model's schedule is the
   * environment's).
   */
  schedule?: 'background' | 'manual';
}

export type GateState = 'waiting' | 'ok' | { error: 'EIO'; path: string };

interface Gate {
  named: string[];
  opened: number;
  state: GateState;
  settle: (() => void)[];
}

export class Hydrator {
  private queue: string[] = [];
  private readonly waiters: { path: string; resolve: () => void }[] = [];
  private readonly gates: Gate[] = [];
  private readonly batch: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fire: () => void, ms: number) => unknown;
  private running: Promise<void> | null = null;

  constructor(private readonly store: HydrationStore, private readonly options: HydratorOptions) {
    this.batch = Math.max(1, options.batch ?? 64);
    this.deadlineMs = options.deadlineMs ?? HYDRATION_DEADLINE_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fire, ms) => setTimeout(fire, ms));
  }

  /** What a lazy import left pending, in the order it named them. */
  enqueue(hashes: Iterable<string>): void {
    const queued = new Set(this.queue);
    for (const hash of hashes) if (!queued.has(hash)) { this.queue.push(hash); queued.add(hash); }
  }

  /** The hashes still to hydrate, front first. */
  queued(): readonly string[] {
    return this.queue;
  }

  /** Whether `path` has every chunk local. */
  isLocal(path: string): boolean {
    return this.store.pendingChunksOf(path).length === 0;
  }

  /**
   * One step of the job: fetch the hashes at the front, store them, then
   * hand waiting readers whose path is now local their turn and settle the
   * gates. False when there is nothing to do.
   */
  async step(): Promise<boolean> {
    if (this.queue.length === 0) return false;
    const front = this.queue.slice(0, Math.min(this.batch, this.queue.length));
    const taken = this.store.pendingOf([...new Set(front)]);
    if (taken.length > 0) this.store.hydrateChunks(await this.options.fetch(taken));
    // The entries taken leave the queue, whatever came back (a hash the fetch
    // did not return is asked again by the next reader that meets it). By
    // entry, not by position: a read may have reordered the queue during the
    // fetch. A hash queued twice is a no-op the second time.
    for (const hash of front) {
      const at = this.queue.indexOf(hash);
      if (at !== -1) this.queue.splice(at, 1);
    }
    this.resume();
    this.settle();
    return true;
  }

  /** Run steps in the background until the queue is empty. */
  run(): Promise<void> {
    if (this.options.schedule === 'manual') return Promise.resolve();
    if (this.running === null) {
      this.running = (async () => {
        try {
          while (await this.step()) { /* next step */ }
        } finally {
          this.running = null;
        }
      })();
    }
    return this.running;
  }

  /** An asynchronous read of `path`: resolves once its bytes are local. */
  whenLocal(path: string): Promise<void> {
    const need = this.store.pendingChunksOf(path);
    if (need.length === 0) return Promise.resolve();
    this.prioritize(need);
    const waiting = new Promise<void>((resolve) => { this.waiters.push({ path, resolve }); });
    void this.run();
    return waiting;
  }

  /** A synchronous read of `path` met its pending chunks: they go first. */
  missed(path: string): void {
    const need = this.store.pendingChunksOf(path);
    if (need.length === 0) return;
    this.prioritize(need);
    void this.run();
  }

  /**
   * A launch that reads `named` synchronously. Resolves once every one is
   * local; rejects with EIO naming the first that is not, at the deadline.
   */
  gate(named: string[]): Promise<void> {
    this.prioritize(named.flatMap((path) => this.store.pendingChunksOf(path)));
    const gate: Gate = { named, opened: this.now(), state: 'waiting', settle: [] };
    this.gates.push(gate);
    const decided = new Promise<void>((resolve, reject) => {
      gate.settle.push(() => {
        if (gate.state === 'ok') resolve();
        else if (typeof gate.state === 'object') {
          reject(Object.assign(
            new Error(`EIO: hydration of ${gate.state.path} did not complete in ${Math.round(this.deadlineMs / 1000)}s`),
            { code: 'EIO', path: gate.state.path },
          ));
        }
      });
    });
    this.settle();
    if (gate.state === 'waiting') {
      this.setTimer(() => this.settle(), this.deadlineMs);
      void this.run();
    }
    return decided;
  }

  /** Every gate so far, in order: for diagnostics. */
  gateStates(): GateState[] {
    return this.gates.map((gate) => gate.state);
  }

  /** Settle every pending gate: open when all its paths are local, failed once its deadline passed. */
  settle(): void {
    const now = this.now();
    for (const gate of this.gates) {
      if (gate.state !== 'waiting') continue;
      const missing = gate.named.find((path) => !this.isLocal(path));
      if (missing === undefined) gate.state = 'ok';
      else if (gate.opened + this.deadlineMs <= now) gate.state = { error: 'EIO', path: missing };
      else continue;
      for (const settle of gate.settle) settle();
    }
  }

  private resume(): void {
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i]!;
      if (this.isLocal(waiter.path)) {
        this.waiters.splice(i, 1);
        waiter.resolve();
      } else i++;
    }
  }

  /** Move `hashes` (still queued) to the front, in their order, duplicates kept. */
  private prioritize(hashes: string[]): void {
    const queued = new Set(this.queue);
    const front = hashes.filter((hash) => queued.has(hash));
    if (front.length === 0) return;
    const moved = new Set(front);
    this.queue = [...front, ...this.queue.filter((hash) => !moved.has(hash))];
  }
}
