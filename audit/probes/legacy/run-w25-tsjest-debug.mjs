import { runProbe, nodeEvalBase64 } from './_driver.mjs';
import fs from 'node:fs';

const ARTIFACT = '/tmp/tsjest-debug.txt';
fs.writeFileSync(ARTIFACT, '');

const probe = `
const fs = require('fs');
const NM = '/home/user/app/node_modules';
console.log('TS_BEGIN');
console.log('typescript_exists=' + fs.existsSync(NM + '/typescript'));
try {
  const ents = fs.readdirSync(NM + '/typescript');
  console.log('typescript_count=' + ents.length);
  console.log('typescript_first=' + JSON.stringify(ents.slice(0,5)));
} catch (e) { console.log('typescript_readdir_err=' + e.code); }
try {
  const st = fs.statSync(NM + '/typescript');
  console.log('typescript_isdir=' + st.isDirectory());
} catch (e) { console.log('typescript_stat_err=' + e.code); }
// Top-level NM listing
try {
  const top = fs.readdirSync(NM);
  console.log('NM_count=' + top.length);
  console.log('NM_has_typescript=' + top.includes('typescript'));
  console.log('NM_first=' + JSON.stringify(top.slice(0, 30)));
} catch (e) {}
console.log('TS_END');
`;

await runProbe('tsjest-debug', [
  { kind: 'cmd', cmd: 'cd app && npm install ts-jest jest typescript', timeoutMs: 240_000, waitFor: /added \d+ package|npm error/ },
  { kind: 'cmd', cmd: nodeEvalBase64(probe), timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log(ARTIFACT);
