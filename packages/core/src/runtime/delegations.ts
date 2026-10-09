/**
 * Delegations, the session's half of the protocol (spike/delegation/MEMO.md):
 * a process holds a subtree as a recallable exclusive-mutation lease
 * (SqliteVFS, ExclusiveMutationOptions.delegation), decides its operations
 * itself, and sends them later as writes under the lease. When another
 * caller's access needs them, the engine recalls the delegation; this is
 * where that recall reaches the holder and where its answer comes back.
 *
 * The holder keeps one recall request outstanding (awaitRecall, a long poll
 * answered with the next recall, or with nothing after `waitMs`). A recall
 * asks it to send what it decided and then either keep sending each
 * operation as it decides it ('share': another caller reads the subtree) or
 * give the subtree up ('revoke': another caller writes it); the holder says
 * it has (recalled). A holder that has not answered within the recall
 * timeout is revoked anyway: its lease ends, so every write it sends later
 * is ESTALE (the lease is the fence), `revoked` is told so the host can stop
 * it, and the caller that recalled it goes on. What it had not sent is lost,
 * as a process's unflushed writes are when it dies: no one observed them.
 *
 * A delegation ends with its holder: releasing the process's scope releases
 * it (its subscriptions are the scope's to dispose).
 */

import type { DelegationTerms } from '../vfs/sqlite-vfs.js';
import type { ExclusiveMutationGrant, RecallKind } from './os-contracts.js';
import { pathsOverlap } from '../vfs/path.js';
import { SESSION_KERNEL_ROOTS } from '../_shared/read-lease-cover.js';

/**
 * How long a holder has to answer a recall (T): send what it decided and
 * say so. A holder making syscalls answers within one recall round trip and
 * one wave's flush; one that has not answered by then is taken to be unable
 * to (a long computation with nothing sent, the documented limit), and is
 * revoked. Measured live (2026-10-06, six sessions): a one-file wave
 * published alone took 34-66 ms at the median, 40-73 ms at p95, 627 ms at
 * the slowest (the first, which opens the writer); a full wave (1,016
 * files, 4 MiB) is under a second at the measured ingest rate. Five
 * seconds is several times their sum. The core README's process model
 * documents it.
 */
export const DELEGATION_RECALL_TIMEOUT_MS = 5_000;

/**
 * The session's own timers, taken when this module is evaluated: a program
 * that shares the realm (a resident body run in-process) wraps the global
 * ones as its own resumptions, and a recall's wait is not one of them.
 */
const sessionTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };

/** How long one awaitRecall waits before it answers that nothing is asked (the holder asks again). */
export const DELEGATION_RECALL_POLL_MS = 25_000;

/**
 * How long a read lease's holder trusts it after it asked the barrier that
 * confirmed it (ProcessFsClient.readLeased): past it, the holder asks again.
 * A recall its holder does not answer waits at most this long after the
 * confirmation (plus READ_LEASE_MARGIN_MS), never a stopped process: the
 * holder no longer answers from the lease by then. A holder that is not
 * reading (no barrier within it) costs a writer nothing.
 */
export const READ_LEASE_TRUST_MS = 500;
/** What a writer waits past a read lease's trust, for the holder's clock against the session's. */
export const READ_LEASE_MARGIN_MS = 50;


/** What the host is told when it must stop a holder that did not answer a recall in time. */
export interface DelegationRevoked {
  readonly pid: number;
  readonly root: string;
  readonly kind: RecallKind;
  readonly reason: string;
}

interface Held {
  readonly pid: number;
  readonly owner: string;
  readonly root: string;
  /** Recalls asked and not yet handed to the holder's awaitRecall, oldest first. */
  readonly asked: RecallKind[];
  /** The holder's outstanding awaitRecall, if one is waiting. */
  waiter: ((kind: RecallKind | null) => void) | null;
  /** The recall it is answering: settled by recalled (which cancels its timeout), or by the timeout. */
  pending: { kind: RecallKind; done: () => void; cancel: () => void } | null;
  /** Lets the engine's lease go and forgets it (the scope's disposer). */
  end(): void;
  /** A read lease's (readLease): when the session last confirmed it to its holder. */
  read: { confirmedAt: number } | null;
  /** The holder's scope, which disposes of it when the process ends. */
  readonly scope: { readonly subscriptions: Set<() => void> };
}

