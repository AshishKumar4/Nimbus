#!/usr/bin/env bun
// @tier slow — native Git/server and real facet differentials; measured 47 s in CI.
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
//   - A remote that is not configured: git's "does not appear to be a git
//     repository" (fetch and push 128, pull 1).
// And remoteFailureText's lines, on their own, for each kind.
// A host's NIMBUS_GIT_CREDENTIAL_HINT (Kinu ask 75) is printed on its own
// line before git's `fatal:` on a 401 that offered no credential, and only
// then: not on a 401 with credentials offered, nor any other failure.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anonymizeUrl, remoteFailureText, selectRemoteCredentials } from '../../packages/worker/src/git/pack/remote-failure.ts';
import { createFacetSession, hostGit as hostGitIn, hostGitEnv } from './lib/facet-session.mjs';
import { startGitHttpServer } from './lib/git-http-server.mjs';

// ── the lines on their own ──
assert.equal(anonymizeUrl('https://u:p@host:8080/a/b.git'), 'https://host:8080/a/b.git');
assert.equal(anonymizeUrl('https://host/a@b.git'), 'https://host/a@b.git', 'an @ in the path is not a user');
const none = { username: '', password: false };
assert.equal(remoteFailureText('https://u:p@h/r.git', { kind: 'transport', detail: 'Could not resolve host: h' }, { username: 'u', password: true }),
  "fatal: unable to access 'https://h/r.git/': Could not resolve host: h\n");
assert.equal(remoteFailureText('https://h/r.git/', { kind: 'status', status: 404, message: 'Repository not found.\n' }, none),
  "remote: Repository not found.\nfatal: repository 'https://h/r.git/' not found\n");
assert.equal(remoteFailureText('https://h:1/r', { kind: 'status', status: 401 }, none),
  "fatal: could not read Username for 'https://h:1': terminal prompts disabled\n");
assert.equal(remoteFailureText('https://h:1/r', { kind: 'status', status: 401 }, { username: 'a b', password: false }),
  "fatal: could not read Password for 'https://a%20b@h:1': terminal prompts disabled\n", 'a user name with no password: its prompt for the password');
assert.equal(remoteFailureText('https://h/r', { kind: 'status', status: 401 }, { username: 'u', password: true }), "fatal: Authentication failed for 'https://h/r/'\n");
assert.equal(remoteFailureText('https://h/r', { kind: 'status', status: 503 }, none),
  "fatal: unable to access 'https://h/r/': The requested URL returned error: 503\n");
assert.equal(remoteFailureText('https://h/r', { kind: 'status', status: 403, message: 'use https://x:hunter2@h/r or TOKEN-9\n' }, { username: '', password: true }, ['TOKEN-9']),
  "remote: use https://h/r or <redacted>\nfatal: unable to access 'https://h/r/': The requested URL returned error: 403\n", 'credentials a server echoes are not printed');
assert.equal(remoteFailureText('http://127.0.0.1/auth.git', { kind: 'status', status: 401 }, { username: 'u', password: true }, ['p']),
  "fatal: Authentication failed for 'http://127.0.0.1/auth.git/'\n", 'a single-letter secret does not redact the protocol spelling');
assert.deepEqual(selectRemoteCredentials('https://h?query=x@y', { username: 'caller', password: 'pass' }),
  { username: 'caller', password: 'pass' }, 'query data is not URL userinfo');
for (const password of ['/', ':', '@', '://']) {
  const url = `https://u:${encodeURIComponent(password)}@h:8443/repo.git`;
  assert.equal(remoteFailureText(url, { kind: 'status', status: 403 }, { username: 'u', password: true }, [password]),
    "fatal: unable to access 'https://h:8443/repo.git/': The requested URL returned error: 403\n", 'URL delimiters are not password data');
}
assert.equal(remoteFailureText('https://u@h:8443/repo.git', { kind: 'status', status: 401 }, { username: 'u', password: false }, ['@', '/', ':']),
  "fatal: could not read Password for 'https://u@h:8443': terminal prompts disabled\n", 'credential-prompt delimiters remain intact');
assert.equal(remoteFailureText('https://HOST.Example:443/repo.git', { kind: 'status', status: 403 }, none),
  "fatal: unable to access 'https://HOST.Example:443/repo.git/': The requested URL returned error: 403\n", 'native git preserves host case and explicit default port spelling');
