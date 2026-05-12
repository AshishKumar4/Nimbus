#!/usr/bin/env bun
// binary-fs/cross-process-binary-read — invariant: a Uint8Array
// written from one node process MUST be readable byte-for-byte from a
// separate, later node process in the same session. Pre-fix, the
// second process's __vfsBundle was constructed by JSON-stringifying
// `vfs.readFileString(path)` for every file, which UTF-8-decoded
// binary bytes ≥ 0x80 to U+FFFD. JSON.stringify then embedded U+FFFD
// as the literal char, and node-shims' readFileSync produced 3 bytes
// (EF BF BD) per original byte — a 256-byte file became 512 bytes,
// every high byte became `239,191,189`.
//
// hardening-r5 — see /workspace/.seal-internal/2026-05-12-hardening-r5/.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('binary-fs/cross-process-binary-read');
console.log(`binary-fs/cross-process-binary-read — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Write in process A (Buffer.alloc(256) where b[i] = i). 256 bytes
//    covers every byte value 0..255 so we exercise the full range
//    including U+FFFD-generating sequences.
await t.run(
  `node -e "const b=Buffer.alloc(256);for(let i=0;i<256;i++)b[i]=i;require('fs').writeFileSync('/tmp/cpb.bin',b);console.log('procA wrote',b.length)"`,
  60_000,
);

// 2. Verify the file's on-disk size (shell `ls`) — sanity check that
//    the supervisor VFS stored the file correctly.
{
  const { output } = await t.run('ls -la /tmp/cpb.bin', 10_000);
  const stripped = stripAnsi(output);
  // Match `... 256 ...` (size column).
  const sizeMatch = /\s256\s/.test(stripped);
  a.check('on-disk size is 256 bytes (supervisor VFS preserves bytes)', sizeMatch,
    sizeMatch ? '' : JSON.stringify(stripped.slice(-300)));
}

// 3. Read in a SEPARATE process B. Pre-fix this produces 768 bytes
//    (256 × 3 — every byte ≥ 0x80 mangled to EF BF BD). Post-fix it
//    returns 256 bytes, identity-mapped.
{
  const { output } = await t.run(
    `node -e "const b=require('fs').readFileSync('/tmp/cpb.bin');let mismatch=-1;for(let i=0;i<b.length;i++)if(b[i]!==(i&255)){mismatch=i;break;}console.log('procB readLen='+b.length+' mismatchAt='+mismatch)"`,
    60_000,
  );
  const stripped = stripAnsi(output);
  const lenMatch = stripped.match(/procB readLen=(\d+)/);
  const len = lenMatch ? parseInt(lenMatch[1]) : -1;
  a.check('cross-process read returns 256 bytes (not 768)', len === 256,
    `len=${len}; tail=${JSON.stringify(stripped.slice(-300))}`);

  const mmMatch = stripped.match(/mismatchAt=(-?\d+)/);
  const mm = mmMatch ? parseInt(mmMatch[1]) : 999;
  a.check('every byte b[i] === i (no UTF-8 mangling)', mm === -1,
    mm === -1 ? '' : `first mismatch at byte ${mm}`);
}

// 4. Write a 128-byte file containing ONLY high bytes [128..255].
//    Every byte triggers the U+FFFD path. Pre-fix: read returns 384
//    bytes, all `[239,191,189,239,191,189,...]`. Post-fix: 128 bytes
//    of `[128,129,...,255]`.
await t.run(
  `node -e "const b=Buffer.alloc(128);for(let i=0;i<128;i++)b[i]=128+i;require('fs').writeFileSync('/tmp/hi.bin',b)"`,
  30_000,
);
{
  const { output } = await t.run(
    `node -e "const b=require('fs').readFileSync('/tmp/hi.bin');console.log('hiLen='+b.length+' first4='+Array.from(b.slice(0,4)).join(','))"`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const m = stripped.match(/hiLen=(\d+) first4=([\d,]+)/);
  const len = m ? parseInt(m[1]) : -1;
  const first4 = m ? m[2] : '';
  a.check('128 high bytes round-trip as 128 bytes (not 384)', len === 128,
    `len=${len}`);
  a.check('first 4 bytes are 128,129,130,131 (not 239,191,189,239)', first4 === '128,129,130,131',
    `first4=${first4}`);
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