export interface DelegationsOptions {
  /** Releases the lease `owner` names (the engine's). */
  readonly release: (owner: string) => void;
  /** Told of a holder revoked for not answering, so the host can stop it. */
  readonly revoked?: (event: DelegationRevoked) => void;
  /**
   * Told of a holder that ended still holding a delegation (killed, or gone
   * without giving it back): what it decided there and had not sent is
   * lost, and the host says so where the process's output goes.
   */
  readonly orphaned?: (event: { readonly pid: number; readonly root: string }) => void;
  readonly recallTimeoutMs?: number;
}

const NONE: ReadonlySet<string> = new Set();

/** What the session's delegations did since it started (the diag route's). */
export interface DelegationStats {
  readonly held: number;
  readonly grants: number;
  readonly recalls: { readonly share: number; readonly revoke: number };
  /** Holders revoked for not answering within the recall timeout. */
  readonly timedOut: number;
  /** Read leases granted, recalls of them answered, and recalls whose holder's trust ran out first. */
  readonly reads: {
    readonly granted: number;
    readonly answered: number;
    readonly expired: number;
    /** What writers waited on recalls of them, in all and at the longest (ms). */
    readonly waitMs: number;
    readonly longestWaitMs: number;
  };
}

export class Delegations {
  private readonly held = new Map<string, Held>();
  private readonly counts = {
    grants: 0, share: 0, revoke: 0, timedOut: 0,
    readGranted: 0, readAnswered: 0, readExpired: 0, readWaitMs: 0, readLongestWaitMs: 0,
  };
  /** Each holder's leases. */
  private readonly byPid = new Map<number, Set<string>>();
  /**
   * When each process's read lease was last recalled: it is granted none
   * for READ_LEASE_TRUST_MS after, so the writer's next change (a save is
   * several) waits on no one, and the reader asks at each barrier meanwhile.
   */
  private readonly readRecalled = new Map<number, number>();
  private readonly recallTimeoutMs: number;

  constructor(private readonly options: DelegationsOptions) {
    this.recallTimeoutMs = options.recallTimeoutMs ?? DELEGATION_RECALL_TIMEOUT_MS;
  }

  /**
   * Delegate to process `pid`: `acquire` takes the lease with the terms this
   * makes (the process's own bridge, so its path and permission are checked
   * as any lease's). `scope` disposes of it when the process ends.
   */
  grant(
    pid: number,
    asked: { readonly reads: boolean; readonly inos?: number; readonly bytes?: number },
    acquire: (terms: DelegationTerms) => ExclusiveMutationGrant,
    scope: { readonly subscriptions: Set<() => void> },
  ): ExclusiveMutationGrant {
    let held: Held | null = null;
    const terms: DelegationTerms = {
      reads: asked.reads,
      ...(asked.inos === undefined ? {} : { inos: asked.inos }),
      ...(asked.bytes === undefined ? {} : { bytes: asked.bytes }),
      admit: (root) => {
        const kernelRoot = SESSION_KERNEL_ROOTS.find((store) => pathsOverlap(root, store));
        if (kernelRoot !== undefined) {
          throw Object.assign(new Error(`EPERM: /${root} holds the session's own /${kernelRoot}; it is not delegated`), { code: 'EPERM' });
        }
      },
      recall: (kind) => {
        if (held === null || this.held.get(held.owner) !== held) return Promise.resolve();
        return this.recall(held, kind);
      },
    };
    const lease = acquire(terms);
    this.counts.grants++;
    const end = (): void => {
      if (this.held.get(lease.owner) !== held) return;
      this.forget(held!);
      if (held!.pending !== null) {
        held!.pending.cancel();
        held!.pending.done();
      }
      this.options.release(lease.owner);
    };
    held = { pid, owner: lease.owner, root: lease.root, asked: [], waiter: null, pending: null, end, scope, read: null };
    this.held.set(lease.owner, held);
    this.holdsOf(pid, scope).add(lease.owner);
    // The process ended holding it: reported, then given up.
    scope.subscriptions.add(() => {
      if (this.held.get(lease.owner) === held) this.options.orphaned?.({ pid, root: lease.root });
      end();
    });
    return { ...lease, recallTimeoutMs: this.recallTimeoutMs };
  }

