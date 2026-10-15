/**
 * The inline `node`'s realm protocol (node-realm.ts): what the guest
 * (node-guest.ts) and this side send each other, and the guards each narrows
 * what it receives with. The guest loads this and not the host's half.
 */
import type { RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../../runtime/os-contracts.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { VfsEvent } from '../../../../vfs/events.js';
import { isEgressGuestEvent, isEgressHostEvent, type EgressGuestEvent, type EgressHostEvent } from '../../../../runtime/realm-egress.js';
import type { NodeProgram } from './node-program.js';
import type { VirtualRequest } from '../../kernel/index.js';

/** The filesystem methods a call names: NodeFilesystem's, but its watch (a call of its own). */
export type FsMethod = Exclude<keyof NodeFilesystem, 'watch'>;

/** A synchronous call the guest makes. */
export type NodeCall =
  | { readonly op: 'fs'; readonly method: FsMethod; readonly args: readonly unknown[] }
  | { readonly op: 'stdin' }
  | { readonly op: 'listen'; readonly port: number }
  | { readonly op: 'unlisten'; readonly port: number }
  /** Watch `path` as watch `id` (NodeFilesystem.watch); a null path stops it. */
  | { readonly op: 'watch'; readonly id: number; readonly path: string | null }
  /** umask(2): the mask the program creates with from now on (its own copy: the shell's is not changed). */
  | { readonly op: 'umask'; readonly mask: number }
  /**
   * Answered once output writes up to number `upTo` are made or failed (the
   * writes come on the event channel, which this call does not wait behind):
   * the outputs that have failed (OutputFailure). The program's code has run,
   * and it hears of a failure before it ends.
   */
  | { readonly op: 'flush'; readonly upTo: number };

/** An output whose write failed: with `code`, on a pipe or a file. */
export interface OutputFailure { readonly fd: 1 | 2; readonly code: string; readonly pipe: boolean }

export function isOutputFailures(value: unknown): value is readonly OutputFailure[] {
  return Array.isArray(value) && value.every((failure) => record(failure) && (failure.fd === 1 || failure.fd === 2)
    && typeof failure.code === 'string' && typeof failure.pipe === 'boolean');
}

/** A response to a request that stayed on the box, as data, either way across. */
export interface RealmResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array;
}

/** What the guest posts on `events`. */
export type GuestEvent =
  /** An output write: the host counts them, both outputs together, in the order they come (a flush's and a settle's numbers). */
  | { readonly type: 'output'; readonly fd: 1 | 2; readonly data: string | Uint8Array }
  /** A write made after the program's code has run (a timer's) waits: tell it once every write so far is made (output-settled). */
  | { readonly type: 'settle' }

  | { readonly type: 'fetch'; readonly id: number; readonly port: number; readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: string | Uint8Array | null }
  | { readonly type: 'served'; readonly id: number; readonly response: RealmResponse | null }
  /** Its status; `ended`, it ended itself (process.exit, a fatal error): a write that fails later is no one's. */
  | { readonly type: 'exit'; readonly code: number; readonly ended: boolean }
  /** The program reached its stream of output `fd`, which a failed write errors: unheard, the program ends of it. */
  | { readonly type: 'stream'; readonly fd: 1 | 2 }
  /** The guest took the failure of output `fd` (output-failed): whatever the program makes of it, it is the guest's. */
  | { readonly type: 'heard'; readonly fd: 1 | 2 }
  | EgressGuestEvent;

/** What this side posts on `events`. */
export type HostEvent =
  | { readonly type: 'fetched'; readonly id: number; readonly response: RealmResponse | null }
  | { readonly type: 'serve'; readonly id: number; readonly port: number; readonly request: VirtualRequest }
  /** A change watch `id` was told. */
  | { readonly type: 'changed'; readonly id: number; readonly event: VfsEvent }
  /**
   * A write to output `fd` failed with `code`, on a pipe or a file: the
   * program's stream of it errors, as Node's does, and no later write is made.
   */
  | { readonly type: 'output-failed'; readonly fd: 1 | 2; readonly code: string; readonly pipe: boolean }
  /**
   * Every output write up to number `seq` is made or failed (a failure told
   * first): told, once asked (settle), when no later write waits.
   */
  | { readonly type: 'output-settled'; readonly seq: number }
  | EgressHostEvent;

