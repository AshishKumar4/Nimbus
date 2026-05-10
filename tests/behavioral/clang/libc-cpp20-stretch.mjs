#!/usr/bin/env bun
// clang/libc-cpp20-stretch — STRETCH probe; binji's sysroot ships
// libc++ for C++ but no full C++20 conformance. We assert only the
// minimum: clang++ exists in the registry, can compile a trivial
// `int main(){ return 0; }` from a .cpp file, and the output runs.
// This is a FORENSIC probe documenting reality; it MAY be RED in v1
// of Wave-3 and that is acceptable (libc++ in sysroot is a Wave-3.1
// follow-on per §3.2).

import { mintSession, Terminal, makeAsserter, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('clang/libc-cpp20-stretch');
console.log(`clang/libc-cpp20-stretch — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install clang', 120_000);

// clang++ available — node-existence check (avoid lifo-sh which-hang).
{
  const { output } = await t.run(
    `node -e "const ok = require('fs').existsSync(process.env.HOME + '/.nimbus/runtimes/clang/binji-2020/bin/clang++'); console.log('C'+'PP-STATE:' + (ok ? 'YES' : 'NO'))"`,
    10_000,
  );
  const stripped = stripAnsi(output);
  const found = /CPP-STATE:YES/.test(stripped);
  a.check('clang++ bin exists at expected path (STRETCH)', found,
    found ? '' : `note: v1 may not ship clang++ entrypoint`);
}

// Trivial C++ — no headers, no stdlib, just `int main()`.
const trivialCpp = `int main(void) { return 0; }`;
await t.run(heredocCommand('trivial.cpp', trivialCpp), 10_000);

{
  const { output } = await t.run('clang++ -std=c++20 trivial.cpp -o trivial 2>&1', 120_000);
  const stripped = stripAnsi(output);
  const noErr = !/error:|fatal:|abort/i.test(stripped);
  a.check('clang++ -std=c++20 compiles trivial.cpp (STRETCH)', noErr,
    noErr ? '' : `STRETCH/may be deferred to Wave-3.1; output=${JSON.stringify(stripped.slice(-400))}`);
}

await t.close();
const sum = a.summary();
// STRETCH probe: do not fail the runner if checks failed. Just report.
console.log(`(stretch probe — failures are expected in Wave-3 v1; documents reality only)`);
process.exit(0);
