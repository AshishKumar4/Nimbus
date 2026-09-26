/**
 * The session's storage ledger (Kinu N18; model Nimbus.Vfs.Ledger, N18-001).
 *
 * One storage limit (10 GB) covers the session's Durable Object and every
 * facet database under it, and `databaseSize` reports only one database. A
 * write that crosses the limit resets the object and leaves the destination
 * empty, so every write is admitted before it is made:
 *
 *   used = the session DO's own bytes (without the namespace images)
 *        + every recorded facet database (live, dead or persisted)
 *        + the per-principal namespace images.
 *
 * A write that does not fit drops the least recently used images (they are
 * regenerable), oldest first, never the one being written, and only as many
 * as it needs. When it would not fit with all of them gone, it is refused
 * with ENOSPC and nothing changes, not even the images. A facet's row leaves
 * only through `deleteFacet` (facets.delete): an aborted facet's database
 * persists, and a restart re-reads the tables.
 */
import { DO_STORAGE_LIMIT_BYTES } from '@nimbus-sh/platform/limits.js';
import { VfsError } from '../vfs/vfs-error.js';
/** The bytes a database occupies on the host: workerd's databaseSize, else SQLite's pages. */
export function databaseBytesOf(sql) {
    return sql.databaseSize ?? Number([...sql.exec('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()')][0].n);
}
/**
 * Who deletes a namespace image's own rows, per database: every ledger over
 * that database (the engine's, a facet host's) evicts through it. Without
 * one, images are never evicted: a write that needs their room is refused.
 */
