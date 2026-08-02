/**
 * wasm-memory.ts — linear-memory accounting and allocation control for wasm
 * processes.
 *
 * What the host can and cannot control
 * ────────────────────────────────────
 * `malloc` is dlmalloc compiled into the guest's own linear memory, and
 * `memory.grow` is a wasm *instruction* (opcode 0x40), not an import. There is
 * therefore no host hook on a guest allocation: the guest asks the engine for
 * pages directly and the host is never consulted.
 *
 * The one lever the host does hold is the memory's DECLARED MAXIMUM. Every
 * wasm binary Nimbus runs (bash, busybox, opentui, …) defines its own memory
 * with limits flags `0x00` — a minimum and NO maximum — so `memory.grow`
 * succeeds until the isolate itself dies. That is the silent-isolate-kill
 * failure mode: the guest never learns it ran out of memory, because from its
 * point of view every grow succeeded right up until the process vanished.
 *
 * `withMemoryLimit` rewrites the memory section's limits to carry an explicit
 * maximum. Past that maximum `memory.grow` returns -1, dlmalloc's `sbrk`
 * fails, `malloc` returns NULL, and the program reports an honest allocation
 * failure through its own error path. The isolate survives; the guest reports
 * ENOMEM. Nothing else about the module changes.
 *
 * Scope, stated honestly: this governs the ceiling, not the allocation rate.
 * A guest that stays under the cap is unobserved, and there is no way to
 * observe it — see the module comment in `wasm-process-image.ts` for why
 * page-level demand paging is unreachable for natively-compiled wasm.
 */

/** wasm page size. Fixed by the specification. */
export const WASM_PAGE_BYTES = 65536;

/** wasm32 address-space ceiling: 65536 pages of 64 KiB = 4 GiB. */
export const WASM32_MAX_PAGES = 65536;

/** Limits declared by a wasm memory, in pages. */
export interface WasmMemoryLimits {
  readonly minPages: number;
  /** `null` when the binary declares no maximum — growth is unbounded. */
  readonly maxPages: number | null;
  /** Raw limits flags. Bit 0 = has-maximum, bit 1 = shared, bit 2 = memory64. */
  readonly flags: number;
}

/** Thrown when a guest allocation cannot be satisfied within its cap. */
export class WasmOutOfMemoryError extends Error {
  readonly code = 'ENOMEM';
  constructor(
    readonly requestedBytes: number,
    readonly limitBytes: number,
    readonly currentBytes: number,
  ) {
    super(
      `ENOMEM: cannot grow linear memory to ${requestedBytes} bytes ` +
      `(current ${currentBytes}, limit ${limitBytes})`,
    );
    this.name = 'WasmOutOfMemoryError';
  }
}

// ── binary walking ───────────────────────────────────────────────────────────
//
// Only two sections matter here: the import section (id 2), which tells us
// whether the memory is supplied by the host, and the memory section (id 5),
// which declares it. Everything else is copied through byte-for-byte.

const SECTION_IMPORT = 2;
const SECTION_MEMORY = 5;

class Cursor {
  offset: number;
  constructor(readonly bytes: Uint8Array, offset = 0) {
    this.offset = offset;
  }
  u8(): number {
    if (this.offset >= this.bytes.length) throw new Error('wasm: truncated');
    return this.bytes[this.offset++];
  }
  /** Unsigned LEB128. */
  varuint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new Error('wasm: varuint too long');
    }
  }
  skip(n: number): void {
    this.offset += n;
  }
}

function encodeVaruint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function readLimits(cursor: Cursor): WasmMemoryLimits {
  const flags = cursor.varuint();
  const minPages = cursor.varuint();
  const maxPages = (flags & 1) !== 0 ? cursor.varuint() : null;
  return { flags, minPages, maxPages };
}

interface Section {
  readonly id: number;
  /** Offset of the section id byte. */
  readonly start: number;
  /** Offset of the first payload byte. */
  readonly payload: number;
  readonly size: number;
}

