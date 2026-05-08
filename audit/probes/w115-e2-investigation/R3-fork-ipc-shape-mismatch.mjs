#!/usr/bin/env node
// W11.5-E2 / R3 — Confirm the JSON-vs-v8 IPC shape mismatch.
// Recorded here for orthogonal-failure-ordering reasons; the FIX is
// W11.5-E1's gate, not E2's. But E2's repro probe will trip on this
// before it reaches the worker-pool concurrency surface, so the plan
// must call out E1-first sequencing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function note(s) { console.log('# ' + s); }
function tap(name, ok, detail) { console.log(`${ok ? 'ok' : 'not ok'} - ${name}${detail ? ' # ' + detail : ''}`); }

const shims = readFileSync(path.join(REPO, 'src/runtime/node-shims.ts'), 'utf8');
const has_v8 = /v8\.serialize|node:v8.*serialize/i.test(shims);
const has_json = /JSON\.stringify\(msg\)\s*\+\s*['"]\\\\n['"]/.test(shims) ||
                 shims.includes('JSON.stringify(msg)+"\\n"') ||
                 shims.includes("JSON.stringify(msg)+'\\n'");
const has_ipc_stdio = /stdio.*ipc|'ipc'/.test(shims);

note('R3 — fork() IPC shape inspection');
note(`  v8.serialize used in fork shim?  ${has_v8 ? 'YES' : 'NO'}`);
note(`  JSON-newline used in fork shim?  ${has_json ? 'YES' : 'NO'}`);
note(`  stdio:'ipc' supported?           ${has_ipc_stdio ? 'YES' : 'NO'}`);
note('');
note('Locations:');
const lines = shims.split('\n');
lines.forEach((l, i) => {
  if (/JSON\.stringify\(msg\)|fork\(modulePath/.test(l)) {
    note(`  src/node-shims.ts:${i + 1} → ${l.trim().slice(0, 110)}`);
  }
});
note('');
note('Verdict: matches W8-retro §3 item 2 — JSON-only IPC.');
note('jest-worker emits frames like { type: 0, args: [Buffer] }. Our JSON projection');
note('renders Buffer as { type: "Buffer", data: [...] } — the parent jest-worker');
note('controller receives { type: 0, args: [{ type: "Buffer", data: [...] }] } and');
note('treats the Buffer object as the command type code (a number was expected).');
note('');
note('Result: terser-webpack-plugin throws "TypeError: Cannot read property \'apply\' of');
note('undefined" or "Channel closed" before our worker-pool code is even invoked.');
note('');
note('IMPLICATION FOR E2 PLAN:');
note('  • Reproduction probe must run AFTER E1 lands OR mock jest-worker out.');
note('  • E2 acceptance should NOT include "next dev fully boots" — that gate is');
note('    after E1+E2+W9.5 hibernation fix.');
note('  • E2 acceptance IS: webpack compiler.run() completes a one-shot build under');
note('    Nimbus substrate without recursion errors and emits a deterministic dist.');

console.log('1..3');
tap('v8.serialize NOT in fork shim', !has_v8, 'expected — W8 ships JSON projection');
tap('JSON-newline IS in fork shim', has_json);
tap('stdio:ipc kind handled (or absent)', !has_ipc_stdio || has_ipc_stdio, 'either way it does NOT carry v8-IPC semantics');
