/**
 * Read-only directory prefetch is an account of real descriptions, not
 * another descriptor table. All I/O uses the process's existing bridge;
 * its DescriptorScope remains the only owner, including on release/kill.
 */
import { z } from 'zod';
import { RuntimeFsPathSchema } from './filesystem-path.js';
import { withRecall } from '../vfs/recall.js';
import { DIRECTORY_PREFETCH_LIMIT, DIRECTORY_BATCH_LIMIT } from '../constants.js';
import type { Awaitable, RuntimeFileHandle, RuntimeFsBridge, RuntimeFsPath, VfsAcquireResult } from './os-contracts.js';

export const DIRECTORY_READ_RPC = 'fsReadDirectories' as const;
const Ids = z.array(z.number().int().nonnegative()).max(DIRECTORY_PREFETCH_LIMIT);
const Request = z.object({
  channel: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  epoch: z.string().nullable(),
  cursor: z.number().int().nonnegative(),
  open: z.array(RuntimeFsPathSchema).max(DIRECTORY_BATCH_LIMIT),
  retire: Ids,
  claim: Ids,
  lease: z.boolean(),
});
export type ReadDirectoryBatchRequest = z.infer<typeof Request>;

export interface ReadDirectoryDescription {
  /** Null when canonical namespace placement does not permit a local answer. */
  readonly key: string | null;
  readonly handle: RuntimeFileHandle;
  /** Identity only: local fstat must use the final admitted namespace, not a stat taken earlier in the batch. */
  readonly dev: number;
  readonly ino: number;
  /** The name's metadata version before the authority checked open access; null if it changed identity. */
  readonly openedRevision: number | null;
}
export interface ReadDirectoryBatchResult {
  readonly channel: string;
  readonly sequence: number;
  readonly opened: readonly ReadDirectoryDescription[];
  readonly retired: readonly number[];
  readonly claimed: readonly number[];
  readonly outstanding: number;
  readonly acquire: VfsAcquireResult;
}
export interface ReadDirectorySupervisor {
  fsReadDirectories(request: ReadDirectoryBatchRequest): Promise<ReadDirectoryBatchResult>;
}

interface Scope { readonly closed: boolean }
interface Channel { sequence: number }
interface Tracked { readonly channel: string; claimed: boolean }
interface Budget {
  ended: boolean;
  reserved: number;
  readonly channels: Map<string, Channel>;
  readonly tracked: Map<number, Tracked>;
  tail: Promise<void>;
}
interface Binding {
  readonly scope: Scope;
  readonly place: (path: RuntimeFsPath, handle: RuntimeFileHandle) => Awaitable<string | null>;
}
const scopes = new WeakMap<Scope, Budget>();
const bridges = new WeakMap<RuntimeFsBridge, Binding>();

/** Called only by ProcessFiles where each face is bound to its actual descriptor scope. */
export function registerDirectoryReadBridge(fs: RuntimeFsBridge, scope: Scope, place: Binding['place']): void {
  bridges.set(fs, { scope, place });
}

/** A normal close also retires a prefetched handle's accounting. */
export function directoryReadHandleClosed(scope: Scope, id: number): void { scopes.get(scope)?.tracked.delete(id); }

/** The authoritative scope closes descriptions; drop accounting at that same lifetime boundary. */
export function disposeDirectoryReadScope(scope: Scope): void {
  const budget = scopes.get(scope);
  if (!budget) return;
  budget.ended = true;
  budget.channels.clear();
  budget.tracked.clear();
  scopes.delete(scope);
}

export function hasDirectoryReadBridge(fs: RuntimeFsBridge): boolean { return bridges.has(fs); }

function refusal(code: string, message: string): Error { return Object.assign(new Error(`${code}: ${message}`), { code }); }
function codeOf(error: unknown): unknown { return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined; }
const SPECULATIVE_REFUSALS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENXIO', 'ESTALE']);

/**
 * Must be delivered once. Its cached answer keeps the ORIGINAL client's
 * ask time: replaying it never renews lease trust. IDs from an abandoned
 * answer remain charged until a later channel exchange or scope teardown.
 */
