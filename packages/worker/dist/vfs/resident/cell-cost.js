/**
 * What holding a cell costs a process's resident store, in the one unit both
 * sides use: the facet's store charges itself this to hold a cell, and the
 * manager charges a launch's module map the same before it admits the launch
 * (manager.ts moduleMapStorageBytes).
 */
import { LEDGER_ROW_BYTES } from '@nimbus-sh/core/runtime/storage-ledger.js';
import { arrayCopy, ArrayBufferConstructor, mathCeil, mathFloor, mathMax, mathMin, reflectGet, SafeList, stringCharCodeAt, stringOf, stringSlice, newTextEncoder, textEncoderEncodeInto, typedArrayByteLength, Uint8ArrayConstructor, } from '@nimbus-sh/core/_shared/primordials.js';
import { RESIDENT_CHUNK_BYTES } from '../facet-resident-limits.js';
import { UTF8_LONG_UNITS, UTF8_SCRATCH_BYTES } from '@nimbus-sh/platform/utf8.js';
let encoder;
let scratch;
/**
 * The platform's UTF-8 measure (@nimbus-sh/platform/utf8.js), its policy and
 * its count, on the launch's captures: a fill measures after a program may
 * have replaced String.prototype.charCodeAt. Kept apart from the platform's,
 * which host hot paths call on their realm's methods.
 */
export function utf8Length(text) {
    if (text.length >= UTF8_LONG_UNITS) {
        scratch ??= new Uint8ArrayConstructor(UTF8_SCRATCH_BYTES);
        encoder ??= newTextEncoder();
        let bytes = 0;
        for (let read = 0; read < text.length;) {
            const done = textEncoderEncodeInto(encoder, read === 0 ? text : stringSlice(text, read), scratch);
            // encodeInto returns these as own data properties, not library accessors.
            read += reflectGet(done, 'read');
            bytes += reflectGet(done, 'written');
        }
        return bytes;
    }
    let bytes = text.length;
    for (let index = 0; index < text.length; index++) {
        const unit = stringCharCodeAt(text, index);
        if (unit < 0x80)
            continue;
        if (unit < 0x800)
            bytes++;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
            const next = stringCharCodeAt(text, index + 1);
            bytes += 2;
            if (next >= 0xdc00 && next <= 0xdfff)
                index++;
        }
        else
            bytes += 2;
    }
    return bytes;
}
/** A row's allowance: what one row of 'file', 'chunk' or 'ns' is charged beside its payload. */
export const RESIDENT_ROW_BYTES = LEDGER_ROW_BYTES;
export function residentBytes(value) {
    if (value instanceof Uint8ArrayConstructor)
        return value;
    if (value instanceof ArrayBufferConstructor)
        return new Uint8ArrayConstructor(value);
    return new Uint8ArrayConstructor(0);
}
/** The most UTF-16 units a chunk of text holds: its UTF-8 at most a chunk's bytes. */
const TEXT_CHUNK_UNITS = mathFloor(RESIDENT_CHUNK_BYTES / 3);
/**
 * Where text's chunks end: at most TEXT_CHUNK_UNITS each, never inside a
 * surrogate pair. SQLite keeps text as UTF-8, where half of a pair is not a
 * character: stored apart, both halves came back as U+FFFD.
 */
export function textChunkEnds(text) {
    const ends = new SafeList();
    let at = 0;
    do {
        let end = mathMin(text.length, at + TEXT_CHUNK_UNITS);
        const last = stringCharCodeAt(text, end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff)
            end--;
        ends[ends.length] = end;
        at = end;
    } while (at < text.length);
    return arrayCopy(ends);
}
/**
 * What holding a cell costs the database: its bytes (a text cell's UTF-8
 * length) on overflow pages (1% over, for page headers and the b-tree pages
 * above them), a row per chunk and head, and a page of slack.
 */
export function residentCellCost(cell) {
    const isText = typeof cell === 'string';
    const size = isText ? utf8Length(cell) : typedArrayByteLength(residentBytes(cell));
    const chunks = isText ? textChunkEnds(cell).length : mathMax(1, mathCeil(size / RESIDENT_CHUNK_BYTES));
    return mathCeil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
}
/**
 * At most what holding a file of `size` bytes costs, read as bytes or as
 * text (residentCellCost, with text's smaller chunks): what a fill whose
 * bytes have not arrived yet asks room for.
 */
export function residentFileCost(size) {
    // A text chunk ends a unit early rather than inside a pair (textChunkEnds).
    const chunks = mathMax(1, mathCeil(size / (TEXT_CHUNK_UNITS - 1)));
    return mathCeil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
}
/**
 * What a namespace row costs a one-shot's heap. JavaScript keeps path/target
 * strings in the heap: charge UTF-16 storage plus the row allowance, even
 * when the engine can compress text.
 */
export function namespaceRowBytes(parent, name, target) {
    return RESIDENT_ROW_BYTES + 2 * (stringOf(parent).length + stringOf(name).length + (target == null ? 0 : stringOf(target).length));
}
