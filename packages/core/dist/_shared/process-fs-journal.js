/**
 * process-fs-journal.ts — a process's write log, kept where the death of
 * the process does not reach (process-fs-client.ts).
 *
 * Every change the process makes is appended here in the turn it is made,
 * before the program is told it succeeded: a process's facet keeps it in its
 * own SQLite (sqlJournal), local and synchronous, which outlives the facet's
 * isolate, and the facet's output gate holds anything the program does after
 * the change (its output, its network) until the row is durable. The waves
 * the client sends are cut from it, and an entry is forgotten once the
 * session has answered it. What a process held when it died, the session
 * drains (drainProcessFsJournal): sent again under the numbers it was given,
 * so the session's cursor answers what already landed and applies the rest
 * once.
 *
 * Entries are numbered in the order they were appended (jid). The numbers
 * the session knows them by are a function of it: from the entry at `jid`
 * on, entries are numbered under `writer` from `seq`, one each, in order
 * (number()). A new numbering is recorded only when the client opens a new
 * writer epoch, so the journal writes one row per change, and deletes it.
 */
function dataOf(op) {
    return op.type === 'call' && 'data' in op.call ? op.call.data : null;
}
/** `op` as a row: its fields as JSON, its data apart. */
function rowOf(op) {
    const data = dataOf(op);
    if (data === null)
        return { json: JSON.stringify(op), data: null };
    const { data: _data, ...call } = op.call;
    return { json: JSON.stringify({ type: 'call', call }), data };
}
function opOf(json, data) {
    const op = JSON.parse(json);
    if (data === null || data === undefined)
        return op;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return { type: 'call', call: { ...op.call, data: bytes } };
}
/**
 * The journal in a process's own SQLite. Two tables: the entries (one row
 * each, deleted once answered) and the numberings (one row per writer
 * epoch). A facet that restarts after a crash opens the same tables, and the
 * entries it finds are what its process left unanswered.
 */
