#!/usr/bin/env bun
// A git server that cannot be reached, or refuses, against host git doing
// the same: clone, fetch, pull and push each exit as git does (128; pull,
// whose fetch is git's child, 1) with git's own message.
//   - No answer (a port nothing listens on, a name that does not resolve):
//     "fatal: unable to access '<url>/': " and the transport's own words
//     (curl's in git, the runtime's here: compared up to them).
//   - 404 with a text/plain body: its lines as "remote: …", then
//     "fatal: repository '<url>/' not found".
//   - 403, 500: "fatal: unable to access '<url>/': The requested URL
//     returned error: <status>" (a non-plain body not shown).
//   - 401: with nothing offered, git's prompt for a user name with no
//     terminal ("terminal prompts disabled"); with credentials offered,
//     "fatal: Authentication failed for '<url>/'".
//   - The URL as git shows it: a slash at its end, its credentials taken out.
// And remoteFailureText's lines, on their own, for each kind.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anonymizeUrl, remoteFailureText } from '../../packages/worker/src/git/pack/remote-failure.ts';
import { createFacetSession, hostGitEnv } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-remote-failure-'));

// ── the lines on their own ──
assert.equal(anonymizeUrl('https://u:p@host:8080/a/b.git'), 'https://host:8080/a/b.git');
assert.equal(anonymizeUrl('https://host/a@b.git'), 'https://host/a@b.git', 'an @ in the path is not a user');
assert.equal(remoteFailureText('https://u:p@h/r.git', { kind: 'transport', detail: 'Could not resolve host: h' }, true),
  "fatal: unable to access 'https://h/r.git/': Could not resolve host: h\n");
assert.equal(remoteFailureText('https://h/r.git/', { kind: 'status', status: 404, message: 'Repository not found.\n' }, false),
  "remote: Repository not found.\nfatal: repository 'https://h/r.git/' not found\n");
assert.equal(remoteFailureText('https://h:1/r', { kind: 'status', status: 401 }, false),
  "fatal: could not read Username for 'https://h:1': terminal prompts disabled\n");
assert.equal(remoteFailureText('https://h/r', { kind: 'status', status: 401 }, true), "fatal: Authentication failed for 'https://h/r/'\n");
assert.equal(remoteFailureText('https://h/r', { kind: 'status', status: 503 }, false),
  "fatal: unable to access 'https://h/r/': The requested URL returned error: 503\n");
console.log('  ok  remoteFailureText: each kind in git\'s words');

/** A server answering each repository's discovery with a failure. */
const server = createServer((req, res) => {
  const name = req.url.split('/')[1];
  if (name === 'missing.git') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Repository not found.\n');
  } else if (name === 'forbidden.git') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: this token cannot read it\nAsk its owner\n');
  } else if (name === 'broken.git') {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<h1>oops</h1>');
  } else {
    res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="git"' });
    res.end('Unauthorized\n');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** Host git in `cwd`: no terminal to prompt at, no credential helper. */
function realGit(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...hostGitEnv(work), GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C' },
  });
  return { code: r.status, stderr: r.stderr };
}

/** git's last line on stderr, its fatal one; for no answer, up to the transport's own words. */
const fatal = (stderr, transport) => {
  const lines = stderr.trimEnd().split('\n').filter((line) => line.startsWith('fatal: ') || line.startsWith('remote: '));
  if (!transport) return lines.join('\n');
  const last = lines.pop() ?? '';
  return last.slice(0, last.indexOf("': ") + 3);
};

const session = await createFacetSession(work, { realGit: true });
const cases = [
  { name: 'no listener', url: 'http://127.0.0.1:1/r.git', transport: true },
  { name: 'no such host', url: 'https://example.invalid/r.git', transport: true },
  { name: '404', url: `${base}/missing.git` },
  { name: '403', url: `${base}/forbidden.git` },
  { name: '500', url: `${base}/broken.git` },
  { name: '401', url: `${base}/auth.git` },
  { name: '401 with credentials', url: `http://u:p@127.0.0.1:${server.address().port}/auth.git`, ours: `${base}/auth.git`, env: { GIT_USERNAME: 'u', GIT_PASSWORD: 'p' } },
];
let n = 0;
try {
  for (const { name, url, transport = false, ours: oursUrl = url, env = {} } of cases) {
    n++;
    // clone
    const host = realGit(work, ['clone', url, join(work, `host-${n}`)]);
    const ours = await session.git('/home/user', ['clone', oursUrl, `/home/user/ours-${n}`], env);
    assert.deepEqual([ours.code, fatal(ours.stderr, transport)], [host.code, fatal(host.stderr, transport).replace(url, anonymizeUrl(url))], `${name}: clone (git's: ${host.stderr}; ours: ${ours.stderr})`);
    assert.equal(session.kernel.exists(`home/user/ours-${n}`), false, `${name}: the failed clone leaves nothing`);

    // fetch, pull and push in a repository whose origin is the URL
    const hostRepo = join(work, `host-repo-${n}`);
    mkdirSync(hostRepo);
    for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'one'], ['remote', 'add', 'origin', url]]) {
      assert.equal(realGit(hostRepo, args).code, 0);
    }
    const repo = `/home/user/repo-${n}`;
    assert.equal((await session.git('/home/user', ['init', '-q', '-b', 'main', repo])).code, 0);
    session.kernel.writeFile(`${repo.slice(1)}/a.txt`, 'a\n');
    for (const args of [['add', 'a.txt'], ['commit', '-q', '-m', 'one'], ['remote', 'add', 'origin', oursUrl]]) {
      const step = await session.git(repo, args, { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' });
      assert.equal(step.code, 0, `${args[0]}: ${step.stderr}`);
    }
    for (const args of [['fetch'], ['pull', 'origin', 'main'], ['push', 'origin', 'main']]) {
      const h = realGit(hostRepo, args);
      const o = await session.git(repo, args, env);
      assert.deepEqual([o.code, fatal(o.stderr, transport)], [h.code, fatal(h.stderr, transport).replace(url, anonymizeUrl(url))], `${name}: ${args[0]} (git's: ${h.stderr}; ours: ${o.stderr})`);
    }
    console.log(`  ok  ${name}: clone, fetch, pull and push exit as git does, with git's message`);
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log('git-remote-failure: ok');
