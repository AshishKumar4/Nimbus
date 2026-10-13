/**
 * A wasm bash process's unwind arena, and the setjmp captures it holds, for
 * their whole lifetime (bash-runner@4).
 *
 * Every suspension unwinds the whole stack into the arena (asyncify):
 * setjmp(env)'s, and a blocking call's, a fork's or a longjmp's. A setjmp's
 * stays where it was unwound, as a capture, and longjmp(env, v) rewinds it.
 * Captures are packed from the arena's base; every other unwind goes above
 * the last of them (top), and is discarded or rewound before another starts.
 *
 * A capture lives exactly as long as a buffer that names it can still be
 * jumped through. bash copies jmp_bufs by value (saved around eval, source
 * and traps), and the bash 5.2.37-4 build routes every such copy through
 * nimbus_procenv.copy and every end of a saved copy through
 * nimbus_procenv.drop (wasm/bash/patches/procenv.patch). So the store keeps a
 * registry, buffer address → capture, and a count per capture of the buffers
 * that name it. A buffer on the stack ends without a hook, when its frame
 * returns or a longjmp skips it: below the stack pointer, it is dead
 * (sweep). A capture no buffer names is freed, and its space is taken back
 * from the top, or by sliding the live captures down when an unwind needs
 * the room. No memory is scanned.
 *
 * A jmp_buf as this store writes it: word 0 names the capture (TAG | a
 * 16-bit id), word 1 is setjmp's return value (the only word nimbus-proc.c
 * reads), word 2 the capture's generation, which no other capture of the
 * process shares. A buffer whose words no longer name its capture was
 * written over without a hook, and stops counting. A longjmp through a
 * buffer naming no capture held is refused, loudly.
 */

const TAG = 0xfb5a0000;
/** The arena: as large as the 8 MiB main buffer and the 32 × 256 KiB slots it replaces. */
export const ARENA_SIZE = 16 << 20;
/** What every unwind is given at least. bash's deepest unwind seen is ~240 KiB (12 nested function calls). */
const MIN_ROOM = 2 << 20;

/** Where a module's shadow stack is: [low, high), from its __data_end and __heap_base (data first, as wasm-ld lays it out). */
export interface StackBounds {
  readonly low: number;
  readonly high: number;
}

/** What the store reports into the session's stats. */
export interface CaptureStats {
  /** The largest unwind, in bytes. */
  mainHi: number;
  /** The most of the arena captures filled. */
  captureBytesHi: number;
  /** Times live captures were slid down to make room. */
  captureCompactions: number;
  /** The most captures one process held at once. */
  captureLiveHi: number;
}

/** One setjmp's unwound stack: asyncify's header at `at`, `length` bytes after it. */
interface Capture {
  at: number;
  readonly length: number;
  /** The jmp_buf setjmp was given, which its landing reads its return value from. */
  readonly env: number;
  readonly generation: number;
  /** The stack pointer of setjmp's caller, which a longjmp to it restores. */
  readonly sp: number;
  /** Registered buffers that name it. */
  refs: number;
}

/** The capture a longjmp resolved, ready to rewind: where it is, and the stack pointer its landing runs with. */
export interface RewindTarget {
  readonly at: number;
  readonly sp: number;
}

const above = (at: number, length: number): number => (at + 8 + length + 15) & ~15;

export class CaptureStore {
  readonly base: number;
  readonly size: number;
  readonly #stack: StackBounds;
  readonly #captures: Map<number, Capture>;
  /** Registered buffer address → the id of the capture it names. */
  readonly #names: Map<number, number>;
  #top: number;
  #nextId = 1;
  #nextGeneration = 1;

