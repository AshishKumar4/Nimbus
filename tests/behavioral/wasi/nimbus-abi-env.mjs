#!/usr/bin/env bun
// wasi/nimbus-abi-env — compiled WASI binaries see the stable Nimbus ABI.

import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi/nimbus-abi-env');
console.log(`wasi/nimbus-abi-env — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

function hasLine(text, line) {
  return text.split(/\r?\n/).map((value) => value.trim()).includes(line);
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('nimbus install clang', 300_000);

  {
    const r = await t.run('clang --version', 15_000);
    const out = stripAnsi(r.output);
    a.check('clang reports wasm32-wasi-nimbus target',
      /Target:\s+wasm32-wasi-nimbus\b/.test(out),
      JSON.stringify(out.slice(-400)));
  }

  {
    const r = await t.run('wasm-runner --wasi-info', 15_000);
    const out = stripAnsi(r.output);
    a.check('wasm-runner --wasi-info reports ABI',
      /"abi":\s*"wasm32-wasi-nimbus"/.test(out),
      JSON.stringify(out.slice(-500)));
    a.check('wasm-runner --wasi-info reports NIMBUS_OS env',
      /"NIMBUS_OS":\s*"nimbus"/.test(out),
      JSON.stringify(out.slice(-500)));
  }

  const source = `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  const char *os = getenv("NIMBUS_OS");
  const char *abi = getenv("NIMBUS_ABI");
  const char *target = getenv("NIMBUS_ABI_TARGET");
  printf("OS=%s\\n", os ? os : "");
  printf("ABI=%s\\n", abi ? abi : "");
  printf("TARGET=%s\\n", target ? target : "");
  return 0;
}`;
  await t.run(heredocCommand('abi.c', source), 15_000);

  {
    const r = await t.run('clang abi.c -o abi', 300_000);
    const out = stripAnsi(r.output);
    a.check('clang compiles ABI fixture without diagnostics',
      !/error:|fatal:/i.test(out),
      JSON.stringify(out.slice(-500)));
  }

  {
    const r = await t.run('./abi ; echo RUN_EXIT=$?', 60_000);
    const out = stripAnsi(r.output);
    a.check('WASI env exposes NIMBUS_OS=nimbus', hasLine(out, 'OS=nimbus'), JSON.stringify(out.slice(-500)));
    a.check('WASI env exposes NIMBUS_ABI=wasm32-wasi-nimbus', hasLine(out, 'ABI=wasm32-wasi-nimbus'), JSON.stringify(out.slice(-500)));
    a.check('WASI env exposes NIMBUS_ABI_TARGET=wasm32-wasi-nimbus', hasLine(out, 'TARGET=wasm32-wasi-nimbus'), JSON.stringify(out.slice(-500)));
    a.check('ABI fixture exits 0', hasLine(out, 'RUN_EXIT=0'), JSON.stringify(out.slice(-300)));
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  if (!cleanup.ok) {
    console.warn(`cleanup failed for ${sid}: ${cleanup.status} ${cleanup.body}`);
  }
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
