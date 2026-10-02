// Reports a server's live heap on request (interpreter-memory.mjs), loaded
// with `node --expose-gc --import`: on SIGUSR2, collect garbage and write the
// V8 heap's used bytes to NIMBUS_HEAP_FILE.

import { writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

process.on('SIGUSR2', () => {
  globalThis.gc();
  globalThis.gc();
  writeFileSync(process.env.NIMBUS_HEAP_FILE, String(getHeapStatistics().used_heap_size));
});
