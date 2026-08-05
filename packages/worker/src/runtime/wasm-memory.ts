/**
 * wasm-memory.ts — declared allocation limits for wasm processes.
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
 * observe it — a compiled wasm load or store is a raw machine access with no
 * host hook, so page-level accounting is unreachable for a natively-compiled
 * module.
 */

/** wasm page size. Fixed by the specification. */
export const WASM_PAGE_BYTES = 65536;

/** wasm32 address-space ceiling: 65536 pages of 64 KiB = 4 GiB. */
export const WASM32_MAX_PAGES = 65536;

/**
 * Default ceiling for one wasm process's linear memory.
 *
 * Measured on prod workerd (throwaway account-pinned DO, 2026-08-02): a
 * Durable Object sustains ~200 MiB of live wasm linear memory and is then
 * killed, and it makes no difference whether those pages were written to or
 * merely reserved — the untouched and fully-filled arms died at exactly the
 * same 200 MiB. Reserving address space is billed at full price, so there is
 * no headroom to be had by growing lazily.
 *
 * 128 MiB leaves ~70 MiB of that measured ceiling for the facet's own JS
 * heap, the module text, and the runner's buffers. It is a budget rather than
 * a measurement of any particular workload's need, and unlike the supervisor
 * heap budget this one IS enforced — `withMemoryLimit` puts it where a guest
 * `memory.grow` can see it.
 */
export const DEFAULT_WASM_PROCESS_LIMIT_BYTES = 128 * 1024 * 1024;

/** Limits declared by a wasm memory, in pages. */
export interface WasmMemoryLimits {
  readonly minPages: number;
  /** `null` when the binary declares no maximum — growth is unbounded. */
  readonly maxPages: number | null;
  /** Raw limits flags. Bit 0 = has-maximum, bit 1 = shared, bit 2 = memory64. */
  readonly flags: number;
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