const imageEvictors = new WeakMap();
export function registerImageEvictor(sql, evict) {
    imageEvictors.set(sql, evict);
}
const GiB = 1_000_000_000;
/** What admission charges a stored row (an inode, manifest or namespace row and its index entries), rounded up. */
export const LEDGER_ROW_BYTES = 256;
export class StorageLedger {
    sql;
    limit;
    sessionBytes;
    constructor(sql, options = {}) {
        this.sql = sql;
        this.limit = options.limit ?? DO_STORAGE_LIMIT_BYTES;
        this.sessionBytes = options.sessionBytes ?? (() => databaseBytesOf(sql));
        sql.exec('CREATE TABLE IF NOT EXISTS nimbus_facet_storage (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
        sql.exec('CREATE TABLE IF NOT EXISTS nimbus_image_storage (principal TEXT PRIMARY KEY, bytes INTEGER NOT NULL, seq INTEGER NOT NULL)');
        sql.exec('CREATE TABLE IF NOT EXISTS nimbus_storage_ledger (slot INTEGER PRIMARY KEY CHECK(slot = 1), overshoot INTEGER NOT NULL)');
    }
    /** A session-DO write of `bytes`: admitted (evicting what it must) or ENOSPC. */
    admit(bytes) {
        const { fixed, images } = this.totals();
        // The common case, one query: everything fits with every image kept.
        if (fixed + images + bytes <= this.limit)
            return;
        this.fit(bytes, fixed, this.images(), null);
    }
    /** A fill of `bytes` into facet `name`: admitted, and recorded before the fill is acknowledged. */
    fill(name, bytes) {
        this.admit(bytes);
        this.setFacet(name, this.facet(name) + bytes);
    }
    /** A namespace-image write of `bytes` for `principal`; that image becomes the most recent. */
    writeImage(principal, bytes) {
        const current = this.image(principal);
        const others = this.images().filter(([key]) => key !== principal);
        this.fit(bytes, this.totals().fixed + current, others, principal);
        this.setImage(principal, current + bytes);
    }
    /** A launch used `principal`'s image: it becomes the most recent. */
    touchImage(principal) {
        if (this.hasImage(principal))
            this.setImage(principal, this.image(principal));
    }
    /** At an epoch change: keep only the images of `keep`. */
    dropImages(keep) {
        const kept = new Set(keep);
        for (const [principal] of this.images())
            if (!kept.has(principal))
                this.evict(principal);
    }
    /** `facets.delete(name)`: its database is gone. The only way a facet leaves the ledger. */
    deleteFacet(name) {
        this.sql.exec('DELETE FROM nimbus_facet_storage WHERE name = ?', name);
    }
    /** A facet reported `databaseSize` at or below its record (it freed space): the row becomes the smaller. */
    settle(name, bytes) {
        if (this.hasFacet(name))
            this.setFacet(name, Math.min(bytes, this.facet(name)));
    }
    /**
     * A facet reported `databaseSize` (at boot, after a fill, at exit): the row
     * becomes the larger of the report and the record. What exceeds the record
     * was never admitted; it is overshoot, and further writes are refused
     * until something frees space.
     */
    report(name, bytes) {
        const recorded = this.facet(name);
        this.setFacet(name, Math.max(bytes, recorded));
        if (bytes > recorded) {
            this.sql.exec('INSERT INTO nimbus_storage_ledger (slot, overshoot) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET overshoot = overshoot + excluded.overshoot', bytes - recorded);
        }
    }
    /** A facet's measured `databaseSize`: at or below its record it settles, above it is overshoot. */
    reportSize(name, bytes) {
        if (bytes <= this.facet(name))
            this.settle(name, bytes);
        else
            this.report(name, bytes);
    }
    view() {
        const facets = {};
        for (const row of this.sql.exec('SELECT name, bytes FROM nimbus_facet_storage ORDER BY name'))
            facets[String(row.name)] = Number(row.bytes);
        const images = this.images();
        const { session } = this.totals();
        return {
            limit: this.limit,
            used: session + sumOf(Object.values(facets)) + sumOf(images.map(([, bytes]) => bytes)),
            overshoot: Number([...this.sql.exec('SELECT overshoot FROM nimbus_storage_ledger WHERE slot = 1')][0]?.overshoot ?? 0),
            session,
            facets,
            images,
        };
    }
    /** `fixed`: the session's own bytes and the facets', what no eviction frees; `images`: the rest. */
    totals() {
        const row = [...this.sql.exec('SELECT (SELECT COALESCE(SUM(bytes), 0) FROM nimbus_facet_storage) AS facets, (SELECT COALESCE(SUM(bytes), 0) FROM nimbus_image_storage) AS images')][0];
        const images = Number(row.images);
        // The images live in the session's database, so its size includes them.
        const session = Math.max(0, this.sessionBytes() - images);
        return { fixed: session + Number(row.facets), images, session };
    }
    /**
     * Drop the oldest of `evictable` until `fixed + evictable left + need` fits
     * the limit; ENOSPC, dropping nothing, when it cannot fit at all.
     */
    fit(need, fixed, evictable, writing) {
        if (fixed + need > this.limit) {
            const used = fixed + sumOf(evictable.map(([, bytes]) => bytes));
            throw new VfsError('ENOSPC', `${need} bytes would exceed the ${this.limit >= GiB ? `${this.limit / GiB} GB` : `${this.limit}-byte`} storage of this session (used ${used}, needs ${need})${writing === null ? '' : ` for the namespace image of ${writing}`}`);
        }
        let kept = sumOf(evictable.map(([, bytes]) => bytes));
        if (!imageEvictors.has(this.sql)) {
            if (fixed + kept + need <= this.limit)
                return;
            throw new VfsError('ENOSPC', `${need} bytes would exceed the storage of this session (used ${fixed + kept}, needs ${need}; no namespace image can be evicted here)`);
        }
        for (const [principal, bytes] of evictable) {
            if (fixed + kept + need <= this.limit)
                break;
            this.evict(principal);
            kept -= bytes;
        }
    }
    evict(principal) {
        imageEvictors.get(this.sql)?.(principal);
        this.sql.exec('DELETE FROM nimbus_image_storage WHERE principal = ?', principal);
    }
    images() {
        return [...this.sql.exec('SELECT principal, bytes FROM nimbus_image_storage ORDER BY seq')].map((row) => [String(row.principal), Number(row.bytes)]);
    }
    image(principal) {
        const row = [...this.sql.exec('SELECT bytes FROM nimbus_image_storage WHERE principal = ?', principal)][0];
        return row === undefined ? 0 : Number(row.bytes);
    }
    hasImage(principal) {
        return [...this.sql.exec('SELECT 1 FROM nimbus_image_storage WHERE principal = ?', principal)].length > 0;
    }
    setImage(principal, bytes) {
        this.sql.exec('INSERT INTO nimbus_image_storage (principal, bytes, seq) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM nimbus_image_storage)) '
            + 'ON CONFLICT(principal) DO UPDATE SET bytes = excluded.bytes, seq = excluded.seq', principal, bytes);
    }
    facet(name) {
        const row = [...this.sql.exec('SELECT bytes FROM nimbus_facet_storage WHERE name = ?', name)][0];
        return row === undefined ? 0 : Number(row.bytes);
    }
    hasFacet(name) {
        return [...this.sql.exec('SELECT 1 FROM nimbus_facet_storage WHERE name = ?', name)].length > 0;
    }
    setFacet(name, bytes) {
        this.sql.exec('INSERT INTO nimbus_facet_storage (name, bytes, updated_at) VALUES (?, ?, ?) '
            + 'ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at', name, bytes, Date.now());
    }
}
/**
 * `facets.delete(name)` dropped that facet's database: it leaves the ledger in
 * the same step. For the facet hosts, which hold the session's SQL but not
 * its engine.
 */
export function forgetFacetStorage(sql, name) {
    sql.exec('CREATE TABLE IF NOT EXISTS nimbus_facet_storage (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    sql.exec('DELETE FROM nimbus_facet_storage WHERE name = ?', name);
}
function sumOf(values) {
    let total = 0;
    for (const value of values)
        total += value;
    return total;
}