  /**
   * Process `pid`'s read lease (SqliteVFS.acquireReadLease), confirmed: the
   * one it holds, unless a recall of it is asked, or one `acquire` takes now.
   * Asked at the barrier that brought the holder current (fsAcquire with
   * `lease`), in the same turn, so it is granted at the revision that answer
   * reported. Null when its recall is asked (the holder answers it first).
   */
  readLease(
    pid: number,
    acquire: (terms: DelegationTerms) => { readonly owner: string },
    scope: { readonly subscriptions: Set<() => void> },
  ): { owner: string; trustMs: number } | null {
    const now = Date.now();
    for (const owner of this.heldBy(pid)) {
      const held = this.held.get(owner);
      if (held?.read == null) continue;
      if (held.pending !== null || held.asked.length > 0) return null;
      held.read.confirmedAt = now;
      return { owner, trustMs: READ_LEASE_TRUST_MS };
    }
    if (now - (this.readRecalled.get(pid) ?? -Infinity) < READ_LEASE_TRUST_MS) return null;
    let held: Held | null = null;
    const terms: DelegationTerms = {
      reads: false,
      // The session's own stores are written synchronously, and never leased.
      excludes: SESSION_KERNEL_ROOTS,
      lapsed: () => {
        if (held === null || this.held.get(held.owner) !== held) return true;
        if (held.read!.confirmedAt + READ_LEASE_TRUST_MS + READ_LEASE_MARGIN_MS > Date.now()) return false;
        this.counts.readExpired++;
        held.end();
        return true;
      },
      recall: (kind) => {
        if (held === null || this.held.get(held.owner) !== held) return Promise.resolve();
        return this.recall(held, kind);
      },
    };
    const lease = acquire(terms);
    this.counts.readGranted++;
    const end = (): void => {
      if (this.held.get(lease.owner) !== held) return;
      this.forget(held!);
      if (held!.pending !== null) {
        held!.pending.cancel();
        held!.pending.done();
      }
      this.options.release(lease.owner);
    };
    held = { pid, owner: lease.owner, root: '', asked: [], waiter: null, pending: null, end, scope, read: { confirmedAt: now } };
    this.held.set(lease.owner, held);
    this.holdsOf(pid, scope).add(lease.owner);
    // Its holder decided nothing: ending with it loses nothing, and says nothing.
    scope.subscriptions.add(end);
    return { owner: lease.owner, trustMs: READ_LEASE_TRUST_MS };
  }

  /** The next recall of `owner`'s delegation, as soon as one is asked; null after `waitMs` with none, or once it has ended. */
  awaitRecall(pid: number, owner: string, waitMs = DELEGATION_RECALL_POLL_MS): Promise<RecallKind | null> {
    const held = this.holderOf(pid, owner);
    const asked = held.asked.shift();
    if (asked !== undefined) return Promise.resolve(asked);
    held.waiter?.(null);
    // The executor form: core's TypeScript lib (ES2022) has no Promise.withResolvers.
    return new Promise((resolve) => {
      const answer = (kind: RecallKind | null): void => {
        sessionTimers.clearTimeout(timer);
        if (held.waiter === answer) held.waiter = null;
        resolve(kind);
      };
      const timer = sessionTimers.setTimeout(() => answer(null), Math.max(0, waitMs));
      held.waiter = answer;
    });
  }

  /** The holder has sent what it decided, and done what recall `kind` asked. */
  recalled(pid: number, owner: string, kind: RecallKind): void {
    const held = this.holderOf(pid, owner);
    const pending = held.pending;
    if (pending === null || pending.kind !== kind) return;
    held.pending = null;
    pending.cancel();
    pending.done();
    if (held.read !== null) this.counts.readAnswered++;
    // Revoked: the engine ends the lease; this forgets it.
    if (kind === 'revoke') this.forget(held);
  }

  /** The holder gives the delegation up (what it decided is sent). */
  release(pid: number, owner: string): void {
    this.holderOf(pid, owner).end();
  }

