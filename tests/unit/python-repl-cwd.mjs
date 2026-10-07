#!/usr/bin/env bun
// python-repl-cwd: the Python prompt starts in the shell's working directory,
// once per interpreter, keeps the directory the program's own os.chdir left
// on later lines, and refuses one it cannot enter, naming its command, as the
// Ruby prompt does (ruby-repl-cwd).
//
// It started in '/', the WASI default: __cpythonReplRun never entered a
// directory, and the step carried a hard-coded '/home/user' nothing read, so
// open("hello.txt") at the prompt looked in the root.
//
// The prompt's step as the host builds it (pythonReplStep) and as the facet
// runs it (pythonReplStepRequestFn over the preamble's __cpythonReplRun),
// with the interpreter stood in for by one that runs each line under the
// host's python3, replaying the lines before it, so a line sees the state
// the earlier ones left.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plugin } from 'bun';
import { CPYTHON_PREAMBLE_TAIL } from '../../packages/core/src/runtime/cpython-preamble.ts';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
import { outputControlReader } from '../../packages/core/src/runtime/wasi/output-control.ts';

plugin({
  name: 'cloudflare-shims',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: { DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } },
    }));
  },
});
const { pythonReplStep, pythonReplStepRequestFn } = await import('../../packages/worker/src/runtime/python-repl.ts');

if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('python-repl-cwd: SKIPPED (no host python3)');
  process.exit(0);
}

// The facet's scope: the preamble tail, its interpreter boot stood in for.
// Each run replays the interpreter's earlier lines, then the new one, and
// keeps only what the new one printed.
const ran = [];
const MARK = '__NIMBUS_TEST_MARK__';
globalThis.__standInRun = (code) => {
  ran.push(code);
  const script = [...globalThis.__session, `import sys; sys.stdout.write("${MARK}"); sys.stderr.write("${MARK}")`, code].join('\n');
  const out = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: '/' });
  globalThis.__session.push(code);
  globalThis.__testWrite('stdout', new TextEncoder().encode(out.stdout.split(MARK).pop()));
  globalThis.__testWrite('stderr', new TextEncoder().encode(out.stderr.split(MARK).pop()));
  return out.status;
};
const stand = `async function __nimbusPyBoot(args) {
  globalThis.__session = [];
  __nimbusPyOutput = globalThis.__wasiSupervisorOutput({
    stdout: bytes => { const data = __nimbusPyOutputControl ? __nimbusPyOutputControl.feed(bytes) : bytes; globalThis.__visible.stdout += new TextDecoder().decode(data); },
    stderr: bytes => { globalThis.__visible.stderr += new TextDecoder().decode(bytes); },
  });
  globalThis.__testWrite = (stream, bytes) => __nimbusPyOutput[stream+'Bytes'](bytes);
  return { run: async (code) => globalThis.__standInRun(code), flush: async () => {} };
}`;
Object.assign(globalThis,{ __wasiSupervisorOutput: wasiOutputRelay, __wasiOutputControl: outputControlReader });
new Function('globalThis', `${CPYTHON_PREAMBLE_TAIL}\n${stand}`)(globalThis);
globalThis.__wasiAdoptSupervisor = () => {};

const dir = mkdtempSync(join(tmpdir(), 'python-repl-cwd-'));
try {
  writeFileSync(join(dir, 'hello.txt'), 'from the cwd\n');
  mkdirSync(join(dir, 'sub'));
  const line = async (cwd, userCode) => {
    ran.length = 0;
    globalThis.__visible = {stdout:'',stderr:''};
    const body = pythonReplStep({ home: dir, start: { cwd, binName: 'python3' } }, '/py', userCode);
    const response = await pythonReplStepRequestFn(
      new Request('https://facet.internal/python-repl-step', { method: 'POST', body: JSON.stringify(body) }),
      { SUPERVISOR: {} },
    );
    return { ...await response.json(), ...globalThis.__visible };
  };

  // The first line: the prompt enters the shell's cwd, then runs the line there.
  const first = await line(dir, 'import os\nprint(open("hello.txt").read(), end="")\nprint(os.getcwd())');
  assert.deepEqual([first.exitCode, first.stdout, first.stderr], [0, `from the cwd\n${dir}\n`, ''], 'the prompt reads a file in its cwd');
  assert.equal(ran.length, 2, 'it entered the cwd, then ran the line');

  // The program moves; the next line stays where it went.
  await line(dir, 'os.chdir("sub")');
  const later = await line(dir, 'print(os.getcwd())');
  assert.equal(later.stdout, `${join(dir, 'sub')}\n`, 'a later line keeps the program\'s own chdir');
  assert.equal(ran.length, 1, 'and enters nothing');

  // A fresh interpreter starts in the cwd again, and refuses one it cannot enter.
  delete globalThis.__cpythonReplBoot;
  const gone = join(dir, 'gone');
  const refused = await line(gone, 'print("ran")');
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, new RegExp(`^python3: can't enter working directory '${gone}': \\[Errno 2\\] No such file or directory\\n$`),
    `a cwd it cannot enter names the command: ${refused.stderr}`);
  assert.equal(refused.stdout, '', 'and the line does not run');

  // The install-time warm-up starts nowhere in particular.
  assert.equal('enter' in pythonReplStep({ home: dir }, '/py', ''), false, 'a step with no start enters nothing');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('python-repl-cwd: the prompt starts in its cwd, once, and keeps the program\'s');
