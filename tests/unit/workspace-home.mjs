#!/usr/bin/env bun
// A workspace's per-user defaults follow the HOME its host configures.
//
// Kinu runs workspaces with HOME=/home/main. PATH, XDG_CONFIG_HOME,
// XDG_DATA_HOME and /etc/passwd still named /home/user, and the seeded home
// directory and ~/.nimbusrc were made there, so Kinu aliased /home/user to
// /home/main. Every one of them is now derived from the configured HOME.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { DEFAULT_PATH } from '../../packages/core/src/constants.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const SEEDED_PASSWD_USER_HOME = 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:/home/user:/bin/sh\n';
const SEEDED_PROFILE_USER_HOME = `export PATH=${DEFAULT_PATH}\nexport EDITOR=nano\n`;

async function open(db, env) {
  const harness = createSqliteVfsTestHarness(db);
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, env });
  await ws.start();
  return ws;
}

const out = async (ws, line) => {
  const result = await ws.exec(line);
  assert.equal(result.exitCode, 0, `${line}: ${result.stderr}`);
  return result.stdout;
};

// ── A configured HOME ─────────────────────────────────────────────────────
{
  const db = new Database(':memory:');
  const ws = await open(db, { HOME: '/home/main' });
  const kernel = ws.vfs.as(CRED_KERNEL);
  assert.equal(
    await out(ws, 'echo "$PATH|$XDG_CONFIG_HOME|$XDG_DATA_HOME|$PWD"'),
    '/usr/local/bin:/usr/bin:/bin:/home/main/.local/bin:/home/main/.gem/bin|/home/main/.config|/home/main/.local/share|/home/main\n',
    'PATH and the XDG directories are under the configured HOME, after /etc/profile ran',
  );
  assert.equal(
    kernel.readFileString('etc/passwd'),
    'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:/home/main:/bin/sh\n',
  );
  assert.match(await out(ws, 'cd && pwd && cd ~ && pwd'), /^\/home\/main\n\/home\/main\n$/);
  const home = kernel.stat('home/main');
  assert.deepEqual([home.type, home.uid, home.gid, home.mode & 0o777], ['directory', 1000, 1000, 0o755], 'the home is the user\'s');
  assert.equal(kernel.exists('home/main/.config'), true);
  assert.equal(kernel.exists('home/user'), false, 'no stray /home/user');
  assert.match(await out(ws, 'alias ll'), /ls -la/, '~/.nimbusrc is seeded where it is sourced from');
  db.close();
}

// ── A home outside /home is made by root and handed to the user ──────────
{
  const db = new Database(':memory:');
  const ws = await open(db, { HOME: '/srv/agents/main' });
  const kernel = ws.vfs.as(CRED_KERNEL);
  assert.equal(kernel.stat('srv/agents/main').uid, 1000);
  assert.equal(kernel.stat('srv/agents').uid, 0, 'its parents stay root\'s');
  assert.equal(await out(ws, 'touch ~/f && echo ok'), 'ok\n');
  db.close();
}

// ── A workspace seeded under the old defaults follows the new HOME ────────
// The seeded passwd and profile are Nimbus's, so they move; a passwd the user
// edited is theirs, and stays.
{
  const db = new Database(':memory:');
  const kernel0 = (await open(db, {})).vfs.as(CRED_KERNEL);
  kernel0.writeFile('etc/passwd', SEEDED_PASSWD_USER_HOME);
  kernel0.writeFile('etc/profile', SEEDED_PROFILE_USER_HOME);

  const ws = await open(db, { HOME: '/home/main' });
  const kernel = ws.vfs.as(CRED_KERNEL);
  assert.match(kernel.readFileString('etc/passwd'), /Nimbus User:\/home\/main:/);
  assert.equal(kernel.readFileString('etc/profile'), 'export PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.gem/bin\nexport EDITOR=nano\n');
  assert.match(await out(ws, 'echo "$PATH"'), /\/home\/main\/\.gem\/bin\n$/);

  const edited = 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Main:/home/user:/bin/bash\n';
  kernel.writeFile('etc/passwd', edited);
  const again = await open(db, { HOME: '/home/main' });
  assert.equal(again.vfs.as(CRED_KERNEL).readFileString('etc/passwd'), edited, 'a passwd the user changed is left alone');
  db.close();
}

// ── No HOME configured: the defaults are what they were ──────────────────
{
  const db = new Database(':memory:');
  const ws = await open(db, {});
  assert.equal(await out(ws, 'echo "$HOME|$PATH|$XDG_CONFIG_HOME"'), `/home/user|${DEFAULT_PATH}|/home/user/.config\n`);
  assert.equal(ws.vfs.as(CRED_KERNEL).readFileString('etc/passwd'), SEEDED_PASSWD_USER_HOME);
  db.close();
}

// ── A relative HOME is refused, not seeded somewhere surprising ──────────
{
  const db = new Database(':memory:');
  const harness = createSqliteVfsTestHarness(db);
  await assert.rejects(
    NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, env: { HOME: 'home/main' } }),
    /HOME must be an absolute path/,
  );
  db.close();
}

console.log('workspace-home: ok');
