/**
 * The inline `node`'s realm protocol (node-realm.ts): what the guest
 * (node-guest.ts) and this side send each other, and the guards each narrows
 * what it receives with. The guest loads this and not the host's half.
 */
import type { RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../../runtime/os-contracts.js';
import type { NodeFilesystem } from '../../node-compat/filesystem.js';
import type { OutputSource } from '../../node-compat/standard-streams.js';
import type { VfsEvent } from '../../../../vfs/events.js';
import { isEgressGuestEvent, isEgressHostEvent, type EgressGuestEvent, type EgressHostEvent } from '../../../../runtime/realm-egress.js';
import type { NodeProgram } from './node-program.js';
import type { RealmError } from '../../../../runtime/realm.js';
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
  /** Whether standard descriptor `fd` is the terminal, a pipe, or neither. */
  | { readonly op: 'fdKind'; readonly fd: number }
  /** The terminal's raw mode, on or off (tty.ReadStream.setRawMode). */
  | { readonly op: 'rawMode'; readonly on: boolean }
  /**
   * Answered once output writes up to number `upTo` are made, with those
   * after number `after` that failed (since `round`'s settle-mark): the
   * writes a program's 'beforeExit' listeners made in that round, made before
   * its loop is asked again, as Node's writes to a pipe or a file are.
   */
  | { readonly op: 'settle'; readonly round: number; readonly after: number; readonly upTo: number };

/** What a standard descriptor is, as libuv tells a stream it can make from it. */
export type FdKind = 'terminal' | 'pipe' | 'other';

/**
 * A failed write: its number (`seq`, as the host numbers writes), its
 * descriptor, its error, and what made it (its source, and which of the
 * program's writers of `fd`: 0 is process.stdout or process.stderr, and its
 * console).
 */
export interface OutputFailure { readonly seq: number; readonly fd: 1 | 2; readonly code: string; readonly pipe: boolean; readonly source: OutputSource; readonly writer: number }


/** A response to a request that stayed on the box, as data, either way across. */
export interface RealmResponse {
  readonly status: number;
  /** Its reason phrase, when its server named one. */
  readonly statusText?: string;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array;
}

/** What the guest posts on `events`. */
export type GuestEvent =
  /** An output write, through `source`: the host numbers them, both outputs together, in the order they come (a settle's numbers). */
  | { readonly type: 'output'; readonly fd: 1 | 2; readonly source: OutputSource; readonly writer: number; readonly data: string | Uint8Array }
  /** The program's loop ran empty, and it would hear of a failed write: tell it once writes up to number `upTo` are made (output-settled). */
  | { readonly type: 'settle'; readonly upTo: number }
  /**
   * The program's 'beforeExit' is about to be emitted (its round number
   * `round`, counting from 1) with writes up to number `after` posted: the
   * failures of those after it are the answer of the round's settle call,
   * and no output-failed of theirs is posted. Rounds are told apart by
   * number: two can start at the same write number.
   */
  | { readonly type: 'settle-mark'; readonly round: number; readonly after: number }

  | { readonly type: 'fetch'; readonly id: number; readonly port: number; readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: string | Uint8Array | null }
  | { readonly type: 'served'; readonly id: number; readonly response: RealmResponse | null }
  /** Its status; `ended`, it ended itself (process.exit, a fatal error): a write that fails later is no one's. */
  | { readonly type: 'exit'; readonly code: number; readonly ended: boolean }
  /** The guest took a failure of output `fd`'s writer `writer` (output-failed), or the writer closed: whatever the program makes of its failures, they are the guest's. */
  | { readonly type: 'heard'; readonly fd: 1 | 2; readonly writer: number }
  /** fd 0's next piece, wanted as read `id` (process.stdin). */
  | { readonly type: 'stdin-read'; readonly id: number }
  /** Read `id` is withdrawn: what has not arrived stays on fd 0. */
  | { readonly type: 'stdin-cancel'; readonly id: number }
  | EgressGuestEvent;

/** What this side posts on `events`. */
export type HostEvent =
  | { readonly type: 'fetched'; readonly id: number; readonly response: RealmResponse | null }
  | { readonly type: 'serve'; readonly id: number; readonly port: number; readonly request: VirtualRequest }
  /** A change watch `id` was told. */
  | { readonly type: 'changed'; readonly id: number; readonly event: VfsEvent }
  /** A write failed: the stream's, its error; the console's, heard only by a listener on the stream, as Node's console ignores it. */
  | ({ readonly type: 'output-failed' } & OutputFailure)
  /** Every output write up to number `seq` is made or failed (a failure told first): told once asked (settle). */
  | { readonly type: 'output-settled'; readonly seq: number }
  /** Read `id`'s answer, once: its piece of fd 0 (null at its end), its error, or that it was withdrawn before anything arrived. */
  | { readonly type: 'stdin'; readonly id: number; readonly data: Uint8Array | null }
  | { readonly type: 'stdin'; readonly id: number; readonly error: RealmError }
  | { readonly type: 'stdin'; readonly id: number; readonly withdrawn: true }
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

const isOutputSource = (value: unknown): value is OutputSource => value === 'stream' || value === 'console';

const isResponse = (value: unknown): value is RealmResponse | null =>
  value === null || (record(value) && typeof value.status === 'number' && stringRecord(value.headers)
    && (value.statusText === undefined || typeof value.statusText === 'string')
    && (typeof value.body === 'string' || value.body instanceof Uint8Array));

export function isGuestEvent(value: unknown): value is GuestEvent {
  if (isEgressGuestEvent(value)) return true;
  if (!record(value)) return false;
  switch (value.type) {
    case 'output': return (value.fd === 1 || value.fd === 2) && isOutputSource(value.source) && Number.isSafeInteger(value.writer) && (typeof value.data === 'string' || value.data instanceof Uint8Array);
    case 'settle': return Number.isSafeInteger(value.upTo);
    case 'settle-mark': return Number.isSafeInteger(value.round) && Number.isSafeInteger(value.after);
    case 'fetch':
      return Number.isSafeInteger(value.id) && Number.isSafeInteger(value.port) && typeof value.url === 'string'
        && typeof value.method === 'string' && stringRecord(value.headers)
        && (value.body === null || typeof value.body === 'string' || value.body instanceof Uint8Array);
    case 'served': return Number.isSafeInteger(value.id) && isResponse(value.response);
    case 'exit': return Number.isSafeInteger(value.code) && typeof value.ended === 'boolean';
    case 'heard': return (value.fd === 1 || value.fd === 2) && Number.isSafeInteger(value.writer);
    case 'stdin-read':
    case 'stdin-cancel': return Number.isSafeInteger(value.id);
    default: return false;
  }
}

export function isOutputFailures(value: unknown): value is readonly OutputFailure[] {
  return Array.isArray(value) && value.every((failure) => record(failure) && Number.isSafeInteger(failure.seq) && (failure.fd === 1 || failure.fd === 2)
    && typeof failure.code === 'string' && typeof failure.pipe === 'boolean' && isOutputSource(failure.source) && Number.isSafeInteger(failure.writer));
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
      return Number.isSafeInteger(value.seq) && (value.fd === 1 || value.fd === 2) && typeof value.code === 'string' && typeof value.pipe === 'boolean' && isOutputSource(value.source) && Number.isSafeInteger(value.writer);
    case 'output-settled': return Number.isSafeInteger(value.seq);
    case 'stdin':
      return Number.isSafeInteger(value.id) && (value.data === null || value.data instanceof Uint8Array || value.withdrawn === true
        || (record(value.error) && typeof value.error.name === 'string' && typeof value.error.message === 'string' && record(value.error.properties)));
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
