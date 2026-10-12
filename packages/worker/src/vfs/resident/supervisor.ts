/**
 * The session calls a process's store makes, as the session declares them:
 * the filesystem's (core runtime/filesystem-methods.ts) and the session's own
 * reads (session/supervisor-calls.ts). Each is optional, as a supervisor may
 * lack one (a test's) and the store then does without it, and each answer is
 * awaited whether or not it is a promise. What an answer holds crossed an
 * RPC, so the store reads it field by field.
 */

import type { FilesystemSupervisor } from '@nimbus-sh/core/runtime/filesystem-methods.js';
import type { ProcessSupervisor } from '../../session/process-supervisor.js';

type SessionRead = 'fsListTree' | 'fsReadBatch' | 'fsStorageGrant';

/** A session call as the store makes it: its own arguments, its answer whether or not it is a promise. */
type Answered<F> = F extends (...args: infer A) => Promise<infer R> ? (...args: A) => R | PromiseLike<R> : never;

export type ResidentSupervisor = Partial<Pick<FilesystemSupervisor, 'fsAcquire' | 'fsList' | 'readdir' | 'readlink'>>
  & { readonly [K in SessionRead]?: Answered<ProcessSupervisor[K]> };
