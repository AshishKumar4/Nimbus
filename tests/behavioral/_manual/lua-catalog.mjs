#!/usr/bin/env bun
// Run against a throwaway Preview bound to the isolated Lua catalog, or
// explicitly with --local against a loopback workerd with the same catalog.
// The SDK drives shell commands and reads their streams; Lua is a CLI only.
import assert from 'node:assert/strict';
import { Nimbus } from '../../../packages/sdk/src/index.ts';
import { AUTH_TOKEN, BASE, Terminal, deleteSession, mintSession } from '../_driver.mjs';
import { afterReset, resetInstance } from '../durable/_reset-window.mjs';
import { files, successCommand, failureCommand, success, failure, version } from '../../fixtures/lua-cli.mjs';

const local = process.argv.includes('--local');
const target = new URL(BASE);
const host = target.hostname;
if (local) assert.equal(host, '127.0.0.1');
else {
  assert.equal(target.protocol, 'https:', 'remote Lua probe requires HTTPS');
  assert.match(host, /^tw-.+-nimbus-probe-previews\..+\.workers\.dev$/);
}
assert.ok(AUTH_TOKEN, 'a throwaway probe token is required');
const nimbus = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN });
const cwd = '/home/user/lua-project';
const run = async (box, command, expected) => {
  const { exitCode, stdout, stderr } = await box.exec(command, { cwd, timeoutMs: 30_000 });
  assert.deepEqual({ exitCode, stdout, stderr }, expected, command);
};

for (const runtime of ['lua', `lua@${version}`]) {
  const sid = await mintSession();
  const box = nimbus.sandbox(sid);
  const terminal = new Terminal(sid);
  try {
    await terminal.connect();
    await terminal.waitForPrompt();
    const before = await terminal.run('command -v lua');
    assert.equal(before.exitCode, 1, `Lua unexpectedly installed: ${before.output}`);
    const installed = await terminal.run(`nimbus install ${runtime}`, 120_000);
    assert.equal(installed.exitCode, 0, installed.output);
    const setup = await terminal.run(`mkdir -p ${cwd}`);
    assert.equal(setup.exitCode, 0, setup.output);
    for (const [name, contents] of Object.entries(files)) {
      const written = await terminal.writeFile(`${cwd}/${name}`, contents);
      assert.equal(written.exitCode, 0, written.output);
    }
    await terminal.close();
    await run(box, 'lua -v', { exitCode: 0, stdout: `Lua ${version}  Copyright (C) 1994-2025 Lua.org, PUC-Rio\n`, stderr: '' });
    await run(box, successCommand, success);
    await run(box, failureCommand, failure);
    console.log(`ok: nimbus install ${runtime} and project CLI fixtures in fresh session ${sid}`);

    if (runtime === 'lua') continue;
    // The pipe outlasts the host's 8 s parked wait. The guest must ask again.
    await run(box, "(sleep 10; printf 'late input\\n') | lua -E wait.lua",
      { exitCode: 0, stdout: 'LUA_READY\nlate input\n', stderr: '' });
    console.log('ok: Lua restarted a parked read and received the late input');

    // Send SIGINT to the guest, not to the pipeline shell. Lua's own handler
    // throws "interrupted!"; a supervisor-only kill cannot print that error.
    for (const [script, command] of [
      ['wait.lua', "(sleep 10; printf 'late input\\n') | lua -E wait.lua"],
      ['spin.lua', ':; lua -E spin.lua'],
    ]) {
      const waiting = await box.execStream(command, { cwd, timeoutMs: 30_000 });
      let out = '';
      let err = '';
      let sent = false;
      for await (const { stream, data } of waiting.output) {
        if (stream === 'stdout') out += Buffer.from(data).toString();
        else err += Buffer.from(data).toString();
        if (!sent && out.includes('LUA_READY\n')) {
          const guests = (await box.processes.list()).filter((p) => p.command === `lua -E ${script}` && p.state === 'running');
          assert.equal(guests.length, 1, JSON.stringify(guests));
          assert.equal((await box.processes.signal(guests[0].pid, 'SIGINT')).ok, true);
          sent = true;
        }
      }
      assert.ok(sent, `never signaled the Lua guest: ${out} ${err}`);
      assert.equal((await waiting.exit).exitCode, 1, err);
      assert.equal(out, 'LUA_READY\n');
      assert.match(err, /interrupted!/);
      console.log(`ok: Lua handled SIGINT in ${script}`);
    }

    const reset = await resetInstance(sid);
    assert.ok(reset.ok, reset.detail);
    console.log(`ok: ${reset.detail}`);
    // No install or fixture setup after eviction. Make Lua write the result
    // again, so a stale output file cannot pass the rehydration check.
    await afterReset(() => run(box, 'rm output.txt', { exitCode: 0, stdout: '', stderr: '' }));
    await run(box, successCommand, success);
    await run(box, failureCommand, failure);
    console.log(`ok: ${runtime} and the same project still run after rehydration`);
  } finally {
    if (!terminal.closing) await terminal.close();
    const cleaned = await deleteSession(sid);
    assert.ok(cleaned.ok, `failed to delete ${sid}: ${JSON.stringify(cleaned)}`);
  }
}
