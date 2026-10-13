/**
 * What holding a cell costs a process's resident store, in the one unit both
 * sides use: the facet's store charges itself this to hold a cell, and the
 * manager charges a launch's module map the same before it admits the launch
 * (manager.ts moduleMapStorageBytes).
 */

import { LEDGER_ROW_BYTES } from '@nimbus-sh/core/runtime/storage-ledger.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { RESIDENT_CHUNK_BYTES } from '../facet-resident-limits.js';

export { utf8Length };

/** A row's allowance: what one row of 'file', 'chunk' or 'ns' is charged beside its payload. */
export const RESIDENT_ROW_BYTES = LEDGER_ROW_BYTES;

/** A cell as the facet holds it — the shape `__vfsBundle` has always carried. */
export type ResidentCell = string | Uint8Array | { error: 'EACCES' };

export function residentBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

/**
 * What holding a cell costs the database: its bytes (a text cell's UTF-8
 * length) on overflow pages (1% over, for page headers and the b-tree pages
 * above them), a row per chunk and head, and a page of slack.
 */
export function residentCellCost(cell: unknown): number {
  const isText = typeof cell === 'string';
  const size = isText ? cell.length : residentBytes(cell).byteLength;
  const limit = isText ? Math.floor(RESIDENT_CHUNK_BYTES / 3) : RESIDENT_CHUNK_BYTES;
  const chunks = Math.max(1, Math.ceil(size / limit));
  return Math.ceil((isText ? utf8Length(cell) : size) * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
}

/**
 * At most what holding a file of `size` bytes costs, read as bytes or as
 * text (residentCellCost, with text's smaller chunks): what a fill whose
 * bytes have not arrived yet asks room for.
 */
export function residentFileCost(size: number): number {
  const chunks = Math.max(1, Math.ceil(size / Math.floor(RESIDENT_CHUNK_BYTES / 3)));
  return Math.ceil(size * 1.01) + (chunks + 1) * RESIDENT_ROW_BYTES + 4096;
}

/**
 * What a namespace row costs a one-shot's heap. JavaScript keeps path/target
 * strings in the heap: charge UTF-16 storage plus the row allowance, even
 * when the engine can compress text.
 */
export function namespaceRowBytes(parent: string, name: string, target: string | null | undefined): number {
  return RESIDENT_ROW_BYTES + 2 * (String(parent).length + String(name).length + (target == null ? 0 : String(target).length));
}
