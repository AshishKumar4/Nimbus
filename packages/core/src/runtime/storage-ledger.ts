/**
 * The session's storage ledger (Kinu N18; model Nimbus.Vfs.Ledger, N18-001).
 *
 * One storage limit (10 GB, DO_STORAGE_LIMIT_BYTES) is shared by the session's
 * Durable Object and every facet database under it, and `databaseSize` reports
 * only one database. At the wall an ordinary write fails catchably as
 * SQLITE_FULL; a facet clone over it is an uncatchable reset that empties the
 * destination. So every write is admitted against the shared limit before it
 * is made, and clone admission is decided before the clone:
 *
 *   used = the session DO's own bytes
 *        + every recorded facet database (live, dead or persisted)
 *        + reservations held by running operations.
 *
 * A write that does not fit is refused with ENOSPC and nothing changes.
 * Nothing in the ledger is evictable: the per-principal namespace image cache
 * the original design proposed never gained a producer and was removed
 * rather than shipped as dead accounting. A facet's row leaves only through
 * `deleteFacet` (facets.delete): an aborted facet's database persists, and a
 * restart re-reads the tables.
 */

import { DO_STORAGE_LIMIT_BYTES } from '@nimbus-sh/platform/limits.js';
import { VfsError } from '../vfs/vfs-error.js';
import type { SqlDatabase } from './os-contracts.js';

export interface StorageLedgerOptions {
  /** The session DO's database bytes; defaults to the database's own size. */
  sessionBytes?: () => number;
  limit?: number;
  /**
   * Bytes below the limit only privileged (uid 0) admissions may use, as ext4
   * reserves blocks for root: the kernel's own bookkeeping (session state,
   * receipts, leases), much of it written outside admission, still has room
   * when a user has filled the store. Defaults to 1% of the limit, at least
   * 16 MiB.
   */
  kernelReserve?: number;
}

/** The bytes a database occupies on the host: workerd's databaseSize, else SQLite's pages. */
export function databaseBytesOf(sql: SqlDatabase): number {
  return sql.databaseSize ?? Number([...sql.exec('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')][0]!.n);
}

export interface StorageLedgerView {
  limit: number;
  used: number;
  /** Bytes facets reported beyond what they were admitted, cumulative. */
  overshoot: number;
  /** Admitted to running operations and not yet written. */
  reserved: number;
  /** The same, per operation (none held at zero). */
  reservations: Record<string, number>;
  session: number;
  facets: Record<string, number>;
}

const GiB = 1_000_000_000;

/** What admission charges a stored row (an inode, manifest or namespace row and its index entries), rounded up. */
export const LEDGER_ROW_BYTES = 256;

export class StorageLedger {
  readonly limit: number;
  readonly kernelReserve: number;

  private readonly sessionBytes: () => number;

  constructor(private readonly sql: SqlDatabase, options: StorageLedgerOptions = {}) {
    this.limit = options.limit ?? DO_STORAGE_LIMIT_BYTES;
    this.kernelReserve = Math.min(this.limit, options.kernelReserve ?? Math.max(Math.ceil(this.limit / 100), 16 * 1024 * 1024));
    this.sessionBytes = options.sessionBytes ?? (() => databaseBytesOf(sql));
    sql.exec('CREATE TABLE IF NOT EXISTS nimbus_facet_storage (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS nimbus_storage_ledger (slot INTEGER PRIMARY KEY CHECK(slot = 1), overshoot INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS nimbus_storage_reservation (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)');
  }

  /** A session-DO write of `bytes`: admitted or ENOSPC, changing nothing. */
  admit(bytes: number, privileged = false): void {
    const { fixed } = this.totals();
    const limit = this.limitFor(privileged);
    if (fixed + bytes <= limit) return;
    throw new VfsError('ENOSPC', `${bytes} bytes would exceed the ${this.limit >= GiB ? `${this.limit / GiB} GB` : `${this.limit}-byte`} storage of this session (used ${fixed}, needs ${bytes})`);
  }

  /** What an admission may fill up to. */
  private limitFor(privileged: boolean): number {
    return privileged ? this.limit : this.limit - this.kernelReserve;
  }

  /** A fill of `bytes` into facet `name`: admitted, and recorded before the fill is acknowledged. */
  fill(name: string, bytes: number): void {
    this.admit(bytes);
    this.setFacet(name, this.facet(name) + bytes);
  }

  /**
   * An operation that writes over several turns (a sliced copy, a paged
   * import) reserves what it is admitted for: every other writer counts it as
   * used until the operation draws it (as its writes land) or releases it.
   * So the operation's own writes, within the reservation, are never refused.
   */
  reserve(id: string, bytes: number, privileged = false): void {
    this.admit(bytes, privileged);
    this.sql.exec(
      'INSERT INTO nimbus_storage_reservation (id, bytes) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET bytes = bytes + excluded.bytes',
      id, bytes,
    );
  }

  /**
   * A write of `bytes` by the operation that reserved `id`: taken from its
   * reservation first; only what exceeds it is admitted like any write.
   * Returns what it took, for `refund` if the write does not land.
   */
  draw(id: string, bytes: number, privileged = false): number {
    const held = this.reservation(id);
    const take = Math.min(bytes, held);
    if (bytes > take) this.admit(bytes - take, privileged);
    if (take > 0) this.sql.exec('UPDATE nimbus_storage_reservation SET bytes = bytes - ? WHERE id = ?', take, id);
    return take;
  }