  /** The arena `size` bytes from `base`, empty, or a copy of what `from` holds (a fork's). */
  constructor(stack: StackBounds, base: number, size: number, from?: CaptureStore) {
    this.#stack = stack; this.base = base; this.size = size;
    this.#captures = new Map();
    if (from === undefined) { this.#names = new Map(); this.#top = base; return; }
    this.#names = new Map(from.#names);
    this.#top = from.#top;
    for (const [id, capture] of from.#captures) this.#captures.set(id, { ...capture });
    this.#nextId = from.#nextId; this.#nextGeneration = from.#nextGeneration;
  }

  /** A forked child's: the same captures, buffers and counts, at the same places in the child's copy of the memory. */
  fork(): CaptureStore {
    return new CaptureStore(this.#stack, this.base, this.size, this);
  }

  /** An empty store for the same arena: an exited process's instance, kept for reuse, holds no captures. */
  emptied(): CaptureStore {
    return new CaptureStore(this.#stack, this.base, this.size);
  }

  /** The module's shadow stack, which every store of its processes shares. */
  get stackBounds(): StackBounds { return this.#stack; }

  /** Where the next unwind goes, and where the one pending is. */
  get top(): number { return this.#top; }

  /** What of the arena a fork copies: each live capture's bytes, and the pending unwind's up to `unwound`. */
  liveRanges(unwound: number): Array<readonly [number, number]> {
    const ranges: Array<readonly [number, number]> = [];
    for (const capture of this.#captures.values()) ranges.push([capture.at, capture.at + 8 + capture.length]);
    ranges.push([this.#top, Math.min(Math.max(unwound, this.#top + 8), this.base + this.size)]);
    return ranges;
  }

  /**
   * The header of an unwind about to start, at top, with every byte to the
   * arena's end to fill: made room for first by sliding the live captures
   * down when less than MIN_ROOM is left. Only between a rewind's end and
   * the next unwind, when captures are the only unwound data.
   */
  unwindAt(memory: WebAssembly.Memory, stats: CaptureStats, pid: number): number {
    if (this.base + this.size - this.#top < MIN_ROOM) { this.#compact(memory); stats.captureCompactions++; }
    if (this.base + this.size - this.#top < MIN_ROOM) {
      throw new Error(`bash-runner: pid ${pid}'s live setjmp captures fill its ${this.size >> 20} MiB arena (a recursion too deep?)`);
    }
    const view = new DataView(memory.buffer);
    view.setUint32(this.#top, this.#top + 8, true);
    view.setUint32(this.#top + 4, this.base + this.size, true);
    return this.#top;
  }

  /** Before each hook's effect: let go of the buffers that ended without one. `sp`: the current stack pointer. */
  sweep(memory: WebAssembly.Memory, sp: number): void {
    const view = new DataView(memory.buffer);
    for (const [at, id] of this.#names) {
      if ((at >= this.#stack.low && at < sp) || !this.#holds(view, at, id)) this.#unname(at);
    }
  }

  /** setjmp(env) is about to capture: env stops naming what it named. */
  setting(env: number): void {
    if (this.#names.has(env)) this.#unname(env);
  }

  /**
   * Keep the stack setjmp(env) just unwound at top as a capture: write env
   * to name it, and count env. `sp`: setjmp's caller's stack pointer.
   * Answers where the capture is, ready to rewind.
   */
  take(memory: WebAssembly.Memory, env: number, sp: number, stats: CaptureStats, pid: number): number {
    const view = new DataView(memory.buffer);
    const at = this.#top, length = view.getUint32(at, true) - (at + 8);
    for (let tried = 0; this.#captures.has(this.#nextId); tried++) {
      if (tried === 0xffff) throw new Error(`bash-runner: pid ${pid} holds a setjmp capture under every id`);
      this.#nextId = this.#nextId === 0xffff ? 1 : this.#nextId + 1;
    }
    if (this.#nextGeneration > 0xffffffff) throw new Error(`bash-runner: pid ${pid} has used every setjmp generation`);
    const id = this.#nextId, generation = this.#nextGeneration++;
    this.#nextId = id === 0xffff ? 1 : id + 1;
    view.setUint32(env, (TAG | id) >>> 0, true);
    view.setInt32(env + 4, 0, true);
    view.setUint32(env + 8, generation, true);
    const capture: Capture = { at, length, env, generation, sp, refs: 1 };
    this.#captures.set(id, capture);
    this.#names.set(env, id);
    this.#top = above(at, length);
    if (length > stats.mainHi) stats.mainHi = length;
    if (this.#top - this.base > stats.captureBytesHi) stats.captureBytesHi = this.#top - this.base;
    if (this.#captures.size > stats.captureLiveHi) stats.captureLiveHi = this.#captures.size;
    return this.#ready(view, capture);
  }

  /** nimbus_procenv.copy(dst, src), after the copy: dst names what src named. */
  copied(memory: WebAssembly.Memory, dst: number, src: number): void {
    if (this.#names.has(dst)) this.#unname(dst);
    const id = this.#names.get(src);
    if (id === undefined || !this.#holds(new DataView(memory.buffer), dst, id)) return;
    this.#names.set(dst, id);
    const capture = this.#captures.get(id);
    if (capture !== undefined) capture.refs++;
  }

  /** nimbus_procenv.drop(at): the saved buffer at `at` ends. */
  dropped(at: number): void {
    if (this.#names.has(at)) this.#unname(at);
  }

  /**
   * The capture longjmp(env, value) jumps to, its landing given `value`,
   * made ready to rewind; after the current stack was unwound and
   * discarded. The buffers in the frames the jump skips (on the stack below
   * the capture's stack pointer) end here. Refused, loudly, when env names
   * no capture held.
   */
  jump(memory: WebAssembly.Memory, env: number, value: number, pid: number): RewindTarget {
    const view = new DataView(memory.buffer);
    const tag = view.getUint32(env, true), generation = view.getUint32(env + 8, true);
    const capture = (tag & 0xffff0000) >>> 0 === TAG ? this.#captures.get(tag & 0xffff) : undefined;
    if (capture === undefined || capture.generation !== generation) {
      throw new Error(`bash-runner: pid ${pid} longjmp'd through a jmp_buf whose setjmp it no longer holds (0x${tag.toString(16)}, generation ${generation})`);
    }
    // Freed by this, the capture's bytes stay as they are until the landing: no unwind comes before it.
    this.sweep(memory, capture.sp);
    view.setInt32(capture.env + 4, value, true);
    return { at: this.#ready(view, capture), sp: capture.sp };
  }

  /** Its header at its end: a rewind reads the stack back from there, and leaves the bytes as they were. */
  #ready(view: DataView, capture: Capture): number {
    const end = capture.at + 8 + capture.length;
    view.setUint32(capture.at, end, true);
    view.setUint32(capture.at + 4, end, true);
    return capture.at;
  }

  #holds(view: DataView, at: number, id: number): boolean {
    const capture = this.#captures.get(id);
    return capture !== undefined && view.getUint32(at, true) === ((TAG | id) >>> 0) && view.getUint32(at + 8, true) === capture.generation;
  }

  /** `at` stops naming its capture; a capture no buffer names is freed, and the top comes down past freed space. */
  #unname(at: number): void {
    const id = this.#names.get(at);
    this.#names.delete(at);
    if (id === undefined) return;
    const capture = this.#captures.get(id);
    if (capture === undefined || --capture.refs > 0) return;
    this.#captures.delete(id);
    if (above(capture.at, capture.length) !== this.#top) return;
    let top = this.base;
    for (const live of this.#captures.values()) top = Math.max(top, above(live.at, live.length));
    this.#top = top;
  }

  /** Slide the live captures down over freed space, in address order; asyncify's data holds no address of its own, so a capture moves freely. */
  #compact(memory: WebAssembly.Memory): void {
    const bytes = new Uint8Array(memory.buffer);
    let to = this.base;
    for (const capture of [...this.#captures.values()].sort((a, b) => a.at - b.at)) {
      if (capture.at !== to) bytes.copyWithin(to, capture.at, capture.at + 8 + capture.length);
      capture.at = to;
      to = above(to, capture.length);
    }
    this.#top = to;
  }
}
