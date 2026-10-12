#!/usr/bin/env bun
/**
 * One install into a node_modules tree at a time (core _shared/npm-tree.ts
 * holdTree), in the order they asked:
 *   - a free tree is held at once, with no turn of the event loop;
 *   - a held one is held next by the first to wait for it, once released;
 *   - one whose signal stops it while it waits never holds it, and the
 *     next in line does; one already stopped is refused at once;
 *   - two namespaces, or two trees, never wait for each other;
 *   - two paths to one tree (a symlink to it) are one tree.
 */

import assert from 'node:assert/strict';
import { canonicalTreePath, holdTree } from '../../packages/core/src/_shared/npm-tree.ts';

const namespace = {};
const order = [];

const first = holdTree(namespace, '/p/node_modules');
assert.equal(typeof first, 'function', 'a free tree is held at once');

const second = holdTree(namespace, '/p/node_modules');
assert.ok(second instanceof Promise, 'a held one is waited for');
second.then(() => order.push('second'));

const stopped = new AbortController();
const third = holdTree(namespace, '/p/node_modules', stopped.signal);
const thirdOutcome = third.then(() => 'held', (error) => error);
const fourth = holdTree(namespace, '/p/node_modules');
fourth.then(() => order.push('fourth'));

const elsewhere = holdTree(namespace, '/q/node_modules');
assert.equal(typeof elsewhere, 'function', 'another tree is not waited for');
assert.equal(typeof holdTree({}, '/p/node_modules'), 'function', 'nor is the same path in another namespace');

stopped.abort(new DOMException('stopped', 'AbortError'));
const refused = await thirdOutcome;
assert.equal(refused?.name, 'AbortError', 'one stopped while it waits never holds the tree');

first();
const releaseSecond = await second;
assert.deepEqual(order, ['second'], 'the first to wait holds it next');
releaseSecond();
const releaseFourth = await fourth;
assert.deepEqual(order, ['second', 'fourth'], 'the stopped one is passed over');

const late = new AbortController();
late.abort(new DOMException('stopped', 'AbortError'));
await assert.rejects(holdTree(namespace, '/p/node_modules', late.signal), { name: 'AbortError' }, 'one already stopped is refused at once');

releaseFourth();
assert.equal(typeof holdTree(namespace, '/p/node_modules'), 'function', 'released by all, the tree is free again');

// /home/user/l is a link to /home/user/p, whose lib/node_modules does not exist yet.
const realpath = async (path) => {
  if (path === '/home/user/l' || path === '/home/user/p') return '/home/user/p';
  if (path === '/home/user' || path === '/home') return path;
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
};
assert.equal(await canonicalTreePath(realpath, '/home/user/l/lib/node_modules'), '/home/user/p/lib/node_modules');
assert.equal(await canonicalTreePath(realpath, '/home/user/p/lib/node_modules'), '/home/user/p/lib/node_modules', 'two paths to one tree are one');

console.log('npm-tree-hold: one install into a tree at a time, in order; a stopped waiter never holds it');
