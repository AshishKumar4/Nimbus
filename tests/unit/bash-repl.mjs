// @serial
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { mock } from 'bun:test';
import { requireFacetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { normalizeTerminalNewlines } from '../../packages/core/src/_shared/terminal.ts';
import { installedRuntime, manifestFile, runtimeSupervisor, SESSION_USER } from './lib/runtime-session.mjs';
import { loadPreamble } from './lib/bash-preamble.mjs';
import { bounded, captureTerminal } from './lib/terminal-capture.mjs';

let current;
mock.module('../../packages/worker/src/runtime/facet-loader-host.js', () => ({
  facetHostForManager: () => ({
    parking: 'none',
    open(spec) {
      const state = current;
      const session = loadPreamble({
        preambleSource: spec.preamble,
        dirs: ['home/user/work'],
        files: { 'home/user/.bashrc': state.rc },
      });
      const decoders = {
        stdout: new TextDecoder('utf-8', { ignoreBOM: true }),
        stderr: new TextDecoder('utf-8', { ignoreBOM: true }),
      };
      const release = session.processes.subscribeOutputBytes(session.pid, (chunk) => {
        state.bytes[chunk.stream].push(Buffer.from(chunk.data));
        state.view.terminal.write(normalizeTerminalNewlines(decoders[chunk.stream].decode(chunk.data, { stream: true })));
      });
      const facet = {
        slices: [],
        disposed: false,
        async submitRequest(task, request) {
          const args = await request.clone().json();
          if (args.op === 'feed' && state.holdNext) {
            state.holdNext = false;
            state.held.resolve();
            await new Promise((_, reject) => {
              request.signal.throwIfAborted();
              request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
            });
          }
          if (args.op === 'feed' && state.invalidNext) {
            state.invalidNext = false;
            request = new Request(request, { body: JSON.stringify({ op: 'invalid' }) });
          }
          const response = await session.evaluate('(' + requireFacetTaskSource(task) + ')')(request, session.bindings);
          this.slices.push(await response.clone().json());
          return response;
        },
        dispose() { this.disposed = true; release(); },
        cleanup: () => session.dispose(),
      };
      state.facets.push(facet);
      return facet;
    },
  }),
}));
const { runBashRepl } = await import('../../packages/worker/src/runtime/bash-repl.ts');
const { WebSocketTerminal } = await import('../../packages/worker/src/facets/ws-terminal.ts');
const image = readFileSync(new URL('../../packages/worker/wasm/bash/bash.async.wasm', import.meta.url));
const ps1 = 'reader@repl:~/work$ ';
const rc = 'printf "BOOTOUT\\n"; printf "BOOTERR\\n" >&2\nPS1="$PS1$PS2"\nPS2="CONT:$PS2"\n';

function start(script = rc) {
  const view = captureTerminal(WebSocketTerminal, { shown: stripVTControlCharacters, timeoutMs: 5000 });
  const runtime = installedRuntime({ 'bash/share/bash/bash.async.wasm': image });
  const env = { HOME: '/home/user', USER: 'reader', HOSTNAME: 'repl', PATH: '/bin' };
  const state = {
    view, rc: script, bytes: { stdout: [], stderr: [] }, facets: [],
    held: Promise.withResolvers(), holdNext: false, invalidNext: false,
  };
  current = state;
  const running = runBashRepl({
    facetMgr: {}, authority: runtime.filesystem, terminal: view.terminal,
    manifest: { files: [manifestFile('share/bash/bash.async.wasm', image)] },
    installRoot: 'bash', cred: SESSION_USER, pid: 41, processes: runtimeSupervisor(),
    filesystem: runtime.filesystem.bind({ pid: 41, cred: SESSION_USER }),
    env: { ...env, USER: 'old', HOSTNAME: 'old' }, cwd: '/home/user',
    shell: { getEnv: () => env, getCwd: () => '/home/user/work', takeQueuedInput: () => [] },
  });
  return Object.assign(state, {
    running,
    async boot() {
      await view.seen((value) => value === ps1, 'initial editor prompt');
      view.reset();
      view.terminal.sendData(':\r');
      await view.seen((value) => value.endsWith(ps1), 'primary prompt after Bash boot');
      assert.equal(view.text(), ':\r\nBOOTOUT\r\nBOOTERR\r\n' + ps1, 'boot output reaches the terminal once before readiness');
      assert.ok(state.facets[0].slices.some((slice) => slice.control?.ps1 !== undefined && slice.control?.ps2 !== undefined),
        'real Bash emitted both prompt controls together');
    },
    async close() {
      await bounded(view.terminal.disposeRepl(), 'Bash REPL teardown', 5000);
      await bounded(running, 'Bash REPL completion', 5000);
      view.terminal.close();
      for (const facet of state.facets) await facet.cleanup();
      await runtime.filesystem.releaseProcess(41);
    },
  });
}

// Real Bash owns boot, primary/continuation prompts, output bytes and exit.
{
  const state = start();
  const { view, bytes, facets, running } = state;
  try {
    await state.boot();
    bytes.stdout.length = 0;
    bytes.stderr.length = 0;
    view.reset();
    const command = String.raw`printf '\000\001\177\357\273\277\360\237\230\200'; printf '\002\303\251' >&2`;
    view.terminal.sendData(command + '\r');
    await view.seen((value) => value.endsWith(ps1), 'primary prompt after byte output');
    const stdout = Buffer.from([0, 1, 127, 239, 187, 191, 240, 159, 152, 128]);
    const stderr = Buffer.from([2, 195, 169]);
    assert.deepEqual(Buffer.concat(bytes.stdout), stdout, 'stdout bytes arrive exactly once');
    assert.deepEqual(Buffer.concat(bytes.stderr), stderr, 'stderr bytes arrive exactly once without prompt controls');
    assert.equal(view.text(), command + '\r\n' + stdout.toString() + stderr.toString() + ps1);

    for (const line of ['for value in one two; do', 'printf \'<%s>\' "$value"']) {
      view.reset();
      view.terminal.sendData(line + '\r');
      await view.seen((value) => value.endsWith('CONT:> '), 'continuation output and prompt');
      assert.equal(view.text(), line + '\r\nCONT:> ', 'continuation output arrives once before the editor prompt');
    }
    view.reset();
    view.terminal.sendData('done\r');
    await view.seen((value) => value.endsWith(ps1), 'primary prompt after multiline command');
    assert.equal(view.text(), 'done\r\n<one><two>' + ps1, 'only new source reaches the continued Bash program');
    assert.deepEqual(Buffer.concat(bytes.stdout), Buffer.concat([stdout, Buffer.from('<one><two>')]));
    assert.deepEqual(Buffer.concat(bytes.stderr), Buffer.concat([stderr, Buffer.from('CONT:CONT:')]));
    view.reset();
    const exit = 'printf EXITOUT; printf EXITERR >&2; exit 7';
    view.terminal.sendData(exit + '\r');
    assert.equal(await bounded(running, 'Bash exit', 5000), 7);
    assert.equal(view.text(), exit + '\r\nEXITOUTEXITERRexit\r\n', 'exit output arrives exactly once with no new prompt');
    assert.equal(facets.length, 1);
    assert.ok(facets[0].disposed);
  } finally { await state.close(); }
}

// Missing controls at boot and after a command fail closed with visible stderr.
for (const duringBoot of [true, false]) {
  const state = start(duringBoot ? rc + 'PS1=\n' : rc);
  try {
    if (!duringBoot) await state.boot();
    state.bytes.stdout.length = 0;
    state.bytes.stderr.length = 0;
    state.view.reset();
    const command = duringBoot ? ':' : 'PS1=';
    state.view.terminal.sendData(command + '\r');
    assert.notEqual(await bounded(state.running, 'missing Bash prompt', 5000), 0);
    const printed = state.view.text().slice((command + '\r\n').length);
    const programLength = Object.values(state.bytes).reduce((length, chunks) =>
      length + normalizeTerminalNewlines(Buffer.concat(chunks).toString()).length, 0);
    assert.ok(printed.length > programLength, 'the adapter displays a diagnostic besides program output');
    assert.ok(!printed.endsWith(ps1));
    assert.ok(state.facets[0].disposed);
  } finally { await state.close(); }
}

// A malformed request is rejected by the real facet task, not a fabricated slice.
{
  const state = start();
  try {
    await state.boot();
    state.view.reset();
    state.invalidNext = true;
    state.view.terminal.sendData(':\r');
    assert.notEqual(await bounded(state.running, 'facet error did not end Bash', 5000), 0);
    assert.ok(state.view.text().slice(':\r\n'.length).trim().length > 0, 'facet failure reaches adapter stderr');
    assert.ok(!state.view.text().endsWith(ps1));
    assert.ok(state.facets[0].disposed);
  } finally { await state.close(); }
}

// Interrupt settles the held dispatch, disposes its Bash and boots a fresh one.
{
  const state = start();
  try {
    await state.boot();
    state.view.reset();
    state.view.terminal.sendData('kept=old\r');
    await state.view.seen((value) => value.endsWith(ps1), 'assignment prompt');
    state.view.reset();
    state.holdNext = true;
    state.view.terminal.sendData('printf STALE\r');
    await bounded(state.held.promise, 'held Bash dispatch', 5000);
    state.view.terminal.sendData('\x03printf \'<%s>\' "${kept-unset}"\r');
    await state.view.seen((value) => value.includes('<unset>') && value.endsWith(ps1), 'fresh Bash after interruption');
    assert.equal(state.facets.length, 2, 'interrupt opens one replacement Bash');
    assert.ok(state.facets[0].disposed);
    assert.equal(state.view.text().split('BOOTOUT').length - 1, 1, 'replacement boot output is not repeated');
    assert.deepEqual(Buffer.concat(state.bytes.stdout), Buffer.from('BOOTOUT\nBOOTOUT\n<unset>'));
    assert.equal(state.view.text().split('<unset>').length - 1, 1, 'replacement input runs once');
  } finally { await state.close(); }
}

console.log('bash-repl: boot, prompts, bytes, failures and interruption preserve the real flow');
