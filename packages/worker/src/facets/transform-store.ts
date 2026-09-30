/**
 * transform-store.ts — a session's launch transform results, kept by content
 * in its SQLite database.
 *
 * A launch lowers every ES module and TypeScript source in its closure to
 * CommonJS (core runtime/bundle-cell-transform.ts). For pi that is 25-45 s of
 * esbuild CPU, and it was kept only in the isolate's heap, so every reset,
 * eviction and re-drive paid it again: session zealous-pangolin-6268 was torn
 * down five times in 4.4 h and redid the whole transform after each one. Here
 * a result outlives the isolate, and a re-driven or repeated launch reads it
 * back instead.
 *
 * Addressing. A result is stored under the sha256 of everything its output is
 * a function of: the pipeline's code (TRANSFORM_PIPELINE_ID, pinned at build
 * from the bundled closure of bundle-cell-transform.ts and EsbuildService),
 * the transform host's code (the store is bound to one host — for the session,
 * its esbuild facet, whose id carries the esbuild version, the facet body and
 * the staged CLI runner), what is transformed (a module cell or an entry
 * script), where it is staged (its path or URL: the loader, format,
 * TypeScript-ness and import.meta all follow from it), and the source. A different deploy or
 * esbuild addresses different rows; nothing is ever served across them. The
 * old in-heap key was a 32-bit hash of the source and its length, and two
 * sources that shared it got each other's code.
 *
 * Why its own tables. The facet image store (fabric image-store.ts) is
 * addressed by its OUTPUT, and is swept of every image no running process
 * boots from — after a reset, all of them — which is exactly the case this
 * store exists for. The VFS's content store would hold the bytes, but only as
 * files: hundreds of kernel files in the namespace every resident process
 * lists and stores a row for, each write advancing the revision clock that
 * live processes and the prefetch cache key on. So results live in
 * `nimbus_transforms` (one row per result: its flags, size, part count and
 * recency) and `nimbus_transform_parts` (its UTF-8 bytes in parts of at most
 * MAX_TX_BLOB_BYTES, each far under SQLite's 2 MB row bound), with the
 * store's charge and recency clock in `nimbus_transform_state`. The ledger
 * counts them with the rest of the session's database, and `stats()` reports
 * them (GET /api/_diag/cache).
 *
 * Bound and eviction. At most TRANSFORM_STORE_MAX_BYTES of charge (a
 * result's bytes plus LEDGER_ROW_BYTES per row it occupies); the least
 * recently used results leave first, as soon as a write takes the store past
 * it. A result over TRANSFORM_STORE_MAX_ENTRY_BYTES is not kept.
 *
 * Writes. A result's parts go down first, one statement each and paced by the
 * caller between them — the platform resets an object over what one turn has
 * outstanding in storage — and its row last, in one transaction with the
 * charge. A reader believes a row only when its parts add up to it, so a write
 * cut short leaves parts no row names and never a wrong result; the store's
 * first use in each isolate deletes such parts, before this isolate can have a
 * write of its own in flight. A write that fails leaves the result unkept and
 * the launch unharmed.
 */

import { sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
import { TRANSFORM_STORE_MAX_BYTES, TRANSFORM_STORE_MAX_ENTRY_BYTES } from '@nimbus-sh/core/constants.js';
import type { BundleCellResult, BundleCellResultStore } from '@nimbus-sh/core/runtime/bundle-cell-transform.js';
import type { SqlDatabase, SqlTransactions } from '@nimbus-sh/core/runtime/os-contracts.js';
import { LEDGER_ROW_BYTES } from '@nimbus-sh/core/runtime/storage-ledger.js';
import { MAX_TX_BLOB_BYTES, SQL_MAX_BOUND_PARAMETERS } from '@nimbus-sh/platform/limits.js';
import { TRANSFORM_PIPELINE_ID } from '../transform-pipeline.generated.js';

/** Bytes of a result in one part row, and in one write between the caller's turns. */
const PART_BYTES = MAX_TX_BLOB_BYTES;
/** The layout of a key's preimage; a change to it is a change of every address. */
const KEY_SCHEMA = 'nimbus-transform/1';

const FLAG_LOWERED = 1;
const FLAG_FAILED = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the store holds, for diagnostics. */
export interface TransformStoreStats {
  entries: number;
  /** UTF-8 bytes of the results. */
  bytes: number;
  /** What the bound is charged: the bytes plus a ledger row per row. */
  charge: number;
  limit: number;
}

/**
 * Storage whose leftover parts this isolate has already deleted: the store's
 * first use in each isolate does it, before any write of this isolate can have
 * parts in flight. Keyed by the storage object, which is one per object.
 */
const swept = new WeakSet<SqlTransactions>();

function chargeOf(bytes: number, parts: number): number {
  return bytes + (parts + 1) * LEDGER_ROW_BYTES;
}

function ensureSchema(sql: SqlDatabase): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_transforms (
    key TEXT PRIMARY KEY,
    flags INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    parts INTEGER NOT NULL,
    used INTEGER NOT NULL
  ) WITHOUT ROWID`);
  sql.exec('CREATE INDEX IF NOT EXISTS nimbus_transforms_used ON nimbus_transforms(used)');
  // Parts are up to a MiB: rows that large keep a rowid (see vfs_chunks).
  sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_transform_parts (
    key TEXT NOT NULL,
    n INTEGER NOT NULL,
    data BLOB NOT NULL
  )`);
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS nimbus_transform_parts_key ON nimbus_transform_parts(key, n)');
  sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_transform_state (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    charge INTEGER NOT NULL,
    clock INTEGER NOT NULL
  )`);
  sql.exec('INSERT OR IGNORE INTO nimbus_transform_state (slot, charge, clock) VALUES (1, 0, 0)');
}

function bytesOf(blob: unknown): Uint8Array {
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  throw new TypeError('transform store: a part is not a BLOB');
}

/** What the store holds, read without a store bound to any host. */
export function transformStoreStats(sql: SqlDatabase): TransformStoreStats {
  const created = [...sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nimbus_transform_state'")].length > 0;
  if (!created) return { entries: 0, bytes: 0, charge: 0, limit: TRANSFORM_STORE_MAX_BYTES };
  const [state] = [...sql.exec('SELECT charge FROM nimbus_transform_state WHERE slot = 1')];
  const [held] = [...sql.exec('SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM nimbus_transforms')];
  return {
    entries: Number(held.entries),
    bytes: Number(held.bytes),
    charge: Number(state.charge),
    limit: TRANSFORM_STORE_MAX_BYTES,
  };
}

export interface TransformStoreOptions {
  /** The pipeline's code identity. Defaults to this build's. */
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
  private schemaReady = false;

  /**
   * @param host The identity of the transform host whose results this store
   *   holds (for the session, ESBUILD_FACET_WORKER_ID). Given with the host,
   *   by whoever composes both.
   */
  constructor(
    private readonly sql: SqlDatabase,
    private readonly transactions: SqlTransactions,
    private readonly host: string,
    options: TransformStoreOptions = {},
  ) {
    this.pipeline = options.pipeline ?? TRANSFORM_PIPELINE_ID;
    this.maxBytes = options.maxBytes ?? TRANSFORM_STORE_MAX_BYTES;
    this.maxEntryBytes = options.maxEntryBytes ?? TRANSFORM_STORE_MAX_ENTRY_BYTES;
  }

  async key(kind: 'cell' | 'entry', at: string, source: string): Promise<string> {
    const digest = sha256Incremental();
    // JSON, so no field can run into the next; the source follows the NUL.
    await digest.update(encoder.encode(JSON.stringify([KEY_SCHEMA, this.pipeline, this.host, kind, at]) + '\0'));
    await digest.update(encoder.encode(source));
    return digest.hex();
  }

  getMany(keys: readonly string[]): Map<string, BundleCellResult> {
    const found = new Map<string, BundleCellResult>();
    if (keys.length === 0) return found;
    // A store that cannot be read answers what it read: a miss costs a transform.
    this.write(() => this.read(keys, found));
    return found;
  }

  private read(keys: readonly string[], found: Map<string, BundleCellResult>): void {
    this.open();
    const perExec = SQL_MAX_BOUND_PARAMETERS - 1;
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += perExec) {
      const batch = unique.slice(i, i + perExec);
      const heads = [...this.sql.exec(
        `SELECT key, flags, bytes, parts FROM nimbus_transforms WHERE key IN (${batch.map(() => '?').join(',')})`,
        ...batch,
      )];
      const served: string[] = [];
      for (const head of heads) {
        const key = String(head.key);
        const bytes = Number(head.bytes);
        const parts = [...this.sql.exec('SELECT n, data FROM nimbus_transform_parts WHERE key = ? ORDER BY n', key)];
        let whole: Uint8Array | null = new Uint8Array(bytes);
        let offset = 0;
        for (const [expected, part] of parts.entries()) {
          const data = bytesOf(part.data);
          if (Number(part.n) !== expected || offset + data.byteLength > bytes) { whole = null; break; }
          whole.set(data, offset);
          offset += data.byteLength;
        }
        if (whole === null || offset !== bytes || parts.length !== Number(head.parts)) {
          // Parts that do not add up to the row are no result: forget both.
          this.forget(key);
          continue;
        }
        const flags = Number(head.flags);
        found.set(key, {
          code: decoder.decode(whole),
          lowered: (flags & FLAG_LOWERED) !== 0,
          failed: (flags & FLAG_FAILED) !== 0,
        });
        served.push(key);
      }
      if (served.length > 0) {
        this.transactions.transactionSync(() => {
          const clock = this.tick();
          this.sql.exec(`UPDATE nimbus_transforms SET used = ? WHERE key IN (${served.map(() => '?').join(',')})`, clock, ...served);
        });
      }
    }
  }

  async put(key: string, result: BundleCellResult, spend?: (bytes: number) => Promise<void>): Promise<void> {
    const bytes = encoder.encode(result.code);
    const parts = Math.max(1, Math.ceil(bytes.byteLength / PART_BYTES));
    const charge = chargeOf(bytes.byteLength, parts);
    if (bytes.byteLength > this.maxEntryBytes || charge > this.maxBytes) return;
    // The remains of an earlier write of this key that never reached its row.
    if (!this.write(() => {
      this.open();
      this.sql.exec('DELETE FROM nimbus_transform_parts WHERE key = ?', key);
    })) return;
    for (let n = 0; n < parts; n++) {
      const part = bytes.subarray(n * PART_BYTES, (n + 1) * PART_BYTES);
      if (!this.write(() => this.sql.exec('INSERT INTO nimbus_transform_parts (key, n, data) VALUES (?, ?, ?)', key, n, part))) return;
      // Outside the write: a launch that is no longer wanted stops here.
      if (spend) await spend(part.byteLength);
    }
    const flags = (result.lowered ? FLAG_LOWERED : 0) | (result.failed ? FLAG_FAILED : 0);
    this.write(() => {
      this.transactions.transactionSync(() => {
        const [previous] = [...this.sql.exec('SELECT bytes, parts FROM nimbus_transforms WHERE key = ?', key)];
        const released = previous ? chargeOf(Number(previous.bytes), Number(previous.parts)) : 0;
        const clock = this.tick();
        this.sql.exec(
          'INSERT OR REPLACE INTO nimbus_transforms (key, flags, bytes, parts, used) VALUES (?, ?, ?, ?, ?)',
          key, flags, bytes.byteLength, parts, clock,
        );
        this.sql.exec('UPDATE nimbus_transform_state SET charge = charge + ? WHERE slot = 1', charge - released);
      });
      this.evict(key);
    });
  }

  /**
   * One storage step. A step that fails (the storage wall, a reset) leaves a
   * result unkept or unread, which costs a launch a transform and never its
   * result; parts a failed put left behind name no row, and go.
   */
  private write(step: () => void): boolean {
    try {
      step();
      return true;
    } catch (error) {
      console.warn('[transform-store] ' + String((error as Error)?.message ?? error));
      return false;
    }
  }

  /** Drop least recently used results until the charge is within the bound; never `keep`. */
  private evict(keep: string): void {
    for (;;) {
      const [state] = [...this.sql.exec('SELECT charge FROM nimbus_transform_state WHERE slot = 1')];
      if (Number(state.charge) <= this.maxBytes) return;
      const [oldest] = [...this.sql.exec('SELECT key FROM nimbus_transforms WHERE key != ? ORDER BY used LIMIT 1', keep)];
      if (!oldest) return;
      this.forget(String(oldest.key));
    }
  }

  /** Remove one result: its row, its parts and its charge, together. */
  private forget(key: string): void {
    this.transactions.transactionSync(() => {
      const [head] = [...this.sql.exec('SELECT bytes, parts FROM nimbus_transforms WHERE key = ?', key)];
      this.sql.exec('DELETE FROM nimbus_transform_parts WHERE key = ?', key);
      if (!head) return;
      this.sql.exec('DELETE FROM nimbus_transforms WHERE key = ?', key);
      this.sql.exec(
        'UPDATE nimbus_transform_state SET charge = charge - ? WHERE slot = 1',
        chargeOf(Number(head.bytes), Number(head.parts)),
      );
    });
  }

  /** Advance the recency clock and return its new value. Inside a transaction. */
  private tick(): number {
    this.sql.exec('UPDATE nimbus_transform_state SET clock = clock + 1 WHERE slot = 1');
    const [state] = [...this.sql.exec('SELECT clock FROM nimbus_transform_state WHERE slot = 1')];
    return Number(state.clock);
  }

  private open(): void {
    if (!this.schemaReady) {
      ensureSchema(this.sql);
      this.schemaReady = true;
    }
    if (swept.has(this.transactions)) return;
    swept.add(this.transactions);
    this.sql.exec('DELETE FROM nimbus_transform_parts WHERE key NOT IN (SELECT key FROM nimbus_transforms)');
  }
}
