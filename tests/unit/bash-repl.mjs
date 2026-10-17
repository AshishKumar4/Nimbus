// @serial
// @tier slow — compiles and runs the staged Bash wasm
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { mock } from 'bun:test';
import { requireFacetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { normalizeTerminalNewlines } from '../../packages/core/src/_shared/terminal.ts';

import { installedRuntime, manifestFile, runtimeSupervisor, SESSION_USER } from './lib/runtime-session.mjs';
import { loadPreamble } from './lib/bash-preamble.mjs';

const chunks = [];
const listeners = new Set();
const bytes = { stdout: [], stderr: [] };
const facets = [];
let terminal;

// Only the Cloudflare transport is replaced. The real adapter, runner, task,
// Bash wasm and supervisor byte relay handle every line and prompt.
mock.module('../../packages/worker/src/runtime/facet-loader-host.js', () => ({
  facetHostForManager: () => ({
    parking: 'none',
    open(spec) {
      const session = loadPreamble({ preambleSource: spec.preamble, dirs: ['home/user/work'] });
      const decoders = {
        stdout: new TextDecoder('utf-8', { ignoreBOM: true }),
        stderr: new TextDecoder('utf-8', { ignoreBOM: true }),
      };
      const release = session.processes.subscribeOutputBytes(session.pid, (chunk) => {
        bytes[chunk.stream].push(Buffer.from(chunk.data));
        terminal.write(normalizeTerminalNewlines(decoders[chunk.stream].decode(chunk.data, { stream: true })));
      });
      const facet = {
        disposed: false,
        submitRequest(task, request) {
          return session.evaluate(`(${requireFacetTaskSource(task)})`)(request, session.bindings);
        },
        dispose() { this.disposed = true; release(); },
        cleanup: () => session.dispose(),
      };
      facets.push(facet);
      return facet;
    },
  }),
}));
const { runBashRepl } = await import('../../packages/worker/src/runtime/bash-repl.ts');
const { WebSocketTerminal } = await import('../../packages/worker/src/facets/ws-terminal.ts');
terminal = new WebSocketTerminal(null, (chunk) => {
  chunks.push(chunk);
  for (const listener of listeners) listener();
});
const text = () => { terminal.flushNow(); return stripVTControlCharacters(chunks.join('')); };
async function seen(predicate, label) {
  if (predicate(text())) return;
  let timer;
  let listener;
  try {
    await new Promise((resolve, reject) => {
      listener = () => { if (predicate(text())) resolve(); };
      listeners.add(listener);
      timer = setTimeout(() => reject(new Error(`${label}: ${JSON.stringify(text().slice(-500))}`)), 15_000);
    });
  } finally { clearTimeout(timer); listeners.delete(listener); }
}
const reset = () => { terminal.flushNow(); chunks.length = 0; };
const image = readFileSync(new URL('../../packages/worker/wasm/bash/bash.async.wasm', import.meta.url));
const runtime = installedRuntime({ 'bash/share/bash/bash.async.wasm': image });
const processes = runtimeSupervisor();
const env = { HOME: '/home/user', USER: 'reader', HOSTNAME: 'repl', PATH: '/bin' };
const ps1 = 'reader@repl:~/work$ ';
const running = runBashRepl({
  facetMgr: {}, authority: runtime.filesystem, terminal,
  manifest: { files: [manifestFile('share/bash/bash.async.wasm', image)] },
  installRoot: 'bash', cred: SESSION_USER, pid: 41, processes,
  filesystem: runtime.filesystem.bind({ pid: 41, cred: SESSION_USER }),
  env: { ...env, USER: 'old', HOSTNAME: 'old' }, cwd: '/home/user',
  shell: { getEnv: () => env, getCwd: () => '/home/user/work', takeQueuedInput: () => [] },
});
try {
  await seen((value) => value === ps1, 'initial prompt');
  reset();
  terminal.sendData(':\r');
  await seen((value) => value.endsWith(ps1), 'Bash boot and first primary prompt');
  bytes.stdout.length = 0;
  bytes.stderr.length = 0;
  reset();
  const command = String.raw`printf '\000\001\177\357\273\277\360\237\230\200'; printf '\002\303\251' >&2`;
  terminal.sendData(command + '\r');
  await seen((value) => value.endsWith(ps1), 'primary prompt after byte output');
  const stdout = Buffer.from([0, 1, 127, 239, 187, 191, 240, 159, 152, 128]);
  const stderr = Buffer.from([2, 195, 169]);
  assert.deepEqual(Buffer.concat(bytes.stdout), stdout, 'stdout bytes arrive exactly once');
  assert.deepEqual(Buffer.concat(bytes.stderr), stderr, 'stderr bytes arrive exactly once and contain no prompt sentinel');
  assert.equal(text(), command + '\r\n' + stdout.toString() + stderr.toString() + ps1, 'the adapter does not repeat streamed text at the primary prompt');

  for (const line of ['for value in one two; do', 'printf \'<%s>\' "$value"']) {
    reset();
    terminal.sendData(line + '\r');
    await seen((value) => value.endsWith('\r\n> '), 'continuation prompt');
    assert.equal(text(), line + '\r\n> ', 'a continued line has one echo and one continuation prompt');
  }
  reset();
  terminal.sendData('done\r');
  await seen((value) => value.endsWith(ps1), 'primary prompt after multiline command');
  assert.equal(text(), 'done\r\n<one><two>' + ps1, 'only the new line reaches the continued Bash program');
  assert.deepEqual(Buffer.concat(bytes.stdout), Buffer.concat([stdout, Buffer.from('<one><two>')]));
  assert.deepEqual(Buffer.concat(bytes.stderr), stderr);
  reset();
  terminal.sendData('exit 7\r');
  assert.equal(await running, 7, 'Bash exit status reaches the caller');
  assert.ok(!text().includes(ps1), 'exit does not print another primary prompt');
  assert.equal(facets.length, 1, 'multiline input stays in one Bash session');
  assert.ok(facets[0].disposed, 'exit disposes the facet');
} finally {
  await terminal.disposeRepl();
  await running;
  terminal.close();
  for (const facet of facets) await facet.cleanup();
  await runtime.filesystem.releaseProcess(41);
}
console.log('bash-repl: real Bash prompts and multiline commands preserve streamed bytes once');
