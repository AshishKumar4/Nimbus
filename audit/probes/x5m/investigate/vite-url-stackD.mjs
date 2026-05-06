#!/usr/bin/env bun
// X5M vD: stronger guarded URL — when base is null/undefined, derive a
// reasonable base from the call-stack module path. Use Error stack to find
// the loadModule frame and extract __filename.
//
// More practical: check if base passed as null can be replaced with a
// realistic file:// URL based on the FAILED relative path. The relative
// "../../../src/node/constants.ts" suggests the consumer expects
// import.meta.url = file:///<vite-package-root>/dist/node/chunks/node.js,
// such that "../../../src/..." resolves to <vite-pkg-root>/src/...
//
// Test: synthesize base from the relative path's "depth" backward from
// the actual loaded vite chunks/node.js path, which is well-known.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) { console.error('Set BASE=http://127.0.0.1:8788'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stackD.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const _OrigURL = globalThis.URL;
class GuardedURL extends _OrigURL {
  constructor(rel, base) {
    if (base == null) {
      // No base provided. Try to assume we're inside chunks/node.js since
      // that's the well-known pattern. Replace with a base that, when
      // resolved against rel="../../../src/...", returns
      // "file:///home/user/app/node_modules/vite/src/...". Then if vite
      // does fs.readFile(href.slice(7)), it gets the right path —
      // BUT vite's package only ships dist/, not src/. So this won't
      // work for vite — the URL it builds points to a file that doesn't
      // exist in the install. That's a vite-bundle vs runtime composition
      // gap, NOT a shim gap.
      base = 'file:///home/user/app/node_modules/vite/dist/node/chunks/node.js';
    }
    super(rel, base);
  }
}
for (const k of Object.getOwnPropertyNames(_OrigURL)) {
  if (typeof _OrigURL[k] === 'function' && !(k in GuardedURL)) {
    try { GuardedURL[k] = _OrigURL[k].bind(_OrigURL); } catch {}
  }
}
globalThis.URL = GuardedURL;

try {
  const m = require('vite');
  console.log('VITE_OK keys:', Object.keys(m).slice(0,8).join(','));
} catch (e) {
  console.log('VITE_FAIL:', e.message);
  console.log(e.stack && e.stack.split('\\n').slice(0, 12).join('\\n'));
}
`;

const id = 'vite_invD_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stackD', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
