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
 * The delivered envelope travels under its own op, {@link SUPERVISOR_DELIVER_OP},
 * which a host that predates delivery does not serve. Such a host refuses it —
 * a permanent answer the sender never repeats — rather than applying the
 * mutation without a receipt for its repeat to find.
 */

import { VFS_DELIVERY_RECEIPT_RETENTION_MS } from '../constants.js';
import type { RuntimeFileHandle, VfsMutationReceipt } from '../runtime/os-contracts.js';
import type { SupervisorOpName } from './supervisor-op.js';

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
  'writeFile', 'fsWrite', 'fsWriteRange', 'fsTruncate', 'writeBatch',
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

/** Which mutation, under which id, for which host instance. The envelope's args are the mutation's. */
export interface SupervisorDelivery {
  readonly op: SupervisorDeliveredOpName;
  /** Minted once per mutation by its sender, and repeated on every attempt. */
  readonly id: string;
  /** The incarnation of the host instance whose binding sent it. */
  readonly hostIncarnation: string;
}

/** What a delivered mutation answers. */
export type SupervisorDeliveryAnswer =
  | void
  | number
  | VfsMutationReceipt
  | RuntimeFileHandle
  | { readonly root: string; readonly owner: string }
  | { readonly inodes: number; readonly chunks: number };

type Answered = SupervisorDeliveryAnswer | Promise<SupervisorDeliveryAnswer>;

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
 * One host instance's receipts.
 *
 * Two generations, the older dropped whenever the newer has been filling for
 * the retention: a receipt is held at least that long after it is recorded
 * and at most twice that, so the set is bounded by the rate of mutation over
 * twice the retention and is pruned in O(1). A mutation still running is held
 * apart until it settles, and never ages out while it runs.
 */
export class SupervisorDeliveries {
  private minted: string | undefined;
  private current: Generation = new Map();
  private previous: Generation = new Map();
  private rotatedAt = Number.NEGATIVE_INFINITY;
  private readonly running = new Map<string, Receipt>();

  constructor(private readonly retentionMs: number = VFS_DELIVERY_RECEIPT_RETENTION_MS) {}

  /**
   * This instance, as the bindings it mints name it. Minted on first use:
   * a store may be opened where workerd forbids random numbers.
   */
  get incarnation(): string {
    return (this.minted ??= crypto.randomUUID());
  }

  /**
   * Apply `op` for `pid` once per `id`, and answer every repeat with what the
   * first answered — its value, or its failure — applying nothing; a repeat
   * while the first still runs waits for it.
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
   */
  deliver(pid: number, id: string, op: SupervisorDeliveredOpName, apply: () => Answered): Answered {
    this.age(Date.now());
    const key = `${pid}:${id}`;
    const found = this.running.get(key) ?? this.current.get(pid)?.get(id) ?? this.previous.get(pid)?.get(id);
    if (found) {
      if (found.op !== op) {
        throw Object.assign(new Error(`EINVAL: delivery ${id} was ${found.op}, not ${op}`), { code: 'EINVAL' });
      }
      return found.answer;
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
      return applied;
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
    return answer;
  }

  /** A process ended: its receipts answer nothing any more. */
  forget(pid: number): void {
    this.current.delete(pid);
    this.previous.delete(pid);
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
    const elapsed = now - this.rotatedAt;
    if (elapsed < this.retentionMs) return;
    // Idle through a whole generation: what the newer holds is past the retention too.
    this.previous = elapsed < 2 * this.retentionMs ? this.current : new Map();
    this.current = new Map();
    this.rotatedAt = now;
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
