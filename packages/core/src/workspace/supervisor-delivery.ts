/**
 * supervisor-delivery.ts — a process's filesystem mutation, applied at most
 * once however often the platform makes its supervisor send it.
 *
 * The facet → session hop is a Durable Object call the platform drops now
 * and then ("Network connection lost.", `retryable`), and a dropped mutation
 * may or may not have run. So SupervisorRPC mints one delivery id per
 * mutation and re-sends the same one; the host that owns the filesystem
 * applies an id once and answers every repeat from the receipt of the first.
 *
 * The receipts are kept in memory, by the one Durable Object instance that
 * applied them, and never outlive it. A binding carries the incarnation of
 * the instance that minted it (`hostIncarnation` in its props), every
 * delivered envelope carries it back, and an instance refuses — permanently —
 * a delivery minted by any other. A repeat that reaches a restarted instance
 * therefore cannot be applied a second time, and cannot be answered with the
 * dead instance's descriptor numbers. Nothing is lost by that: a process
 * never outlives the instance that spawned it.
 *
 * An answer is held for a bounded time and then dropped, leaving the id as
 * a tombstone: a repeat that arrives later than that — the session stalled —
 * is refused as EIO, outcome unknown, and never applied a second time.
 *
 * The delivered envelope travels under its own op, {@link SUPERVISOR_DELIVER_OP},
 * which a host that predates delivery does not serve. Such a host refuses it —
 * a permanent answer the sender never repeats — rather than applying the
 * mutation without a receipt for its repeat to find.
 */

import {
  VFS_DELIVERY_RECEIPT_RETENTION_MS,
  VFS_DELIVERY_TOMBSTONE_LIMIT,
  VFS_DELIVERY_TOMBSTONE_RETENTION_MS,
} from '../constants.js';
import type { SupervisorOpDispatch, SupervisorOpName } from './supervisor-op.js';

/**
 * The filesystem mutations a process's supervisor delivers exactly once.
 *
 * Not here, so sent once: `writeBatchStream` (its stream is consumed by the
 * first delivery), the descriptor read `fsRead` (it advances the position and
 * answers bytes a receipt would have to hold), `fsAppend`/`fsAppendAck` (the
 * append ledger's own writer/module/operation identity already makes them
 * repeatable), and the process, socket and storage-grant ops.
 */
export const SUPERVISOR_DELIVERED_OPS = [
  'writeFile', 'writeFileStat', 'fsWrite', 'fsWriteRange', 'fsTruncate', 'writeBatch',
  'mkdir', 'rmdir', 'unlink', 'rename', 'symlink',
  'utimes', 'chmod', 'chown',
  'fsOpen', 'fsClose', 'fsDup', 'fsSeek', 'fsSetStatus', 'fsSync',
  'fsFtruncate', 'fsFchmod', 'fsFchown', 'fsFutimes',
  'fsRemove', 'fsCopyFile', 'fsCopyTree',
  'fsAcquireExclusiveMutation', 'fsReleaseExclusiveMutation',
] as const satisfies readonly SupervisorOpName[];

export type SupervisorDeliveredOpName = (typeof SUPERVISOR_DELIVERED_OPS)[number];

const DELIVERED_OP_NAMES = new Map<string, SupervisorDeliveredOpName>(SUPERVISOR_DELIVERED_OPS.map((op) => [op, op]));

/**
 * The delivered mutation `op` names, as this module's own string — a receipt
 * holds that one copy, not the one each envelope arrived with — or undefined
 * for any op that is not delivered once.
 */
export function supervisorDeliveredOp(op: string): SupervisorDeliveredOpName | undefined {
  return DELIVERED_OP_NAMES.get(op);
}

/** The op a delivered mutation travels under; the mutation's own op rides in {@link SupervisorDelivery}. */
export const SUPERVISOR_DELIVER_OP = 'deliverOnce';

/**
 * The filesystem reads a process's supervisor may send more than once — it
 * re-sends a dropped one and hedges an unanswered one — each attempt under
 * the one read id it minted for the read (the envelope's `readId`). A repeat
 * that reaches the host while the read is still being served joins it
 * ({@link SupervisorDeliveries.joinRead}): the host reads once, and every
 * attempt carries that answer. A read is not a mutation, so nothing is kept
 * once it settles, and a host that joins nothing serves each attempt.
 */
export const SUPERVISOR_JOINED_READ_OPS = [
  'access', 'exists', 'stat', 'lstat', 'readdir', 'readlink', 'fsLinkLeadsTo', 'readFile', 'readFileBytes',
  'fsRealpath', 'fsRevision', 'fsList', 'fsAcquire', 'fsAcquired', 'fsFstat', 'fsReaddirHandle',
  'fsReadRange', 'fsReadRangeUncached', 'fsReadBatch', 'hasLegacySymlinkUnder',
] as const satisfies readonly SupervisorOpName[];

