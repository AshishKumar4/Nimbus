#!/usr/bin/env bun
// An operation the engine runs off the program's turn, its zlib's and its
// crypto's callback forms (deflate, pbkdf2: a threadpool in Node and Bun),
// keeps a one-shot program alive until its callback, as Node's active
// requests keep its event loop: the program's output from the callback is
// the program's output.
//
// Red before: the runtime counted only fetches, timers and its own calls as
// live work, so a program whose only work was a deflate or a pbkdf2 ended
// with exit 0 and no output once its synchronous part returned. A small one
// finished in time unless the machine was loaded (node-shims-warm-realm's
// empty stdout under a full run); these take a second or more, so the gate
// is deterministic.
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
const dir = mkdtempSync(join(tmpdir(), 'node-shims-native-async-held-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
authority.kfs.mkdir('home/user', { recursive: true });
authority.rawVfs.as(CRED_KERNEL).chown('home/user', 1000, 1000);
const sources = nodeFacetSources(generateShimsCode());

// The program's run bounded (not its build): a program held open forever is
// a failure, not a hang. With this process's own timer: the runners run here,
// and a timer made through the node shims' setTimeout is a program's live
// timer, which would hold the next program open until it fired.
const hostSetTimeout = realProcess.getBuiltinModule('node:timers').setTimeout;
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => hostSetTimeout(() => resolve(null), ms).unref())]);

async function run(code, name) {
  const generated = await generateEntrypointCode(code, { bundle: {} }, false, sources);
  const runner = await import(writeModuleSet(join(dir, name), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
  const process = processInstanceSupervisor(authority, cred);
  try {
    const response = await within(runner.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({ vfsRoot: process.root(),
        argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
        stdin: '', captureOutput: true, cred, pid: process.pid,
      }),
    }), { SUPERVISOR: process.supervisor }), 120_000);
    return response === null ? { exitCode: 'still running after 120000 ms', stdout: '', stderr: '' } : await response.json();
  } finally {
    await process.close();
  }
}

const failed = [];
const check = async (name, code, want) => {
  const body = await run(code, name);
  if (body.exitCode !== 0 || body.stdout !== want) failed.push(`${name}: exit ${body.exitCode}, stdout ${JSON.stringify(body.stdout)}, want ${JSON.stringify(want)}; stderr ${JSON.stringify(body.stderr).slice(0, 300)}`);
};

await check('deflate', `
const zlib = require('zlib');
const big = require('crypto').randomBytes(48 * 1024 * 1024);
zlib.deflate(big, { level: 9 }, (error, out) => console.log('deflate', error ?? null, out.length > 0));
`, 'deflate null true\n');
await check('pbkdf2', `
require('crypto').pbkdf2('pw', 'salt', 600000, 32, 'sha512', (error, key) => console.log('pbkdf2', error ?? null, key.length));
`, 'pbkdf2 null 32\n');
// One callback's work starting the next: the second is the program's too.
await check('chained', `
const crypto = require('crypto');
crypto.pbkdf2('pw', 'salt', 300000, 16, 'sha512', () => {
  crypto.scrypt('pw', 'salt', 32, { N: 2 ** 14 }, (error, key) => console.log('scrypt', error ?? null, key.length));
});
`, 'scrypt null 32\n');
// A function that ignores a function argument holds nothing: the program ends.
await check('ignored', `
const crypto = require('crypto');
console.log('ignored', crypto.getHashes(() => {}).includes('sha256'), crypto.getCiphers(() => {}).length > 0);
`, 'ignored true true\n');
// The API's own callback holds the program, wherever it is, and an argument
// after it that the API ignores holds nothing: a function there (held, it
// would never settle) or a value there (not held, the program would end
// first).
await check('trailing', `
const crypto = require('crypto');
require('zlib').deflate(Buffer.alloc(8), (error, out) => {
  console.log('deflate', error ?? null, out.length > 0);
  crypto.pbkdf2('pw', 'salt', 600000, 32, 'sha512', (error, key) => {
    console.log('function after', error ?? null, key.length);
    crypto.pbkdf2('pw', 'salt', 600000, 16, 'sha512', (error, key) => console.log('value after', error ?? null, key.length), 1);
  }, () => {});
}, () => {});
`, 'deflate null true\nfunction after null 32\nvalue after null 16\n');
// A call that throws before it starts holds nothing: the program still ends.
await check('refused', `
try { require('zlib').deflate(1, () => {}); } catch (error) { console.log('refused', error.code); }
`, 'refused ERR_INVALID_ARG_TYPE\n');

assert.deepEqual(failed, []);
console.log('node-shims-native-async-held: ok');
realProcess.exit(0);
