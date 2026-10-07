#!/usr/bin/env bun
// `npm init`, `npm create` and `npm innit` do what npm 10.9.8 does
// (npm-init.ts, npm-config.ts): each case runs under real npm and under the
// shell's npm over the same files, and the package.json written, what is
// printed and the exit status must be npm's, byte for byte.
//
// - The template under -y: a directory's .js files, bin/, lib/ and test/,
//   node_modules, .git/config's origin, server.js, a .gyp file, a README and
//   a .d.ts; a package.json that is there, in its own indent, with what npm
//   normalizes of it (bins of every shape, `_` keys, funding, a GitLab
//   subgroup, a Bitbucket shortcut, an author); and npm's configuration:
//   ~/.npmrc, a project .npmrc, npm_config_* and the command line (init-*,
//   the deprecated init.*, ${VAR}, an invalid init-version or url, scope,
//   save-exact, save-prefix).
// - The template asked on a terminal (real npm on a pty, its echo the
//   terminal's): every question, an invalid name, version and license told
//   and asked again, "Is this OK?" answered yes and no, ^C, and input that
//   ends.
// - An initializer, flags before or after it: the package npm exec runs
//   (real npm's request to a stand-in registry, or the repository its git
//   is asked for), and one npm does not recognize.
//
// Before: the shell's npm wrote `type: "module"`, Vite's scripts, license MIT
// and empty dependency maps, asked nothing, read no configuration, refused a
// package.json that was there without -y, and took `npm init -y vite` for
// the template.
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import hostedGitInfo from '../../packages/core/node_modules/hosted-git-info/lib/index.js';

import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const disk = mkdtempSync(join(tmpdir(), 'npm-init-'));
const HOME = join(disk, 'home');
const GLOBAL_RC = join(disk, 'global-npmrc');
mkdirSync(HOME, { recursive: true });
writeFileSync(GLOBAL_RC, '');

// Real npm, with only the configuration a case gives it.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && key !== 'CI'));
const npmEnv = (extra = {}) => ({ ...baseEnv, HOME, npm_config_globalconfig: GLOBAL_RC, npm_config_update_notifier: 'false', npm_config_cache: join(disk, 'cache'), ...extra });
const version = spawnSync('npm', ['--version'], { encoding: 'utf8', env: npmEnv() }).stdout.trim();
assert.equal(version, '10.9.8', 'premise: npm is 10.9.8');

// The same files in the session: /home/user is HOME.
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const fs = ws.vfs.as(CRED_KERNEL);
const npm = createNpmCommand(ws.registry, undefined, ws.kernel);
const SESSION_HOME = '/home/user';
const sessionPath = (path) => path.replace(HOME, SESSION_HOME);
const diskPath = (text) => text.replaceAll(SESSION_HOME, HOME);