/**
 * What the realm starts with: the program, the kernel's /etc/hosts its
 * dns.lookup answers from, and whether its network goes through an egress.
 */
export interface NodeRealmPayload {
  readonly program: NodeProgram;
  readonly hosts?: string;
  /**
   * The workspace's network goes through its host's egress: every request
   * the program makes off the box crosses here (`egress`) and leaves through
   * it; a WebSocket, which cannot cross, is refused by name.
   */
  readonly egress: boolean;
}

// ── The protocol's messages, narrowed where they arrive ─────────────────────
// Each side receives a structured clone it must narrow: a guard per shape.

export const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const stringRecord = (value: unknown): value is Record<string, string> =>
  record(value) && Object.values(value).every((entry) => typeof entry === 'string');

const isResponse = (value: unknown): value is RealmResponse | null =>
  value === null || (record(value) && typeof value.status === 'number' && stringRecord(value.headers)
    && (typeof value.body === 'string' || value.body instanceof Uint8Array));

export function isGuestEvent(value: unknown): value is GuestEvent {
  if (isEgressGuestEvent(value)) return true;
  if (!record(value)) return false;
  switch (value.type) {
    case 'output': return (value.fd === 1 || value.fd === 2) && (typeof value.data === 'string' || value.data instanceof Uint8Array);
    case 'settle': return true;
    case 'fetch':
      return Number.isSafeInteger(value.id) && Number.isSafeInteger(value.port) && typeof value.url === 'string'
        && typeof value.method === 'string' && stringRecord(value.headers)
        && (value.body === null || typeof value.body === 'string' || value.body instanceof Uint8Array);
    case 'served': return Number.isSafeInteger(value.id) && isResponse(value.response);
    case 'exit': return Number.isSafeInteger(value.code) && typeof value.ended === 'boolean';
    case 'stream':
    case 'heard': return value.fd === 1 || value.fd === 2;
    default: return false;
  }
}

export function isHostEvent(value: unknown): value is HostEvent {
  if (isEgressHostEvent(value)) return true;
  if (!record(value)) return false;
  switch (value.type) {
    case 'fetched': return typeof value.id === 'number' && isResponse(value.response);
    case 'serve': return typeof value.id === 'number' && typeof value.port === 'number' && record(value.request);
    case 'changed':
      return Number.isSafeInteger(value.id) && record(value.event)
        && (value.event.type === 'add' || value.event.type === 'change' || value.event.type === 'unlink'
          || value.event.type === 'addDir' || value.event.type === 'unlinkDir' || value.event.type === 'rename')
        && typeof value.event.path === 'string'
        && (value.event.oldPath === undefined || typeof value.event.oldPath === 'string')
        && typeof value.event.timestamp === 'number';
    case 'output-failed':
      return (value.fd === 1 || value.fd === 2) && typeof value.code === 'string' && typeof value.pipe === 'boolean';
    case 'output-settled': return Number.isSafeInteger(value.seq);
    default: return false;
  }
}

const identityId = (value: unknown): boolean => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;

export function isNodeRealmPayload(value: unknown): value is NodeRealmPayload {
  if (!record(value) || !record(value.program) || typeof value.program.source !== 'string') return false;
  const identity = value.program.identity;
  return record(identity) && identityId(identity.pid) && identityId(identity.uid) && identityId(identity.gid) && identityId(identity.umask)
    && Array.isArray(identity.groups) && identity.groups.every(identityId)
    && (value.hosts === undefined || typeof value.hosts === 'string') && typeof value.egress === 'boolean';
}

export function isStat(value: unknown): value is RuntimeVfsStat {
  return record(value) && typeof value.type === 'string' && typeof value.mode === 'number' && typeof value.size === 'number';
}

export function isDirEntries(value: unknown): value is RuntimeVfsDirEntry[] {
  return Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.name === 'string' && typeof entry.type === 'string');
}
