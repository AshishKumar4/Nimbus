#!/usr/bin/env bun
// clang/_libc-cpp20-stretch — whether clang++ compiles C++20, as installed.
// clang++ is not a supported entrypoint: the runtime publisher stages clang
// and wasm-ld only. So nothing here is a verdict on a supported feature.
//
// Category: F (forensic) — always exits 0; reports observed state. A report
// with no verdict is not a probe, so run-all does not discover it (the
// leading `_`). Run it by hand when clang++ is being added:
//   BASE=<target> bun tests/behavioral/clang/_libc-cpp20-stretch.mjs

import { mintSession, Terminal, stripAnsi, heredocCommand } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
console.log(`clang/_libc-cpp20-stretch — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// The install names the directory it installed: "[clang] installed at usr/lib/nimbus/clang/<version> (X MiB)".
const installed = stripAnsi((await t.run('nimbus install clang', 120_000)).output);
const dir = installed.match(/installed at\s+\/?(usr\/lib\/nimbus\/clang\/[\w.-]+)/)?.[1];
const present = dir !== undefined && (await t.run(`test -e /${dir}/bin/clang++`, 10_000)).exitCode === 0;
console.log(`  clang++ in ${dir ? `/${dir}/bin` : 'the install (no install line)'}: ${present ? 'present' : 'absent'}`);

// Trivial C++ — no headers, no stdlib, just `int main()`.
await t.run(heredocCommand('trivial.cpp', 'int main(void) { return 0; }'), 10_000);
const compiled = await t.run('clang++ -std=c++20 trivial.cpp -o trivial 2>&1', 120_000);
const built = compiled.exitCode === 0 && (await t.run('test -e trivial', 10_000)).exitCode === 0;
console.log(`  clang++ -std=c++20 trivial.cpp: exit ${compiled.exitCode}, ${built ? 'built ./trivial' : 'built nothing'}`);
console.log(`  ${JSON.stringify(stripAnsi(compiled.output).slice(-400))}`);

await t.close();
process.exit(0);
