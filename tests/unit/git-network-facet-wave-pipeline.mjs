#!/usr/bin/env bun
// The git facet's writes publish as a pipeline: one W7 wave in flight while
// the next buffers, never two in flight, and a failed wave is the last one
// sent. Admitting a write costs its own new directories, never a recount of
// the wave it joins.
//
// Red before the wave writer: the buffered fs awaited each wave's RPC inline
// (no write completed while a wave was in flight), recounted the wave's owned
// paths on every write (no counter, and O(wave) work per write), and named no
// wave in a failure. The writes come from a git fetch: its buffered fs is
// the facet's one wave writer.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { decodeWriteBatchStream, W7_MAX_PATHS_PER_BATCH } from '../../packages/platform/src/w7-frame.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';

const FILES = 3_000;
const tempDir = mkdtempSync(join(tmpdir(), 'nimbus-git-facet-wave-pipeline-'));

try {
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  // A fetch that writes FILES files across a few hundred directories, and
  // counts each write as it completes.
  writeFileSync(join(tempDir, 'git-bundle.js'), `
export const gitHttp = {};
export const git = {
  async fetch({ fs, dir }) {
    const root = dir.replace(/^\\/+/, '');
    for (let i = 0; i < ${FILES}; i++) {
      const path = root + '/src/d' + (i % 37) + '/e' + (i % 11) + '/file-' + i + '.txt';
      await fs.promises.writeFile(path, 'content of file ' + i + '\\n');
      globalThis.__writesDone = (globalThis.__writesDone || 0) + 1;
    }
  },
};
`);
  const facetWorker = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);

  function supervisorFor({ failWave = null } = {}) {
    const files = new Map();
    const record = { calls: 0, inFlight: 0, maxInFlight: 0, writesDuringFlight: 0 };
    const supervisor = {
      async stat() { return null; },
      async lstat() { return null; },
      async hasLegacySymlinkUnder() { return false; },
      async readdir() { return []; },
      async readFileBytes(path) { return files.get(path) ?? null; },
      async fsReadRange() { throw new Error('unexpected fsReadRange'); },
      async writeBatchStream(stream) {
        const wave = ++record.calls;
        record.inFlight++;
        record.maxInFlight = Math.max(record.maxInFlight, record.inFlight);
        const writesBefore = globalThis.__writesDone || 0;
        try {
          const decoded = await decodeWriteBatchStream(stream);
          let active = null;
          for await (const entry of decoded.records) {
            if (entry.type === 'file-begin') active = { path: entry.inode.path, parts: [] };
            else if (entry.type === 'file-chunk') {
              active.parts.push(entry.data.slice());
              entry.retention.release();
            } else if (entry.type === 'file-end') {
              files.set(active.path, Buffer.concat(active.parts));
              active = null;
            }
          }
          // The RPC's own latency: the producer has this long to buffer the next wave.
          await new Promise((resolve) => setTimeout(resolve, 15));
          record.writesDuringFlight += (globalThis.__writesDone || 0) - writesBefore;
          if (wave === failWave) {
            return { ok: false, committedGroupSequence: 0, committedPathCount: 0, error: { message: 'injected wave failure' } };
          }
          return { ok: true, committedGroupSequence: 1, committedPathCount: 1, inodes: 1, chunks: 1 };
        } finally {
          record.inFlight--;
        }
      },
      async stdout() {},
    };
    return { supervisor, record, files };
  }

  async function fetchInto(supervisor, name) {
    globalThis.__writesDone = 0;
    const response = await facetWorker.default.fetch(
      new Request('http://git/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'fetch', dir: `/${name}`, remote: 'origin' }),
      }),
      { SUPERVISOR: supervisor },
    );
    return response.json();
  }

  // ── A pipeline: writes keep landing while a wave is in flight ──────────
  {
    const { supervisor, record, files } = supervisorFor();
    const result = await fetchInto(supervisor, 'pipelined');
    assert.equal(result.success, true, result.error);
    assert.equal(files.get('pipelined/src/d5/e5/file-5.txt')?.toString(), 'content of file 5\n');
    assert.equal(files.get(`pipelined/src/d${(FILES - 1) % 37}/e${(FILES - 1) % 11}/file-${FILES - 1}.txt`)?.toString(),
      `content of file ${FILES - 1}\n`);
    assert.ok(record.calls > 3, `fixture crossed only ${record.calls} waves`);
    assert.equal(record.maxInFlight, 1, 'two waves were in flight at once');
    assert.ok(record.writesDuringFlight > FILES / 4,
      `only ${record.writesDuringFlight} of ${FILES} writes completed while a wave was in flight: waves are not pipelined`);
    const waves = result.diagnostic.waves;
    assert.ok(waves, 'the diagnostic carries no wave writer counters');
    assert.equal(waves.waves, record.calls);
    // A write probes itself and its directories up to the first one the wave
    // already owns: a handful each. Recounting the wave would be ~100 each.
    assert.ok(waves.ownershipVisits <= 12 * (FILES + 10),
      `ownership accounting probed ${waves.ownershipVisits} paths for ${FILES} writes: it recounts the wave`);
    assert.ok(waves.maxWavePaths <= W7_MAX_PATHS_PER_BATCH, `a wave owned ${waves.maxWavePaths} paths`);
  }

  // ── A failed wave is the last one sent, and it is named ────────────────
  {
    const { supervisor, record } = supervisorFor({ failWave: 3 });
    const result = await fetchInto(supervisor, 'failing');
    assert.equal(result.success, false, 'a failed wave reported success');
    assert.match(result.error, /write wave 3 failed/);
    assert.match(result.error, /injected wave failure/);
    assert.equal(record.calls, 3, `a wave was sent after wave 3 failed (${record.calls} sent)`);
    assert.ok(result.filesWritten < FILES, 'the failed wave and its successors counted as written');
  }

  console.log('git network facet wave pipeline: ok');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
