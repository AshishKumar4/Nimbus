#!/usr/bin/env bun
// A warm isolate runs the runtime's setup again for each program it hosts:
// what that setup puts in front of the realm's shared builtins (Node's
// errors and argument checks for buffer, events, crypto and zlib, the URL
// constructor) is put there once, however many programs the realm has run.
// So a call into them costs, and shows in a stack, what it did for the first
// program. Red before: each run fronted them again, over the last run's
// fronts, and every call went through one more layer per program the realm
// had run.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';

const realProcess = globalThis.process;
const dir = mkdtempSync(join(tmpdir(), 'node-shims-warm-realm-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
authority.kfs.mkdir('home/user', { recursive: true });

// How deep a refused call into each fronted builtin is (the frames of the
// error it throws), and a callback one calls (the frames it is called in).
const program = `
Error.stackTraceLimit = 1000;
const depth = (call) => { try { call(); return 'returned'; } catch (error) { return String(error.stack).split('\\n').length; } };
const called = (start) => new Promise((resolve) => start(() => resolve(String(new Error().stack).split('\\n').length)));
const buffer = require('buffer');
const crypto = require('crypto');
const zlib = require('zlib');
const events = require('events');
(async () => console.log(JSON.stringify({
  zlibCallback: await called((cb) => zlib.deflate(Buffer.from('a'), cb)),
  cryptoCallback: await called((cb) => crypto.randomBytes(1, cb)),
  bufferAlloc: depth(() => Buffer.alloc(-1)),
  bufferTranscode: depth(() => buffer.transcode(1, 'utf8', 'latin1')),
  hashUpdate: depth(() => crypto.createHash('sha256').update(1)),
  zlibCrc32: depth(() => zlib.crc32(1)),
  eventsMaxListeners: depth(() => events.setMaxListeners(-1)),
  url: depth(() => new URL('not a url')),
})))();
`;
const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
async function run() {
  const process = processInstanceSupervisor(authority, cred);
  try {
    const response = await mod.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({
        argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
        stdin: '', captureOutput: true, cred, pid: process.pid,
      }),
    }), { SUPERVISOR: process.supervisor });
    const body = await response.json();
    assert.equal(body.exitCode, 0, JSON.stringify(body));
    return JSON.parse(body.stdout);
  } finally {
    await process.close();
  }
}
const first = await run();
for (const [name, depth] of Object.entries(first)) assert.equal(typeof depth, 'number', `${name} is refused`);
let last;
for (let i = 0; i < 6; i++) last = await run();
assert.deepEqual(last, first, 'the seventh program\'s calls are as deep as the first\'s');
console.log('node-shims-warm-realm: ok');
realProcess.exit(0);