async function stage(rel, files) {
  mkdirSync(join(HOME, rel), { recursive: true });
  await fs.mkdir(`${SESSION_HOME}/${rel}`, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    const at = `${rel}/${file}`;
    mkdirSync(dirname(join(HOME, at)), { recursive: true });
    writeFileSync(join(HOME, at), text);
    await fs.mkdir(`${SESSION_HOME}/${at}`.slice(0, `${SESSION_HOME}/${at}`.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(`${SESSION_HOME}/${at}`, text);
  }
}
async function setNpmrc(rel, text) {
  writeFileSync(join(HOME, rel), text);
  await fs.writeFile(`${SESSION_HOME}/${rel}`, text);
}
async function sessionFile(path) {
  try { return await fs.readFileString(path); } catch { return null; }
}
const diskFile = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/**
 * The shell's npm run in `cwd` (a disk path), `answers` its input one line at
 * a time; the answer `\u0003` is ^C. What it printed comes back merged, each
 * answer echoed as a terminal echoes it, with what it asked npx to run.
 */
async function sessionNpm(args, cwd, { env = {}, answers = [] } = {}) {
  let out = '';
  let stdout = '';
  let stderr = '';
  const ran = [];
  const controller = new AbortController();
  const queue = [...answers];
  const exitCode = await npm({
    args,
    cwd: sessionPath(cwd),
    env: { HOME: SESSION_HOME, npm_config_prefix: '/usr/local', ...env },
    cred: CRED_KERNEL,
    vfs: fs,
    stdout: { write: (text) => { stdout += text; out += text; } },
    stderr: { write: (text) => { stderr += text; out += text; } },
    stdin: {
      readLine: async () => {
        if (queue.length === 0) return null;
        const answer = queue.shift();
        if (answer === '\u0003') {
          controller.abort();
          return new Promise(() => {});
        }
        out += answer + '\n';
        return answer;
      },
      read: async () => null,
      readAll: async () => '',
    },
    signal: controller.signal,
    runAs: async (_cred, argv) => {
      ran.push(argv);
      return { status: 0, signal: null };
    },
    setUmask: () => {},
  });
  return { exitCode, out: diskPath(out), stdout: diskPath(stdout), stderr: diskPath(stderr), ran };
}

/**
 * What a terminal shows for `bytes`, line by line: a carriage return, a line
 * feed, and the cursor and erase sequences npm's spinner and readline write
 * (CSI n G, CSI K, CSI J).
 */
function screen(bytes) {
  const lines = [''];
  let row = 0;
  let col = 0;
  const put = (text) => {
    const line = lines[row].padEnd(col);
    lines[row] = line.slice(0, col) + text + line.slice(col + text.length);
    col += text.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    if (ch === '\r') col = 0;
    else if (ch === '\n') {
      row++;
      col = 0;
      if (lines[row] === undefined) lines[row] = '';
    } else if (ch === '\x1b' && bytes[i + 1] === '[') {
      const csi = /^\x1b\[(\d*)([A-Za-z])/.exec(bytes.slice(i));
      if (csi === null) continue;
      i += csi[0].length - 1;
      const n = csi[1] === '' ? 0 : Number(csi[1]);
      if (csi[2] === 'G') col = Math.max(0, (n || 1) - 1);
      else if (csi[2] === 'K' && n === 0) lines[row] = lines[row].slice(0, col);
      else if (csi[2] === 'J' && n === 0) {
        lines[row] = lines[row].slice(0, col);
        lines.length = row + 1;
      }
    } else put(ch);
  }
  return lines.join('\n');
}

/** Real npm in `cwd` on a pty, typing `answers` (`\u0003` is ^C): what the terminal shows. */
const PTY = join(disk, 'pty-drive.py');
writeFileSync(PTY, `
import os, pty, time, select, sys, json, fcntl, termios, struct
answers = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm'
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
out = b''
def drain(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                return False
            if not data:
                return False
            out += data
            end = time.time() + 0.8
    return True
drain(8)
for a in answers:
    os.write(fd, (a if a == '\\x03' else a + '\\r').encode())
    if not drain(5):
        break
drain(3)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.stderr.write(str(os.waitstatus_to_exitcode(status)))
`);
function realNpmPty(args, cwd, answers, env = {}) {
  const run = spawnSync('python3', [PTY, JSON.stringify(answers), 'npm', ...args], { cwd, encoding: 'utf8', env: npmEnv(env), timeout: 120_000 });
  assert.equal(run.error, undefined, `pty: ${run.error}`);
  return { out: screen(run.stdout), exitCode: Number(run.stderr.trim().split('\n').at(-1)) };
}
function realNpm(args, cwd, env = {}, input) {
  const run = spawnSync('npm', args, { cwd, encoding: 'utf8', env: npmEnv(env), input, timeout: 120_000 });
  // npm names its debug log; the shell's npm keeps none.
  const stderr = run.stderr.split('\n').filter((line) => !line.startsWith('npm error A complete log of this run can be found in')).join('\n');
  return { exitCode: run.status, stdout: run.stdout, stderr };
}

let cases = 0;
async function compareTemplate(name, files, { args = ['init', '-y'], env = {}, sessionEnv = env, npmrc } = {}) {
  await stage(name, files);
  if (npmrc !== undefined) await setNpmrc('.npmrc', npmrc);
  const dir = join(HOME, name);
  const real = realNpm(args, dir, env);
  const ours = await sessionNpm(args, dir, { env: sessionEnv });
  assert.equal(ours.exitCode, real.exitCode, `${name}: exit status (${real.stderr}${ours.stderr})`);
  assert.equal(await sessionFile(`${SESSION_HOME}/${name}/package.json`), diskFile(join(dir, 'package.json')), `${name}: the package.json npm writes`);
  assert.equal(ours.stdout, real.stdout, `${name}: what npm prints`);
  assert.equal(ours.stderr, real.stderr, `${name}: npm's warnings`);
  if (npmrc !== undefined) await setNpmrc('.npmrc', '');
  cases++;
}

try {
  await setNpmrc('.npmrc', '');

  // ── The template under -y ──────────────────────────────────────────────
  await compareTemplate('My_App', {});
  await compareTemplate('node-thing.js', {
    'lib/x.txt': '', 'test/t.txt': '', 'docs/d.txt': '', 'example/e.txt': '', 'man/m.1': '', 'bin/cli.js': '', 'z.js': '',
    'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}',
    'node_modules/mocha/package.json': '{"name":"mocha","version":"10.0.0"}',
    'node_modules/tap/package.json': '{"name":"tap","version":"18.0.0","_requiredBy":["#USER"]}',
    'node_modules/@s/x/package.json': '{"name":"@s/x","version":"1.0.0"}',
    'node_modules/.bin/mocha': '',
  });
  await compareTemplate('g', { '.git/config': '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:u/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' });
  await compareTemplate('sub', { '.git/config': '[remote "origin"]\n\turl = git@gitlab.com:g/sub/r.git\n' });
  await compareTemplate('s', { 'server.js': '', 'addon.gyp': '', 'README.md': '# Title\n\nA small thing\nthat does stuff.\n\nMore.\n' });
  await compareTemplate('typed', { 'index.js': '', 'index.d.ts': '', 'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}' });
  await compareTemplate('kept', { 'package.json': '{\n    "name": "Kept",\n    "version": "nope",\n    "scripts": {"build": "x", "bad": 1}\n}\n' });
  await compareTemplate('compact', { 'package.json': '{"name":"t","bin":"./cli.js","dependencies":{"a":"1"},"version":"v2.0.0","scripts":{"x":"node_modules/.bin/foo"}}' });
  await compareTemplate('tabs', { 'package.json': '{\n\t"name": "q",\n\t"repository": "https://gitlab.com/a/b",\n\t"keywords": "x, y"\n}\n' });
  await compareTemplate('bin-null', { 'package.json': '{"name":"bn","bin":null,"_private":1,"funding":"https://fund.example","bundledDependencies":["a"],"dependencies":{"a":"1"}}' });
  await compareTemplate('bin-array', { 'package.json': JSON.stringify({ name: '@s/ba', bin: ['./a/b.js', 'c:d.js', 'e/'] }, null, 2) });
  await compareTemplate('bin-keys', { 'package.json': JSON.stringify({ name: 'bk', bin: { 'a/x': 't1', x: 't2', 'y/.': 'u', z: 5, '': 'q', '..': 'r', 'w\\v': 'p:q' } }, null, 2) });
  await compareTemplate('bin-scoped', { 'package.json': JSON.stringify({ name: '@s/cli', bin: 'bin\\run.js', repository: 'bitbucket:u/r', author: { name: 'Me', email: 'me@x.io', url: 'https://x.io' } }) });
  await compareTemplate('subgroup', { 'package.json': JSON.stringify({ name: 'sg', repository: { type: 'git', url: 'https://gitlab.com/g/sub/r.git' }, bugs: 'me@x.io' }) });

  // ── The template under npm's configuration ─────────────────────────────
  const node = { 'node_modules/left-pad/package.json': '{"name":"left-pad","version":"1.3.0"}' };
  await compareTemplate('configured', node, {
    env: { SITE: 'https://ex.com' },
    npmrc: 'init.author.name = Old Name\ninit-author-email=me@x.io\ninit-version=abc\ninit-license = MIT\nscope=myco\ninit-author-url=${SITE}/me\nsave-exact=true\n',
  });
  await compareTemplate('flagged', node, {
    args: ['init', '--yes', '--scope=@other', '--init-author-name', 'Cli Name', '--init-version', 'v3.0.0', '-E'],
    env: { npm_config_init_license: 'Apache-2.0', npm_config_save_prefix: '~' },
    npmrc: 'init-author-url=${UNSET}/me\n',
  });
  await stage('project', { ...node, 'package.json': '{"name":"project"}', '.npmrc': 'save-prefix=~\ninit-license=0BSD\n' });
  await compareTemplate('project', {}, { args: ['init', '-f'] });
  await compareTemplate('env-yes', {}, { args: ['init'], env: { npm_config_yes: 'true' } });

  // ── The template asked on a terminal ───────────────────────────────────
  async function compareAsked(name, files, answers, args = ['init']) {
    await stage(name, files);
    const dir = join(HOME, name);
    const real = realNpmPty(args, dir, answers);
    const ours = await sessionNpm(args, dir, { answers });
    assert.equal(screen(ours.out), real.out, `${name}: what the terminal shows`);
    assert.equal(ours.exitCode, real.exitCode, `${name}: exit status`);
    assert.equal(await sessionFile(`${SESSION_HOME}/${name}/package.json`), diskFile(join(dir, 'package.json')), `${name}: the package.json npm writes`);
    cases++;
  }
  await compareAsked('My Pkg.js', {}, ['Foo Bar', 'foo', '1.2', '1.2.3', 'desc', '', '', '', 'kw1, kw2 kw3', 'me <me@x.io>', 'BAD LICENSE', 'MIT', 'y']);
  await compareAsked('refused', {}, ['', '', '', '', '', '', '', '', '', 'no']);
  await compareAsked('existing', {
    'package.json': '{"name":"x2","version":"2.0.0","bin":null,"_x":1}', 'a.js': '',
    '.git/config': '[remote "origin"]\n\turl = git@gitlab.com:g/sub/r.git\n',
    'node_modules/mocha/package.json': '{"name":"mocha","version":"10.0.0"}',
  }, ['', '', '', '', '', '', '', '', '', '']);
  await compareAsked('canceled', {}, ['\u0003']);
  await compareAsked('created', {}, ['', '', '', '', '', '', '', '', '', 'Yes'], ['create']);

  // Input that ends mid-question (not a terminal): npm ends, nothing written.
  await stage('ended', {});
  const ended = realNpm(['init'], join(HOME, 'ended'), {}, '');
  const endedOurs = await sessionNpm(['init'], join(HOME, 'ended'));
  assert.equal(endedOurs.exitCode, ended.exitCode, 'input that ends: exit status');
  assert.equal(endedOurs.stdout, ended.stdout, 'input that ends: what npm prints');
  assert.equal(await sessionFile(`${SESSION_HOME}/ended/package.json`), null, 'input that ends: nothing written');
  cases++;

  // ── An initializer ─────────────────────────────────────────────────────
  // Real npm asks a stand-in registry for the package, or its git for the
  // repository; both answer nothing, which ends it.
  const requests = [];
  const registry = createServer((request, response) => {
    requests.push(decodeURIComponent(request.url.slice(1)));
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((done) => registry.listen(0, '127.0.0.1', done));
  const gitLog = join(disk, 'git.log');
  const fakeGit = join(disk, 'fake-git');
  writeFileSync(fakeGit, `#!/bin/sh\necho "$@" >> ${gitLog}\nexit 1\n`, { mode: 0o755 });
  await stage('initializers', {});
  const initDir = join(HOME, 'initializers');
  const realRun = (args) => new Promise((done) => {
    const child = spawn('npm', args, { cwd: initDir, env: npmEnv({ npm_config_registry: `http://127.0.0.1:${registry.address().port}/`, npm_config_git: fakeGit }) });
    child.on('close', done);
  });
  for (const args of [
    ['init', 'vite'], ['init', '-y', 'vite@latest', 'app'], ['create', 'vite@6', 'app', '--', '--template', 'react-ts'],
    ['init', '--yes', '@scope'], ['init', '@scope@2'], ['init', '@scope/foo'], ['innit', '@scope/foo@1.2.3', '-y'],
    ['init', 'u/r'], ['init', 'github:u/r'], ['create', 'git+https://github.com/u/r.git'], ['init', 'gitlab:g/r'],
  ]) {
    const before = { requests: requests.length, git: diskFile(gitLog)?.length ?? 0 };
    await realRun(args);
    const ours = await sessionNpm(args, initDir);
    assert.equal(ours.ran.length, 1, `npm ${args.join(' ')} runs one initializer: ${ours.stderr}`);
    const [command, yes, initializer, ...rest] = ours.ran[0];
    assert.deepEqual([command, yes], ['npx', '--yes'], `npm ${args.join(' ')}: npm exec's run`);
    const hosted = hostedGitInfo.fromUrl(initializer);
    if (hosted) {
      const asked = (diskFile(gitLog) ?? '').slice(before.git).trim().split('\n')[0];
      assert.ok(asked.includes(`${hosted.domain}/${hosted.user}/${hosted.project}.git`), `npm ${args.join(' ')}: ${initializer} is the repository npm asks git for (${asked})`);
    } else {
      assert.equal(requests[before.requests], initializer.replace(/(.)@[^@]*$/, '$1'), `npm ${args.join(' ')}: ${initializer} is the package npm asks the registry for`);
    }
    // What follows the initializer, past npm's own flags, is the initializer's.
    const positionals = args.slice(1).filter((arg, i, all) => !arg.startsWith('-') || all.slice(0, i).includes('--')).filter((arg) => arg !== '--');
    assert.deepEqual(rest, positionals.slice(1), `npm ${args.join(' ')}: the initializer's arguments`);
    cases++;
  }
  registry.close();
  const unrecognized = realNpm(['init', './dir', 'app'], initDir);
  const unrecognizedOurs = await sessionNpm(['init', './dir', 'app'], initDir);
  assert.equal(unrecognizedOurs.exitCode, unrecognized.exitCode, 'an unrecognized initializer: exit status');
  assert.equal(unrecognizedOurs.stderr, unrecognized.stderr, 'an unrecognized initializer: npm error');
  assert.equal(unrecognizedOurs.ran.length, 0, 'an unrecognized initializer runs nothing');
  cases++;
} finally {
  rmSync(disk, { recursive: true, force: true });
}

console.log(`npm-init-matches-npm: ${cases} cases, as npm ${version} runs them`);