export type SupervisorJoinedReadOpName = (typeof SUPERVISOR_JOINED_READ_OPS)[number];

const JOINED_READ_OP_NAMES = new Map<string, SupervisorJoinedReadOpName>(SUPERVISOR_JOINED_READ_OPS.map((op) => [op, op]));

/** The joined read `op` names, or undefined for any op that is not one. */
export function supervisorJoinedReadOp(op: string): SupervisorJoinedReadOpName | undefined {
  return JOINED_READ_OP_NAMES.get(op);
}

/** A read being served, by `${pid}:${readId}`: what a repeat of it joins. */
interface InFlightRead {
  readonly op: SupervisorJoinedReadOpName;
  readonly answer: ReturnType<SupervisorOpDispatch>;
}

/** Which mutation, under which id, for which host instance. The envelope's args are the mutation's. */
export interface SupervisorDelivery {
  readonly op: SupervisorDeliveredOpName;
  /** Minted once per mutation by its sender, and repeated on every attempt. */
  readonly id: string;
  /** The incarnation of the host instance whose binding sent it. */
  readonly hostIncarnation: string;
}

/**
 * What a delivered mutation answers: plain data — a revision, a mutation
 * receipt, a descriptor, a lease, or nothing — which a receipt can hold and
 * hand back unchanged, and which the RPC carries back as it is.
 */
export type SupervisorDeliveryAnswer =
  | undefined
  | null
  | boolean
  | number
  | string
  | readonly SupervisorDeliveryAnswer[]
  | { readonly [key: string]: SupervisorDeliveryAnswer };

type Answered = SupervisorDeliveryAnswer | Promise<SupervisorDeliveryAnswer>;

/**
 * What one attempt of a delivered mutation met: `applied` (it ran the
 * mutation), `replayed` (answered from the settled receipt of an earlier
 * attempt), `awaited` (joined an earlier attempt still running).
 */
export type DeliveryReceipt = 'applied' | 'replayed' | 'awaited';

/** A delivered mutation's answer, and what this attempt met. */
export interface Delivered {
  readonly receipt: DeliveryReceipt;
  readonly answer: Answered;
}

/** A joined read's answer, and whether this attempt joined one being served. */
export interface JoinedRead {
  readonly joined: boolean;
  readonly answer: ReturnType<SupervisorOpDispatch>;
}

function isDeliveryAnswer(value: unknown): value is SupervisorDeliveryAnswer {
  if (value === undefined || value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return true;
    case 'object': {
      if (Array.isArray(value)) return value.every(isDeliveryAnswer);
      const prototype = Object.getPrototypeOf(value);
      return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isDeliveryAnswer);
    }
    default:
      return false;
  }
}

/**
 * `value`, what a delivered mutation's handler returned, as a delivery
 * answer; anything else is refused. Checked where the handler's answer
 * enters the store, so no op can hand a receipt a live object to replay.
 */
export function supervisorDeliveryAnswer(value: unknown): Answered {
  if (value instanceof Promise) return value.then(supervisorDeliveryAnswer);
  if (isDeliveryAnswer(value)) return value;
  throw new TypeError('a delivered mutation answered something other than plain data');
}

interface Receipt {
  readonly op: SupervisorDeliveredOpName;
  readonly answer: Answered;
}

/** Most mutations answer nothing; each op's such receipt is shared rather than made per mutation. */
const ANSWERED_NOTHING = new Map<SupervisorDeliveredOpName, Receipt>(
  SUPERVISOR_DELIVERED_OPS.map((op) => [op, Object.freeze({ op, answer: undefined })]),
);

/** Receipts by pid, then by delivery id. */
type Generation = Map<number, Map<string, Receipt>>;

/** A failure kept as an answer: every repeat meets it. */
function failed<E>(error: E): Promise<never> {
  const answer = Promise.reject(error);
  answer.catch(() => {});
  return answer;
}

/**
 * cyrb53 (bryc, public domain): a 53-bit hash of `text`. A tombstone is one
 * such number rather than the id itself; two live ids share one with
 * probability n / 2^53 — at the tombstone bound, 1.5e-11 per delivery.
 */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export interface SupervisorDeliveriesOptions {
  /** How long a receipt answers at least (and at most twice). */
  receiptMs?: number;
  /** How long a tombstone generation fills before it is the older one. */
  tombstoneMs?: number;
  /** Ids a tombstone generation holds before it is the older one. */
  tombstoneLimit?: number;
}

