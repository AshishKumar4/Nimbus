#!/usr/bin/env bun
// @tier slow — drives a local workerd with installed bash and git
//
// Ctrl-C reaches a WASI program waiting on a child, a pipe or the terminal,
// as a terminal's does: the foreground job's processes get SIGINT, the
// program's own handling runs, and the prompt is back within a second with
// the status Linux gives. Each case is run natively first, its process group
// sent SIGINT as a terminal's Ctrl-C sends it, and Nimbus must end as that
// did:
//
//   1. `git credential fill` waiting on a helper that sleeps a minute: git
//      dies of SIGINT (130), and the helper with it;
//   2. `git commit -a` waiting on an editor that sleeps a minute: git ignores
//      SIGINT while its editor runs, the editor dies of it, and git reports
//      the editor's failure and removes the index.lock it held (1);
//   3. real bash's `read` waiting on the terminal: bash dies of SIGINT (130).
//
// Red before: the program and its children ran on (git and its helper 24 s
// after Ctrl-C), and the prompt did not come back.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

/** How long after a Ctrl-C the prompt must be back. */
const PROMPT_BACK_MS = 1_000;
/** How long the job runs before its Ctrl-C: long enough to be waiting where the case says. */
const SETTLE_MS = 4_000;

/** `argv` run natively in a process group of its own, which gets SIGINT after SETTLE_MS: its status, and its stderr. */
function nativeInterrupt(argv, { cwd, env = {}, input = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    if (input !== null) child.stdin.end(input);
    const timer = setTimeout(() => process.kill(-child.pid, 'SIGINT'), SETTLE_MS);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // What a shell reports for it: 128 + the signal it died of, else its code.
      resolve({ status: signal === 'SIGINT' ? 130 : signal ? 128 : code, stderr });
    });
  });
}

/** A repo with one commit and a tracked file changed since, for `commit -a`. */
function nativeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wasi-signals-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f'), 'one\n');
  git('add', 'f');
  git('commit', '-q', '-m', 'one');
  writeFileSync(join(dir, 'f'), 'two\n');
  return dir;
}

const query = 'protocol=https\nhost=example.com\n\n';
const ident = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };

let probe;
const terminals = [];
const failed = [];
const check = async (name, body) => {
  try {
    await body();
    console.log(`  ok ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
  }
};

/**
 * `line` typed into a fresh session's terminal, Ctrl-C after SETTLE_MS: the
 * status it printed, how long after the Ctrl-C, and the terminal's text.
 */
async function interrupted(line, { setup = [] } = {}) {
  const session = await localTerminal(probe, { install: ['bash', 'git'] });
  terminals.push(session);
  for (const command of setup) {
    const r = await session.run(command, 120_000);
    assert.equal(r.status, 0, `${command}: ${r.stdout}`);
  }
  const t = session.terminal;
  await t.waitForPrompt(30_000);
  t.reset();
  t.cmd(`${line}; echo "status $?"`);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const sent = Date.now();
  t.send('\x03');
  let backMs = null;
  try {
    await t.waitFor((buf) => /status \d+/.test(buf), 30_000, 'the status line');
    backMs = Date.now() - sent;
  } catch {}
  const status = Number(/status (\d+)/.exec(t.buf)?.[1] ?? NaN);
  // The driver after the probe started: it reads the probe's address as it loads.
  const { requestHeaders } = await import('../behavioral/_driver.mjs');
  const running = await (await fetch(`${probe.base}/s/${session.sid}/api/processes`, { headers: requestHeaders() })).json();
  const live = (Array.isArray(running) ? running : running.processes ?? []).filter((p) => p.state === 'running').map((p) => p.command);
  return { session, status, backMs, text: t.buf, live };
}

try {
  probe = await startLocalProbe({ runtimes: ['bash', 'git'] });

  await check('git waiting on its credential helper dies of SIGINT, its helper with it', async () => {
    const native = await nativeInterrupt(['git', '-c', 'credential.helper=!sleep 60', 'credential', 'fill'], { cwd: tmpdir(), input: query });
    const nimbus = await interrupted(`printf '${query.replace(/\n/g, '\\n')}' | NIMBUS_GIT_WASI=1 git -c credential.helper='!sleep 60' credential fill`);
    assert.equal(nimbus.status, native.status, `status (native ${native.status}): ${JSON.stringify(nimbus.text.slice(-400))}`);
    assert.ok(nimbus.backMs !== null && nimbus.backMs <= PROMPT_BACK_MS, `prompt back ${nimbus.backMs} ms after Ctrl-C`);
    assert.deepEqual(nimbus.live.filter((command) => /git|sleep/.test(command)), [], 'git and its helper ended');
  });

  await check('git commit ignores SIGINT while its editor runs, and cleans up after the editor dies of it', async () => {
    const dir = nativeRepo();
    try {
      const native = await nativeInterrupt(['git', 'commit', '-a'], { cwd: dir, env: { ...ident, GIT_EDITOR: 'sleep 60' } });
      const nimbus = await interrupted('cd repo && GIT_EDITOR="sleep 60" NIMBUS_GIT_WASI=1 git commit -a', {
        setup: [
          'mkdir repo && cd repo && NIMBUS_GIT_WASI=1 git init -q -b main && echo one > f && NIMBUS_GIT_WASI=1 git add f'
            + ` && ${Object.entries(ident).map(([k, v]) => `${k}=${v}`).join(' ')} NIMBUS_GIT_WASI=1 git commit -q -m one && echo two > f`,
        ],
      });
      assert.equal(nimbus.status, native.status, `status (native ${native.status}): ${JSON.stringify(nimbus.text.slice(-600))}`);
      assert.ok(nimbus.backMs !== null && nimbus.backMs <= PROMPT_BACK_MS, `prompt back ${nimbus.backMs} ms after Ctrl-C`);
      assert.match(native.stderr, /problem with the editor/);
      assert.match(nimbus.text, /problem with the editor/, 'git reported the editor\'s failure');
      assert.equal(existsSync(join(dir, '.git', 'index.lock')), false, 'native git removed its index.lock');
      const lock = await nimbus.session.run('test -e repo/.git/index.lock && echo locked || echo clean', 30_000);
      assert.match(lock.stdout, /clean/, 'git removed its index.lock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('real bash reading the terminal dies of SIGINT', async () => {
    const native = await new Promise((resolve, reject) => {
      // Its stdin a pipe kept open: bash waits in read, as on a terminal.
      const child = spawn('bash', ['-c', 'read line; echo "read $line"'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      const timer = setTimeout(() => process.kill(-child.pid, 'SIGINT'), SETTLE_MS);
      child.on('error', reject);
      child.on('exit', (code, signal) => { clearTimeout(timer); child.stdin.destroy(); resolve({ status: signal === 'SIGINT' ? 130 : code, stdout }); });
    });
    const nimbus = await interrupted(`bash -c 'read line; echo "read $line"'`);
    assert.equal(nimbus.status, native.status, `status (native ${native.status}): ${JSON.stringify(nimbus.text.slice(-400))}`);
    assert.ok(nimbus.backMs !== null && nimbus.backMs <= PROMPT_BACK_MS, `prompt back ${nimbus.backMs} ms after Ctrl-C`);
    assert.doesNotMatch(nimbus.text, /read \S*\r?\n/, 'read did not complete');
  });
} finally {
  for (const session of terminals) await session.close().catch(() => {});
  if (probe) await probe.stop();
}
assert.deepEqual(failed, [], failed.join('\n'));
console.log('wasi-signals-workerd: Ctrl-C ends git and bash waiting, as natively');
