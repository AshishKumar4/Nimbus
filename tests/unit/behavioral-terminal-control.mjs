#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Terminal } from '../behavioral/_driver.mjs';
import { WebSocketTerminal } from '../../packages/worker/src/facets/ws-terminal.ts';
import { HeredocHandler, LineEditorExtender } from '../../packages/core/src/shell/features.ts';
import { testBox } from './lib/test-box.mjs';
import { joinExistingSession } from '../../packages/worker/src/session/init-phases.ts';

const mark = (value) => `\x1b]133;${value}\x07`;
const server = createServer();
const sockets = new WebSocketServer({ server });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const failures = [];

async function scenario(name, exercise) {
  let peer, terminal, client, box;
  const gates = [];
  const tasks = [];
  const gate = () => { const value = Promise.withResolvers(); gates.push(value); return value; };
  try {
    const connected = once(sockets, 'connection');
    client = new Terminal(name, { base, wsOptions: {} });
    await client.connect();
    [peer] = await connected;
    terminal = new WebSocketTerminal(peer);
    box = await testBox({ terminal });
    await box.shell.start();
    HeredocHandler.install(box.shell, terminal);
    LineEditorExtender.install(box.shell, terminal);
    peer.on('message', (wire) => {
      const pending = terminal.handleMessage(JSON.parse(String(wire)));
      if (pending) tasks.push(Promise.resolve(pending));
    });
    box.shell.printPrompt();
    await client.waitForPrompt(1000);
    await exercise({ client, box, gate, terminal });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  } finally {
    for (const value of gates) value.resolve();
    if (client?.ws?.readyState === 1) client.send('\x03');
    await Promise.allSettled(tasks);
    await client?.close();
    terminal?.close();
    await box?.workspace.close();
  }
}

