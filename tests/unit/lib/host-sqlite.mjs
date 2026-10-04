// The workspace's SQLite on the host's own database, as core's README shows:
// bun:sqlite under Bun, node:sqlite under Node. For a test that runs the
// library under both (inline-node-realm, local-facet-realm).

const underBun = typeof process.versions.bun === 'string';

/** The workspace's SQLite, on the host's own: bun:sqlite or node:sqlite, as core's README shows. */
export async function hostSqlite() {
  if (underBun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:');
    return {
      sql: { exec(q, ...p) { const st = db.query(q); if (st.columnNames.length === 0) { db.run(q, ...p); return []; } return st.all(...p); } },
      transactions: { storage: { transactionSync: (cb) => db.transaction(cb)() } },
    };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  return {
    sql: {
      exec(q, ...p) {
        const st = db.prepare(q);
        if (st.columns().length === 0) { if (p.length === 0) db.exec(q); else st.run(...p); return []; }
        return st.all(...p);
      },
    },
    transactions: {
      storage: {
        transactionSync(cb) {
          const name = `s${depth}`;
          db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
          depth++;
          try {
            const result = cb();
            depth--;
            db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
            return result;
          } catch (error) {
            depth--;
            db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
            throw error;
          }
        },
      },
    },
  };
}
