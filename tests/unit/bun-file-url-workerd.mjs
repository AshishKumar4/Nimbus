// @serial
// @tier slow — drives a local workerd
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const PROGRAM = String.raw`
const url = require('node:url');
const fs = require('node:fs');
const base = process.cwd();
const baseURL = url.pathToFileURL(base).href;
const api = globalThis.Bun || url;
const clean = (value) => value.replaceAll(baseURL, 'file:///case').replaceAll(base, '/case');
const result = (fn, input) => {
  try {
    const value = fn(input);
    return { value: clean(typeof value === 'string' ? value : value.href) };
  } catch (error) { return { error: error.code || error.name }; }
};
const rows = [];
for (const phase of ['initial', 'moved']) {
  if (phase === 'moved') { fs.mkdirSync('moved'); process.chdir('moved'); }
  for (const input of ['a b.txt', 'hash#name', 'percent%name', './sub/../relative #%.txt', phase === 'initial' ? './parent %/' : '../parent %/', '', process.cwd() + '/a b#c%', '/tmp/a b#c%']) {
    rows.push([phase, 'encode', clean(input), result(api.pathToFileURL, input), result(url.pathToFileURL, input)]);
  }
  for (const input of ['file:///tmp/a%20b', 'file:///tmp/%23name%25', 'file:///tmp/%C3%A9t%C3%A9', 'file://localhost/etc/x', 'file:///tmp/a%2Fb', 'file://host/x', 'https://example.com/x', new URL(baseURL + '/a%20b%23%25')]) {
    rows.push([phase, 'decode', clean(typeof input === 'string' ? input : input.href), result(api.fileURLToPath, input), result(url.fileURLToPath, input)]);
  }
}
console.log('URLS ' + JSON.stringify(rows));
`;

const hostDir = mkdtempSync(join(tmpdir(), 'bun-file-url-'));
let reference;
try {
  const host = spawnSync('node', ['-e', PROGRAM], { cwd: hostDir, encoding: 'utf8', timeout: 20_000 });
  assert.equal(host.status, 0, host.stderr);
  reference = JSON.parse(host.stdout.trim().slice('URLS '.length));
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}

const probe = await startLocalProbe({ runtimes: [] });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const cwd = '/home/user/url-case';
    const setup = await terminal.run(`mkdir -p ${cwd}`);
    assert.equal(setup.status, 0, setup.stdout);
    await terminal.writeFile(`${cwd}/urls.cjs`, PROGRAM);
    const guest = await terminal.run(`cd ${cwd} && bun urls.cjs`);
    assert.equal(guest.status, 0, guest.stdout);
    const line = guest.stdout.split('\n').find((value) => value.startsWith('URLS '));
    assert.ok(line, guest.stdout);
    const rows = JSON.parse(line.slice('URLS '.length));
    for (const [phase, operation, input, actual, expected] of rows) {
      assert.deepEqual(actual, expected, `${phase}: Bun ${operation} ${JSON.stringify(input)} agrees with the guest's node:url`);
    }
    assert.deepEqual(rows, reference, 'the same URL program agrees with real Node before and after chdir');
  } finally { await terminal.close(); }
} finally { await probe.stop(); }
console.log('bun-file-url-workerd: Bun and Node preserve filenames and the process cwd');
