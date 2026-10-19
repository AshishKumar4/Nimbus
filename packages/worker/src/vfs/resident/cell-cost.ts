/**
 * What holding a cell costs a process's resident store, in the one unit both
 * sides use: the facet's store charges itself this to hold a cell, and the
 * manager charges a launch's module map the same before it admits the launch
 * (manager.ts moduleMapStorageBytes).
 */

import { LEDGER_ROW_BYTES } from '@nimbus-sh/core/runtime/storage-ledger.js';
import {
  ArrayBufferConstructor, mathCeil, mathFloor, mathMax, reflectGet, stringCharCodeAt, stringOf, stringSlice,
  newTextEncoder, textEncoderEncodeInto, typedArrayByteLength, Uint8ArrayConstructor,
} from '@nimbus-sh/core/_shared/primordials.js';
import { RESIDENT_CHUNK_BYTES } from '../facet-resident-limits.js';

let encoder: TextEncoder | undefined;
let scratch: Uint8Array | undefined;

/** The platform's UTF-8 measure, on the launch's captures after a program starts. */
export function utf8Length(text: string): number {
  if (text.length >= 256) {
    scratch ??= new Uint8ArrayConstructor(256 * 1024);
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
    if (unit < 0x80) continue;
    if (unit < 0x800) bytes++;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = stringCharCodeAt(text, index + 1);
      bytes += 2;
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    } else bytes += 2;
  }
  return bytes;
}

/** A row's allowance: what one row of 'file', 'chunk' or 'ns' is charged beside its payload. */
export const RESIDENT_ROW_BYTES = LEDGER_ROW_BYTES;

/** A cell as the facet holds it — the shape `__vfsBundle` has always carried. */
export type ResidentCell = string | Uint8Array | { error: 'EACCES' };

export function residentBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8ArrayConstructor) return value;
  if (value instanceof ArrayBufferConstructor) return new Uint8ArrayConstructor(value);
  return new Uint8ArrayConstructor(0);
}

/**
 * What holding a cell costs the database: its bytes (a text cell's UTF-8
 * length) on overflow pages (1% over, for page headers and the b-tree pages
 * above them), a row per chunk and head, and a page of slack.
 */
export function residentCellCost(cell: unknown): number {
  const isText = typeof cell === 'string';
  const size = isText ? cell.length : typedArrayByteLength(residentBytes(cell));
  const limit = isText ? mathFloor(RESIDENT_CHUNK_BYTES / 3) : RESIDENT_CHUNK_BYTES;
  const chunks = mathMax(1, mathCeil(size / limit));
  return mathCeil((isText ? utf8Length(cell) : size) * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
}

/**
 * At most what holding a file of `size` bytes costs, read as bytes or as
 * text (residentCellCost, with text's smaller chunks): what a fill whose
 * bytes have not arrived yet asks room for.
 */
export function residentFileCost(size: number): number {
  const chunks = mathMax(1, mathCeil(size / mathFloor(RESIDENT_CHUNK_BYTES / 3)));
  return mathCeil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
}

/**
 * What a namespace row costs a one-shot's heap. JavaScript keeps path/target
 * strings in the heap: charge UTF-16 storage plus the row allowance, even
 * when the engine can compress text.
 */
export function namespaceRowBytes(parent: string, name: string, target: string | null | undefined): number {
  return RESIDENT_ROW_BYTES + 2 * (stringOf(parent).length + stringOf(name).length + (target == null ? 0 : stringOf(target).length));
}