/**
 * One host instance's receipts, and the ids of those it has dropped.
 *
 * Receipts: two generations, the older dropped whenever the newer has been
 * filling for the retention. A receipt answers for at least the retention
 * after it is recorded and at most twice that, so the set is bounded by the
 * rate of mutation over twice the retention. A mutation still running is
 * held apart until it settles, and never ages out while it runs.
 *
 * Tombstones: a dropped receipt leaves its id, hashed, so a repeat that
 * arrives after its answer is gone — the session stalled past the retention
 * — is refused as EIO, outcome unknown, instead of applied a second time.
 * Two generations again, each filling for the tombstone retention or up to
 * its limit, whichever comes first: a tombstone is held for at least one
 * whole generation, and there are never more than twice the limit.
 */
export class SupervisorDeliveries {
  private minted: string | undefined;
  private current: Generation = new Map();
  private previous: Generation = new Map();
  private rotatedAt = Number.NEGATIVE_INFINITY;
  private readonly running = new Map<string, Receipt>();
  private readonly readsInFlight = new Map<string, InFlightRead>();
  private tombstones = new Set<number>();
  private olderTombstones = new Set<number>();
  private tombstonesSince = Number.NEGATIVE_INFINITY;
  private readonly receiptMs: number;
  private readonly tombstoneMs: number;
  private readonly tombstoneLimit: number;

  constructor(options: SupervisorDeliveriesOptions = {}) {
    this.receiptMs = options.receiptMs ?? VFS_DELIVERY_RECEIPT_RETENTION_MS;
    this.tombstoneMs = options.tombstoneMs ?? VFS_DELIVERY_TOMBSTONE_RETENTION_MS;
    this.tombstoneLimit = options.tombstoneLimit ?? VFS_DELIVERY_TOMBSTONE_LIMIT;
  }

  /**
   * This instance, as the bindings it mints name it. Minted on first use:
   * a store may be opened where workerd forbids random numbers.
   */
  get incarnation(): string {
    return (this.minted ??= crypto.randomUUID());
  }

  /** Tombstones held, both generations: what their bound is stated against. */
  get tombstoneCount(): number {
    return this.tombstones.size + this.olderTombstones.size;
  }

  /**
   * Apply `op` for `pid` once per `id`, and answer every repeat with what the
   * first answered — its value, or its failure — applying nothing; a repeat
   * while the first still runs waits for it, and one that arrives after its
   * answer was dropped is refused, EIO, as its outcome is unknown.
   *
   * The receipt is recorded in the turn `apply` returns or throws in, with
   * nothing that can fail between them, so no mutation is ever applied
   * without the receipt that stops its repeat. It keeps the answer as it
   * was given: a repeat only ever arrives while the mutation's caller is
   * still waiting for that answer, so nothing else holds what the mutation
   * made — a descriptor's number, a lease — to change it in the meantime.
   *
   * The caller has already established that `pid` is a live process of this
   * instance; receipts are its, and are consulted only for it.
   *
   * Returns the answer and what this attempt met ({@link DeliveryReceipt}).
   */
  deliver(pid: number, id: string, op: SupervisorDeliveredOpName, apply: () => Answered): Delivered {
    const now = Date.now();
    this.age(now);
    const key = `${pid}:${id}`;
    const running = this.running.get(key);
    const found = running ?? this.current.get(pid)?.get(id) ?? this.previous.get(pid)?.get(id);
    if (found) {
      if (found.op !== op) {
        throw Object.assign(new Error(`EINVAL: delivery ${id} was ${found.op}, not ${op}`), { code: 'EINVAL' });
      }
      return { receipt: running ? 'awaited' : 'replayed', answer: found.answer };
    }
    const tombstone = hash53(key);
    if (this.tombstones.has(tombstone) || this.olderTombstones.has(tombstone)) {
      throw Object.assign(
        new Error(`EIO: ${op} arrived again after its answer was dropped, so its outcome is unknown`),
        { code: 'EIO' },
      );
    }
    let applied: Answered;
    try {
      applied = apply();
    } catch (error) {
      this.record(pid, id, op, failed(error));
      throw error;
    }
    if (!(applied instanceof Promise)) {
      this.record(pid, id, op, applied);
      return { receipt: 'applied', answer: applied };
    }
    const answer = applied.then(
      (value) => {
        this.running.delete(key);
        this.record(pid, id, op, value);
        return value;
      },
      (error) => {
        this.running.delete(key);
        this.record(pid, id, op, failed(error));
        throw error;
      },
    );
    this.running.set(key, { op, answer });
    return { receipt: 'applied', answer };
  }

