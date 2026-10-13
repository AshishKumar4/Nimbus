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
 * (sweep, at every hook, over the stack's buffers only). A buffer written
 * over without a hook no longer holds its capture's words; that only keeps
 * the capture longer, so it is looked for only when an unwind needs room.
 * A capture no buffer names is freed, and its space is taken back from the
 * top, or by sliding the live captures down once freed space below the top
 * passes PACK_SLACK, so the arena a process touches stays near what is live
 * (fresh pages and cold lines are most of a capture's cost). No memory is
 * scanned.
 *
 * A jmp_buf as this store writes it: word 0 names the capture (TAG | a
 * 16-bit id), word 1 is setjmp's return value (the only word nimbus-proc.c
 * reads), word 2 the capture's generation, which no other capture of the
 * process shares. A buffer whose words no longer name its capture was
 * written over without a hook, and stops counting. A longjmp through a
 * buffer naming no capture held is refused, loudly.
 */
/** The arena: as large as the 8 MiB main buffer and the 32 × 256 KiB slots it replaces. */
export declare const ARENA_SIZE: number;
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
/** The capture a longjmp resolved, ready to rewind: where it is, and the stack pointer its landing runs with. */
export interface RewindTarget {
    readonly at: number;
    readonly sp: number;
}
export declare class CaptureStore {
    #private;
    readonly base: number;
    readonly size: number;
    /** The arena `size` bytes from `base`, empty, or a copy of what `from` holds (a fork's). */
    constructor(stack: StackBounds, base: number, size: number, from?: CaptureStore);
    /** A forked child's: the same captures, buffers and counts, at the same places in the child's copy of the memory. */
    fork(): CaptureStore;
    /** An empty store for the same arena: an exited process's instance, kept for reuse, holds no captures. */
    emptied(): CaptureStore;
    /** The module's shadow stack, which every store of its processes shares. */
    get stackBounds(): StackBounds;
    /** Where the next unwind goes, and where the one pending is. */
    get top(): number;
    /** What of the arena a fork copies: each live capture's bytes, and the pending unwind's up to `unwound`. */
    liveRanges(unwound: number): Array<readonly [number, number]>;
    /**
     * The header of an unwind about to start, at top, with every byte to the
     * arena's end to fill: made room for first by sliding the live captures
     * down when less than MIN_ROOM is left. Only between a rewind's end and
     * the next unwind, when captures are the only unwound data.
     */
    unwindAt(memory: WebAssembly.Memory, stats: CaptureStats, pid: number): number;
    /** Before each hook's effect: the stack's buffers below `sp`, the current stack pointer, ended with their frames. */
    sweep(sp: number): void;
    /** setjmp(env) is about to capture: env stops naming what it named. */
    setting(env: number): void;
    /**
     * Keep the stack setjmp(env) just unwound at top as a capture: write env
     * to name it, and count env. `sp`: setjmp's caller's stack pointer.
     * Answers where the capture is, ready to rewind.
     */
    take(memory: WebAssembly.Memory, env: number, sp: number, stats: CaptureStats, pid: number): number;
    /** nimbus_procenv.copy(dst, src), after the copy: dst names what src named. */
    copied(memory: WebAssembly.Memory, dst: number, src: number): void;
    /** nimbus_procenv.drop(at): the saved buffer at `at` ends. */
    dropped(at: number): void;
    /**
     * The capture longjmp(env, value) jumps to, its landing given `value`,
     * made ready to rewind; after the current stack was unwound and
     * discarded. The buffers in the frames the jump skips (on the stack below
     * the capture's stack pointer) end here. Refused, loudly, when env names
     * no capture held.
     */
    jump(memory: WebAssembly.Memory, env: number, value: number, pid: number): RewindTarget;
}
//# sourceMappingURL=capture-store.d.ts.map