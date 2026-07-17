#!/usr/bin/env bun

import assert from 'node:assert/strict';

import {
  expandPythonEffectiveMode,
  installPythonFsSnapshot,
} from '../../packages/worker/src/runtime/python-runner.ts';

class FakeEmscriptenFs {
  ignorePermissions = true;
  nodes = new Map([['/', { type: 'directory', mode: 0o777, bytes: new Uint8Array() }]]);

  analyzePath(path) {
    return { exists: this.nodes.has(path) };
  }

  unlink(path) {
    this.nodes.delete(path);
  }

  mkdirTree(path) {
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current += `/${part}`;
      if (!this.nodes.has(current)) {
        this.nodes.set(current, { type: 'directory', mode: 0o777, bytes: new Uint8Array() });
      }
    }
  }

  writeFile(path, bytes) {
    this.nodes.set(path, { type: 'file', mode: 0o666, bytes: Uint8Array.from(bytes) });
  }

  chmod(path, mode) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    node.mode = mode;
  }

  open(path, operation) {
    const node = this.nodes.get(path);
    if (!node) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    const mask = operation === 'read' ? 0o444 : 0o222;
    if (!this.ignorePermissions && (node.mode & mask) === 0) {
      throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
    }
    return node;
  }
}

assert.deepEqual(
  Array.from({ length: 8 }, (_, effective) => expandPythonEffectiveMode(effective)),
  [0o000, 0o111, 0o222, 0o333, 0o444, 0o555, 0o666, 0o777],
  'effective credential bits are replicated across Emscripten owner/group/other classes',
);

const fs = new FakeEmscriptenFs();
fs.mkdirTree('/workspace');
fs.writeFile('/workspace/stale.txt', new TextEncoder().encode('stale'));
const mounted = installPythonFsSnapshot(fs, {
  root: 'workspace',
  preopens: [],
  dirs: ['workspace', 'workspace/private'],
  files: {
    'workspace/read-only.txt': Buffer.from('visible').toString('base64'),
  },
  modes: {
    workspace: 0o7,
    'workspace/private': 0o1,
    'workspace/denied.txt': 0o0,
    'workspace/read-only.txt': 0o4,
  },
}, new Set(['workspace/stale.txt']));

assert.deepEqual([...mounted].sort(), ['workspace/denied.txt', 'workspace/read-only.txt']);
assert.equal(fs.nodes.has('/workspace/stale.txt'), false, 'stale mounted files are removed');
assert.deepEqual(fs.nodes.get('/workspace/denied.txt'), {
  type: 'file',
  mode: 0o000,
  bytes: new Uint8Array(),
}, 'a modes-only unreadable path remains an existing empty denial cell');
assert.equal(new TextDecoder().decode(fs.nodes.get('/workspace/read-only.txt').bytes), 'visible');
assert.equal(fs.nodes.get('/workspace/read-only.txt').mode, 0o444);
assert.equal(fs.nodes.get('/workspace/private').mode, 0o111);

fs.ignorePermissions = false;
assert.throws(() => fs.open('/workspace/denied.txt', 'read'), (error) => error.code === 'EACCES');
assert.throws(() => fs.open('/workspace/read-only.txt', 'write'), (error) => error.code === 'EACCES');
assert.equal(new TextDecoder().decode(fs.open('/workspace/read-only.txt', 'read').bytes), 'visible');

console.log('python snapshot permissions: ok');
