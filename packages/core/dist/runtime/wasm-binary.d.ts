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
export declare const WASM_SECTION: {
    readonly custom: 0;
    readonly import: 2;
    readonly memory: 5;
    readonly export: 7;
};
/** Import and export kinds. */
export declare const WASM_EXTERN: {
    readonly func: 0;
    readonly table: 1;
    readonly memory: 2;
    readonly global: 3;
};
/** Limits as a memory or table declares them, in pages or elements. */
export interface WasmLimits {
    /** Raw limits flags. Bit 0 = has-maximum, bit 1 = shared, bit 2 = memory64. */
    readonly flags: number;
    readonly min: number;
    /** `null` when the binary declares no maximum. */
    readonly max: number | null;
}
/** A forward reader over a binary; every read past the end throws. */
export declare class WasmReader {
    readonly bytes: Uint8Array;
    offset: number;
    constructor(bytes: Uint8Array, offset?: number);
    u8(): number;
    /** Unsigned LEB128, up to 35 bits. */
    varuint(): number;
    /** A length-prefixed UTF-8 name. */
    name(): string;
    limits(): WasmLimits;
}
/** Unsigned LEB128 encoding of `value`. */
export declare function encodeVaruint(value: number): number[];
/** True when `bytes` opens with the wasm magic and room for a version. */
export declare function isWasmBinary(bytes: Uint8Array): boolean;
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
export declare function wasmSections(bytes: Uint8Array): Generator<WasmSection>;
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
export declare function wasmInterface(bytes: Uint8Array): {
    imports: WasmImport[];
    exports: WasmExport[];
};
//# sourceMappingURL=wasm-binary.d.ts.map