// sqlJournal and its helpers from main 9c1f4eeb82bc69367b2f46a68f13f17f90010d9f.
// Type-only imports point at the current contracts; the reader code is unchanged.
import type { W7Call } from '../../../packages/platform/src/w7-frame.js';
import type { ProcessFsOp } from '../../../packages/core/src/_shared/process-fs-client.js';
import type { JournalSql, ProcessFsJournal } from '../../../packages/core/src/_shared/process-fs-journal.js';

function dataOf(op: ProcessFsOp): Uint8Array | null {
  return op.type === 'call' && 'data' in op.call ? op.call.data : null;
}

function rowOf(op: ProcessFsOp): { json: string; data: Uint8Array | null } {
  const data = dataOf(op);
  if (data === null) return { json: JSON.stringify(op), data: null };
  const { data: _data, ...call } = (op as { type: 'call'; call: { data: Uint8Array } }).call;
  return { json: JSON.stringify({ type: 'call', call }), data };
}

type JournaledOpen = Omit<Extract<W7Call, { call: 'open' }>, 'access'> & { access?: undefined; read?: true };
type JournaledOp = Exclude<ProcessFsOp, { type: 'call' }> | { type: 'call'; call: W7Call | JournaledOpen };

function currentCall(call: W7Call | JournaledOpen): W7Call {
  if (call.call === 'open' && call.access === undefined) {
    const { read, ...open } = call;
    return { ...open, access: read === true ? 'readwrite' : 'write' };
  }
  return call;
}

function opOf(json: string, data: unknown): ProcessFsOp {
  const journaled: JournaledOp = JSON.parse(json);
  const op: ProcessFsOp = journaled.type === 'call' ? { type: 'call', call: currentCall(journaled.call) } : journaled;
  if (data === null || data === undefined) return op;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  return { type: 'call', call: { ...(op as { call: object }).call, data: bytes } } as ProcessFsOp;
}

export function sqlJournal(sql: JournalSql): ProcessFsJournal {
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
      if (row === undefined) throw new Error(`process-fs journal: entry ${jid} is not held`);
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
      const out: { jid: number; op: ProcessFsOp }[] = [];
      let taken = 0;
      for (const row of sql.exec('SELECT jid, op, data FROM nimbus_fs_journal WHERE jid > ? ORDER BY jid', after)) {
        const size = row.data === null || row.data === undefined ? 0 : (row.data as ArrayBuffer).byteLength;
        if (out.length > 0 && taken + size > maxBytes) break;
        out.push({ jid: Number(row.jid), op: opOf(String(row.op), row.data) });
        taken += size;
      }
      return out;
    },
    dropThrough(jid) {
      const freed = [...sql.exec('SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM nimbus_fs_journal WHERE jid <= ?', jid)][0];
      bytes -= Number(freed?.bytes ?? 0);
      sql.exec('DELETE FROM nimbus_fs_journal WHERE jid <= ?', jid);
      sql.exec(
        'DELETE FROM nimbus_fs_numbering WHERE jid < (SELECT COALESCE(MAX(jid), 0) FROM nimbus_fs_numbering WHERE jid <= ?)',
        jid + 1,
      );
    },
    number(numbering) {
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
