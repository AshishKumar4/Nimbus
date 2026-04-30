// W2.5b — diagnostic capture for fastify install on prod.
// Runs in fresh prod session: npm install fastify, captures missing-pkg
// state via fs.readdirSync. Worker logs (with [sqlite-vfs/W2.5b] lines)
// are captured via `wrangler tail` separately.
//
// Output: audit/probes/w25-diag-fastify.txt

import { runProbe, nodeEvalBase64 } from './_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'w25-diag-fastify.txt');
fs.writeFileSync(ARTIFACT, '');

const introspectScript = `
const fs = require('fs');
const path = require('path');
const NM = '/home/user/app/node_modules';
const PKGS = ['fastify','avvio','fastq','pino','semver','fast-json-stringify',
              'find-my-way','light-my-request','process-warning','rfdc',
              'secure-json-parse','toad-cache','@fastify/error',
              '@fastify/ajv-compiler','@fastify/fast-json-stringify-compiler',
              '@fastify/forwarded','@fastify/merge-json-schemas',
              '@fastify/proxy-addr','abstract-logging'];
const out = {};
for (const p of PKGS) {
  const dir = NM + '/' + p;
  try {
    const st = fs.statSync(dir);
    const ents = fs.readdirSync(dir);
    out[p] = { exists: true, count: ents.length, sample: ents.slice(0,5) };
  } catch (e) {
    out[p] = { exists: false, err: e.code || e.message };
  }
}
console.log('INTROSPECT_BEGIN');
console.log(JSON.stringify(out, null, 2));
console.log('INTROSPECT_END');

// Find empty dirs anywhere under node_modules (depth 2)
console.log('EMPTY_DIRS_BEGIN');
function walk(d, depth) {
  if (depth > 2) return;
  let ents;
  try { ents = fs.readdirSync(d); } catch (_) { return; }
  if (ents.length === 0) console.log(d);
  for (const e of ents) {
    const p2 = d + '/' + e;
    try { if (fs.statSync(p2).isDirectory()) walk(p2, depth + 1); } catch (_) {}
  }
}
walk(NM, 0);
console.log('EMPTY_DIRS_END');
`;

await runProbe('w25-diag-fastify', [
  { kind: 'cmd', cmd: 'cd app && npm install fastify', timeoutMs: 90_000, waitFor: /added \d+ package|npm warn|npm error/ },
  { kind: 'cmd', cmd: nodeEvalBase64(introspectScript), timeoutMs: 30_000 },
  { kind: 'cmd', cmd: 'curl -s http://localhost/api/stats 2>/dev/null || echo "(no stats endpoint via curl)"', timeoutMs: 5_000 },
], { artifactPath: ARTIFACT, settleMs: 5000 });

console.log('done. Artifact:', ARTIFACT);
