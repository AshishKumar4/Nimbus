#!/usr/bin/env bun
// X5M vC: alternative approach — define globalThis.location AND globalThis.document
// so the rollup-emitted ternary picks up location.href.
//
// Rollup's __filename polyfill for browser/CJS (when document/location undefined):
//   typeof document === 'undefined' ? new URL('file:' + __filename).href :
//     (document.currentScript && document.currentScript.src ||
//      new URL('main.js', document.baseURI).href)
//
// If document is undefined and __filename is also undefined, returns "file:undefined".
// If __filename IS defined (which it is for our modules), would return "file:/path/to/module.js".
//
// But our v5 probe showed second arg comes through as LITERAL null. So vite's
// polyfill must be different — possibly the rolldown/oxc one emits something
// like `import.meta.url || null` inline.
//
// Test: instead of patching URL, define globalThis.location + document with realistic values.
// See if vite then forms valid URLs.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) { console.error('Set BASE=http://127.0.0.1:8788'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stackC.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
// Set globalThis.location to a sane file:// URL.
globalThis.location = { href: 'file:///home/user/app/' };
globalThis.document = { baseURI: 'file:///home/user/app/' };

let viteOk = false;
try {
  const m = require('vite');
  viteOk = true;
  console.log('VITE_OK keys:', Object.keys(m).slice(0,8).join(','));
} catch (e) {
  console.log('VITE_FAIL:', e.message);
  console.log(e.stack && e.stack.split('\\n').slice(0, 8).join('\\n'));
}
`;

const id = 'vite_invC_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stackC', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
