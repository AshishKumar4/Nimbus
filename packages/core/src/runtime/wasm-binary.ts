/**
 * wasm-binary.ts — reading a wasm binary's structure supervisor-side, where
 * the bytes already are and nothing is compiled: the section walk, unsigned
 * LEB128, and the import and export sections. Dependency-free.
 *
 * Callers keep their own decisions: what threads a module asks for
 * (wasi-threads.ts), where its memory limits sit (wasm-memory.ts), which WASI
 * ABI it binds (wasm-runner.ts).
 */

/** Section ids this module names. */
export const WASM_SECTION = { custom: 0, import: 2, memory: 5, export: 7 } as const;

/** Import and export kinds. */
export const WASM_EXTERN = { func: 0x00, table: 0x01, memory: 0x02, global: 0x03 } as const;

/** Limits as a memory or table declares them, in pages or elements. */
export interface WasmLimits {
  /** Raw limits flags. Bit 0 = has-maximum, bit 1 = shared, bit 2 = memory64. */
  readonly flags: number;
  readonly min: number;
  /** `null` when the binary declares no maximum. */
  readonly max: number | null;
}

/** A forward reader over a binary; every read past the end throws. */
export class WasmReader {
  constructor(readonly bytes: Uint8Array, public offset = 0) {}

  u8(): number {
    if (this.offset >= this.bytes.length) throw new Error('wasm: truncated');
    return this.bytes[this.offset++];
  }

  /** Unsigned LEB128, up to 35 bits. */
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

  /** A length-prefixed UTF-8 name. */
  name(): string {
    const length = this.varuint();
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error('wasm: truncated');
    const value = new TextDecoder().decode(this.bytes.subarray(this.offset, end));
    this.offset = end;
    return value;
  }

  limits(): WasmLimits {
    const flags = this.varuint();
    const min = this.varuint();
    const max = (flags & 1) !== 0 ? this.varuint() : null;
    return { flags, min, max };
  }
}

/** Unsigned LEB128 encoding of `value`. */
export function encodeVaruint(value: number): number[] {
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

/** True when `bytes` opens with the wasm magic and room for a version. */
export function isWasmBinary(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

export interface WasmSection {
  readonly id: number;
  /** Offset of the section id byte. */
  readonly start: number;
  /** Offset of the first payload byte. */
  readonly payload: number;
  readonly size: number;
}

/**
 * The sections of a wasm binary, in order, each skipped by its declared size.
 * The walk ends at a section whose declared size runs past the end of the
 * bytes, without yielding it; a header cut short throws.
 */
export function* wasmSections(bytes: Uint8Array): Generator<WasmSection> {
  const reader = new WasmReader(bytes, 8);
  while (reader.offset < bytes.length) {
    const start = reader.offset;
    const id = reader.u8();
    const size = reader.varuint();
    const payload = reader.offset;
    if (payload + size > bytes.length) return;
    yield { id, start, payload, size };
    reader.offset = payload + size;
  }
}

export interface WasmImport {
  readonly module: string;
  readonly name: string;
  readonly kind: number;
  /** An imported memory's declared limits. */
  readonly memory?: WasmLimits;
}

export interface WasmExport {
  readonly name: string;
  readonly kind: number;
}

/**
 * A module's imports and exports, read from its import and export sections.
 * Malformed input is answered, not thrown at: not a wasm binary reads as
 * none, and a truncated section, or an import of a kind this reader does not
 * know, ends the walk with what was read before it.
 */
export function wasmInterface(bytes: Uint8Array): { imports: WasmImport[]; exports: WasmExport[] } {
  const imports: WasmImport[] = [];
  const exports: WasmExport[] = [];
  if (!isWasmBinary(bytes)) return { imports, exports };
  try {
    readInterface(bytes, imports, exports);
  } catch {
    // Truncated: what was read stands.
  }
  return { imports, exports };
}

function readInterface(bytes: Uint8Array, imports: WasmImport[], exports: WasmExport[]): void {
  for (const section of wasmSections(bytes)) {
    const reader = new WasmReader(bytes.subarray(0, section.payload + section.size), section.payload);
    if (section.id === WASM_SECTION.import) {
      for (let count = reader.varuint(); count > 0; count--) {
        const module = reader.name();
        const name = reader.name();
        const kind = reader.u8();
        if (kind === WASM_EXTERN.func) {
          reader.varuint(); // type index
          imports.push({ module, name, kind });
        } else if (kind === WASM_EXTERN.table) {
          reader.u8(); // reftype
          reader.limits();
          imports.push({ module, name, kind });
        } else if (kind === WASM_EXTERN.memory) {
          imports.push({ module, name, kind, memory: reader.limits() });
        } else if (kind === WASM_EXTERN.global) {
          reader.offset += 2; // valtype + mutability
          imports.push({ module, name, kind });
        } else {
          return;
        }
      }
    } else if (section.id === WASM_SECTION.export) {
      for (let count = reader.varuint(); count > 0; count--) {
        const name = reader.name();
        const kind = reader.u8();
        reader.varuint(); // index
        exports.push({ name, kind });
      }
    }
  }
}
