#!/usr/bin/env bun
// X5M investigation v5: directly evaluate chunks/node.js by reading its
// source and using new Function — but with try/catch sentinels to localize
// the throwing line at runtime.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) {
  console.error('Set BASE=http://127.0.0.1:8788');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stack5.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
const fs = require('fs');
const NODE = '/home/user/app/node_modules/vite/dist/node/chunks/node.js';

let exists = false;
try { fs.statSync(NODE); exists = true; } catch {}
console.log('NODE_EXISTS:', exists);
if (!exists) { console.log('REINSTALL_NEEDED'); process.exit(0); }

const src = fs.readFileSync(NODE, 'utf8');
const lines = src.split('\\n');
console.log('TOTAL_LINES:', lines.length);

// Strategy: bisect by replacing the file with successive prefixes and
// re-requiring vite. Find the smallest prefix (rounded to nearest top-level
// statement) that still triggers the URL error.
// Simpler: monkey-patch the URL constructor to log every call with its arg.
//
// Actually — we know the loader uses new Function(). The error fires during
// the eval of chunks/node.js. So just intercept URL with a logging proxy
// and try requiring vite. The last logged URL is the offender.

const _OrigURL = globalThis.URL;
let lastInput = null;
let urlCallCount = 0;
globalThis.URL = function PatchedURL(...args) {
  urlCallCount++;
  lastInput = args;
  if (urlCallCount <= 50) {
    console.log('URL_CALL #' + urlCallCount + ': args=' + JSON.stringify(args).slice(0, 200));
  }
  try { return new _OrigURL(...args); }
  catch (e) {
    console.log('URL_THREW at call#' + urlCallCount + ' args=' + JSON.stringify(args) + ' err=' + e.message);
    throw e;
  }
};
// Copy static methods
for (const k of Object.getOwnPropertyNames(_OrigURL)) {
  try { globalThis.URL[k] = _OrigURL[k]; } catch {}
}
globalThis.URL.prototype = _OrigURL.prototype;

console.log('TRY_REQUIRE');
try {
  const m = require('vite');
  console.log('UNEXPECTED_OK keys:', Object.keys(m).slice(0,5));
} catch (e) {
  console.log('FAIL_MSG:', e.message);
  console.log('LAST_URL_INPUT:', JSON.stringify(lastInput));
  console.log('TOTAL_URL_CALLS:', urlCallCount);
}
`;

const id = 'vite_inv5_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stack5', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
