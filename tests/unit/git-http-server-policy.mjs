#!/usr/bin/env bun
// lib/git-http-server.mjs's environment and header policy, which the tests
// serving their repositories through it rely on: `forward` passes a
// request's Git-Protocol on (as a web server passes HTTP_GIT_PROTOCOL to a
// CGI), so a client asking for protocol v2 is answered in it, and one not
// forwarded is answered in v0; `env` is the environment http-backend runs
// in, so the configuration a test puts there (GIT_CONFIG_COUNT) is the
// server's.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'nimbus-git-http-policy-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'r.git')], { env });

/** The upload-pack advertisement `server` answers, asked with `headers`. */
async function advertised(server, headers = {}) {
  const response = await fetch(`${server.url}/r.git/info/refs?service=git-upload-pack`, { headers });
  assert.equal(response.status, 200);
  return response.text();
}

const v2 = { 'Git-Protocol': 'version=2' };
const forwarding = startGitHttpServer(root, { plain: true, env, forward: ['git-protocol'] });
const plain = startGitHttpServer(root, { plain: true, env });
const configured = startGitHttpServer(root, { plain: true, env: { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'uploadpack.allowFilter', GIT_CONFIG_VALUE_0: 'true' }, forward: ['git-protocol'] });
try {
  assert.match(await advertised(forwarding, v2), /version 2/, 'forwarded: answered in protocol v2');
  assert.doesNotMatch(await advertised(plain, v2), /version 2/, 'not forwarded: answered in v0');
  assert.doesNotMatch(await advertised(forwarding, v2), /fetch=[^\n]*filter/, 'plain: no filter');
  assert.match(await advertised(configured, v2), /fetch=[^\n]*filter/, 'its env\'s configuration is the server\'s');
} finally {
  for (const server of [forwarding, plain, configured]) server.stop();
}
console.log('git-http-server-policy: ok');
