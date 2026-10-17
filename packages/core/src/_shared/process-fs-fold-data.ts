import type { ProcessFsOp } from './process-fs-client.js';

export interface FoldData {
  /** Furthest exposed prefix: shorter snapshots cannot extend it in place. */
  buffer: { bytes: Uint8Array; used: number };
  data: Uint8Array;
  append: Uint8Array;
  pending: boolean;
}

export const FOLDED_DATA = new WeakMap<ProcessFsOp, FoldData>();

/** A new fold's delta, consumed once by its journal. */
export function pendingFold(op: ProcessFsOp): FoldData | undefined {
  const held = FOLDED_DATA.get(op);
  return held?.pending === true ? held : undefined;
}
