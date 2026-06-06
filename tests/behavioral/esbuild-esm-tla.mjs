#!/usr/bin/env bun
// behavioral/esbuild-esm-tla — minimal repro of the Nuxt ESM-in-CJS bug.
//
// Category: B (build/transform).
//
// Bug: when source has BOTH ESM `import` statements AND top-level `await`,
// the EsbuildService.transform path with format:cjs fails with
// "Unexpected <identifier>" — the previous TLA fix (framework-gaps-fix
// P2) wraps the source in an async IIFE which moves `import` statements
// inside a function body where they are illegal.
//
// This probe drives the transform via the /api/_diag/esbuild-transform
// endpoint (if available) OR via a direct facet invocation, asserting
// that the transformed output has NO esbuild "Unexpected" error for an
// ESM+TLA source.

import { Terminal, mintSession, sleep, stripAnsi, BASE, heredocCommand } from './_driver.mjs';

const sid = await mintSession();
console.log(`[esbuild-esm-tla] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

// Drop a small .mjs file that mimics nuxi's entry: ESM imports + top-level
// await. The simplest reliable trigger for the transform path is to
// require()/import-via-node a .mjs file from a JS script — the runtime
// pre-compiles .mjs files which routes through EsbuildService.transform
// with format:cjs.
await t.run('mkdir -p /home/user/esm-tla-probe', 10_000);
await t.run('cd /home/user/esm-tla-probe', 10_000);

// Write the trigger file via heredoc — same path other probes use.
// Use builtins that ARE shimmed by Nimbus's node-shims so the only
// possible failure is in the transform path (ESM+TLA → CJS+IIFE). We
// use `node:url`, `node:path` — both are first-class shims. The
// historic Nuxt failure was the transform step itself; runtime-level
// shim gaps are a separate concern (e.g., the `node:inspector` gap
// surfaced when we tested with that builtin originally).
const triggerSource = `import { fileURLToPath } from "node:url";
import * as path from "node:path";
const start = await Promise.resolve(42);
console.log("ESM_TLA_OK start=" + start);
console.log("fileURLToPath typeof=" + typeof fileURLToPath);
console.log("path.join typeof=" + typeof path.join);
`;
await t.run(heredocCommand('/home/user/esm-tla-probe/trigger.mjs', triggerSource), 15_000);

// Now invoke the trigger via node — this exercises the pre-compile path
// for .mjs files (the same path nuxi.mjs uses inside npx).
console.log('[esbuild-esm-tla] node trigger.mjs');
const r = await t.run('node trigger.mjs', 60_000);
const fullOut = stripAnsi(r.output);
const tail = fullOut.split(/\r?\n/).slice(-20).join('\n');
console.log('--- tail ---');
console.log(tail);

const plainSource = `console.log("PLAIN_TLA_A");
await Promise.resolve();
console.log("PLAIN_TLA_B");
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("PLAIN_TLA_C");
`;
await t.run(heredocCommand('/home/user/esm-tla-probe/plain.mjs', plainSource), 15_000);
console.log('[esbuild-esm-tla] node plain.mjs');
const plainRun = await t.run('node plain.mjs', 60_000);
const plainOut = stripAnsi(plainRun.output);
const plainTail = plainOut.split(/\r?\n/).slice(-20).join('\n');
console.log('--- plain tail ---');
console.log(plainTail);

await t.close();

const errorRe = /Unexpected\s+"[^"]+"|Top-level await|pre-compile failed/i;
const hasTransformError = errorRe.test(fullOut);
const hasOkLine = /ESM_TLA_OK start=42/.test(fullOut);
const expectedOrder = [
  'ESM_TLA_OK start=42',
  'fileURLToPath typeof=function',
  'path.join typeof=function',
];
const orderPositions = expectedOrder.map((line) => fullOut.indexOf(line));
const preservesOrder = orderPositions.every((pos) => pos >= 0) &&
  orderPositions.every((pos, i) => i === 0 || orderPositions[i - 1] < pos);
const plainExpectedOrder = ['PLAIN_TLA_A', 'PLAIN_TLA_B', 'PLAIN_TLA_C'];
const plainOrderPositions = plainExpectedOrder.map((line) => plainOut.indexOf(line));
const preservesPlainOrder = plainOrderPositions.every((pos) => pos >= 0) &&
  plainOrderPositions.every((pos, i) => i === 0 || plainOrderPositions[i - 1] < pos);

const findings = {
  probe: 'esbuild-esm-tla',
  category: 'B',
  sid, base: BASE,
  hasTransformError,
  hasOkLine,
  preservesOrder,
  orderPositions,
  preservesPlainOrder,
  plainOrderPositions,
  tail: tail.slice(-500),
  plainTail: plainTail.slice(-500),
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['NO esbuild transform error in output', !hasTransformError,
    hasTransformError ? `match: ${(fullOut.match(errorRe) || [])[0]}` : ''],
  ['Trigger script executed (ESM_TLA_OK observed)', hasOkLine,
    !hasOkLine ? `tail: ${tail.slice(-360)}` : ''],
  ['Top-level await output order is preserved', preservesOrder,
    !preservesOrder ? `positions: ${orderPositions.join(', ')}` : ''],
  ['Plain .mjs top-level await output order is preserved', preservesPlainOrder,
    !preservesPlainOrder ? `positions: ${plainOrderPositions.join(', ')}` : ''],
];

let pass = 0;
for (const c of checks) {
  const [name, ok, detail] = c;
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? '' : (detail ? ' — ' + detail : '')}`);
  if (ok) pass++;
}

const verdict = pass === checks.length ? 'passing' : 'failing';
console.log(`\n[esbuild-esm-tla] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'passing' ? 0 : 1);
