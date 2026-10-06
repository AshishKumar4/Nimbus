#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { retryingGitHttp } from '../../packages/worker/src/git/pack/transport.ts';

const schedule = [1, 1];

async function readBody(body) {
  if (!body) return [];
  const bytes = [];
  for await (const chunk of body) bytes.push(...chunk);
  return bytes;
}

function queuedHttp(outcomes) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push({
        req,
        body: await readBody(req.body),
      });
      const outcome = outcomes[calls.length - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const control = queuedHttp([
  { statusCode: 522 },
  { statusCode: 200 },
]);
assert.equal(
  (await control.request({
    method: 'GET',
    url: 'https://github.com/example/project.git/info/refs?service=git-upload-pack',
  })).statusCode,
  522,
);
assert.equal(control.calls.length, 1, 'the unwrapped adapter unexpectedly retried');

const uploadPack = queuedHttp([
  { statusCode: 522 },
  { statusCode: 200 },
]);
async function* uploadPackBody() {
  yield Uint8Array.of(0, 1, 2);
  yield Uint8Array.of(253, 254, 255);
}
const uploadPackResult = await retryingGitHttp(uploadPack, schedule).request({
  method: 'POST',
  url: 'https://github.com/example/project.git/git-upload-pack',
  body: uploadPackBody(),
});
assert.equal(uploadPackResult.statusCode, 200);
assert.equal(uploadPack.calls.length, 2);
assert.deepEqual(uploadPack.calls[0].body, [0, 1, 2, 253, 254, 255]);
assert.deepEqual(uploadPack.calls[1].body, uploadPack.calls[0].body);

const discovery = queuedHttp([
  { statusCode: 522 },
  { statusCode: 200 },
]);
const discoveryResult = await retryingGitHttp(discovery, schedule).request({
  method: 'GET',
  url: 'https://github.com/example/project.git/info/refs?service=git-upload-pack',
});
assert.equal(discoveryResult.statusCode, 200);
assert.equal(discovery.calls.length, 2);

const notFoundResponse = { statusCode: 404 };
const notFound = queuedHttp([notFoundResponse]);
assert.equal(
  await retryingGitHttp(notFound, schedule).request({
    method: 'GET',
    url: 'https://github.com/example/missing.git/info/refs?service=git-upload-pack',
  }),
  notFoundResponse,
);
assert.equal(notFound.calls.length, 1);

const persistentResponses = [
  { statusCode: 522 },
  { statusCode: 522 },
  { statusCode: 522 },
];
const persistent = queuedHttp(persistentResponses);
assert.equal(
  await retryingGitHttp(persistent, schedule).request({
    method: 'GET',
    url: 'https://github.com/example/project.git/info/refs?service=git-upload-pack',
  }),
  persistentResponses[2],
);
assert.equal(persistent.calls.length, 3);

const networkFailure = queuedHttp([
  new Error('connection reset'),
  { statusCode: 200 },
]);
const networkFailureResult = await retryingGitHttp(networkFailure, schedule).request({
  method: 'GET',
  url: 'https://github.com/example/project.git/info/refs?service=git-upload-pack',
});
assert.equal(networkFailureResult.statusCode, 200);
assert.equal(networkFailure.calls.length, 2);

const receivePackResponse = { statusCode: 522 };
const receivePack = queuedHttp([receivePackResponse]);
assert.equal(
  await retryingGitHttp(receivePack, schedule).request({
    method: 'POST',
    url: 'https://github.com/example/project.git/git-receive-pack',
    body: [Uint8Array.of(1, 2, 3)],
  }),
  receivePackResponse,
);
assert.equal(receivePack.calls.length, 1);

const receivePackFailure = new Error('push connection reset');
const failingReceivePack = queuedHttp([receivePackFailure]);
await assert.rejects(
  retryingGitHttp(failingReceivePack, schedule).request({
    method: 'POST',
    url: 'https://github.com/example/project.git/git-receive-pack',
    body: [Uint8Array.of(1, 2, 3)],
  }),
  receivePackFailure,
);
assert.equal(failingReceivePack.calls.length, 1);

console.log('git-http retry adapter: ok');
