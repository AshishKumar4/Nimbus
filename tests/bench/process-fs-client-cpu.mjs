#!/usr/bin/env bun
// The client's submit and delivery CPU, with an independent module graph per arm.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { HOLDER_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

const TEN = new TextEncoder().encode('0123456789');
const MODULE = '_shared/process-fs-client.ts';
const FRAMES = 'packages/platform/src/w7-frame.ts';
let checksum = 0;

function storage() {
  const db = new Database(':memory:');
  return {
    db,
    sql: {
      exec(query, ...bindings) {
        const statement = db.query(query);
        if (statement.columnNames.length > 0) return statement.all(...bindings);
        db.run(query, ...bindings);
        return [];
      },
    },
  };
}

/** The arm's client (`module`) writing, the arm's own frame decoder standing in for the supervisor. */
async function work(module, { decodeWriteBatchStream }, mode, writes, files, metric) {
  const durable = mode === 'sql' ? storage() : null;
  const journal = durable ? module.sqlJournal(durable.sql) : module.memoryJournal();
  const received = Array.from({ length: files }, () => new Uint8Array(writes / files * TEN.byteLength));
  let delivered = 0;
  const client = module.processFsClient({ journal, session: {
    openWriter: async () => null,
    writeBatchStream: async (stream) => {
      const decoded = await decodeWriteBatchStream(stream);
      let current;
      let at = 0;
      let committedOps = 0;
      let chunks = 0;
      for await (const record of decoded.records) {
        if (record.type === 'file-begin') {
          current = received[Number(record.inode.path.slice(-1))];
          at = record.inode.offset;
        } else if (record.type === 'file-chunk') {
          current.set(record.data, at);
          at += record.data.byteLength;
          delivered += record.data.byteLength;
          chunks++;
          record.retention.release();
        } else if (record.type === 'file-end') committedOps++;
      }
      return { ok: true, committedGroupSequence: 0, committedPathCount: files, committedOps, inodes: committedOps, chunks, receipts: [] };
    },
  } });
  try {
    const before = process.cpuUsage();
    for (let i = 0; i < writes; i++) {
      const file = i % files;
      client.submit({ type: 'call', call: {
        call: 'write', path: `home/user/f${file}`, ino: file + 2,
        offset: Math.floor(i / files) * TEN.byteLength, data: TEN,
      } }, { acknowledged: true });
    }
    // Read synchronously: awaiting even a void callback would run the pump first.
    const submitted = process.cpuUsage(before);
    await client.settle();
    const total = process.cpuUsage(before);
    assert.equal(client.stats().folded, files === 1 ? writes - 1 : 0);
    assert.equal(journal.bytes, 0);
    assert.equal(journal.entries().length, 0);
    assert.equal(delivered, writes * TEN.byteLength);
    for (const data of received) for (let i = 0; i < data.byteLength; i++) assert.equal(data[i], TEN[i % TEN.byteLength]);
    checksum += delivered;
    const used = metric === 'submit' ? submitted : total;
    return (used.user + used.system) / 1000;
  } finally {
    durable?.db.close();
  }
}

await runPairedBenchmark({
  async run({ short, cleanup, withArms, sample }) {
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: HOLDER_CPU_SOURCES, modules: [MODULE], helpers: [FRAMES],
    }), async (arms) => {
      for (const mode of ['heap', 'sql']) for (const writes of [5_000, 20_000]) for (const files of [1, 2]) for (const metric of ['submit', 'total']) {
        const kind = `${mode}-${writes}-${files}file-${metric}`;
        await sample(kind, arms, (modules) => work(modules[MODULE], modules[FRAMES], mode, short ? 500 : writes, files, metric), {
          pairs: 12, warm: 4, iterations: 1,
        });
      }
    });
    assert.ok(checksum > 0);
  },
});
