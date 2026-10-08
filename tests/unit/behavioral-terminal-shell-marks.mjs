#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Terminal, stripAnsi } from '../behavioral/_driver.mjs';

const mark = (value, end = '\x07') => `\x1b]133;${value}${end}`;
const prompt = 'user@nimbus:~$ ';
const server = createServer();
const sockets = new WebSocketServer({ server });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const failures = [];

async function scenario(name, exercise) {
  let terminal;
  let peer;
  try {
    const connected = once(sockets, 'connection');
    terminal = new Terminal(name, { base, wsOptions: {} });
    await terminal.connect();
    [peer] = await connected;
    peer.send(JSON.stringify({ type: 'output', data: prompt }));
    await terminal.waitFor((text) => text.includes(prompt), 1000, 'initial prompt text');
    const output = (data) => peer.send(JSON.stringify({ type: 'output', data }));
    await exercise(terminal, peer, output);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  } finally {
    peer?.close();
    await terminal?.close();
  }
}

try {
  await scenario('ANSI-only output cannot complete a submitted command', async (terminal, peer, output) => {
    let finished = false;
    terminal.cmd('held');
    const completion = terminal.waitForPrompt(1000).then(() => { finished = true; });
    const chunk = once(terminal.ws, 'message');
    output('\x1b[?25h');
    await chunk;
    await setImmediate();
    const premature = finished;
    output(`${mark('C')}done\n${mark('D;7')}${mark('A')}${prompt}${mark('B')}`);
    await completion;
    assert.equal(premature, false, 'ANSI bytes after a buffered prompt are not a new prompt');
  });

  await scenario('prompt-looking program output cannot complete run()', async (terminal, peer, output) => {
    let finished = false;
    const completion = terminal.run('held', 1000).then((result) => { finished = true; return result; });
    output(`${mark('C')}a@b:c$ `);
    await terminal.waitFor((text) => text.endsWith('a@b:c$ '), 1000, 'program output');
    await setImmediate();
    const premature = finished;
    output(`still running\n${mark('D;9')}${mark('A')}${prompt}${mark('B')}`);
    const result = await completion;
    assert.equal(premature, false, 'a program can print a prompt at a chunk boundary and keep running');
    assert.equal(result.exitCode, 9);
    assert.match(result.output, /still running/);
    assert.ok(!result.output.includes('\x1b]133;'), 'OSC marks are not visible output');
  });

  await scenario('split marks survive reset; the first B owns the result', async (terminal, peer, output) => {
    const completion = terminal.run('held', 1000);
    output(`${mark('C')}first\n${mark('D;3', '\x1b\\')}${mark('A')}${prompt}\x1b]133;`);
    await terminal.waitFor((text) => text.includes('first'), 1000, 'first output');
    terminal.reset();
    output(`B\x1b\\${mark('C')}queued\n${mark('D;0')}${mark('A')}${prompt}${mark('B')}`);
    const result = await completion;
    assert.equal(result.exitCode, 3, 'the queued command cannot overwrite the first completion');
    assert.match(result.output, /first/);
    assert.ok(!result.output.includes('queued'), 'run output ends at its own B');

    const thrown = terminal.run('throws', 1000);
    output(`${mark('C')}threw\n${mark('D')}${mark('A')}${prompt}${mark('B')}`);
    assert.equal((await thrown).exitCode, null, 'bare D has no exit status, never an earlier command\'s status');

    terminal.cmd('');
    const empty = terminal.waitForPrompt(1000);
    output(`${mark('A')}${prompt}${mark('B')}`);
    await empty;
  });

  assert.equal(stripAnsi(`a${mark('D;0')}b\x1b]0;window title\x1b\\c\x1b[31md\x1b[0m`), 'abcd');
} finally {
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
assert.deepEqual(failures, []);
console.log('behavioral-terminal-shell-marks: PASS');
