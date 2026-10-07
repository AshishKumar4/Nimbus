#!/usr/bin/env bun
// A one-shot process releases no output ahead of a change it logged before
// it (ProcessFsClient.effect; the one-shot runner's output queue).
//
// A one-shot node process (no store of its own: a Dynamic Worker) is told a
// synchronous write succeeded once it is logged in its client, before the
// session answers it. If it then dies (out of memory, CPU), what it logged and
// the session never answered is lost: at most the client's decided backlog.
// What must never happen is an output of the program's after those writes
// reaching anyone while they can still be lost: an `echo` after the writes
// would claim they happened. So each output leaves only once every change
// logged ahead of it is answered. Red before: the output went at once.
//
// Runs the real generated one-shot facet module against a session whose
// write waves are held until the test lets them through.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { withNamespace } from './lib/listing-supervisor.mjs';
import { createAuthority } from './lib/resident-body.mjs';

const realProcess = globalThis.process;
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), 'one-shot-gate-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const sources = nodeFacetSources(generateShimsCode());

const program = `
const fs = require('fs');
fs.mkdirSync('/home/user/out', { recursive: true });
for (let i = 0; i < 40; i++) fs.writeFileSync('/home/user/out/f' + i, 'v' + i);
console.log('ECHO');
`;

const generated = await generateEntrypointCode(program, { bundle: {} }, false, sources);
const file = writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs');
const mod = await import(file);
const authority = createAuthority();
const files = () => {
  try { return authority.kfs.readdir('home/user/out').length; } catch { return 0; }
};
const events = [];
const { supervisor } = withNamespace({
  stdout: async (bytes) => { events.push(['stdout', new TextDecoder().decode(bytes), files()]); },
  stderr: async (bytes) => { events.push(['stderr', new TextDecoder().decode(bytes), files()]); },
  reportExit: async (code) => { events.push(['exit', code, files()]); },
}, authority);
// The session's answers to the write waves are held until `open`.
let open;
const opened = new Promise((resolve) => { open = resolve; });
const held = new Proxy(supervisor, {
  get(target, name) {
    if (name === 'writeBatchStream') return async (...args) => { await opened; return target.writeBatchStream(...args); };
    return Reflect.get(target, name);
  },
});
const request = new Request('http://facet/', {
  method: 'POST',
  body: JSON.stringify({
    argv: [], env: {}, cwd: '/home/user', filename: '/home/user/p.js', dirname: '/home/user',
    stdin: '', captureOutput: false, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  }),
});
const run = mod.default.fetch(request, { SUPERVISOR: held }).then((response) => response.json());

// The program has written and printed; its writes are not answered. Were it
// to die now, they would be lost: its ECHO must not be out.
await sleep(300);
assert.equal(files() < 40, true, 'the writes were answered while the session held them');
assert.deepEqual(events.filter(([kind]) => kind === 'stdout'), [], `an output left ahead of the writes before it: ${JSON.stringify(events)}`);

open();
const body = await run;
await sleep(50);
assert.equal(body.exitCode, 0, JSON.stringify(body));
const echo = events.find(([kind, text]) => kind === 'stdout' && text === 'ECHO\n');
assert.ok(echo, `the output never left: ${JSON.stringify(events)}`);
assert.equal(echo[2], 40, `the output left with ${echo[2]} of the 40 writes before it in the session`);

realProcess.stdout.write('one-shot-output-gate: ok\n');
realProcess.exit(0);
