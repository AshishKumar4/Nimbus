#!/usr/bin/env bun
// The supervisor's walk reads a file's require wrappers once per revision of
// it: requireFsOverBridge keeps what a revision answers, so a launch that
// walks what the last one walked reads, tokenizes and parses nothing again,
// and a write (a new revision) is read anew.

import assert from 'node:assert/strict';
import { requireFsOverBridge } from '../../packages/core/src/runtime/require-resolver.ts';

const wrapper = (specifier) => `function load(id) { return require(id); }\nexport const d = load('${specifier}');`;
const revisions = new Map([['app/a.js', 1], ['app/b.js', 1]]);
const bridge = {
  revision: async (path) => {
    if (!revisions.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return revisions.get(path);
  },
  stat: async () => null,
  readFile: async () => null,
  access: async () => {},
};
const fs = requireFsOverBridge(bridge);

const first = await fs.wrapperCalls('app/a.js', wrapper('first'));
assert.deepEqual(first, ['first']);
// The same revision answers what it answered, whatever text is handed with it.
assert.equal(await fs.wrapperCalls('app/a.js', wrapper('unread')), first, 'one revision is read once');
// Another filesystem over the same bridge (another launch) keeps it too.
assert.equal(await requireFsOverBridge(bridge).wrapperCalls('app/a.js', wrapper('unread')), first, 'across launches');
// A write is a new revision, read anew.
revisions.set('app/a.js', 2);
assert.deepEqual(await fs.wrapperCalls('app/a.js', wrapper('second')), ['second'], 'a new revision is read');
// Each path is its own.
assert.deepEqual(await fs.wrapperCalls('app/b.js', wrapper('other')), ['other']);
// A path the filesystem has no revision for is read, and kept by nothing.
assert.deepEqual(await fs.wrapperCalls('app/gone.js', wrapper('gone')), ['gone']);
assert.deepEqual(await fs.wrapperCalls('app/gone.js', wrapper('again')), ['again']);
// Another filesystem keeps its own.
const elsewhere = requireFsOverBridge({ ...bridge, revision: async () => 2 });
assert.deepEqual(await elsewhere.wrapperCalls('app/a.js', wrapper('elsewhere')), ['elsewhere'], 'per filesystem');

console.log('require-wrapper-memo: ok');
