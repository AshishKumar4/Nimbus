#!/usr/bin/env bun
// The shell's own work, CPU per arm: lines of builtins read one after another,
// a loop, function calls, pipelines of builtins (each element a child shell),
// words split and matched as patterns, and arrays built and copied. Each arm is its side's whole tree
// (main, main's null arm, and head): its shell, commands, supervisor and
// filesystem, a fresh filesystem each sample.
import assert from 'node:assert/strict';
import { cpuMs } from './lib/paired-cpu.mjs';
import { LIFO_SHELL_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

let ran = 0;

function shellOf({
  'substrate/lifo/shell/Shell.ts': { Shell },
  'runtime/session-process-supervisor.ts': { SessionProcessSupervisor },
  'substrate/lifo/commands/registry.ts': { createDefaultRegistry },
  'tests/unit/lib/test-box.mjs': { memoryFiles },
}) {
  const { files } = memoryFiles();
  const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
  return new Shell(terminal, files, createDefaultRegistry(), { HOME: '/home/user', USER: 'user', PATH: '/usr/bin:/bin' }, new SessionProcessSupervisor());
}

const WORK = {
  lines: (n) => Array.from({ length: n }, (_, i) => `x=${i}; : "$x"; true`).join('\n'),
  loop: (n) => `i=0; while [ "$i" -lt ${n} ]; do i=$((i + 1)); true; done`,
  functions: (n) => `f() { g "$1"; }; g() { : "$1"; return 0; }; for i in $(seq 1 ${n}); do f "$i"; done`,
  pipelines: (n) => Array.from({ length: n }, () => 'true | : | true').join('\n'),
  // Splitting, quoting and the pattern operators: fields that keep or lose their quoted characters.
  words: (n) => `v='a b c d e f g h'; for i in $(seq 1 ${n}); do set -- $v "$v" \${u:-'q r' s} "\${v#a b}" "\${v/c*/X}" "\${v//[aeiou]/_}"; done`,
  // An array built one element at a time, written at subscripts, and copied by a literal.
  arrays: (n) => `a=(); for i in $(seq 1 ${n}); do a+=("$i"); a[i+1]=x; done; b=([0]=p "\${a[@]}" [2]=q); : "\${#b[@]}"`,
};

await runPairedBenchmark({
  async run({ short, cleanup, withArms, sample }) {
    const n = short ? 20 : 400;
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: LIFO_SHELL_CPU_SOURCES,
      modules: ['substrate/lifo/shell/Shell.ts', 'runtime/session-process-supervisor.ts', 'substrate/lifo/commands/registry.ts'],
      helpers: ['tests/unit/lib/test-box.mjs'],
    }), async (arms) => {
      for (const [kind, script] of Object.entries(WORK)) {
        const text = script(kind === 'pipelines' ? Math.ceil(n / 4) : n);
        await sample(kind, arms, async (modules) => {
          const shell = shellOf(modules);
          return cpuMs(async () => {
            const result = await shell.execute(text, { cwd: '/home/user' });
            assert.equal(result.exitCode, 0, `${kind}: ${JSON.stringify(result)}`);
            ran++;
          });
        }, { pairs: 30, warm: 4, iterations: 1 });
      }
    });
    assert.ok(ran > 0);
  },
});
