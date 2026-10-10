#!/usr/bin/env bun
// git-upload-pack-auth — the one smart-HTTP client's credentials, for clone,
// fetch and pull alike: a URL's own (https://user:password@host/repo.git)
// are taken out of it and sent as Basic credentials, as git does, else the
// options' are; either way UTF-8, then base64. Red before: the URL went to
// fetch with its credentials in it, and btoa threw on a character past
// Latin-1 (and sent Latin-1 bytes for one within it).
import assert from 'node:assert/strict';
import { discover } from '../../packages/worker/src/git/pack/upload-pack.ts';

const encoder = new TextEncoder();
const pkt = (text) => encoder.encode((text.length + 4).toString(16).padStart(4, '0') + text);
const advertisement = () => {
  const parts = [pkt('# service=git-upload-pack\n'), encoder.encode('0000'), pkt('1'.repeat(40) + ' refs/heads/main\0side-band-64k\n'), encoder.encode('0000')];
  return new Response(new Blob(parts), { status: 200 });
};
const basic = (user, password) => 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');

async function sent(options) {
  const requests = [];
  await discover({ ...options, fetch: async (url, init) => { requests.push({ url, authorization: init.headers.authorization }); return advertisement(); } });
  return requests;
}

assert.deepEqual(await sent({ url: 'https://us%C3%A9r:p%40ss@example.com/repo.git/' }),
  [{ url: 'https://example.com/repo.git/info/refs?service=git-upload-pack', authorization: basic('usér', 'p@ss') }]);
assert.deepEqual(await sent({ url: 'https://token@example.com/repo.git', auth: { username: 'other', password: 'x' } }),
  [{ url: 'https://example.com/repo.git/info/refs?service=git-upload-pack', authorization: basic('token', '') }], 'the URL\'s own win');
assert.deepEqual(await sent({ url: 'https://example.com/repo.git', auth: { username: 'José', password: 'пароль-✓' } }),
  [{ url: 'https://example.com/repo.git/info/refs?service=git-upload-pack', authorization: basic('José', 'пароль-✓') }]);
assert.deepEqual(await sent({ url: 'https://example.com/repo.git', auth: { username: '', password: '' } }),
  [{ url: 'https://example.com/repo.git/info/refs?service=git-upload-pack', authorization: undefined }]);
console.log('git-upload-pack-auth: ok');