assert.equal(remoteFailureText('https://h/a%2Fb?x=%20', { kind: 'status', status: 403 }, none, ['2']),
  "fatal: unable to access 'https://h/a%2Fb?x=%20/': The requested URL returned error: 403\n", 'escape digits are encoding syntax, not secret data');
for (const url of ['https://h/r?TOKEN-9=public', 'https://h/r?%54OKEN%2d9=public', 'https://h/%54OKEN%2d9/r']) {
  const message = remoteFailureText(url, { kind: 'status', status: 403 }, none, ['TOKEN-9']);
  assert.equal(message.includes('TOKEN-9'), false, 'secret-bearing query names are redacted');
  assert.equal(message.includes('%54OKEN%2d9'), false, 'raw and percent-encoded forms are redacted without canonicalizing unrelated text');
}
for (const [secret, data] of [['%', '%25'], ['%25', '%2525'], ['x%y', 'x%y'], ['x%y', '%78%25%79']]) {
  const message = remoteFailureText(`https://h/r?access=${data}`, { kind: 'status', status: 403 }, none, [secret]);
  assert.match(message, /access=<redacted>/, 'percent secrets are matched as decoded bytes, not shadowed by a shorter raw alternative');
}
console.log('  ok  remoteFailureText: each kind in git\'s words');

const work = mkdtempSync(join(tmpdir(), 'nimbus-remote-failure-'));

