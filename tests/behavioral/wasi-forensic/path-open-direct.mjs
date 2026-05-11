#!/usr/bin/env bun
// wasi-forensic/path-open-direct — handcrafted WASI probe.
//
// Bypasses wasi-libc entirely. Issues `path_open(fd=3, ...)` DIRECTLY
// from a tiny hand-rolled wasm module with explicit FULL rights
// (rights_base=0xFFFFFFFFFFFFFFFF, rights_inheriting=0xFFFFFFFFFFFFFFFF)
// and `O_CREAT|O_TRUNC` oflags. Writes the resulting errno as ASCII
// "errno=N\n" to stdout via fd_write+proc_exit.
//
// Tests TWO variants of the same handcrafted module, differing ONLY
// in the wasi import module name:
//
//   preview1:  imports `wasi_snapshot_preview1.path_open` etc.
//              (existing wasi-w2 fixtures use this — known to work)
//   unstable:  imports `wasi_unstable.path_open` etc.
//              (binji-clang-compiled binaries use this — broken in
//              practice per `wasi-write-caps` wave investigation)
//
// Source `path-open-direct.wat` lives next to this driver. The driver
// assembles it twice (search-and-replace MODNAME → real module name)
// using the `wabt` npm package via a host-side helper, base64-encodes
// the result, drops it into VFS, and invokes `wasm-runner`.
//
// Verdict matrix:
//
//   preview1=success, unstable=success → our runtime is FINE for
//     both namespaces. Bug is in binji's bundled libc.a (custom
//     rights gate that returns ENOTCAPABLE without calling path_open).
//     Next wave: swap the clang sysroot OR patch the libc.a binary.
//
//   preview1=success, unstable=fail → our `wasi_unstable` namespace
//     routing in wasm-runner.ts is broken. Should be a simple fix
//     in src/runtime/wasm-runner.ts (the same shim served under
//     both namespaces should behave identically).
//
//   preview1=fail, unstable=fail → our wasi-instance shim's
//     `path_open` is broken for full-rights case. Surprising given
//     the existing wasi-w2 fixtures pass, but possible if those
//     fixtures use different rights values. Investigate
//     wasi-instance.ts:528+.
//
//   preview1=fail, unstable=success → improbable; would suggest
//     namespace aliasing changes semantics. Investigate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Terminal, mintSession, sleep, stripAnsi, BASE, heredocCommand,
} from '../_driver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watPath = join(__dirname, 'path-open-direct.wat');
const watSrc = readFileSync(watPath, 'utf8');

// ── Assemble both variants on the host side (no wabt in the sandbox) ──
// We use the host's `wabt` npm package. The .mjs driver runs locally
// (under bun/node), so `node_modules/wabt` is reachable via the worktree
// install. If the package is missing, the driver fails loudly.
let wabtFactory;
try {
  ({ default: wabtFactory } = await import('wabt'));
} catch (e) {
  console.error('[path-open-direct] FATAL: `wabt` npm package not installed.');
  console.error('  Run: bun add -d wabt (in this worktree) to enable this probe.');
  console.error('  Original error:', e?.message || e);
  process.exit(2);
}
const wabt = await wabtFactory();

function assemble(moduleName) {
  const src = watSrc.replace(/MODNAME/g, moduleName);
  const mod = wabt.parseWat('path-open-direct.wat', src);
  const { buffer } = mod.toBinary({ write_debug_names: false });
  return Buffer.from(buffer);
}

const preview1Bytes = assemble('wasi_snapshot_preview1');
const unstableBytes = assemble('wasi_unstable');

console.log(`[path-open-direct] assembled preview1 variant: ${preview1Bytes.length} bytes`);
console.log(`[path-open-direct] assembled unstable variant: ${unstableBytes.length} bytes`);

const sid = await mintSession();
console.log(`[path-open-direct] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

await t.run('mkdir -p /home/user/wasi-forensic', 10_000);
await t.run('cd /home/user/wasi-forensic', 10_000);

// Drop both .wasm files into VFS via node -e (matches the wasm-runner/
// hand-crafted-add pattern).
await t.run(
  `node -e "require('fs').writeFileSync('p1.wasm', Buffer.from('${preview1Bytes.toString('base64')}','base64'))"`,
  30_000,
);
await t.run(
  `node -e "require('fs').writeFileSync('us.wasm', Buffer.from('${unstableBytes.toString('base64')}','base64'))"`,
  30_000,
);

// ── Run preview1 variant ──
console.log('\n--- preview1 variant ---');
const p1 = await t.run('wasm-runner p1.wasm', 60_000);
const p1Out = stripAnsi(p1.output);
const p1Tail = p1Out.split(/\r?\n/).slice(-8).join('\n');
console.log(p1Tail);
const p1Match = p1Out.match(/errno=(\d+)/);
const p1Errno = p1Match ? parseInt(p1Match[1], 10) : NaN;

// ── Run unstable variant ──
console.log('\n--- unstable variant ---');
const us = await t.run('wasm-runner us.wasm', 60_000);
const usOut = stripAnsi(us.output);
const usTail = usOut.split(/\r?\n/).slice(-8).join('\n');
console.log(usTail);
const usMatch = usOut.match(/errno=(\d+)/);
const usErrno = usMatch ? parseInt(usMatch[1], 10) : NaN;

// ── Also verify the file was actually created (sanity check) ──
const ls = await t.run('ls /home/user/wasi-forensic', 10_000);
const lsOut = stripAnsi(ls.output);

await t.close();

const findings = {
  probe: 'wasi-forensic/path-open-direct',
  sid,
  base: BASE,
  preview1: {
    errno: p1Errno,
    success: p1Errno === 0,
    tail: p1Tail.slice(-300),
  },
  unstable: {
    errno: usErrno,
    success: usErrno === 0,
    tail: usTail.slice(-300),
  },
  greetCreated: /\bgreet\.txt\b/.test(lsOut),
  lsTail: lsOut.split(/\r?\n/).slice(-10).join('\n'),
};
console.log('\n--- FINDINGS ---');
console.log(JSON.stringify(findings, null, 2));

// ── Verdict matrix ──
let attribution;
if (p1Errno === 0 && usErrno === 0) {
  attribution = 'RUNTIME-OK / LIBC-BUG: both namespaces succeed in our runtime. '
              + 'Bug is in binji-2020 sysroot libc.a (custom rights gate). '
              + 'Next wave: swap sysroot or patch libc.a binary.';
} else if (p1Errno === 0 && usErrno !== 0) {
  attribution = 'RUNTIME-BUG (namespace-routing): preview1 OK, unstable FAIL. '
              + 'src/runtime/wasm-runner.ts wasi_unstable alias broken.';
} else if (p1Errno !== 0 && usErrno !== 0) {
  attribution = 'RUNTIME-BUG (path_open or preopen): both namespaces fail with '
              + 'explicit full rights. Investigate wasi-instance.ts:528+ or the '
              + 'preopen registration in wasm-runner.ts:660+.';
} else {
  attribution = 'UNEXPECTED: preview1 fails but unstable succeeds. Investigate '
              + 'namespace-conditional behaviour.';
}
console.log('\n--- ATTRIBUTION ---');
console.log(attribution);

// Forensic probe — we EXIT 0 unconditionally because this measures
// rather than asserts. The findings JSON is the deliverable.
process.exit(0);
