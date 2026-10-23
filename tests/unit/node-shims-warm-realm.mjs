#!/usr/bin/env bun
// A warm isolate runs the runtime's setup again for each program it hosts:
// what that setup puts in front of the realm's shared builtins (Node's
// errors and argument checks for buffer, events, crypto and zlib, the URL
// constructor) is put there once, however many programs the realm has run.
// So a call into them costs, and shows in a stack, what it did for the first
// program. Red before: each run fronted them again, over the last run's
// fronts, and every call went through one more layer per program the realm
// had run; the URL constructor, fronting the last run's, let \`new URL\` take
// a string that is no URL.
//
// And the runtime's own use of a builtin (its write log's checksums) is the
// realm's, not the last program's: a program that replaced zlib.crc32 left
// the next program in the isolate unable to write a file the session took.
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
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const realProcess = globalThis.process;
const dir = mkdtempSync(join(tmpdir(), 'node-shims-warm-realm-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
authority.kfs.mkdir('home/user', { recursive: true });
authority.rawVfs.as(CRED_KERNEL).chown('home/user', 1000, 1000);

// How a refused call into each fronted builtin ends (its error) and how many
// of the runtime's frames it passes through, and as many for a callback one
// calls. The runtime's frames are the runner's own; the program's are its
// module's (a file: URL).
const program = `
Error.stackTraceLimit = 1000;
const fronts = (stack) => String(stack).split('\\n').filter((line) => line.includes('runner.mjs:') && !line.includes('file:')).length;
const depth = (call) => { try { call(); return 'returned'; } catch (error) { return [String(error.message), fronts(error.stack)]; } };
const called = (start) => new Promise((resolve) => start(() => resolve(fronts(new Error().stack))));
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
const sources = nodeFacetSources(generateShimsCode());
const load = async (code, name) => {
  const generated = await generateEntrypointCode(code, { bundle: {} }, false, sources);
  return import(writeModuleSet(join(dir, name), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
};
const mod = await load(program, 'entry');
async function run(runner = mod) {
  const process = processInstanceSupervisor(authority, cred);
  try {
    const response = await runner.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({ vfsRoot: process.root(),
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
for (const [name, outcome] of Object.entries(first)) assert.notEqual(outcome, 'returned', `${name} is refused`);
let last;
for (let i = 0; i < 6; i++) last = await run();
assert.deepEqual(last, first, 'the seventh program\'s calls are as deep as the first\'s');

const patcher = await load(`require('zlib').crc32 = () => 0; console.log('{}');`, 'patcher');
const writer = await load(`require('fs').writeFileSync('/home/user/after.bin', Buffer.alloc(4096, 5)); console.log('{}');`, 'writer');
await run(patcher);
await run(writer);
assert.deepEqual(Array.from(authority.kfs.readFile('home/user/after.bin').subarray(0, 4)), [5, 5, 5, 5], 'a program after one that replaced zlib.crc32 writes');
console.log('node-shims-warm-realm: ok');
realProcess.exit(0);