  /** A drawn write rolled back: its bytes go back to the reservation. */
  refund(id: string, bytes: number): void {
    if (bytes > 0) {
      this.sql.exec(
        'INSERT INTO nimbus_storage_reservation (id, bytes) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET bytes = bytes + excluded.bytes',
        id, bytes,
      );
    }
  }

  /** The operation ended (done or failed): what it did not use is free again. */
  release(id: string): void {
    this.sql.exec('DELETE FROM nimbus_storage_reservation WHERE id = ?', id);
  }

  /** Reservations no running operation holds (after a restart): all of them are released. */
  releaseAll(): void {
    if ([...this.sql.exec('SELECT 1 FROM nimbus_storage_reservation LIMIT 1')].length > 0) {
      this.sql.exec('DELETE FROM nimbus_storage_reservation');
    }
  }

  /** `facets.delete(name)`: its database is gone. The only way a facet leaves the ledger. */
  deleteFacet(name: string): void {
    this.sql.exec('DELETE FROM nimbus_facet_storage WHERE name = ?', name);
  }

  /** A facet reported `databaseSize` at or below its record (it freed space): the row becomes the smaller. */
  settle(name: string, bytes: number): void {
    if (this.hasFacet(name)) this.setFacet(name, Math.min(bytes, this.facet(name)));
  }

  /**
   * A facet reported `databaseSize` (at boot, after a fill, at exit): the row
   * becomes the larger of the report and the record. What exceeds the record
   * was never admitted; it is overshoot, and further writes are refused
   * until something frees space.
   */
  report(name: string, bytes: number): void {
    const recorded = this.facet(name);
    this.setFacet(name, Math.max(bytes, recorded));
    if (bytes > recorded) {
      this.sql.exec(
        'INSERT INTO nimbus_storage_ledger (slot, overshoot) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET overshoot = overshoot + excluded.overshoot',
        bytes - recorded,
      );
    }
  }

  /** A facet's measured `databaseSize`: at or below its record it settles, above it is overshoot. */
  reportSize(name: string, bytes: number): void {
    if (bytes <= this.facet(name)) this.settle(name, bytes);
    else this.report(name, bytes);
  }

  view(): StorageLedgerView {
    const facets: Record<string, number> = {};
    for (const row of this.sql.exec('SELECT name, bytes FROM nimbus_facet_storage ORDER BY name')) facets[String(row.name)] = Number(row.bytes);
    const { session, reserved } = this.totals();
    return {
      limit: this.limit,
      used: session + sumOf(Object.values(facets)) + reserved,
      reserved,
      reservations: Object.fromEntries([...this.sql.exec('SELECT id, bytes FROM nimbus_storage_reservation WHERE bytes > 0 ORDER BY id')]
        .map((row) => [String(row.id), Number(row.bytes)])),
      overshoot: Number([...this.sql.exec('SELECT overshoot FROM nimbus_storage_ledger WHERE slot = 1')][0]?.overshoot ?? 0),
      session,
      facets,
    };
  }

  /** `fixed`: the session's own bytes, the facets' and the reservations. */
  private totals(): { fixed: number; session: number; reserved: number } {
    const row = [...this.sql.exec(
      'SELECT (SELECT COALESCE(SUM(bytes), 0) FROM nimbus_facet_storage) AS facets, '
        + '(SELECT COALESCE(SUM(bytes), 0) FROM nimbus_storage_reservation) AS reserved',
    )][0]!;
    const session = this.sessionBytes();
    return { fixed: session + Number(row.facets) + Number(row.reserved), session, reserved: Number(row.reserved) };
  }

  private reservation(id: string): number {
    const row = [...this.sql.exec('SELECT bytes FROM nimbus_storage_reservation WHERE id = ?', id)][0];
    return row === undefined ? 0 : Number(row.bytes);
  }

  private facet(name: string): number {
    const row = [...this.sql.exec('SELECT bytes FROM nimbus_facet_storage WHERE name = ?', name)][0];
    return row === undefined ? 0 : Number(row.bytes);
  }

  private hasFacet(name: string): boolean {
    return [...this.sql.exec('SELECT 1 FROM nimbus_facet_storage WHERE name = ?', name)].length > 0;
  }

  private setFacet(name: string, bytes: number): void {
    this.sql.exec(
      'INSERT INTO nimbus_facet_storage (name, bytes, updated_at) VALUES (?, ?, ?) '
        + 'ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at',
      name, bytes, Date.now(),
    );
  }
}

/**
 * `facets.delete(name)` dropped that facet's database: it leaves the ledger in
 * the same step. For the facet hosts, which hold the session's SQL but not
 * its engine.
 */
export function forgetFacetStorage(sql: SqlDatabase, name: string): void {
  sql.exec('CREATE TABLE IF NOT EXISTS nimbus_facet_storage (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  sql.exec('DELETE FROM nimbus_facet_storage WHERE name = ?', name);
}

function sumOf(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