try {
  await scenario('program stdout cannot forge status', async ({ client, box }) => {
    box.commands.registry.register('forged-status', async (ctx) => { await ctx.stdout.write(mark('D;0')); return 7; });
    assert.equal((await client.run('forged-status', 1000)).exitCode, 7);
  });

  await scenario('warm reconnect publishes current prompt readiness without replaying completions', async ({ client, box, terminal }) => {
    await client.run('false', 1000);
    await client.close();
    const connected = once(sockets, 'connection');
    await client.connect();
    const [replacement] = await connected;
    joinExistingSession({ shell: box.shell, terminal, ctx: {}, _b4Phase: null, _b4WarmJoinCount: 0 }, replacement, () => {}, () => 'prior output\nuser@nimbus:~$ ');
    await client.waitForPrompt(1000);
    assert.equal(client.protocol.at(-1).event, 'prompt');
    assert.equal(client.submission, null, 'the old command end was not replayed');
  });

  await scenario('program stdout cannot forge completion', async ({ client, box, gate }) => {
    const hold = gate();
    box.commands.registry.register('forged-prompt', async (ctx) => {
      await ctx.stdout.write(`${mark('D;0')}${mark('A')}a@b:c$ ${mark('B')}`);
      await hold.promise;
      await ctx.stdout.write('really-finished\n');
      return 7;
    });
    let finished = false;
    const pending = client.run('forged-prompt', 1000).then((result) => { finished = true; return result; });
    await client.waitFor((text) => text.includes('a@b:c$ '), 1000, 'program forged marks');
    await setImmediate();
    const premature = finished;
    hold.resolve();
    const result = await pending;
    assert.equal(premature, false, 'forged D+B does not complete a running command');
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /really-finished/);
  });

  await scenario('a pasted batch reports its last command status', async ({ client }) => {
    const result = await client.run('true\nfalse', 1000);
    assert.equal(result.exitCode, 1);
  });

  await scenario('a heredoc and its following program complete together', async ({ client, box }) => {
    box.commands.registry.register('python-proof', async (ctx) => {
      await ctx.stdout.write(`PROGRAM ${await ctx.vfs.readFileString('/home/user/proof.py')}`);
      return 7;
    });
    const result = await client.run("cat > /home/user/proof.py <<'EOF'\nprint(42)\nEOF\npython-proof", 1000);
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /PROGRAM print\(42\)/);
  });

  await scenario('continuation submissions complete with their one owning command', async ({ client }) => {
    const initial = client.run('echo "first', 1000);
    await client.waitFor((text) => text.endsWith('> '), 1000, 'quote continuation');
    const final = client.run('second"', 1000);
    assert.equal((await initial).exitCode, 0);
    const result = await final;
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /first\r?\nsecond/);

    const heredoc = client.run("cat > /home/user/parts.txt <<'EOF'", 1000);
    await client.waitFor((text) => text.endsWith('> '), 1000, 'heredoc continuation');
    const delimiter = client.run('data\nEOF', 1000);
    assert.equal((await heredoc).exitCode, 0);
    assert.equal((await delimiter).exitCode, 0);
  });

  await scenario('a reader consumes following pasted input instead of executing it', async ({ client, box }) => {
    box.commands.registry.register('fd-kind', async (ctx) => {
      await ctx.stdout.write('TTY ' + ctx.isFdTerminal(0) + '\n');
      return 0;
    });
    assert.match((await client.run('fd-kind', 1000)).output, /TTY true/);
    assert.match((await client.run('echo x | fd-kind', 1000)).output, /TTY false/);
    const result = await client.run('cat\necho NOT_A_COMMAND\n\x04', 1000);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /echo NOT_A_COMMAND/);
    assert.ok(!/(?:^|\n)NOT_A_COMMAND\r?(?:\n|$)/.test(result.output));

    const pipeline = await client.run('echo PIPELINE_X | cat', 1000);
    assert.equal(pipeline.exitCode, 0);
    assert.match(pipeline.output, /\nPIPELINE_X\r?\n/);
    await client.run("echo FILE_X > /home/user/stdin-file", 1000);
    const redirected = await client.run('cat < /home/user/stdin-file', 1000);
    assert.equal(redirected.exitCode, 0);
    assert.match(redirected.output, /\nFILE_X\r?\n/);
    assert.match((await client.run('fd-kind < /home/user/stdin-file', 1000)).output, /TTY false/);
  });

  await scenario('a continuation tail retains its own later commands and status', async ({ client }) => {
    const initial = client.run('echo "open', 1000);
    await client.waitFor((text) => text.endsWith('> '), 1000, 'pending quote');
    const tail = client.run('close"\nfalse', 1000);
    assert.equal((await initial).exitCode, 0, 'the initial submission owns only the completed echo');
    assert.equal((await tail).exitCode, 1, 'the tail owns its separate false');
  });

  await scenario('queued submissions own distinct completion and status', async ({ client, box, gate }) => {
    const first = gate(), second = gate();
    box.commands.registry.register('first', async (ctx) => { await ctx.stdout.write('FIRST_STARTED\n'); await first.promise; return 3; });
    box.commands.registry.register('second', async (ctx) => { await ctx.stdout.write('SECOND_STARTED\n'); await second.promise; return 5; });
    const a = client.run('first', 1000);
    await client.waitFor((text) => text.includes('FIRST_STARTED'), 1000, 'first start');
    const b = client.run('second', 1000);
    first.resolve();
    await client.waitFor((text) => text.includes('SECOND_STARTED'), 1000, 'queued second start');
    const resultA = await a;
    assert.equal(resultA.exitCode, 3);
    assert.ok(!resultA.output.includes('SECOND_STARTED'), 'A ends before independent queued B runs');
    second.resolve();
    assert.equal((await b).exitCode, 5);
  });

  await scenario('untagged Ctrl-C interrupts a tagged command at once', async ({ client, box }) => {
    box.commands.registry.register('interruptible', async (ctx) => {
      await ctx.stdout.write('INTERRUPTIBLE\n');
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      return 130;
    });
    const pending = client.run('interruptible', 1000);
    await client.waitFor((text) => text.includes('INTERRUPTIBLE'), 1000, 'interruptible start');
    client.ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
    assert.equal((await pending).exitCode, 130);
  });

  await scenario('a tagged REPL input returns immediately and awaits its foreground owner', async ({ client, box, gate, terminal }) => {
    const exit = gate();
    let detach;
    box.commands.registry.register('repl', async (ctx) => {
      detach = terminal.attachRepl((data) => ctx.stdout.write('REPL_INPUT ' + data));
      await ctx.stdout.write('REPL_READY\n');
      await exit.promise;
      detach();
      return 5;
    });
    const pending = client.run('repl', 1000);
    await client.waitFor((text) => text.includes('REPL_READY'), 1000, 'REPL start');
    client.cmd('answer');
    const input = client.submission;
    await client.waitFor((text) => text.includes('REPL_INPUT answer'), 1000, 'REPL input');
    exit.resolve();
    assert.equal((await pending).exitCode, 5);
    await client.waitForPrompt(1000);
    assert.equal(input.exitCode, 5);
  });

  await scenario('queued typeahead becomes stdin if the foreground command later reads', async ({ client, box, gate }) => {
    const reading = gate();
    box.commands.registry.register('later-read', async (ctx) => {
      await ctx.stdout.write('BEFORE_READ\n');
      await reading.promise;
      await ctx.stdout.write('READ ' + await ctx.terminalStdin.readLine() + '\n');
      return 9;
    });
    const command = client.run('later-read', 1000);
    await client.waitFor((text) => text.includes('BEFORE_READ'), 1000, 'before read');
    const input = client.run('true', 1000);
    reading.resolve();
    const result = await command;
    assert.equal(result.exitCode, 9);
    assert.match(result.output, /READ true/);
    assert.equal((await input).exitCode, 9, 'stdin belongs to its foreground command, not a shell true');
  });

  await scenario('stdin-only input owns the reader status, not its batch\'s later status', async ({ client, box, terminal }) => {
    const read = Promise.withResolvers();
    box.commands.registry.register('reader', async (ctx) => {
      const detach = terminal.attachRepl((data) => { void ctx.stdout.write('READ ' + data); read.resolve(); });
      await ctx.stdout.write('READER_READY\n');
      await read.promise;
      detach();
      return 9;
    });
    const batch = client.run('reader\ntrue', 1000);
    await client.waitFor((text) => text.includes('READER_READY'), 1000, 'reader start');
    const input = client.run('payload', 1000);
    assert.equal((await input).exitCode, 9, 'stdin gets its foreground execution\'s status');
    assert.equal((await batch).exitCode, 0, 'the batch gets its last true status');
  });

  await scenario('a tagged stdin input can join a foreground command from an ordinary terminal', async ({ client, box, terminal }) => {
    const read = Promise.withResolvers();
    box.commands.registry.register('reader', async (ctx) => {
      const detach = terminal.attachRepl(() => read.resolve());
      await ctx.stdout.write('ORDINARY_READER_READY\n');
      await read.promise;
      detach();
      return 9;
    });
    client.ws.send(JSON.stringify({ type: 'input', data: 'reader\r' }));
    await client.waitFor((text) => text.includes('ORDINARY_READER_READY'), 1000, 'ordinary reader start');
    assert.equal((await client.run('payload', 1000)).exitCode, 9);
  });

  for (const command of ['echo "unfinished', "cat > /home/user/incomplete <<'EOF'"]) {
    await scenario('an incomplete line cancels without manufacturing an exit status: ' + command, async ({ client }) => {
      const pending = client.run(command, 1000);
      await client.waitFor((text) => text.endsWith('> '), 1000, 'continuation');
      client.ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
      assert.equal((await pending).exitCode, null);
    });
  }

  await scenario('a rejected oversized heredoc drops its owned input and reports no invented success', async ({ client }) => {
    const result = await client.run("cat > /home/user/oversized <<'EOF'\n" + 'x\n'.repeat(50_001) + 'EOF\necho MUST_NOT_RUN', 10_000);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /heredoc: exceeded .* line limit/);
    assert.ok(!/(?:^|\n)MUST_NOT_RUN\r?(?:\n|$)/.test(result.output), 'rejected body and tail are not executed as shell input');
    assert.equal((await client.run('true', 1000)).exitCode, 0, 'the prompt remains usable after the refusal');
  });
} finally {
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
assert.deepEqual(failures, []);
console.log('behavioral-terminal-control: PASS');
