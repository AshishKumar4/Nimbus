#!/usr/bin/env bun
// The shell's own work, CPU per arm: lines of builtins read one after another,
// a loop, function calls, and pipelines of builtins (each element a child
// shell). Independent copies of the shell (substrate/lifo/shell) for main,
// main's null arm, and head, each on a fresh filesystem.
import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { memoryFiles } from '../unit/lib/test-box.mjs';
import { cpuMs } from './lib/paired-cpu.mjs';
import { LIFO_SHELL_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { loadIsolatedCore } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

let ran = 0;

function shellOf({ 'substrate/lifo/shell/Shell.ts': { Shell } }) {
  const { files } = memoryFiles();
  const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
  return new Shell(terminal, files, createDefaultRegistry(), { HOME: '/home/user', USER: 'user', PATH: '/usr/bin:/bin' }, new SessionProcessSupervisor());
}

const WORK = {
  lines: (n) => Array.from({ length: n }, (_, i) => `x=${i}; : "$x"; true`).join('\n'),
  loop: (n) => `i=0; while [ "$i" -lt ${n} ]; do i=$((i + 1)); true; done`,
  functions: (n) => `f() { g "$1"; }; g() { : "$1"; return 0; }; for i in $(seq 1 ${n}); do f "$i"; done`,
  pipelines: (n) => Array.from({ length: n }, () => 'true | : | true').join('\n'),
};

await runPairedBenchmark({
  source: LIFO_SHELL_CPU_SOURCES.source,
  async run({ short, cleanup, withArms, sample }) {
    const n = short ? 20 : 400;
    await withArms((from) => loadIsolatedCore(from, cleanup, {
      sources: LIFO_SHELL_CPU_SOURCES, modules: ['substrate/lifo/shell/Shell.ts'],
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
