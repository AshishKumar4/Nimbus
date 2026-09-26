#!/usr/bin/env bun
// N18 for a running facet. A node process's facet database grows as the
// process runs: its own writes cached, fills, and content an ACQUIRE pushes.
// Each growth is admitted by the session's ledger under the facet's name
// before it is written; the store never grows its database past the
// allowance it holds. A program that writes past a small limit therefore
// never takes the session DO and its facet together past it. The program
// sees ENOSPC only when the session itself refuses the write, and a refused
// write is not served back to it.

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, facetSql } from './lib/resident-body.mjs';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';

const PROGRAM = `
const fs = require("fs");
let seed = 1;
const bytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; b[i] = seed >>> 24; } return b; };
const size = (p) => { try { return fs.readFileSync(p).length; } catch (e) { return e.code; } };
globalThis.__probe = {
  writeSync: (p, n) => { try { fs.writeFileSync(p, bytes(n)); return "ok"; } catch (e) { return e.code; } },
  writeAsync: (p, n) => fs.promises.writeFile(p, bytes(n)).then(() => "ok", (e) => e.code),
  size,
  settle: () => new Promise((r) => setTimeout(r, 20)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

const authority = createAuthority({ storageKernelReserve: 0 });
authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
const raw = authority.rawVfs;
const limit = raw.databaseBytes() + 12_000_000;
raw.ledger = new StorageLedger(raw.sql, { limit, kernelReserve: 0 });
const handle = facetSupervisor(authority);
const sql = facetSql();
const FACET = 'proc-slot-0';
// The fabric admits the launch's fill before the facet exists.
raw.ledger.fill(FACET, 256 * 1024);
const { started } = await launchResident({
  authority, sql, program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor(),
  startArgs: { storage: { facet: FACET, grant: 256 * 1024 } },
});
// As the fabric does once the facet is up: its row is the cap it keeps under.
if (typeof started?.storageCap === "number") raw.ledger.reportSize(FACET, started.storageCap);
const facetBytes = () => sql.db.query('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get().n;
const inSession = (name) => authority.kfs.exists(`home/user/app/${name}`);
const probe = globalThis.__probe;

const MB = 1_000_000;
let refused = 0;
let uncached = 0;
for (let i = 0; i < 16; i++) {
  const async = i % 2 === 0;
  const name = `out${i}`;
  const room = limit - raw.ledger.view().used;
  const answer = async ? await probe.writeAsync(`/home/user/app/${name}`, MB) : probe.writeSync(`/home/user/app/${name}`, MB);
  await probe.settle();
  await probe.settle();
  // The session and its facet together never pass the limit, and the facet
  // stays within what the ledger holds for it.
  assert.ok(raw.databaseBytes() + facetBytes() <= limit, `step ${i}: session ${raw.databaseBytes()} + facet ${facetBytes()} > ${limit}`);
  assert.ok(facetBytes() <= raw.ledger.view().facets[FACET], `step ${i}: the facet grew past its allowance: ${facetBytes()} > ${raw.ledger.view().facets[FACET]}`);
  if (inSession(name)) {
    assert.equal(answer, 'ok');
    // Held by the facet, unless the ledger had no room left for its copy:
    // then the bytes are the session's only, and a sync read names the miss.
    const read = probe.size(`/home/user/app/${name}`);
    if (read !== MB) {
      assert.equal(read, 'EAGAIN', `step ${i}`);
      assert.ok(limit - raw.ledger.view().used < MB, `step ${i}: not held with room for it`);
      uncached++;
    }
  } else {
    refused++;
    // Only the session refuses: there was no room for it there.
    assert.ok(room < MB, `step ${i}: refused with ${room} bytes free`);
    // An async writer is told; a sync one's write is not served back.
    if (async) assert.equal(answer, 'ENOSPC');
    assert.equal(probe.size(`/home/user/app/${name}`), 'ENOENT');
  }
}
assert.ok(refused > 0, 'the program wrote past the limit');
assert.ok(refused < 16);

await Bun.write(Bun.stdout, `n18-facet-growth: ok (${16 - refused} writes landed, ${uncached} of them not held by the facet, ${refused} refused by the session)\n`);