  /**
   * Serve read `id` of process `pid` once, however many of its attempts
   * arrive while it is being served. The first runs `read`; a repeat that
   * arrives before it settles is admitted (`admit`: the process is live and
   * is who it says) and answered with the same promise, reading nothing. A
   * read queued here behind the session's read budget, a lazy import or a
   * busy input gate is exactly what the sender's hedge fires on, and joining
   * is what keeps that hedge from reading the same bytes again. Nothing is
   * kept once the read settles: an attempt after that reads afresh, which a
   * read may. The map holds only reads in flight.
   *
   * Returns the answer, and whether this attempt joined a read already
   * being served rather than reading.
   */
  joinRead(
    pid: number,
    id: string,
    op: SupervisorJoinedReadOpName,
    admit: () => void,
    read: () => ReturnType<SupervisorOpDispatch>,
  ): JoinedRead {
    const key = `${pid}:${id}`;
    const running = this.readsInFlight.get(key);
    if (running) {
      if (running.op !== op) {
        throw Object.assign(new Error(`EINVAL: read ${id} is ${running.op}, not ${op}`), { code: 'EINVAL' });
      }
      admit();
      return { joined: true, answer: running.answer };
    }
    const answer = read();
    this.readsInFlight.set(key, { op, answer });
    const settled = (): void => {
      if (this.readsInFlight.get(key)?.answer === answer) this.readsInFlight.delete(key);
    };
    answer.then(settled, settled);
    return { joined: false, answer };
  }

  /** Reads being served, which repeats of them would join. */
  get readsServing(): number {
    return this.readsInFlight.size;
  }

  /** A process ended: its receipts answer nothing more, and their ids stay refused. */
  forget(pid: number): void {
    const now = Date.now();
    for (const generation of [this.current, this.previous]) {
      const receipts = generation.get(pid);
      if (receipts) this.bury(pid, receipts, now);
      generation.delete(pid);
    }
  }

  private record(pid: number, id: string, op: SupervisorDeliveredOpName, answer: Answered): void {
    let receipts = this.current.get(pid);
    if (!receipts) {
      receipts = new Map();
      this.current.set(pid, receipts);
    }
    receipts.set(id, answer === undefined ? ANSWERED_NOTHING.get(op) ?? { op, answer } : { op, answer });
  }

  private age(now: number): void {
    if (now - this.tombstonesSince >= this.tombstoneMs) this.rotateTombstones(now);
    const elapsed = now - this.rotatedAt;
    if (elapsed < this.receiptMs) return;
    for (const [pid, receipts] of this.previous) this.bury(pid, receipts, now);
    if (elapsed < 2 * this.receiptMs) {
      this.previous = this.current;
    } else {
      // Idle through a whole generation: what the newer holds is past the retention too.
      for (const [pid, receipts] of this.current) this.bury(pid, receipts, now);
      this.previous = new Map();
    }
    this.current = new Map();
    this.rotatedAt = now;
  }

  private bury(pid: number, receipts: Map<string, Receipt>, now: number): void {
    for (const id of receipts.keys()) {
      if (this.tombstones.size >= this.tombstoneLimit) this.rotateTombstones(now);
      this.tombstones.add(hash53(`${pid}:${id}`));
    }
  }

  private rotateTombstones(now: number): void {
    // Nothing buried through a whole generation: the newer is past its span too.
    this.olderTombstones = now - this.tombstonesSince < 2 * this.tombstoneMs ? this.tombstones : new Set();
    this.tombstones = new Set();
    this.tombstonesSince = now;
  }
}

const hosts = new WeakMap<object, SupervisorDeliveries>();

/**
 * The delivery store of the Durable Object instance whose state `ctx` is,
 * opened by the host that serves its supervisor ops — once, before it spawns
 * anything, so every binding it mints can name it.
 */
export function openSupervisorDeliveries(ctx: object): SupervisorDeliveries {
  let deliveries = hosts.get(ctx);
  if (!deliveries) {
    deliveries = new SupervisorDeliveries();
    hosts.set(ctx, deliveries);
  }
  return deliveries;
}

/**
 * What to spread into the props of a SUPERVISOR binding minted for a process
 * of the instance whose state `ctx` is: its `hostIncarnation`, or nothing
 * when that host applies nothing once — and then the binding sends each
 * mutation once.
 */
export function supervisorDeliveryProps(ctx: object): { hostIncarnation?: string } {
  const deliveries = hosts.get(ctx);
  return deliveries === undefined ? {} : { hostIncarnation: deliveries.incarnation };
}