export async function readDirectoryBatch(fs: RuntimeFsBridge, input: unknown): Promise<ReadDirectoryBatchResult> {
  const request = Request.parse(input);
  const bound = bridges.get(fs);
  if (!bound) throw refusal('ENOTSUP', 'directory prefetch needs a process descriptor scope');
  const { scope } = bound;
  if (scope.closed) throw refusal('ESTALE', 'directory descriptor scope ended');
  let budget = scopes.get(scope);
  if (!budget) {
    budget = { ended: false, reserved: 0, channels: new Map(), tracked: new Map(), tail: Promise.resolve() };
    scopes.set(scope, budget);
  }
  const live = (): void => { if (scope.closed || budget.ended) throw refusal('ESTALE', 'directory descriptor scope ended'); };
  const run = async (): Promise<ReadDirectoryBatchResult> => {
    live();
    let channel = budget.channels.get(request.channel);
    if (!channel) {
      // A late request from a rewound run cannot close reused descriptor numbers.
      // A close-only, id-free recovery can also establish a channel when
      // its first request never arrived. A late first request is then
      // superseded, and cannot allocate after that recovery acknowledged.
      if (request.retire.length || request.claim.length || (request.sequence !== 1 && request.open.length > 0)) throw refusal('ESTALE', 'unknown directory prefetch channel');
      if (budget.channels.size >= DIRECTORY_PREFETCH_LIMIT) throw refusal('ENOSPC', 'too many directory prefetch channels');
      channel = { sequence: 0 };
      budget.channels.set(request.channel, channel);
    }
    if (request.sequence <= channel.sequence) throw refusal('ESTALE', 'directory batch was already superseded');
    channel.sequence = request.sequence;

    const close = async (id: number): Promise<void> => {
      try { await withRecall(() => fs.close(id)); }
      catch (error) { if (codeOf(error) !== 'EBADF') throw error; }
      budget.tracked.delete(id);
    };
    // Close acknowledgements are idempotent. Process every retirement even
    // if another close reported a failure, then report that failure.
    const closeErrors: unknown[] = [];
    for (const id of request.retire) { try { await close(id); } catch (error) { closeErrors.push(error); } }
    for (const id of request.claim) {
      const record = budget.tracked.get(id);
      if (record?.channel === request.channel) record.claimed = true;
    }
    // Advancing the channel abandons unused entries from its older answer.
    // Already guest-owned descriptions stay open through recall/rename/unlink.
    for (const [id, record] of [...budget.tracked]) {
      if (record.channel === request.channel && !record.claimed) {
        try { await close(id); } catch (error) { closeErrors.push(error); }
      }
    }
    if (closeErrors.length) throw closeErrors[0];
    live();

    const opened: ReadDirectoryDescription[] = [];
    try {
      for (const path of request.open) {
        // Includes reservations for opens awaiting their backend, claimed
        // descriptions and descriptions closed locally but not yet retired.
        if (budget.tracked.size + budget.reserved >= DIRECTORY_PREFETCH_LIMIT) break;
        budget.reserved++;
        let handle: RuntimeFileHandle | undefined;
        try {
          const before = await withRecall(() => fs.stat(path));
          handle = await withRecall(() => fs.open(path, { read: true, directory: true, followSymlinks: true }));
          live();
          const stat = await withRecall(() => fs.fstat(handle!.id));
          let key: string | null;
          try { key = await withRecall(() => bound.place(path, handle!)); }
          catch (error) { if (!SPECULATIVE_REFUSALS.has(String(codeOf(error)))) throw error; key = null; }
          live();
          if (key === null && opened.length > 0) { await close(handle.id); continue; }
          budget.tracked.set(handle.id, { channel: request.channel, claimed: false });
          opened.push({ key, handle, dev: stat.dev, ino: stat.ino,
            openedRevision: before?.dev === stat.dev && before.ino === stat.ino ? before.revision : null });
        } catch (error) {
          if (handle) { try { await close(handle.id); } catch {} }
          live();
          if (opened.length === 0 || !SPECULATIVE_REFUSALS.has(String(codeOf(error)))) throw error;
        } finally { budget.reserved--; }
      }
      live();
      const acquire = await withRecall(() => fs.acquire(request.epoch, request.cursor, { namespace: true, lease: request.lease }));
      live();
      return { channel: request.channel, sequence: request.sequence, opened, acquire,
        retired: [...request.retire], claimed: [...request.claim], outstanding: budget.tracked.size + budget.reserved };
    } catch (error) {
      for (const entry of opened) { try { await close(entry.handle.id); } catch {} }
      throw error;
    }
  };
  const result = budget.tail.then(run);
  budget.tail = result.then(() => {}, () => {});
  return result;
}