export function sqlJournal(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_fs_journal (jid INTEGER PRIMARY KEY, op TEXT NOT NULL, data BLOB)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_fs_numbering (jid INTEGER PRIMARY KEY, writer TEXT, seq INTEGER NOT NULL)`);
    const last = [...sql.exec('SELECT MAX(jid) AS jid FROM nimbus_fs_journal')][0];
    let next = Number(last?.jid ?? 0) + 1;
    const held = [...sql.exec('SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM nimbus_fs_journal')][0];
    let bytes = Number(held?.bytes ?? 0);
    return {
        durable: true,
        append(op) {
            const jid = next++;
            const row = rowOf(op);
            sql.exec('INSERT INTO nimbus_fs_journal (jid, op, data) VALUES (?, ?, ?)', jid, row.json, row.data);
            bytes += row.data?.byteLength ?? 0;
            return jid;
        },
        read(jid) {
            const row = [...sql.exec('SELECT op, data FROM nimbus_fs_journal WHERE jid = ?', jid)][0];
            if (row === undefined)
                throw new Error(`process-fs journal: entry ${jid} is not held`);
            return opOf(String(row.op), row.data);
        },
        replace(jid, op) {
            const before = [...sql.exec('SELECT LENGTH(data) AS bytes FROM nimbus_fs_journal WHERE jid = ?', jid)][0];
            const row = rowOf(op);
            sql.exec('UPDATE nimbus_fs_journal SET op = ?, data = ? WHERE jid = ?', row.json, row.data, jid);
            bytes += (row.data?.byteLength ?? 0) - Number(before?.bytes ?? 0);
        },
        entries() {
            return [...sql.exec('SELECT jid, op, data FROM nimbus_fs_journal ORDER BY jid')]
                .map((row) => ({ jid: Number(row.jid), op: opOf(String(row.op), row.data) }));
        },
        readAfter(after, maxBytes) {
            const out = [];
            let taken = 0;
            for (const row of sql.exec('SELECT jid, op, data FROM nimbus_fs_journal WHERE jid > ? ORDER BY jid', after)) {
                const size = row.data === null || row.data === undefined ? 0 : row.data.byteLength;
                if (out.length > 0 && taken + size > maxBytes)
                    break;
                out.push({ jid: Number(row.jid), op: opOf(String(row.op), row.data) });
                taken += size;
            }
            return out;
        },
        dropThrough(jid) {
            const freed = [...sql.exec('SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM nimbus_fs_journal WHERE jid <= ?', jid)][0];
            bytes -= Number(freed?.bytes ?? 0);
            sql.exec('DELETE FROM nimbus_fs_journal WHERE jid <= ?', jid);
            // A numbering no held entry is under any more goes with them.
            sql.exec('DELETE FROM nimbus_fs_numbering WHERE jid < (SELECT COALESCE(MAX(jid), 0) FROM nimbus_fs_numbering WHERE jid <= ?)', jid + 1);
        },
        number(numbering) {
            // A numbering from `jid` supersedes any that started at or after it.
            sql.exec('DELETE FROM nimbus_fs_numbering WHERE jid >= ?', numbering.jid);
            sql.exec('INSERT INTO nimbus_fs_numbering (jid, writer, seq) VALUES (?, ?, ?)', numbering.jid, numbering.writer, numbering.seq);
        },
        numberings() {
            return [...sql.exec('SELECT jid, writer, seq FROM nimbus_fs_numbering ORDER BY jid')]
                .map((row) => ({ jid: Number(row.jid), writer: row.writer === null ? null : String(row.writer), seq: Number(row.seq) }));
        },
        get bytes() { return bytes; },
    };
}
/** The journal in the process's heap: for a process with no storage of its own, it dies with it. */
export function memoryJournal() {
    const held = new Map();
    const numbered = [];
    let next = 1;
    let bytes = 0;
    return {
        durable: false,
        append(op) {
            const jid = next++;
            held.set(jid, op);
            bytes += dataOf(op)?.byteLength ?? 0;
            return jid;
        },
        read(jid) {
            const op = held.get(jid);
            if (op === undefined)
                throw new Error(`process-fs journal: entry ${jid} is not held`);
            return op;
        },
        replace(jid, op) {
            const before = held.get(jid);
            if (before === undefined)
                throw new Error(`process-fs journal: entry ${jid} is not held`);
            bytes += (dataOf(op)?.byteLength ?? 0) - (dataOf(before)?.byteLength ?? 0);
            held.set(jid, op);
        },
        entries() {
            return [...held].map(([jid, op]) => ({ jid, op }));
        },
        readAfter(after, maxBytes) {
            const out = [];
            let taken = 0;
            for (const [jid, op] of held) {
                if (jid <= after)
                    continue;
                const size = dataOf(op)?.byteLength ?? 0;
                if (out.length > 0 && taken + size > maxBytes)
                    break;
                out.push({ jid, op });
                taken += size;
            }
            return out;
        },
        dropThrough(jid) {
            for (const [at, op] of held) {
                if (at > jid)
                    break;
                bytes -= dataOf(op)?.byteLength ?? 0;
                held.delete(at);
            }
            while (numbered.length > 1 && numbered[1].jid <= jid + 1)
                numbered.shift();
        },
        number(numbering) {
            while (numbered.length > 0 && numbered[numbered.length - 1].jid >= numbering.jid)
                numbered.pop();
            numbered.push({ ...numbering });
        },
        numberings() {
            return numbered.map((numbering) => ({ ...numbering }));
        },
        get bytes() { return bytes; },
    };
}
/** `journal` as a drain's source. */
export function journalSource(journal) {
    return {
        numberings: async () => journal.numberings(),
        number: async (numbering) => { journal.number(numbering); },
        readAfter: async (after, maxBytes) => journal.readAfter(after, maxBytes),
        dropThrough: async (jid) => { journal.dropThrough(jid); },
    };
}
