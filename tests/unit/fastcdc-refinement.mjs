// Refinement bridge for Nimbus.Vfs.FastCdc (lean/traceability.yaml CDC-001).
// lean/fixtures/fastcdc.json holds buffers and the chunk ends the Lean model's
// cutContent gives at the deployed parameters; the deployed cutContent, and a
// ContentCutter fed the same bytes in random pieces (sizes up to 3x CDC_MAX),
// must give exactly those ends.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContentCutter, cutContent } from '../../packages/core/src/vfs/content-chunking.ts';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/fastcdc.json', import.meta.url), 'utf8'));

function bytes(seed, n, runs) {
  let s = (Math.imul(seed, 2654435761) + 1) >>> 0;
  if (s === 0) s = 1;
  const out = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    if (runs && Math.floor(j / 4096) % 2 === 1) { out[j] = out[j - 4096]; continue; }
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[j] = s & 255;
  }
  return out;
}

let rng = 0x5eed;
function below(n) { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng % n; }

for (const c of fixture.cases) {
  const data = bytes(c.seed, c.length, c.runs);
  const where = `seed ${c.seed} length ${c.length} runs ${c.runs}`;
  assert.deepEqual(cutContent(data), c.ends, `${where}: cutContent`);
  // The stream path cuts only files above one chunk (a smaller file is one chunk).
  if (c.length <= 65536) continue;
  for (let trial = 0; trial < 4; trial++) {
    const cutter = new ContentCutter();
    const ends = [];
    let at = 0;
    const emit = (chunks) => { for (const chunk of chunks) { at += chunk.byteLength; ends.push(at); } };
    for (let pos = 0; pos < data.length;) {
      const size = 1 + below(3 * 65536);
      emit(cutter.push(data.subarray(pos, Math.min(data.length, pos + size))));
      pos += size;
    }
    emit(cutter.finish());
    assert.deepEqual(ends, c.ends, `${where}: ContentCutter trial ${trial}`);
  }
}
console.log(`fastcdc-refinement: ${fixture.cases.length} buffers cut as the model cuts them`);