function* sections(bytes: Uint8Array): Generator<Section> {
  if (bytes.length < 8) throw new Error('wasm: not a module (too short)');
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('wasm: bad magic');
  }
  const cursor = new Cursor(bytes, 8);
  while (cursor.offset < bytes.length) {
    const start = cursor.offset;
    const id = cursor.u8();
    const size = cursor.varuint();
    const payload = cursor.offset;
    yield { id, start, payload, size };
    cursor.offset = payload + size;
  }
}

/** Skip one import entry's descriptor, returning its memory limits if it is one. */
function readImportDescriptor(cursor: Cursor): WasmMemoryLimits | null {
  const kind = cursor.u8();
  switch (kind) {
    case 0x00: // function: type index
      cursor.varuint();
      return null;
    case 0x01: // table: reftype + limits
      cursor.u8();
      readLimits(cursor);
      return null;
    case 0x02: // memory: limits
      return readLimits(cursor);
    case 0x03: // global: valtype + mutability
      cursor.u8();
      cursor.u8();
      return null;
    default:
      throw new Error(`wasm: unknown import kind ${kind}`);
  }
}

/**
 * Read the module's linear-memory declaration.
 *
 * Returns `null` for a module that neither defines nor imports a memory.
 * `imported` distinguishes the two cases that matter: an imported memory is
 * created by the host, so its limits are ours to choose at instantiation and
 * no binary rewrite is needed.
 */
export function readMemoryLimits(
  bytes: Uint8Array,
): (WasmMemoryLimits & { imported: boolean }) | null {
  for (const section of sections(bytes)) {
    if (section.id === SECTION_IMPORT) {
      const cursor = new Cursor(bytes, section.payload);
      const count = cursor.varuint();
      for (let i = 0; i < count; i++) {
        cursor.skip(cursor.varuint()); // module name
        cursor.skip(cursor.varuint()); // field name
        const limits = readImportDescriptor(cursor);
        if (limits) return { ...limits, imported: true };
      }
    } else if (section.id === SECTION_MEMORY) {
      const cursor = new Cursor(bytes, section.payload);
      const count = cursor.varuint();
      if (count === 0) continue;
      return { ...readLimits(cursor), imported: false };
    }
  }
  return null;
}

/**
 * Return a copy of `bytes` whose defined memory carries an explicit maximum of
 * at most `limitBytes`.
 *
 * The cap is only ever lowered: a module that already declares a tighter
 * maximum keeps it. Returns the input unchanged when the module imports its
 * memory (the host picks the limits at instantiation instead) or declares no
 * memory at all.
 *
 * Throws when `limitBytes` is below the module's declared minimum — capping
 * there would produce a module that cannot instantiate, which is a worse
 * failure than the one we are preventing.
 */
export function withMemoryLimit(bytes: Uint8Array, limitBytes: number): Uint8Array {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    throw new RangeError(`withMemoryLimit: limitBytes must be positive, got ${limitBytes}`);
  }
  const limitPages = Math.min(Math.floor(limitBytes / WASM_PAGE_BYTES), WASM32_MAX_PAGES);

  for (const section of sections(bytes)) {
    if (section.id !== SECTION_MEMORY) continue;

    const cursor = new Cursor(bytes, section.payload);
    const count = cursor.varuint();
    if (count === 0) return bytes;
    const entryStart = cursor.offset;
    const limits = readLimits(cursor);
    const entryEnd = cursor.offset;

    if (limits.minPages > limitPages) {
      throw new RangeError(
        `withMemoryLimit: limit of ${limitPages} pages is below the module's ` +
        `declared minimum of ${limits.minPages} pages`,
      );
    }
    const maxPages = limits.maxPages === null
      ? limitPages
      : Math.min(limits.maxPages, limitPages);
    if (limits.maxPages === maxPages) return bytes;

    // Re-encode this one entry with the has-maximum bit set, preserving the
    // shared and memory64 bits, then rebuild the section around it.
    const entry = [
      ...encodeVaruint(limits.flags | 1),
      ...encodeVaruint(limits.minPages),
      ...encodeVaruint(maxPages),
    ];
    const tail = bytes.subarray(entryEnd, section.payload + section.size);
    const countBytes = bytes.subarray(section.payload, entryStart);
    const payload = new Uint8Array(countBytes.length + entry.length + tail.length);
    payload.set(countBytes, 0);
    payload.set(entry, countBytes.length);
    payload.set(tail, countBytes.length + entry.length);

    const header = [section.id, ...encodeVaruint(payload.length)];
    const head = bytes.subarray(0, section.start);
    const rest = bytes.subarray(section.payload + section.size);
    const out = new Uint8Array(head.length + header.length + payload.length + rest.length);
    out.set(head, 0);
    out.set(header, head.length);
    out.set(payload, head.length + header.length);
    out.set(rest, head.length + header.length + payload.length);
    return out;
  }
  return bytes;
}

