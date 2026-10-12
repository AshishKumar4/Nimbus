/**
 * The session calls a process's store makes (session/supervisor-calls.ts),
 * as the store asks them: each may be missing from a supervisor (an older
 * one, a test's), and the store then does without it. Answers are read
 * defensively, field by field, as an answer over RPC may be anything.
 */

import type { RuntimeVfsStat, VfsAcquireOptions } from '@nimbus-sh/core/runtime/os-contracts.js';

/** A stat as the session reports it, with the revision a batch read carries. */
export type ResidentStat = Partial<RuntimeVfsStat> & {
  type?: string;
  revision?: number;
  linkTarget?: string | null;
  target?: string | null;
  [field: string]: unknown;
};

/** One entry of an ACQUIRE answer (VfsInvalidatedPath), as received. */
export interface AcquireEntry {
  path: string;
  rev: number;
  subtree?: boolean;
  structural?: boolean;
  stat?: ResidentStat | null;
  linkTarget?: string;
  contentKey?: string | null;
  bytes?: unknown;
}

/** An ACQUIRE answer (VfsAcquireResult), as received. */
export interface AcquireAnswer {
  epoch?: unknown;
  rev?: unknown;
  poison?: boolean;
  namespace?: boolean;
  paths?: AcquireEntry[];
}

/** One entry of a listing (VfsListEntry), as received. */
export interface ListEntry {
  path: string;
  kind?: string;
  size?: number;
  rev: number;
  stat?: ResidentStat | null;
  linkTarget?: string;
  contentKey?: string | null;
  unlisted?: string | null;
}

export interface ListPage {
  epoch?: unknown;
  rev?: unknown;
  entries?: ListEntry[];
  next?: string | null;
}

export interface ReadBatchRequest {
  path: string;
  offset?: number;
  length?: number;
  lstat?: boolean;
  expectedEpoch?: string;
  expectedRevision?: number;
}

export interface ReadBatchAnswer {
  error?: { code?: string } | string | null;
  bytes?: unknown;
  stat?: ResidentStat | null;
}

export interface ResidentSupervisor {
  fsAcquire?(epoch: string | null, cursor: number, options?: VfsAcquireOptions): Promise<AcquireAnswer | null | undefined>;
  fsList?(after: string | null, limit: number): Promise<ListPage | null | undefined>;
  fsListTree?(path: string, limit: number): Promise<{ entries?: ListEntry[] } | null | undefined>;
  fsReadBatch?(requests: ReadBatchRequest[]): Promise<(ReadBatchAnswer | null | undefined)[] | null | undefined>;
  readdir?(path: string): Promise<{ name: string }[] | null | undefined>;
  readlink?(path: string): Promise<unknown>;
  fsStorageGrant?(facet: string, bytes: number, databaseSize: number): Promise<{ granted?: number; cap?: number } | null | undefined>;
}
