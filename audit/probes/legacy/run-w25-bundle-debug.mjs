// Debug: what's in the bundle vs missing?

import { runProbe, nodeEvalBase64 } from './_driver.mjs';
import fs from 'node:fs';

const ARTIFACT = '/tmp/bundle-debug.txt';
fs.writeFileSync(ARTIFACT, '');

const probe = `
const fs = require('fs');
const NM = '/home/user/app/node_modules';
console.log('---DEBUG-BEGIN---');
// Try to read fastq's package.json + index.js
for (const f of ['fastq/package.json','fastq/queue.js','fastq/index.d.ts','avvio/package.json','avvio/lib/index.js','avvio/index.js']) {
  try {
    const c = fs.readFileSync(NM + '/' + f, 'utf8');
    console.log(f + ' BUNDLED size=' + c.length);
  } catch (e) {
    console.log(f + ' MISSING ' + e.code);
  }
}
console.log('---DEBUG-END---');
`;

await runProbe('bundle-debug', [
  { kind: 'cmd', cmd: 'cd app && npm install fastify', timeoutMs: 90_000, waitFor: /added \d+ package/ },
  { kind: 'cmd', cmd: nodeEvalBase64(probe), timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log(ARTIFACT);
