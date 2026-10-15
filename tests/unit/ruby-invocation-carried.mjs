#!/usr/bin/env bun
// What `ruby` is asked to run reaches its VM whole, by every path:
//
//   - `ruby -r NAME` requires NAME as it is written, as Ruby does: the
//     runner hands the VM the names (RubyFacetCallArgs.requires), and the
//     VM requires each in a literal, so `-r './literal#{7}'` loads
//     ./literal#{7}.rb, never ./literal7.rb. Driven through the workspace's
//     runner (its facet records what it was handed), then the VM's own
//     wrapper (RUBY_RUNNER_PREAMBLE_TAIL, the VM stood in for by a recorder
//     of what it evaluates), then the host's Ruby running that, in a
//     directory holding both files.
//   - a program that keeps running (a script) runs as the caller, as a
//     one-shot run does: the resident process's start (ruby-resident.ts)
//     hands __rubyRun the invocation as the runner made it, whose
//     credential makes the VM's filesystem its resident one; without it,
//     the VM fell back to the live bridge.
//
// Red before: the runner wrote `require "./literal#{7}"` into the program,
// a double-quoted literal Ruby interpolates; the resident start dropped the
// credential.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plugin } from 'bun';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
import { outputControlReader } from '../../packages/core/src/runtime/wasi/output-control.ts';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-resident.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

plugin({
  name: 'cloudflare-shims',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: { DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } },
    }));
  },
});

if (spawnSync('ruby', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('ruby-invocation-carried: SKIPPED (no host ruby)');
  process.exit(0);
}

const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const failed = [];
const check = (what, actual, expected) => {
  try { assert.deepEqual(actual, expected); console.log(`  ✓ ${what}`); }
  catch { failed.push(`${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); console.log(`  ✗ ${what}`); }
};

// ── -r: the runner's invocation, through the VM's wrapper, under the host's Ruby ──
const bytes = new Uint8Array([10]);
const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const build = {
  manifest: {
    name: 'ruby', version: '3.3.4', license: 'BSD-2-Clause', wasi_namespace: 'wasi_snapshot_preview1',
    entrypoints: [{ binName: 'ruby', runner: 'ruby-runner', args: [] }],
    files: ['bin/ruby', 'share/ruby/ruby+stdlib.wasm'].map((path) => ({ path, content: `blobs/ruby/${path}`, sha256, size: 1, ...(path.startsWith('bin/') ? { mode: 'exec' } : {}) })),
  },
  readBlob: () => bytes,
};
const runtimeSource = {
  async list() { return [{ name: 'ruby', abi: 'wasm32-wasi-nimbus', defaultVersion: '3.3.4', versions: [{ version: '3.3.4', sizeBytes: 1, license: 'BSD-2-Clause' }] }]; },
  async resolve(spec) { return spec === 'ruby' || spec === 'ruby@3.3.4' ? build : null; },
};
const handed = [];
const facets = {
  parking: 'none',
  open() {
    return {
      async submit(_task, args) { handed.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
      dispose() {},
    };
  },
};
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, runtimeSource, facets });
try {
  await ws.runtimes.install('ruby');
  const ran = await ws.exec(`ruby -r './literal#{7}' -r './second' -e 'puts "body"'`, { cwd: '/home/user' });
  assert.equal(ran.exitCode, 0, ran.stderr);
} finally {
  await ws.close();
}
assert.equal(handed.length, 1, 'one run, one invocation');

// The VM's own wrapper over that invocation, the VM stood in for by a recorder of what it evaluates.
const evaluated = [];
globalThis.__evaluated = evaluated;
Object.assign(globalThis, { __wasiSupervisorOutput: wasiOutputRelay, __wasiOutputControl: outputControlReader, __wasiSettled: async (result) => result, __nimbusRubyStep: async () => ({ resumed: false, alive: false }) });
new Function('globalThis', `${RUBY_RUNNER_PREAMBLE_TAIL}
function __nimbusInstallRubyFs() {}
function __wasiAdoptSupervisor() {}
async function __nimbusRubyEval(boot, code) { globalThis.__evaluated.push(code); return { status: 0 }; }`)(globalThis);
globalThis.__rubyBootstrap = Promise.resolve({ ok: true, rubyInitialized: true });

const dir = mkdtempSync(join(tmpdir(), 'ruby-invocation-'));
try {
  writeFileSync(join(dir, 'literal#{7}.rb'), 'puts "literal"\n');
  writeFileSync(join(dir, 'literal7.rb'), 'puts "interpolated"\n');
  writeFileSync(join(dir, 'second.rb'), 'puts "second"\n');
  const result = await globalThis.__rubyRun({ ...handed[0], cwd: dir, userEnv: { HOME: dir } });
  assert.equal(result.exitCode, 0, result.stderr);
  const host = spawnSync('ruby', ['-e', evaluated.join('\n')], { encoding: 'utf8', cwd: '/' });
  check('ruby -r requires each name as it is written, in order, before the program', host.stdout, 'literal\nsecond\nbody\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── A resident process's start hands __rubyRun the whole invocation ──
{
  const workerDir = mkdtempSync(join(tmpdir(), 'ruby-invocation-resident-'));
  try {
    const preamble = [
      'function __wasiAdoptSupervisor() {}',
      'globalThis.__nimbusRubyDrainOutput = async () => {};',
      'globalThis.__nimbusRubyStep = async () => ({ resumed: false, alive: false, wakeAfter: null });',
      'globalThis.__rubyRun = async (args) => { globalThis.__startedWith = args; return { exitCode: 0, stdout: "", stderr: "" }; };',
    ].join('\n');
    writeFileSync(join(workerDir, 'ruby+stdlib.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    writeFileSync(join(workerDir, 'worker.mjs'), buildRubySocketProcessWorker(preamble));
    const { NimbusProcess } = await import(join(workerDir, 'worker.mjs'));
    const invocation = { userCode: 'puts 1', requires: ['./lib'], rbArgv: ['server.rb'], userEnv: {}, progName: 'server.rb', binName: 'ruby', cwd: '/home/user', cred: CRED, supervisorPid: 7 };
    const started = await new NimbusProcess({ storage: {} }, {}).startProcess(invocation);
    assert.equal(started.state, 'exited');
    check('a resident process runs the invocation as the runner made it: as the caller, with its -r libraries', globalThis.__startedWith, invocation);
  } finally {
    rmSync(workerDir, { recursive: true, force: true });
  }
}

assert.deepEqual(failed, [], failed.join('\n'));
console.log('ruby-invocation-carried: ok');