// ── accounting ───────────────────────────────────────────────────────────────

/** Exact, cheap linear-memory accounting for one wasm process. */
export interface LinearMemoryUsage {
  readonly bytes: number;
  readonly pages: number;
  /** Declared ceiling in bytes, or `null` when the module declares none. */
  readonly limitBytes: number | null;
}

/**
 * Exact committed linear-memory size. Unlike `estimateSupervisorHeap`, this is
 * not an estimate and has no blind spots: `buffer.byteLength` IS the committed
 * size of the process's address space, straight from the engine.
 */
export function accountLinearMemory(
  memory: WebAssembly.Memory,
  limits?: WasmMemoryLimits | null,
): LinearMemoryUsage {
  const bytes = memory.buffer.byteLength;
  return {
    bytes,
    pages: bytes / WASM_PAGE_BYTES,
    limitBytes: limits?.maxPages != null ? limits.maxPages * WASM_PAGE_BYTES : null,
  };
}

/**
 * Bytes the process has actually written, measured by skipping all-zero pages.
 *
 * This is an O(size) scan of the whole address space — call it when sizing a
 * swap image or answering a diagnostic, never in a loop. Fresh wasm pages are
 * zero-filled by the specification, so an untouched page is indistinguishable
 * from one deliberately zeroed; this therefore reports an upper bound on
 * untouched memory and, equivalently, a lower bound on live data. That is the
 * honest direction: it never claims a page is cold when the guest is using it.
 */
export function measureResidentBytes(memory: WebAssembly.Memory): number {
  const view = new Uint8Array(memory.buffer);
  let resident = 0;
  for (let base = 0; base < view.length; base += WASM_PAGE_BYTES) {
    const end = Math.min(base + WASM_PAGE_BYTES, view.length);
    for (let i = base; i < end; i++) {
      if (view[i] !== 0) {
        resident += end - base;
        break;
      }
    }
  }
  return resident;
}

/**
 * Grow `memory` by `deltaPages`, refusing to cross `limitBytes`.
 *
 * This governs HOST-initiated growth only — the arena reservations bash makes
 * before starting a process, opentui's buffer sizing, and similar. A guest
 * calling `memory.grow` from inside wasm bypasses this entirely; that path is
 * governed by the declared maximum `withMemoryLimit` installs, which is the
 * only mechanism that reaches it.
 *
 * Returns the previous size in pages, matching `WebAssembly.Memory.prototype.grow`.
 */
export function growWithinLimit(
  memory: WebAssembly.Memory,
  deltaPages: number,
  limitBytes: number,
): number {
  const currentBytes = memory.buffer.byteLength;
  const requestedBytes = currentBytes + deltaPages * WASM_PAGE_BYTES;
  if (requestedBytes > limitBytes) {
    throw new WasmOutOfMemoryError(requestedBytes, limitBytes, currentBytes);
  }
  try {
    return memory.grow(deltaPages);
  } catch {
    // The engine refused below our own cap — the declared maximum or the
    // isolate's real ceiling is tighter. Report it as ENOMEM rather than
    // letting a bare RangeError escape into a runtime that cannot classify it.
    throw new WasmOutOfMemoryError(requestedBytes, currentBytes, currentBytes);
  }
}