  /** Whether `owner` is a delegation `pid` holds (its lease is released here, not by a plain release). */
  holds(pid: number, owner: string): boolean {
    return this.held.get(owner)?.pid === pid;
  }

  /** The leases of every delegation `pid` holds: what its own calls are made by. */
  heldBy(pid: number): ReadonlySet<string> {
    return this.byPid.get(pid) ?? NONE;
  }

  /**
   * The leases process `pid` holds, as one set for as long as its `scope`
   * lives: a call that began before it took one (a wave in flight when its
   * read lease is granted) is made by that one too.
   */
  holdsOf(pid: number, scope: { readonly subscriptions: Set<() => void> }): Set<string> {
    let owned = this.byPid.get(pid);
    if (owned === undefined) {
      const made = owned = new Set();
      this.byPid.set(pid, made);
      scope.subscriptions.add(() => {
        if (this.byPid.get(pid) !== made) return;
        this.byPid.delete(pid);
        this.readRecalled.delete(pid);
      });
    }
    return owned;
  }

  get size(): number {
    return this.held.size;
  }

  stats(): DelegationStats {
    return {
      held: this.held.size,
      grants: this.counts.grants,
      recalls: { share: this.counts.share, revoke: this.counts.revoke },
      timedOut: this.counts.timedOut,
      reads: {
        granted: this.counts.readGranted, answered: this.counts.readAnswered, expired: this.counts.readExpired,
        waitMs: this.counts.readWaitMs, longestWaitMs: this.counts.readLongestWaitMs,
      },
    };
  }

  private recall(held: Held, kind: RecallKind): Promise<void> {
    if (held.read !== null) return this.recallRead(held);
    this.counts[kind]++;
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => { resolve = settle; });
    const timer = sessionTimers.setTimeout(() => {
      // Unanswered: revoked, its lease ended (its later writes are ESTALE),
      // and the caller that recalled it goes on.
      held.pending = null;
      held.end();
      this.counts.timedOut++;
      this.options.revoked?.({ pid: held.pid, root: held.root, kind, reason: `no answer to a ${kind} recall within ${this.recallTimeoutMs} ms` });
      resolve();
    }, this.recallTimeoutMs);
    held.pending = { kind, done: resolve, cancel: () => sessionTimers.clearTimeout(timer) };
    if (held.waiter !== null) held.waiter(kind);
    else held.asked.push(kind);
    return promise;
  }

  /**
   * A read lease's recall: asked of its holder, and answered, or over once
   * the holder's trust in it has run out (it reads nothing from it by then):
   * the lease ends either way, and no one is stopped. A holder whose trust
   * ran out already is not asked.
   */
  private recallRead(held: Held): Promise<void> {
    this.readRecalled.set(held.pid, Date.now());
    const trustLeft = held.read!.confirmedAt + READ_LEASE_TRUST_MS + READ_LEASE_MARGIN_MS - Date.now();
    if (trustLeft <= 0) {
      this.counts.readExpired++;
      held.end();
      return Promise.resolve();
    }
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => { resolve = settle; });
    const timer = sessionTimers.setTimeout(() => {
      held.pending = null;
      this.counts.readExpired++;
      held.end();
      resolve();
    }, trustLeft);
    held.pending = { kind: 'revoke', done: resolve, cancel: () => sessionTimers.clearTimeout(timer) };
    if (held.waiter !== null) held.waiter('revoke');
    else held.asked.push('revoke');
    const asked = Date.now();
    return promise.then(() => {
      const waited = Date.now() - asked;
      this.counts.readWaitMs += waited;
      this.counts.readLongestWaitMs = Math.max(this.counts.readLongestWaitMs, waited);
    });
  }

  private forget(held: Held): void {
    if (this.held.get(held.owner) !== held) return;
    this.held.delete(held.owner);
    this.byPid.get(held.pid)?.delete(held.owner);
    held.scope.subscriptions.delete(held.end);
    held.waiter?.(null);
  }

  private holderOf(pid: number, owner: string): Held {
    const held = this.held.get(owner);
    if (held === undefined || held.pid !== pid) {
      throw Object.assign(new Error('ESTALE: no delegation of this process under that lease'), { code: 'ESTALE' });
    }
    return held;
  }
}
