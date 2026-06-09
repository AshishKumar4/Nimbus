#!/usr/bin/env bun
//
// Re-entrancy regression (commit 88d67bb fallout): a nested `Shell.execute`
// (e.g. `npm run <script>` routing a script back through the same interactive
// Shell) must NOT hijack the parent command's stream routing.
//
// Before the fix, `Shell.execute` mutated shared
// `interpreterConfig.defaultStdout/defaultStderr/writeToTerminal` to capture the
// nested execution. The PARENT command's stdout, when run at the top-level
// interactive path, is the interpreter's LATE-BOUND fallback
// `{ write: (t) => this.config.writeToTerminal(t) }` which dereferences config
// AT WRITE TIME — so a write issued AFTER the nested execute started re-routed
// into the nested capture (and, in the real `npm` path, recursed via the tee).
// Net effect: the parent command's terminal output was silently lost.
//
// This test drives exactly that shape: a top-level (uncaptured) parent command
// whose `ctx.stdout` is the late-bound terminal fallback, writing AROUND a
// nested `shell.execute`. Its output must land on the real terminal verbatim.

import assert from 'node:assert/strict';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';

// Minimal ITerminal that records everything written to the real terminal.
function makeRecordingTerminal() {
  let buf = '';
  return {
    write: (d) => { buf += String(d); },
    writeln: (d) => { buf += String(d) + '\n'; },
    clear: () => { buf = ''; },
    onData: () => {},
    focus: () => {},
    cols: 80,
    rows: 24,
    get text() { return buf; },
  };
}

const terminal = makeRecordingTerminal();
const box = await Sandbox.create({ persist: false, terminal });

try {
  let nestedResult = null;

  // Parent registry command modelled on the real `npm run` path: at the
  // interactive path `ctx.stdout` is the late-bound terminal fallback. It runs
  // a nested capturing `shell.execute` and TEES the nested output back through
  // its OWN ctx streams (exactly what shellExecuteTracked does) — so a nested
  // write re-enters the parent's late-bound stream WHILE the nested execute is
  // still on the stack. Pre-fix this synchronously recursed into the nested
  // capture (mutated shared config), losing/duplicating the parent banner.
  box.commands.registry.register('parentcmd', async (ctx) => {
    ctx.stdout.write('PARENT_BEFORE\n');
    nestedResult = await box.shell.execute('echo NESTED_CAPTURED', {
      onStdout: (t) => { try { ctx.stdout.write(t); } catch {} },
      onStderr: (t) => { try { ctx.stderr.write(t); } catch {} },
    });
    ctx.stdout.write('PARENT_AFTER\n');
    return 0;
  });

  const countOf = (hay, needle) => hay.split(needle).length - 1;

  // Run the parent through the INTERACTIVE line path: output routes to the real
  // terminal via the interpreter's late-bound `writeToTerminal` fallback — the
  // exact stream the pre-fix nested `execute` reassigned mid-flight.
  terminal.clear();
  await box.shell.executeLine('parentcmd');

  // Nested execute's output stays in its own capture buffer.
  assert.equal(nestedResult.stdout, 'NESTED_CAPTURED\n', 'nested stdout captured');
  assert.equal(nestedResult.exitCode, 0, 'nested exit');

  // The crux: every line reaches the terminal exactly once, in order. Pre-fix
  // the nested write recursed (config aliasing), so PARENT_AFTER was lost and
  // the nested line was duplicated/swallowed. The tee forwards NESTED_CAPTURED
  // to the terminal exactly once (deliberate, like npm echoing script output).
  assert.equal(countOf(terminal.text, 'PARENT_BEFORE'), 1, 'PARENT_BEFORE once on terminal');
  assert.equal(countOf(terminal.text, 'PARENT_AFTER'), 1, 'PARENT_AFTER once on terminal');
  assert.equal(countOf(terminal.text, 'NESTED_CAPTURED'), 1, 'nested line teed to terminal once');
  assert.ok(
    terminal.text.indexOf('PARENT_BEFORE')
      < terminal.text.indexOf('NESTED_CAPTURED'),
    'BEFORE precedes nested',
  );
  assert.ok(
    terminal.text.indexOf('NESTED_CAPTURED') < terminal.text.indexOf('PARENT_AFTER'),
    'nested precedes AFTER',
  );

  // Shared interpreter config ended the nested execute exactly as it began: a
  // subsequent captured execute routes cleanly into its buffer (not terminal).
  terminal.clear();
  let cap = '';
  const captured = await box.shell.execute('echo CAPTURED_AGAIN', {
    onStdout: (t) => { cap += t; },
  });
  assert.equal(captured.stdout, 'CAPTURED_AGAIN\n', 'post-nested captured stdout');
  assert.equal(cap, 'CAPTURED_AGAIN\n', 'post-nested onStdout');
  assert.equal(terminal.text.includes('CAPTURED_AGAIN'), false, 'capture did not leak to terminal');

  // And a subsequent interactive line still reaches the real terminal.
  terminal.clear();
  await box.shell.executeLine('echo TERMINAL_AGAIN');
  assert.equal(countOf(terminal.text, 'TERMINAL_AGAIN'), 1, 'post-nested terminal path intact');
} finally {
  box.destroy();
}

console.log('shell-execute-reentrancy: ok');
