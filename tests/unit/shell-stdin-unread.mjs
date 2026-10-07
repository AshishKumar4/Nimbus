#!/usr/bin/env bun
// A command that does not read its stdin does not read it.
//
// The shell's commands used to have their stdin read to its end before they
// ran (unix-commands.ts `wrap`), whether they read it or not. With a child
// process's stdin a live pipe its parent may never end, that held `sh -c
// 'printf x > f'` until the parent did; under Node it exits at once. What has
// to hold: builtins, a redirect, a pipeline whose first command does not read
// stdin, `true`, and `head -n 0` / `head -c 0` (GNU reads nothing for them)
// never pull the shell's stdin, even one that stays open; a command that
// reads it does, and gets it.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { pulledStdinReader } from '../../packages/core/src/shell/stdin-adapter.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1 });

/** A stdin that counts each pull. It hands `text` once, then ends. */
function countedStdin(text) {
  const seen = { pulls: 0 };
  let left = new TextEncoder().encode(text);
  const stdin = pulledStdinReader(async () => {
    seen.pulls++;
    const bytes = left;
    left = null;
    return bytes;
  });
  return { stdin, seen };
}

for (const line of [
  'printf child-live-ok > /home/user/out.txt',
  'echo a b | tr a-z A-Z',
  'true',
  'printf "%s\\n" x; basename /a/b; test -d /home/user && echo dir; pwd',
  'seq 3 | awk "{ print }"',
  'base64 /home/user/out.txt',
  'head -n 0',
  'head -c 0',
  'head -n 0 -',
]) {
  const { stdin, seen } = countedStdin('never read\n');
  const result = await ws.shell.execute(line, { stdin, cwd: '/home/user' });
  assert.equal(result.exitCode, 0, `${line}: ${result.stderr}`);
  assert.equal(seen.pulls, 0, `${line}: its stdin is not read`);
}
// Left open: a stdin no one ends. A command that pulls it waits for good.
for (const line of ['head -n 0', 'head -c 0', 'true', 'printf x']) {
  let pulls = 0;
  const open = pulledStdinReader(() => { pulls++; return new Promise(() => {}); });
  const result = await ws.shell.execute(line, { stdin: open, cwd: '/home/user' });
  assert.deepEqual([result.exitCode, pulls], [0, 0], `${line}: returns without reading its open stdin`);
}
// A file operand is still opened, and its failure still reported.
{
  const result = await ws.shell.execute('head -n 0 -v /home/user/out.txt /home/user/missing', { cwd: '/home/user' });
  assert.equal(result.stdout, '==> /home/user/out.txt <==\n');
  assert.match(result.stderr, /head: cannot open '\/home\/user\/missing' for reading/);
  assert.equal(result.exitCode, 1);
}

assert.equal(new TextDecoder().decode(ws.vfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).readFile('home/user/out.txt')), 'child-live-ok');

for (const [line, out] of [['cat', 'in\n'], ['tr a-z A-Z', 'IN\n'], ['base64', 'aW4K\n'], ['awk "{ print \\$1 }"', 'in\n']]) {
  const { stdin, seen } = countedStdin('in\n');
  const result = await ws.shell.execute(line, { stdin, cwd: '/home/user' });
  assert.equal(result.stdout, out, `${line}: ${result.stderr}`);
  assert.ok(seen.pulls > 0, `${line}: reads its stdin`);
}

console.log('ok - shell-stdin-unread (only a command that reads its stdin reads it)');
