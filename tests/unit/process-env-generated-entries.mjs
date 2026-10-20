#!/usr/bin/env bun
// A process's environment never enters the module that runs it (ask 62):
// generated modules are content-addressed into images every process on the
// box can read. Through each complete generated entry, the program reads the
// env its start or its run hands over, and no module text holds it:
//
//   - a resident node, started with its env;
//   - an opencode one-shot, run with its env;
//   - an opencode serve, started with its env.
//
// Red before: the node resident and the opencode runner wrote the env into
// their module as a literal, and read it from there.
//
// Each program runs in a child process of its own (runScenarios): a runner
// replaces the realm's process, console and timers.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runScenarios } from './lib/resident-body.mjs';

const SECRET = 'ask62-sentinel-5e1d';

/** Every file below `dir`, as text: the module set a runner was imported from. */
const filesBelow = (dir) => readdirSync(dir, { recursive: true })
  .map((name) => join(dir, String(name)))
  .filter((path) => statSync(path).isFile())
  .map((path) => readFileSync(path, 'latin1'));

// An opencode bundle's program: it writes what it was given to a file, as
// opencode's own import of node:fs reaches the session.
const writesEnv = `
const fs = globalThis.__nimbusOpencodeBuiltins.fs;
export async function nimbusMain() {
  fs.writeFileSync("/home/user/env.txt", String(process.env.SECRET));
}
`;
// A server: its main resolves once it serves, and it writes and exits later.
const servesEnv = `
const fs = globalThis.__nimbusOpencodeBuiltins.fs;
export async function nimbusMain() {
  setTimeout(() => {
    fs.writeFileSync("/home/user/env.txt", String(process.env.SECRET));
    process.exit(0);
  }, 0);
}
`;

/** An opencode runner of `mode` over a fresh session, its program `program`. */
async function opencodeRunner(mode, program) {
  const { CRED, createAuthority } = await import('./lib/resident-body.mjs');
  const { opSender, supervisorDouble } = await import('./lib/supervisor-double.mjs');
  const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
  const authority = createAuthority();
  const { pid } = authority.host.processes.spawn('opencode', ['opencode'], '/home/user', { cred: CRED, longRunning: mode !== 'oneshot' });
  const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
  const exited = Promise.withResolvers();
  const supervisor = supervisorDouble((name, args) => {
    if (name === 'stdout' || name === 'stderr') return undefined;
    if (name === 'reportExit') { exited.resolve(args[0]); return undefined; }
    return send(name, args);
  });
  const { runner, dir } = await importOpencodeRunner({ mode, program, vfsCursor: JSON.stringify(authority.cursor()) });
  return { authority, supervisor, runner, dir, exited: exited.promise };
}

await runScenarios(import.meta.path, {
  async 'node resident: the env comes with its start'() {
    const { createAuthority, facetSupervisor, launchResident, until } = await import('./lib/resident-body.mjs');
    const authority = createAuthority();
    const { supervisor, log } = facetSupervisor(authority);
    const { generated } = await launchResident({
      program: 'process.stdout.write(String(process.env.SECRET));',
      env: { SUPERVISOR: supervisor },
      processEnv: { SECRET },
      authority,
    });
    await until(() => log.stdout === SECRET, 'the program to print its env', 10_000);
    assert.equal(JSON.stringify(generated).includes(SECRET), false, 'no module of the resident holds its env');
  },
  async 'opencode one-shot: the env comes with its run'() {
    const { authority, supervisor, runner, dir } = await opencodeRunner('oneshot', writesEnv);
    const response = await runner.default.fetch(
      new Request('http://facet/run', { method: 'POST', body: JSON.stringify({ env: { SECRET } }) }),
      { SUPERVISOR: supervisor },
    );
    const result = await response.json();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(authority.read('home/user/env.txt'), SECRET, 'the program read the env its run handed over');
    assert.equal(filesBelow(dir).some((text) => text.includes(SECRET)), false, 'no module of the runner holds it');
  },
  async 'opencode serve: the env comes with its start'() {
    const { facetSql } = await import('./lib/resident-body.mjs');
    const { authority, supervisor, runner, dir, exited } = await opencodeRunner('server', servesEnv);
    const serve = new runner.NimbusProcess({ storage: { sql: facetSql() }, waitUntil() {}, id: { toString: () => 'process-env' } }, { SUPERVISOR: supervisor });
    await serve.startProcess({ env: { SECRET } });
    assert.equal(await exited, 0);
    assert.equal(authority.read('home/user/env.txt'), SECRET, 'the program read the env its start handed over');
    assert.equal(filesBelow(dir).some((text) => text.includes(SECRET)), false, 'no module of the runner holds it');
  },
});
console.log('process-env-generated-entries: each generated entry reads its env from its start or run, and no module holds it');
