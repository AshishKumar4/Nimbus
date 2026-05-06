#!/usr/bin/env bun
// X5M vA: instrument URL with stack capture to identify EXACT line/file in
// chunks/node.js that emits new URL("...", null).

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.BASE) { console.error('Set BASE=http://127.0.0.1:8788'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'vite-url-stackA.txt');
fs.writeFileSync(ARTIFACT, '');

const PROBE_JS = `
Error.stackTraceLimit = Infinity;
const _OrigURL = globalThis.URL;
let firstStack = null;
let firstArgs = null;
globalThis.URL = function PatchedURL(...args) {
  if (firstStack === null) {
    firstArgs = args;
    firstStack = new Error().stack;
  }
  return new _OrigURL(...args);
};
for (const k of Object.getOwnPropertyNames(_OrigURL)) {
  try { globalThis.URL[k] = _OrigURL[k]; } catch {}
}
globalThis.URL.prototype = _OrigURL.prototype;

// Also log __filename, __dirname, document, location at call site? Can't —
// they're not globals when the patched URL is called. But we can dump them
// from the runner's perspective.
console.log('PRE typeof document:', typeof document, 'typeof location:', typeof location);
console.log('PRE typeof __filename:', typeof __filename, 'typeof __dirname:', typeof __dirname);

try {
  const m = require('vite');
  console.log('UNEXPECTED_OK');
} catch (e) {
  console.log('FIRST_URL_ARGS:', JSON.stringify(firstArgs));
  console.log('FIRST_URL_STACK:');
  console.log(firstStack);
  console.log('FAIL_MSG:', e.message);
}
`;

const id = 'vite_invA_' + Date.now().toString(36);
const b64 = Buffer.from(PROBE_JS, 'utf8').toString('base64');
const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
const runCmd = `cd /home/user/app && node .${id}.js`;

await runProbe('vite-url-stackA', [
  { kind: 'cmd', cmd: 'cd app && npm install vite', timeoutMs: 240_000 },
  { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });
console.log('Wrote', ARTIFACT);