/** A server answering each repository's discovery with a failure. */
const server = createServer((req, res) => {
  const name = req.url.split('/')[1];
  if (name === 'missing.git') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Repository not found.\n');
  } else if (name === 'forbidden.git') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden: this token cannot read it\nAsk its owner\n');
  } else if (name === 'echo.git') {
    // A server that echoes the credentials it was sent.
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end(`denied for ${req.headers.authorization ?? ''}; clone https://u:hunter2@127.0.0.1/r.git with TOKEN-9\n`);
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

/**
 * Host git in `cwd`: no terminal to prompt at, no credential helper. Not
 * spawnSync: the server it talks to answers from this process's loop.
 */
async function realGit(cwd, args) {
  const child = spawn('git', args, {
    cwd,
    env: { ...hostGitEnv(work), GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stderr };
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
  { name: '401 with a user name only', url: `http://u@127.0.0.1:${server.address().port}/auth.git`, ours: `${base}/auth.git`, env: { GIT_USERNAME: 'u' } },
  { name: 'URL user wins over environment user', url: `http://url-user@127.0.0.1:${server.address().port}/auth.git`, env: { GIT_USERNAME: 'environment-user' } },
  { name: 'URL user with no password does not borrow environment password', url: `http://url-user@127.0.0.1:${server.address().port}/auth.git`, env: { GIT_USERNAME: 'environment-user', GIT_PASSWORD: 'environment-password' } },
];
let n = 0;
try {
  for (const { name, url, transport = false, ours: oursUrl = url, env = {} } of cases) {
    n++;
    // clone
    const host = await realGit(work, ['clone', url, join(work, `host-${n}`)]);
    const ours = await session.git('/home/user', ['clone', oursUrl, `/home/user/ours-${n}`], env);
    assert.deepEqual([ours.code, fatal(ours.stderr, transport)], [host.code, fatal(host.stderr, transport).replace(url, anonymizeUrl(url))], `${name}: clone (git's: ${host.stderr}; ours: ${ours.stderr})`);
    assert.equal(session.kernel.exists(`home/user/ours-${n}`), false, `${name}: the failed clone leaves nothing`);

    // fetch, pull and push in a repository whose origin is the URL
    const hostRepo = join(work, `host-repo-${n}`);
    mkdirSync(hostRepo);
    for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'one'], ['remote', 'add', 'origin', url]]) {
      assert.equal((await realGit(hostRepo, args)).code, 0);
    }
    const repo = `/home/user/repo-${n}`;
    assert.equal((await session.git('/home/user', ['init', '-q', '-b', 'main', repo])).code, 0);
    session.kernel.writeFile(`${repo.slice(1)}/a.txt`, 'a\n');
    for (const args of [['add', 'a.txt'], ['commit', '-q', '-m', 'one'], ['remote', 'add', 'origin', oursUrl]]) {
      const step = await session.git(repo, args, { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' });
      assert.equal(step.code, 0, `${args[0]}: ${step.stderr}`);
    }
    for (const args of [['fetch'], ['pull', 'origin', 'main'], ['push', 'origin', 'main']]) {
      const h = await realGit(hostRepo, args);
      const o = await session.git(repo, args, env);
      assert.deepEqual([o.code, fatal(o.stderr, transport)], [h.code, fatal(h.stderr, transport).replace(url, anonymizeUrl(url))], `${name}: ${args[0]} (git's: ${h.stderr}; ours: ${o.stderr})`);
    }
    console.log(`  ok  ${name}: clone, fetch, pull and push exit as git does, with git's message`);
  }

  // A host's hint for a 401 that offered no credential, and only that.
  {
    const hint = { NIMBUS_GIT_CREDENTIAL_HINT: 'Kinu: this command holds no GitHub credential. Connect GitHub in Settings > Connections; then run git again.' };
    const bare = await session.git('/home/user', ['clone', `${base}/auth.git`, '/home/user/hinted'], hint);
    assert.equal(bare.code, 128, bare.stderr);
    assert.match(bare.stderr, /^Kinu: this command holds no GitHub credential\. Connect GitHub in Settings > Connections; then run git again\.\nfatal: could not read Username for '[^']*': terminal prompts disabled\n$/m, bare.stderr);
    const offered = await session.git('/home/user', ['clone', `${base}/auth.git`, '/home/user/hinted-2'], { ...hint, GIT_USERNAME: 'u', GIT_PASSWORD: 'p' });
    assert.doesNotMatch(offered.stderr, /Kinu:/, `a credential was offered: ${offered.stderr}`);
    const missing = await session.git('/home/user', ['clone', `${base}/missing.git`, '/home/user/hinted-3'], hint);
    assert.notEqual(missing.code, 0);
    assert.doesNotMatch(missing.stderr, /Kinu:/, `not a 401: ${missing.stderr}`);
    console.log('  ok  a host\'s credential hint: on its own line before a 401 that offered none, and only then');
  }

  // A remote that is not configured.
  // Resolve one command's effective destination before crossing into the
  // network facet. Its request and its diagnostic must name the same server.
  {
    const hostRepo = join(work, 'host-repo-1');
    const repo = '/home/user/repo-1';
    const differences = [];
    // remote.<name>.url is multi-valued in git: an added -c URL does not
    // override an existing first URL, unlike a scalar configuration key.
    for (const run of [() => realGit(hostRepo, ['config', 'remote.origin.url', `${base}/missing.git`]),
      () => session.git(repo, ['config', 'remote.origin.url', `${base}/missing.git`])]) assert.equal((await run()).code, 0);
    const compare = async (label, args) => {
      const h = await realGit(hostRepo, args);
      const o = await session.git(repo, args);
      const expected = [h.code, fatal(h.stderr, false)];
      const actual = [o.code, fatal(o.stderr, false)];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) differences.push({ label, actual, expected, stderr: o.stderr });
    };
    for (const args of [['fetch', 'origin'], ['pull', 'origin', 'main'], ['push', 'origin', 'main']]) {
      await compare(`first configured URL survives appended -c for ${args[0]}`, ['-c', `remote.origin.url=${base}/forbidden.git`, ...args]);
    }
    await compare('command-only remote URL', ['-c', `remote.temporary.url=${base}/forbidden.git`, 'fetch', 'temporary']);
    await compare('empty URL resets earlier configured URLs', ['-c', 'remote.origin.url=', '-c', `remote.origin.url=${base}/forbidden.git`, 'fetch', 'origin']);
    for (const args of [
      ['config', 'remote.upload.pushurl', `${base}/forbidden.git`],
      ['config', 'remote.origin.url', `${base}/missing.git`],
      ['config', 'remote.origin.pushurl', `${base}/forbidden.git`],
    ]) {
      assert.equal((await realGit(hostRepo, args)).code, 0);
      assert.equal((await session.git(repo, args)).code, 0);
    }
    await compare('pushurl-only remote', ['push', 'upload', 'main']);
    await compare('pushurl preferred over fetch URL', ['push', 'origin', 'main']);
    await compare('first pushurl survives appended -c', ['-c', `remote.origin.pushurl=${base}/missing.git`, 'push', 'origin', 'main']);
    await compare('empty pushurl resets earlier configured URLs', ['-c', 'remote.origin.pushurl=', '-c', `remote.origin.pushurl=${base}/missing.git`, 'push', 'origin', 'main']);
    assert.deepEqual(differences, [], 'remote destination and reported failure agree with host git for every operation');
    console.log('  ok  each effective fetch/pull/push destination crosses the facet and appears in its error');
  }

  // A remote that is not configured.
  {
    const hostRepo = join(work, 'host-repo-1');
    for (const args of [['fetch', 'nosuch'], ['pull', 'nosuch', 'main'], ['push', 'nosuch', 'main']]) {
      const h = await realGit(hostRepo, args);
      const o = await session.git('/home/user/repo-1', args);
      assert.deepEqual([o.code, o.stderr.split('\n').filter((line) => !line.startsWith('Fetching') && !line.startsWith('Pulling') && !line.startsWith('Pushing')).join('\n').trim()],
        [h.code, h.stderr.trim()], `${args[0]} of a remote not configured (git's: ${h.stderr}; ours: ${o.stderr})`);
    }
    console.log('  ok  a remote not configured: git\'s "does not appear to be a git repository", exit as git');
  }

  // A server that echoes credentials: git prints its text as it is, ours with them taken out.
  {
    const echoed = await session.git('/home/user', ['clone', `${base}/echo.git`, '/home/user/echoed'], { GIT_TOKEN: 'TOKEN-9' });
    assert.equal(echoed.code, 128, echoed.stderr);
    assert.match(echoed.stderr, /^remote: denied for Basic <redacted>; /m, echoed.stderr);
    assert.doesNotMatch(echoed.stderr, /TOKEN-9|hunter2/, `no credential printed: ${echoed.stderr}`);
    assert.match(echoed.stderr, /clone https:\/\/127\.0\.0\.1\/r\.git with <redacted>/);
    const encoded = await session.git('/home/user', ['clone', `http://git:secret%2Dpass@127.0.0.1:${server.address().port}/echo.git`, '/home/user/echoed-encoded']);
    assert.equal(encoded.code, 128, encoded.stderr);
    assert.match(encoded.stderr, /^remote: denied for Basic <redacted>; /m, 'the redactor uses the decoded credentials the transport actually sent');
    const unicode = await session.git('/home/user', ['clone', `${base}/echo.git`, '/home/user/echoed-unicode'], { GIT_USERNAME: 'git', GIT_PASSWORD: 'secret-密码' });
    assert.equal(unicode.code, 128, unicode.stderr);
    assert.match(unicode.stderr, /^remote: denied for Basic <redacted>; /m, unicode.stderr);
    assert.equal(unicode.stderr.includes(Buffer.from('git:secret-密码').toString('base64')), false, 'UTF-8 Basic credentials the server echoes are redacted');
    console.log('  ok  credentials a server echoes in its message are not printed');
  }

  // A server that answers the discovery, then refuses the request for the pack (a POST), its body
  // echoing the credentials sent: git reports "RPC failed" and discards the body, and so does ours.
  // (A push's own "send-pack:" line is not said here.)
  {
    const served = join(work, 'rpc-served');
    mkdirSync(served);
    hostGitIn(work, work, ['init', '-q', '--bare', '-b', 'main', join(served, 'repo.git')]);
    hostGitIn(work, join(served, 'repo.git'), ['config', 'http.receivepack', 'true']);
    const seed = join(work, 'rpc-seed');
    hostGitIn(work, work, ['init', '-q', '-b', 'main', seed]);
    hostGitIn(work, seed, ['commit', '-q', '--allow-empty', '-m', 'seed']);
    hostGitIn(work, seed, ['push', '-q', join(served, 'repo.git'), 'main']);
    const rpc = startGitHttpServer(served, {
      refuse: (path, body, request) => request.method === 'POST' && new Response(
        `denied for ${request.headers.get('authorization')}; use https://u:hunter2@127.0.0.1/r.git with TOKEN-9\n`,
        { status: 403, headers: { 'content-type': 'text/plain' } },
      ),
    });
    try {
      const url = rpc.url.replace('http://', 'http://u:TOKEN-9@') + '/repo.git';
      const said = (stderr) => stderr.split('\n').filter((line) => /^(error|fatal|remote): /.test(line)).join('\n');
      const quiet = (label, stderr) => assert.doesNotMatch(stderr, /denied|hunter2|TOKEN-9|dTpUT0tFTi05/, `${label}: nothing of the body, no credential: ${stderr}`);
      const host = await realGit(work, ['clone', url, join(work, 'rpc-host')]);
      const ours = await session.git('/home/user', ['clone', url, '/home/user/rpc-ours']);
      assert.deepEqual([ours.code, said(ours.stderr)], [host.code, said(host.stderr)], `clone (git's: ${host.stderr}; ours: ${ours.stderr})`);
      assert.match(ours.stderr, /^error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403\nfatal: the remote end hung up unexpectedly\n/m);
      quiet('clone', ours.stderr);
      const hostRepo = join(work, 'rpc-host-repo');
      hostGitIn(work, work, ['init', '-q', '-b', 'main', hostRepo]);
      hostGitIn(work, hostRepo, ['commit', '-q', '--allow-empty', '-m', 'mine']);
      hostGitIn(work, hostRepo, ['remote', 'add', 'origin', url]);
      hostGitIn(work, hostRepo, ['branch', 'other']);
      const repo = '/home/user/rpc-repo';
      assert.equal((await session.git('/home/user', ['init', '-q', '-b', 'main', repo])).code, 0);
      session.kernel.writeFile(`${repo.slice(1)}/a.txt`, 'a\n');
      for (const args of [['add', 'a.txt'], ['commit', '-q', '-m', 'mine'], ['remote', 'add', 'origin', url], ['branch', 'other']]) {
        const step = await session.git(repo, args, { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' });
        assert.equal(step.code, 0, `${args[0]}: ${step.stderr}`);
      }
      // A branch the remote lacks: its push sends a pack.
      for (const args of [['fetch', 'origin'], ['pull', 'origin', 'main'], ['push', 'origin', 'other']]) {
        const h = await realGit(hostRepo, args);
        const o = await session.git(repo, args);
        assert.deepEqual([o.code, said(o.stderr)], [h.code, said(h.stderr)], `${args[0]} (git's: ${h.stderr}; ours: ${o.stderr})`);
        quiet(args[0], o.stderr);
      }
      console.log('  ok  a refused request for the pack: "RPC failed" as git says it, the body not shown');
    } finally {
      rpc.stop();
    }
  }

  // The same, in a repository made as a shell makes one: `git init`, `git config`, a commit, `git remote add`.
  {
    assert.equal((await session.git('/home/user', ['init', '-q', '/home/user/shell'])).code, 0);
    for (const args of [['config', 'user.name', 'a'], ['config', 'user.email', 'a@b']]) assert.equal((await session.git('/home/user/shell', args)).code, 0);
    session.kernel.writeFile('home/user/shell/a', 'a\n');
    for (const args of [['add', 'a'], ['commit', '-q', '-m', 'one'], ['remote', 'add', 'origin', 'https://example.invalid/r.git']]) {
      const step = await session.git('/home/user/shell', args);
      assert.equal(step.code, 0, `${args[0]}: ${step.stderr}`);
    }
    const nosuch = await session.git('/home/user/shell', ['fetch', 'nosuch']);
    assert.equal(nosuch.code, 128, `fetch nosuch: ${nosuch.stdout}${nosuch.stderr}`);
    assert.match(nosuch.stderr, /^fatal: 'nosuch' does not appear to be a git repository\n/);
    console.log('  ok  a remote not configured, in a repository a shell made');
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log('git-remote-failure: ok');
for (const failure of [{ kind: 'status', status: 403 }, { kind: 'status', status: 401 }, { kind: 'status', status: 404 }, { kind: 'transport', detail: 'unreachable' }]) {
  const message = remoteFailureText('https://h/TOKEN-9/r.git?access_token=TOKEN-9', failure, { username: '', password: true }, ['TOKEN-9']);
  assert.doesNotMatch(message, /TOKEN-9/, 'known secrets in the destination path/query are not printed');
  assert.match(message, /(?:<redacted>|%3Credacted%3E)/);
}
