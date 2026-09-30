/**
 * transform-store.ts — a session's launch transform results, kept by content
 * in its SQLite database.
 *
 * A launch lowers every ES module and TypeScript source in its closure to
 * CommonJS (core runtime/bundle-cell-transform.ts). For pi that is 11.5 MB of
 * source and 11-15 s of esbuild CPU, and it was kept only in the isolate's
 * heap, so every reset, eviction and re-drive paid it again: session
 * zealous-pangolin-6268 was torn down five times in 4.4 h and redid the whole
 * transform after each one. Here a result outlives the isolate, and a
 * re-driven or repeated launch reads it back instead.
 *
 * Addressing. A result is stored under the sha256 of everything its output is
 * a function of: the pipeline's code (TRANSFORM_PIPELINE_ID, which core's
 * build pins from the bundled closure of bundle-cell-transform.ts and
 * EsbuildService and ships with that code), the transform host's code (the
 * store is bound to one host — for the session, its esbuild facet, whose id
 * carries the esbuild version, the facet body and the staged CLI runner),
 * what is transformed (a module cell or an entry script), where it is staged
 * (its path or URL: the loader, format, TypeScript-ness and import.meta all
 * follow from it), and the source. The old in-heap key was a 32-bit hash of
 * the source and its URL, and two sources that shared it got each other's
 * code.
 *
 * What is kept. Only transforms that succeeded: a host can report a crash as
 * a rejection, and a stored diagnostic shim would outlive the crash.
 *
 * Why its own tables. The facet image store (fabric image-store.ts) is
 * addressed by its OUTPUT, and is swept of every image no running process
 * boots from — after a reset, all of them — which is exactly the case this
 * store exists for. The VFS's content store would hold the bytes, but only as
 * files: hundreds of kernel files in the namespace every resident process
 * lists and stores a row for, each write advancing the revision clock that
 * live processes and the prefetch cache key on.
 *
 * Layout. `nimbus_transform_results` has a row per result. A result of at
 * most MAX_TX_BLOB_BYTES is in its row, written in one statement. A larger
 * one is in `nimbus_transform_result_parts`, in parts of MAX_TX_BLOB_BYTES
 * under an id of the write that made them, and its row names that write: the
 * parts go down first, one statement each and paced by the caller between
 * them — the platform resets an object over what one turn has outstanding in
 * storage — and the row last. A reader believes a row only when its parts add
 * up to it. A write that fails deletes its own parts; one cut short by a
 * reset leaves parts no row names, which the store's first use in the next
 * isolate deletes. `nimbus_transform_store` holds the charge and the
 * generation (key schema, pipeline, host) the rows were written under: a
 * store of another generation — a deploy that changed any of them — drops
 * them all when it opens, rather than let them hold the bound.
 *
 * Bound and admission. At most TRANSFORM_STORE_MAX_BYTES of charge (a
 * result's bytes plus LEDGER_ROW_BYTES per row it occupies); the least
 * recently used leave first. Recency is kept to the hour, so a warm launch
 * does not rewrite a row per hit. Every write is admitted through the
 * session's storage ledger first. A write the ledger or SQLite refuses for
 * space is not kept, and counted (the launch's stats, GET /api/_diag/cache);
 * any other storage failure throws.
 */

import { sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
import { TRANSFORM_STORE_MAX_BYTES, TRANSFORM_STORE_MAX_ENTRY_BYTES } from '@nimbus-sh/core/constants.js';
import type { BundleCellResultStore, StoredBundleCell } from '@nimbus-sh/core/runtime/bundle-cell-transform.js';
import type { SqlDatabase, SqlTransactions } from '@nimbus-sh/core/runtime/os-contracts.js';
import { LEDGER_ROW_BYTES } from '@nimbus-sh/core/runtime/storage-ledger.js';
import { TRANSFORM_PIPELINE_ID } from '@nimbus-sh/core/runtime/transform-pipeline.generated.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { MAX_TX_BLOB_BYTES, SQL_MAX_BOUND_PARAMETERS } from '@nimbus-sh/platform/limits.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';

/** Bytes of a result kept in its own row; a larger one goes in parts of this size. */
const PART_BYTES = MAX_TX_BLOB_BYTES;
/** The layout of a key's preimage; a change to it is a change of every address. */
const KEY_SCHEMA = 'nimbus-transform/2';
/** Rows removed per transaction when a generation's rows are dropped. */
const DROP_BATCH_ROWS = 128;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The session storage ledger's admission, as the store uses it (core StorageLedger). */
export interface TransformStoreLedger {
  admit(bytes: number): void;
  reserve(id: string, bytes: number): void;
  draw(id: string, bytes: number): number;
  release(id: string): void;
}

/** What the store holds, for diagnostics. */
export interface TransformStoreStats {
  entries: number;
  /** UTF-8 bytes of the results. */
  bytes: number;
  /** What the bound is charged: the bytes plus a ledger row per row. */
  charge: number;
  limit: number;
  /** Writes refused for space in this isolate, and the first refusal's reason. */
  storeErrors: number;
  storeError: string | null;
}

/** Per storage object: which isolate-once steps ran, and what was refused. */
interface StorageState {
  swept: boolean;
  storeErrors: number;
  storeError: string | null;
}
const storages = new WeakMap<SqlTransactions, StorageState>();

function storageState(transactions: SqlTransactions): StorageState {
  let state = storages.get(transactions);
  if (!state) {
    state = { swept: false, storeErrors: 0, storeError: null };
    storages.set(transactions, state);
  }
  return state;
}

function chargeOf(bytes: number, parts: number): number {
  return bytes + (parts + 1) * LEDGER_ROW_BYTES;
}

function hourNow(): number {
  return Math.floor(Date.now() / 3_600_000);
}

/** A refusal for space — the ledger's ENOSPC or SQLite's SQLITE_FULL — and nothing else. */
function refusalReason(error: unknown): string | null {
  if (isVfsError(error, 'ENOSPC') || classifyError(error) === 'sqlite_full') {
    return String((error as Error)?.message ?? error);
  }
  return null;
}

function ensureSchema(sql: SqlDatabase): void {
  // Rows up to a MiB keep a rowid (see vfs_chunks), and the rowid orders
  // results written within the same hour.
  sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_transform_results (
    key TEXT NOT NULL,
    lowered INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    charge INTEGER NOT NULL,
    used INTEGER NOT NULL,
    code BLOB NULL,
    write_id TEXT NULL,
    parts INTEGER NOT NULL
  )`);
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS nimbus_transform_results_key ON nimbus_transform_results(key)');
  sql.exec('CREATE INDEX IF NOT EXISTS nimbus_transform_results_used ON nimbus_transform_results(used)');
  sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_transform_result_parts (
    write_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    data BLOB NOT NULL
  )`);
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS nimbus_transform_result_parts_write ON nimbus_transform_result_parts(write_id, n)');
  sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_transform_store (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    generation TEXT NOT NULL,
    charge INTEGER NOT NULL
  )`);
}

function bytesOf(blob: unknown): Uint8Array {
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  throw new TypeError('transform store: a stored result is not a BLOB');
}

/** What the store holds, read without a store bound to any host. */
export function transformStoreStats(sql: SqlDatabase, transactions: SqlTransactions): TransformStoreStats {
  const { storeErrors, storeError } = storageState(transactions);
  const created = [...sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nimbus_transform_store'")].length > 0;
  if (!created) return { entries: 0, bytes: 0, charge: 0, limit: TRANSFORM_STORE_MAX_BYTES, storeErrors, storeError };
  const [state] = [...sql.exec('SELECT charge FROM nimbus_transform_store WHERE slot = 1')];
  const [held] = [...sql.exec('SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM nimbus_transform_results')];
  return {
    entries: Number(held.entries),
    bytes: Number(held.bytes),
    charge: Number(state?.charge ?? 0),
    limit: TRANSFORM_STORE_MAX_BYTES,
    storeErrors,
    storeError,
  };
}

export interface TransformStoreOptions {
  /** The pipeline's code identity. Defaults to the one core shipped with. */
  pipeline?: string;
  /** Charge the store may hold. */
  maxBytes?: number;
  /** Largest result kept. */
  maxEntryBytes?: number;
}

export class TransformStore implements BundleCellResultStore {
  private readonly pipeline: string;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly generation: string;
  private opened = false;

  /**
   * @param host The identity of the transform host whose results this store
   *   holds: EsbuildService.transformHostId, for the session its esbuild
   *   facet's ESBUILD_FACET_WORKER_ID.
   * @param ledger The session's storage ledger, which admits every write.
   */
  constructor(
    private readonly sql: SqlDatabase,
    private readonly transactions: SqlTransactions,
    private readonly ledger: TransformStoreLedger,
    private readonly host: string,
    options: TransformStoreOptions = {},
  ) {
    this.pipeline = options.pipeline ?? TRANSFORM_PIPELINE_ID;
    this.maxBytes = options.maxBytes ?? TRANSFORM_STORE_MAX_BYTES;
    this.maxEntryBytes = options.maxEntryBytes ?? TRANSFORM_STORE_MAX_ENTRY_BYTES;
    this.generation = JSON.stringify([KEY_SCHEMA, this.pipeline, this.host]);
  }

  async key(kind: 'cell' | 'entry', at: string, source: string): Promise<string> {
    const digest = sha256Incremental();
    // JSON, so no field can run into the next; the source follows the NUL.
    await digest.update(encoder.encode(JSON.stringify([KEY_SCHEMA, this.pipeline, this.host, kind, at]) + '\0'));
    await digest.update(encoder.encode(source));
    return digest.hex();
  }

  getMany(keys: readonly string[]): Map<string, StoredBundleCell> {
    const found = new Map<string, StoredBundleCell>();
    if (keys.length === 0 || this.open() !== null) return found;
    const hour = hourNow();
    const unique = [...new Set(keys)];
    const perExec = SQL_MAX_BOUND_PARAMETERS - 2;
    for (let i = 0; i < unique.length; i += perExec) {
      const batch = unique.slice(i, i + perExec);
      const marks = batch.map(() => '?').join(',');
      const rows = [...this.sql.exec(
        `SELECT key, lowered, bytes, code, write_id, parts FROM nimbus_transform_results WHERE key IN (${marks})`,
        ...batch,
      )];
      for (const row of rows) {
        const key = String(row.key);
        const code = this.readCode(row);
        if (code === null) {
          // Parts that do not add up to the row are no result: forget both.
          this.forget(key);
          continue;
        }
        found.set(key, { code, lowered: Number(row.lowered) !== 0 });
      }
      // Recency to the hour: a launch within the hour of the last rewrites nothing.
      this.sql.exec(`UPDATE nimbus_transform_results SET used = ? WHERE used < ? AND key IN (${marks})`, hour, hour, ...batch);
    }
    return found;
  }

  /** The result a row holds, or null when its parts do not add up to it. */
  private readCode(row: Record<string, unknown>): string | null {
    const bytes = Number(row.bytes);
    if (row.write_id === null) {
      const inline = bytesOf(row.code);
      return inline.byteLength === bytes ? decoder.decode(inline) : null;
    }
    const parts = [...this.sql.exec('SELECT n, data FROM nimbus_transform_result_parts WHERE write_id = ? ORDER BY n', row.write_id)];
    if (parts.length !== Number(row.parts)) return null;
    const whole = new Uint8Array(bytes);
    let offset = 0;
    for (const [expected, part] of parts.entries()) {
      const data = bytesOf(part.data);
      if (Number(part.n) !== expected || offset + data.byteLength > bytes) return null;
      whole.set(data, offset);
      offset += data.byteLength;
    }
    return offset === bytes ? decoder.decode(whole) : null;
  }

  async put(key: string, result: StoredBundleCell, spend?: (bytes: number) => Promise<void>): Promise<string | null> {
    const bytes = encoder.encode(result.code);
    const inline = bytes.byteLength <= PART_BYTES;
    const parts = inline ? 0 : Math.ceil(bytes.byteLength / PART_BYTES);
    const charge = chargeOf(bytes.byteLength, parts);
    // Used for the launch that made it, and not kept: it would crowd out too much else.
    if (bytes.byteLength > this.maxEntryBytes || charge > this.maxBytes) return null;
    const unopened = this.open();
    if (unopened !== null) return unopened;
    // Content-addressed: a result already held is this one.
    if (this.holds(key)) return null;
    const row = { key, lowered: result.lowered ? 1 : 0, bytes: bytes.byteLength, charge };
    if (inline) {
      const refused = this.refusable(() => {
        this.ledger.admit(charge);
        this.commit(row, bytes, null, 0);
      });
      if (refused === null && spend) await spend(bytes.byteLength);
      return refused;
    }
    const writeId = crypto.randomUUID();
    const reservation = `transform:${writeId}`;
    let committed = false;
    try {
      const refused = this.refusable(() => this.ledger.reserve(reservation, charge));
      if (refused !== null) return refused;
      for (let n = 0; n < parts; n++) {
        const part = bytes.subarray(n * PART_BYTES, (n + 1) * PART_BYTES);
        const unlanded = this.refusable(() => {
          this.sql.exec('INSERT INTO nimbus_transform_result_parts (write_id, n, data) VALUES (?, ?, ?)', writeId, n, part);
          this.ledger.draw(reservation, part.byteLength);
        });
        if (unlanded !== null) return unlanded;
        if (spend) await spend(part.byteLength);
      }
      return this.refusable(() => { committed = this.commit(row, null, writeId, parts); });
    } finally {
      this.ledger.release(reservation);
      // A write that did not become the result's row takes its parts with it.
      if (!committed) this.sql.exec('DELETE FROM nimbus_transform_result_parts WHERE write_id = ?', writeId);
    }
  }

  private holds(key: string): boolean {
    return [...this.sql.exec('SELECT 1 FROM nimbus_transform_results WHERE key = ?', key)].length > 0;
  }

  /**
   * Run `write`, answering null. A refusal for space is counted and answered
   * with its reason; every other failure — a malformed statement, a schema
   * this code does not know — is thrown, so a store that cannot work is never
   * mistaken for one that has nothing.
   */
  private refusable(write: () => void): string | null {
    try {
      write();
      return null;
    } catch (error) {
      const reason = refusalReason(error);
      if (reason === null) throw error;
      const state = storageState(this.transactions);
      state.storeErrors++;
      state.storeError ??= reason;
      return reason;
    }
  }

  /**
   * The row, with the charge, in one transaction; then the bound is restored.
   * False when another write of the same result got there first, which
   * leaves this write's parts to its caller.
   */
  private commit(
    row: { key: string; lowered: number; bytes: number; charge: number },
    code: Uint8Array | null,
    writeId: string | null,
    parts: number,
  ): boolean {
    const inserted = this.transactions.transactionSync(() => {
      if (this.holds(row.key)) return false;
      this.sql.exec(
        'INSERT INTO nimbus_transform_results (key, lowered, bytes, charge, used, code, write_id, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        row.key, row.lowered, row.bytes, row.charge, hourNow(), code, writeId, parts,
      );
      this.sql.exec('UPDATE nimbus_transform_store SET charge = charge + ? WHERE slot = 1', row.charge);
      return true;
    });
    for (;;) {
      const [state] = [...this.sql.exec('SELECT charge FROM nimbus_transform_store WHERE slot = 1')];
      if (Number(state.charge) <= this.maxBytes) break;
      const [oldest] = [...this.sql.exec(
        'SELECT key FROM nimbus_transform_results WHERE key != ? ORDER BY used, rowid LIMIT 1',
        row.key,
      )];
      if (!oldest) break;
      this.forget(String(oldest.key));
    }
    return inserted;
  }

  /** Remove one result: its row, its parts and its charge, together. */
  private forget(key: string): void {
    this.transactions.transactionSync(() => {
      const [row] = [...this.sql.exec('SELECT charge, write_id FROM nimbus_transform_results WHERE key = ?', key)];
      if (!row) return;
      if (row.write_id !== null) this.sql.exec('DELETE FROM nimbus_transform_result_parts WHERE write_id = ?', row.write_id);
      this.sql.exec('DELETE FROM nimbus_transform_results WHERE key = ?', key);
      this.sql.exec('UPDATE nimbus_transform_store SET charge = charge - ? WHERE slot = 1', Number(row.charge));
    });
  }

  /**
   * The schema; the rows of another generation, dropped; and once per
   * isolate, before any write of this isolate can have parts in flight, the
   * parts no row names (a write a reset cut short), with the charge recounted.
   * Null when the store is open; the reason when storage refused it for space.
   */
  private open(): string | null {
    if (this.opened) return null;
    const refused = this.refusable(() => {
      ensureSchema(this.sql);
      const [state] = [...this.sql.exec('SELECT generation FROM nimbus_transform_store WHERE slot = 1')];
      if (!state) {
        this.sql.exec('INSERT INTO nimbus_transform_store (slot, generation, charge) VALUES (1, ?, 0)', this.generation);
      } else if (String(state.generation) !== this.generation) {
        this.dropAll();
      }
    });
    if (refused !== null) return refused;
    const storage = storageState(this.transactions);
    if (!storage.swept) {
      storage.swept = true;
      this.sql.exec('DELETE FROM nimbus_transform_result_parts WHERE write_id NOT IN (SELECT write_id FROM nimbus_transform_results WHERE write_id IS NOT NULL)');
      this.sql.exec('UPDATE nimbus_transform_store SET charge = (SELECT COALESCE(SUM(charge), 0) FROM nimbus_transform_results) WHERE slot = 1');
    }
    this.opened = true;
    return null;
  }

  /** Every result of another generation, a bounded batch of rows per transaction. */
  private dropAll(): void {
    for (;;) {
      const more = this.transactions.transactionSync(() => {
        this.sql.exec(
          'DELETE FROM nimbus_transform_result_parts WHERE write_id IN (SELECT write_id FROM nimbus_transform_results WHERE write_id IS NOT NULL ORDER BY rowid LIMIT ?)',
          DROP_BATCH_ROWS,
        );
        this.sql.exec('DELETE FROM nimbus_transform_results WHERE rowid IN (SELECT rowid FROM nimbus_transform_results ORDER BY rowid LIMIT ?)', DROP_BATCH_ROWS);
        return [...this.sql.exec('SELECT 1 FROM nimbus_transform_results LIMIT 1')].length > 0;
      });
      if (!more) break;
    }
    this.transactions.transactionSync(() => {
      this.sql.exec('DELETE FROM nimbus_transform_result_parts');
      this.sql.exec('UPDATE nimbus_transform_store SET generation = ?, charge = 0 WHERE slot = 1', this.generation);
    });
  }
}
