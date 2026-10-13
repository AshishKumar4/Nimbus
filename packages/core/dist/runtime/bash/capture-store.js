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
const TAG = 0xfb5a0000;
/** The arena: as large as the 8 MiB main buffer and the 32 × 256 KiB slots it replaces. */
export const ARENA_SIZE = 16 << 20;
/** What every unwind is given at least. bash's deepest unwind seen is ~240 KiB (12 nested function calls). */
const MIN_ROOM = 2 << 20;
/** Freed space below the top past which the live captures are packed before the next unwind. */
const PACK_SLACK = 1 << 20;
/** A capture's footprint: its header and bytes, to the next 16-byte boundary (every capture starts on one). */
const span = (length) => (8 + length + 15) & ~15;
const above = (at, length) => at + span(length);
export class CaptureStore {
    base;
    size;
    #stack;
    #captures;
    /** Registered buffer address → the id of the capture it names. */
    #names;
    /** The registered buffers on the shadow stack, ascending: those below the stack pointer are a prefix. */
    #stackNames;
    #view = null;
    #top;
    /** The live captures' footprint: the arena below the top, less the space freed in it. */
    #liveBytes = 0;
    #nextId = 1;
    #nextGeneration = 1;
    /** The arena `size` bytes from `base`, empty, or a copy of what `from` holds (a fork's). */
    constructor(stack, base, size, from) {
        this.#stack = stack;
        this.base = base;
        this.size = size;
        this.#captures = new Map();
        if (from === undefined) {
            this.#names = new Map();
            this.#stackNames = [];
            this.#top = base;
            return;
        }
        this.#names = new Map(from.#names);
        this.#stackNames = [...from.#stackNames];
        this.#top = from.#top;
        this.#liveBytes = from.#liveBytes;
        for (const [id, capture] of from.#captures)
            this.#captures.set(id, { ...capture });
        this.#nextId = from.#nextId;
        this.#nextGeneration = from.#nextGeneration;
    }
    /** A forked child's: the same captures, buffers and counts, at the same places in the child's copy of the memory. */
    fork() {
        return new CaptureStore(this.#stack, this.base, this.size, this);
    }
    /** An empty store for the same arena: an exited process's instance, kept for reuse, holds no captures. */
    emptied() {
        return new CaptureStore(this.#stack, this.base, this.size);
    }
    /** The module's shadow stack, which every store of its processes shares. */
    get stackBounds() { return this.#stack; }
    /** Where the next unwind goes, and where the one pending is. */
    get top() { return this.#top; }
    /** What of the arena a fork copies: each live capture's bytes, and the pending unwind's up to `unwound`. */
    liveRanges(unwound) {
        const ranges = [];
        for (const capture of this.#captures.values())
            ranges.push([capture.at, capture.at + 8 + capture.length]);
        ranges.push([this.#top, Math.min(Math.max(unwound, this.#top + 8), this.base + this.size)]);
        return ranges;
    }
    /**
     * The header of an unwind about to start, at top, with every byte to the
     * arena's end to fill: made room for first by sliding the live captures
     * down when less than MIN_ROOM is left. Only between a rewind's end and
     * the next unwind, when captures are the only unwound data.
     */
    unwindAt(memory, stats, pid) {
        const view = this.#viewOf(memory);
        const short = this.base + this.size - this.#top < MIN_ROOM;
        if (short || this.#top - this.base - this.#liveBytes > PACK_SLACK) {
            // Short of room, the buffers written over without a hook end first.
            if (short)
                for (const [at, id] of this.#names)
                    if (!this.#holds(view, at, id))
                        this.#unname(at);
            this.#compact(memory);
            stats.captureCompactions++;
        }
        if (this.base + this.size - this.#top < MIN_ROOM) {
            throw new Error(`bash-runner: pid ${pid}'s live setjmp captures fill its ${this.size >> 20} MiB arena (a recursion too deep?)`);
        }
        view.setUint32(this.#top, this.#top + 8, true);
        view.setUint32(this.#top + 4, this.base + this.size, true);
        return this.#top;
    }
    /** Before each hook's effect: the stack's buffers below `sp`, the current stack pointer, ended with their frames. */
    sweep(sp) {
        const stack = this.#stackNames;
        let dead = 0;
        while (dead < stack.length && stack[dead] < sp)
            dead++;
        if (dead > 0)
            for (const at of stack.splice(0, dead))
                this.#release(at);
    }
    /** setjmp(env) is about to capture: env stops naming what it named. */
    setting(env) {
        if (this.#names.has(env))
            this.#unname(env);
    }
    /**
     * Keep the stack setjmp(env) just unwound at top as a capture: write env
     * to name it, and count env. `sp`: setjmp's caller's stack pointer.
     * Answers where the capture is, ready to rewind.
     */
    take(memory, env, sp, stats, pid) {
        const view = this.#viewOf(memory);
        const at = this.#top, length = view.getUint32(at, true) - (at + 8);
        for (let tried = 0; this.#captures.has(this.#nextId); tried++) {
            if (tried === 0xffff)
                throw new Error(`bash-runner: pid ${pid} holds a setjmp capture under every id`);
            this.#nextId = this.#nextId === 0xffff ? 1 : this.#nextId + 1;
        }
        if (this.#nextGeneration > 0xffffffff)
            throw new Error(`bash-runner: pid ${pid} has used every setjmp generation`);
        const id = this.#nextId, generation = this.#nextGeneration++;
        this.#nextId = id === 0xffff ? 1 : id + 1;
        view.setUint32(env, (TAG | id) >>> 0, true);
        view.setInt32(env + 4, 0, true);
        view.setUint32(env + 8, generation, true);
        const capture = { at, length, env, generation, sp, refs: 1 };
        this.#captures.set(id, capture);
        this.#name(env, id);
        this.#top = above(at, length);
        this.#liveBytes += span(length);
        if (length > stats.mainHi)
            stats.mainHi = length;
        if (this.#top - this.base > stats.captureBytesHi)
            stats.captureBytesHi = this.#top - this.base;
        if (this.#captures.size > stats.captureLiveHi)
            stats.captureLiveHi = this.#captures.size;
        return this.#ready(view, capture);
    }
    /** nimbus_procenv.copy(dst, src), after the copy: dst names what src named. */
    copied(memory, dst, src) {
        if (this.#names.has(dst))
            this.#unname(dst);
        const id = this.#names.get(src);
        if (id === undefined || !this.#holds(this.#viewOf(memory), dst, id))
            return;
        this.#name(dst, id);
        const capture = this.#captures.get(id);
        if (capture !== undefined)
            capture.refs++;
    }
    /** nimbus_procenv.drop(at): the saved buffer at `at` ends. */
    dropped(at) {
        if (this.#names.has(at))
            this.#unname(at);
    }
    /**
     * The capture longjmp(env, value) jumps to, its landing given `value`,
     * made ready to rewind; after the current stack was unwound and
     * discarded. The buffers in the frames the jump skips (on the stack below
     * the capture's stack pointer) end here. Refused, loudly, when env names
     * no capture held.
     */
    jump(memory, env, value, pid) {
        const view = this.#viewOf(memory);
        const tag = view.getUint32(env, true), generation = view.getUint32(env + 8, true);
        const capture = (tag & 0xffff0000) >>> 0 === TAG ? this.#captures.get(tag & 0xffff) : undefined;
        if (capture === undefined || capture.generation !== generation) {
            throw new Error(`bash-runner: pid ${pid} longjmp'd through a jmp_buf whose setjmp it no longer holds (0x${tag.toString(16)}, generation ${generation})`);
        }
        // Freed by this, the capture's bytes stay as they are until the landing: no unwind comes before it.
        this.sweep(capture.sp);
        view.setInt32(capture.env + 4, value, true);
        return { at: this.#ready(view, capture), sp: capture.sp };
    }
    /** Its header at its end: a rewind reads the stack back from there, and leaves the bytes as they were. */
    #ready(view, capture) {
        const end = capture.at + 8 + capture.length;
        view.setUint32(capture.at, end, true);
        view.setUint32(capture.at + 4, end, true);
        return capture.at;
    }
    /** A view of `memory`, made again only when it grew. */
    #viewOf(memory) {
        if (this.#view === null || this.#view.buffer !== memory.buffer)
            this.#view = new DataView(memory.buffer);
        return this.#view;
    }
    /** Register `at` as naming capture `id`; a buffer on the stack also in address order. */
    #name(at, id) {
        this.#names.set(at, id);
        if (at < this.#stack.low || at >= this.#stack.high)
            return;
        const stack = this.#stackNames;
        let lo = 0, hi = stack.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (stack[mid] < at)
                lo = mid + 1;
            else
                hi = mid;
        }
        stack.splice(lo, 0, at);
    }
    #holds(view, at, id) {
        const capture = this.#captures.get(id);
        return capture !== undefined && view.getUint32(at, true) === ((TAG | id) >>> 0) && view.getUint32(at + 8, true) === capture.generation;
    }
    /** `at` stops naming its capture (#release), out of the stack's order first when it is on the stack. */
    #unname(at) {
        if (at >= this.#stack.low && at < this.#stack.high) {
            const stack = this.#stackNames;
            let lo = 0, hi = stack.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (stack[mid] < at)
                    lo = mid + 1;
                else
                    hi = mid;
            }
            if (stack[lo] === at)
                stack.splice(lo, 1);
        }
        this.#release(at);
    }
    /** A capture no buffer names is freed, and the top comes down past freed space. */
    #release(at) {
        const id = this.#names.get(at);
        this.#names.delete(at);
        if (id === undefined)
            return;
        const capture = this.#captures.get(id);
        if (capture === undefined || --capture.refs > 0)
            return;
        this.#captures.delete(id);
        this.#liveBytes -= span(capture.length);
        if (above(capture.at, capture.length) !== this.#top)
            return;
        let top = this.base;
        for (const live of this.#captures.values())
            top = Math.max(top, above(live.at, live.length));
        this.#top = top;
    }
    /** Slide the live captures down over freed space, in address order; asyncify's data holds no address of its own, so a capture moves freely. */
    #compact(memory) {
        const bytes = new Uint8Array(memory.buffer);
        let to = this.base;
        for (const capture of [...this.#captures.values()].sort((a, b) => a.at - b.at)) {
            if (capture.at !== to)
                bytes.copyWithin(to, capture.at, capture.at + 8 + capture.length);
            capture.at = to;
            to = above(to, capture.length);
        }
        this.#top = to;
    }
}
