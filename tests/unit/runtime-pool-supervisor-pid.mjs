#!/usr/bin/env bun
// runtime-pool-supervisor-pid — a runtime pool that binds SUPERVISOR must also
// bake in the invoking process's pid.
//
// The supervisor derives the write credential from `props.pid`
// (`SupervisorRPC._pid()` → `processes.cred(pid)`) and rejects the call
// outright without a positive one. A runtime pool binds SUPERVISOR for exactly
// one reason — to back the WASI filesystem with the live session VFS — so one
// with no pid has a filesystem it can read and can never write. Every
// write-back comes back "missing or invalid process pid in props".
//
// That shipped: turning on the live filesystem for wasm-runner and ruby gave
// both pools a SUPERVISOR and neither a pid, and because wasm-runner built its
// pool BEFORE spawning the process, there was no pid to give. It survived
// typecheck and every unit test, and only a real program writing a real file
// on a real deployment showed it.
//
// Pools outside runtime/ legitimately bind SUPERVISOR with pid 0 for
// cache/registry RPCs that never reach `_pid()`; this rule covers the runtime
// pools, all of which exist to run user programs against a filesystem.

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'worker', 'src', 'runtime');

/** The options object literal of each `new LoaderPool(...)`, brace-matched. */
function poolOptions(src) {
  const out = [];
  for (const m of src.matchAll(/new LoaderPool\s*\(/g)) {
    let depth = 0;
    for (let i = src.indexOf('{', m.index); i >= 0 && i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { out.push(src.slice(m.index, i)); break; }
    }
  }
  return out;
}

let checked = 0;
const findings = [];

for (const file of readdirSync(RUNTIME_DIR).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(RUNTIME_DIR, file), 'utf8');
  for (const opts of poolOptions(src)) {
    checked++;
    const code = opts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Sealed by construction: no SUPERVISOR, so no credential to get wrong.
    if (/omitSupervisor\s*:\s*true/.test(code)) continue;
    if (/supervisorPid\s*:/.test(code)) continue;
    const tag = /tag\s*:\s*([^,\n]+)/.exec(code)?.[1]?.trim() ?? '(untagged)';
    findings.push(`${file} :: pool ${tag} binds SUPERVISOR without supervisorPid`);
  }
}

assert.ok(checked > 0, 'the detector found no runtime loader pools — it has stopped checking anything');
assert.deepEqual(findings, [],
  `a runtime pool that binds SUPERVISOR must set supervisorPid:\n  ${findings.join('\n  ')}`);

console.log(`runtime-pool-supervisor-pid: ${checked} runtime pools, every SUPERVISOR-bound one carries a pid`);
