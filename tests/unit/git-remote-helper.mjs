#!/usr/bin/env bun
/**
 * git-remote-helper — the helper's side of gitremote-helpers(7) that a
 * differential run against git's own transport does not reach
 * (git-remote-helper-differential.mjs covers clone, fetch, pull and push):
 * what the engine is asked for a shallow, filtered or tag-following fetch,
 * connectivity-ok, :object-format, C-quoted option values, the answers to
 * options it does and does not take, GIT_DIR relative to the helper's
 * directory, and an engine failure (fatal, 128).
 */

import assert from 'node:assert/strict';
import { runRemoteHelper, unquoteC } from '../../packages/worker/src/git/remote-helper.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** Run the helper on `input` (git's lines): its exit, what it wrote, and what the engine was asked. */
async function converse(input, { env = { GIT_DIR: '.git' }, engine: override = {} } = {}) {
  const lines = input.split('\n');
  const asked = [];
  let out = '';
  let err = '';
  const engine = {
    async listRefs(request) {
      asked.push(['listRefs', request]);
      return { refs: [{ name: 'HEAD', oid: null, symref: 'refs/heads/main' }, { name: 'refs/heads/main', oid: A }], objectFormat: 'sha1' };
    },
    async fetchPack(request) {
      asked.push(['fetchPack', request]);
      return { packName: 'pack-x', objects: 3, bytes: 100, shallow: false, promisor: false, selfContained: true };
    },
    async pushPack(request) {
      asked.push(['pushPack', request]);
      return { refs: request.commands.map((c) => ({ ref: c.ref, ok: true })) };
    },
    ...override,
  };
  const code = await runRemoteHelper({
    args: ['origin', 'https://example.com/r.git'],
    env: { GIT_TOKEN: 't0k', ...env },
    cwd: '/home/user/repo',
    readLine: async () => (lines.length > 0 ? lines.shift() : null),
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    readFile: async () => null,
  }, engine, { has: async () => new Set(), packObjects: () => null });
  return { code, out, err, asked };
}

assert.equal(unquoteC('plain'), 'plain');
assert.equal(unquoteC('"a\\tb\\"c\\\\\\303\\251"'), 'a\tb"c\\é', 'C escapes, octal bytes as UTF-8');
assert.equal(unquoteC('"open'), null);

{
  const r = await converse('capabilities\n');
  assert.equal(r.code, 0);
  assert.equal(r.out, 'fetch\npush\noption\ncheck-connectivity\nobject-format\n\n');
}

{
  const r = await converse([
    'option verbosity 0', 'option depth 1', 'option deepen-since 1700000000', 'option deepen-not "refs/heads/old one"',
    'option deepen-not v1', 'option deepen-relative true', 'option followtags true', 'option filter blob:none',
    'option check-connectivity true', 'option update-shallow true', 'option family ipv4', 'option depth -1',
    'option progress maybe', 'option pushcert true', 'option object-format true',
    'list', 'fetch ' + A + ' refs/heads/main', 'fetch ' + B + ' refs/tags/v1', '', '',
  ].join('\n'));
  assert.equal(r.code, 0);
  assert.equal(r.out, [
    'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'unsupported', 'error invalid value', 'error invalid value', 'unsupported', 'ok',
    ':object-format sha1', '@refs/heads/main HEAD', `${A} refs/heads/main`, '',
    'connectivity-ok', '', '',
  ].join('\n'), 'each option answered; the list; the fetch batch answered once');
  assert.deepEqual(r.asked[0], ['listRefs', { url: 'https://example.com/r.git', auth: { username: '', password: 't0k' }, forPush: false }]);
  assert.deepEqual(r.asked[1], ['fetchPack', {
    url: 'https://example.com/r.git', auth: { username: '', password: 't0k' }, gitDir: '/home/user/repo/.git',
    wants: [A, B], depth: 1, deepenSince: 1700000000, deepenNot: ['refs/heads/old one', 'v1'], deepenRelative: true,
    filter: 'blob:none', includeTag: true, updateShallow: true,
  }]);
}

{
  const r = await converse(`fetch ${A} refs/heads/main\n\n`, { env: { GIT_DIR: '/srv/r.git' } });
  assert.equal(r.out, '\n', 'connectivity-ok only when asked for');
  assert.equal(r.asked[0][1].gitDir, '/srv/r.git');
  assert.equal(r.asked[0][1].includeTag, false);
}

{
  const r = await converse(`list\nfetch ${A} refs/heads/main\n\n`, {
    engine: { async fetchPack() { throw new Error('HTTP 403'); } },
  });
  assert.equal(r.code, 128);
  assert.match(r.err, /^fatal: could not fetch from https:\/\/example\.com\/r\.git: HTTP 403\n$/);
}

{
  const r = await converse('connect git-upload-pack\n');
  assert.equal(r.code, 128, 'a command it does not have ends it');
  assert.match(r.err, /unknown command 'connect git-upload-pack'/);
}

{
  const r = await converse(`fetch ${A} refs/heads/main\n\n`, { env: {} });
  assert.equal(r.code, 128, 'a fetch needs the repository git names');
}

console.log('git-remote-helper: ok');
