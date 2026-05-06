#!/usr/bin/env bun
// X5M vB: probe whether wrapping URL to fall back to "file:///" as base when
// second arg is null/undefined makes vite load successfully. If so, the fix
// for M-3 is to install a guarded URL global in node-shims.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) { console.error('Set BASE=http://127.0.0.1:8788'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stackB.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const _OrigURL = globalThis.URL;
class GuardedURL extends _OrigURL {
  constructor(rel, base) {
    if (base == null) base = 'file:///';
    super(rel, base);
  }
}
// Preserve static methods (createObjectURL, revokeObjectURL, canParse, parse).
for (const k of Object.getOwnPropertyNames(_OrigURL)) {
  if (typeof _OrigURL[k] === 'function' && !(k in GuardedURL)) {
    try { GuardedURL[k] = _OrigURL[k].bind(_OrigURL); } catch {}
  }
}
globalThis.URL = GuardedURL;

let urlCount = 0;
const _origConstruct = GuardedURL.prototype.constructor;
console.log('PATCHED');
let viteOk = false;
try {
  const m = require('vite');
  viteOk = true;
  console.log('VITE_OK keys:', Object.keys(m).slice(0,8).join(','));
} catch (e) {
  console.log('VITE_FAIL:', e.message);
  console.log('STACK:', e.stack && e.stack.split('\\n').slice(0, 5).join('\\n'));
}
`;

const id = 'vite_invB_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stackB', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
