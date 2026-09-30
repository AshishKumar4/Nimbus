#!/usr/bin/env bun
// A resident process ends as Node's does: when it holds no live handle.
//
// A program judged to start a server runs resident, where a port is routed.
// Its end used to be only process.exit: a resident that simply finished (a
// CLI whose serve path was not taken, `--help`, a server that closed) kept
// running and never reported an exit. It now ends when the handles Node
// counts are gone (timers, operations in flight, listening servers not
// unref'd, a held stdin), with the one-shot's accounting, and reports its exit
// as process.exit does. One that finishes during its boot reports before the
// boot answers, so the shell prints its exit instead of "started".
// `--watch` still holds a process with nothing left.
//
// This is the acceptance for the server-launch prediction: a program wrongly
// predicted resident still ends exactly as in Node (only a server predicted
// one-shot is a bug).
//
// The real generated resident body, one launch per child process.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createAuthority, facetSupervisor, launchResident, runScenarios, sleep, until } from './lib/resident-body.mjs';

/** Launch `program` resident, with `files` (VFS key → text) in the session and its bundle. */
async function launch(program, { files = {}, ...options } = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  for (const [path, text] of Object.entries(files)) {
    authority.kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    authority.kfs.writeFile(path, text);
  }
  const { supervisor, log } = facetSupervisor(authority);
  const { proc } = await launchResident({
    authority, program, env: { SUPERVISOR: supervisor }, cursor: authority.cursor(), bundle: files, ...options,
  });
  return { log, proc };
}

/** Commander 11.1.0 itself, installed at home/user/app/node_modules/commander. */
function commanderFiles() {
  const root = new URL('../../node_modules/.bun/commander@11.1.0/node_modules/commander/', import.meta.url).pathname;
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(js|json)$/.test(name)) files[`home/user/app/node_modules/commander/${rel}`] = readFileSync(join(root, rel), 'utf8');
    }
  };
  walk('');
  return files;
}

const SERVER = 'const server = require("http").createServer((req, res) => res.end("hi"));';

await runScenarios(import.meta.filename, {
  async finishedProgramExits() {
    const { log } = await launch('console.log("done");');
    assert.deepEqual(log.exit, { code: 0, reason: '' }, 'reported before its boot answered');
    assert.equal(log.stdout, 'done\n');
  },

  async serverThatClosesItsLastListenerExits() {
    const { log } = await launch(`${SERVER}\nserver.listen(3000, () => setTimeout(() => server.close(), 1500));`);
    assert.equal(log.exit, null, 'still serving when its boot answered');
    assert.deepEqual([...log.ports], [3000]);
    await until(() => log.exit !== null, 'the exit after close', 5_000);
    assert.deepEqual(log.exit, { code: 0, reason: '' });
    assert.deepEqual([...log.ports], [], 'the port is released');
  },

  async unrefdListenerAloneExits() {
    const { log } = await launch(`${SERVER}\nserver.listen(3000).unref();`);
    assert.deepEqual(log.exit, { code: 0, reason: '' });
  },

  async idleServerStaysUp() {
    const { log, proc } = await launch(`${SERVER}\nserver.listen(3000);`);
    const response = await proc.fetch(new Request('http://facet/', { headers: { 'X-Nimbus-Port': '3000' } }));
    assert.equal(response.status, 200);
    await sleep(300);
    assert.equal(log.exit, null, 'a live listener holds it, across a request');
    assert.deepEqual([...log.ports], [3000]);
  },

  async pendingTimerExitsAfterItFires() {
    const { log } = await launch('setTimeout(() => console.log("fired"), 1500);');
    assert.equal(log.exit, null, 'the timer is pending when its boot answered');
    await until(() => log.exit !== null, 'the exit after the timer', 5_000);
    assert.equal(log.stdout, 'fired\n');
    assert.deepEqual(log.exit, { code: 0, reason: '' });
  },

  async processExitStillDecides() {
    const { log } = await launch('setInterval(() => {}, 100);\nsetTimeout(() => process.exit(3), 1200);');
    await until(() => log.exit !== null, 'the explicit exit', 5_000);
    assert.equal(log.exit.code, 3);
  },

  // Predicted resident though it serves nothing: it loads a module exporting a
  // Commander program with a serving action, and parses another's, whose
  // action only prints. Commander runs only the parsed program's action.
  async wrongResidentPredictionEndsAsInNode() {
    const program = (action) => [
      "const { Command } = require('commander');",
      'const program = new Command();',
      `program.action(${action});`,
      'module.exports = program;',
    ].join('\n');
    const { log } = await launch("require('./unused.js');\nrequire('./used.js').parse(process.argv);", {
      files: {
        ...commanderFiles(),
        'home/user/app/unused.js': program("() => require('http').createServer().listen(3000)"),
        'home/user/app/used.js': program("() => console.log('built')"),
      },
    });
    assert.equal(log.stdout, 'built\n');
    assert.deepEqual(log.exit, { code: 0, reason: '' });
    assert.deepEqual([...log.ports], []);
  },

  async watchHoldsAFinishedProgram() {
    const { log } = await launch('console.log("done");', { argv: ['--watch', '/home/user/app/main.js'] });
    await sleep(300);
    assert.equal(log.exit, null, '--watch waits for a change');
  },
});
console.log('resident-natural-exit: ok');
