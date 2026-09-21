import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Terminal, stripAnsi } from '../behavioral/_driver.mjs';

const base = process.env.BASE;
const token = process.env.NIMBUS_PROBE_TOKEN;
assert.ok(base && token, 'BASE and NIMBUS_PROBE_TOKEN must name the isolated library-host fixture');
const names = [`library-a-${randomUUID()}`, `library-b-${randomUUID()}`];
const [first, second] = names;
const terminals = [];
const failures = [];

async function request(name, path, method = 'GET', data) {
  const response = await fetch(`${base}/workspaces/${name}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function exec(name, command, options) {
  console.log(`RUN ${name}: ${command}`);
  const result = await request(name, '/exec', 'POST', { command, options });
  assert.equal(result.exitCode, 0, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

async function until(read, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await read();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(result)}`);
}

async function terminal(name) {
  const attached = new Terminal(name);
  terminals.push(attached);
  await attached.connect();
  await attached.waitForPrompt();
  return attached;
}

try {
  const initial = await Promise.all(names.map((name) => request(name, '/state')));
  for (const state of initial) {
    assert.deepEqual(state.installed, [], 'on-demand creation installed runtime payloads');
    assert.deepEqual(state.hostRows, [{ id: 'keep', value: 'host-owned' }]);
  }
  if (process.argv.includes('--require-shared-isolate')) {
    assert.equal(initial[0].isolateId, initial[1].isolateId, 'isolation test requires both workspaces in the same real workerd isolate');
    console.log('PASS both application-owned workspaces share one real workerd isolate');
  }
  console.log('PASS two application-owned workspaces open without preinstalling runtimes');

  await exec(first, "printf alpha > /home/user/identity.txt");
  await exec(second, "printf beta > /home/user/identity.txt");
  assert.equal((await request(first, '/file?path=/home/user/identity.txt')).content, 'alpha');
  assert.equal((await request(second, '/file?path=/home/user/identity.txt')).content, 'beta');
  await exec(first, 'mkdir -p /home/user/one; cd /home/user/one; export LIBRARY_SHELL=one', { shellId: 'one' });
  assert.equal((await exec(first, 'printf "%s:%s" "$PWD" "$LIBRARY_SHELL"', { shellId: 'one' })).trim(), '/home/user/one:one');
  assert.equal((await exec(first, 'printf "%s" "$LIBRARY_SHELL"', { shellId: 'two' })).trim(), '');
  console.log('PASS files and named-shell state stay with their owner');

  for (const command of ['node --version', 'bun --version', 'npm --version', 'npx --version', 'git --version', 'esbuild --version']) {
    assert.ok((await exec(first, command)).trim(), `${command} returned no version`);
  }
  assert.equal((await exec(first, 'bun -e "console.log(6 * 7)"')).trim(), '42');
  await request(first, '/file', 'PUT', { path: '/home/user/package.json', content: '{"name":"library-proof","private":true}' });
  await exec(first, 'npm install --ignore-scripts is-number@7.0.0', { cwd: '/home/user' });
  assert.equal((await exec(first, 'node -e "console.log(require(\'is-number\')(42))"', { cwd: '/home/user' })).trim(), 'true');
  assert.match(await exec(first, 'npx cowsay@1.6.0 library-host'), /library-host/);
  await exec(first, 'git clone --depth 1 https://github.com/octocat/Hello-World.git /home/user/hello-world');
  assert.match(await exec(first, 'cat /home/user/hello-world/README'), /Hello World/i);
  console.log('PASS real Bun execution, npm dependency execution, npx CLI and git clone');

  // Kinu's clone-and-serve, verbatim: a quiet clone, then the branch name
  // read through `-C` from another directory. The facets behind these reach
  // the supervisor through bindings minted with this host's route, in a
  // namespace that is not NIMBUS_SESSION.
  const quiet = await request(first, '/exec', 'POST', { command: 'git clone -q --depth 1 https://github.com/octocat/Hello-World.git /home/user/quiet' });
  assert.equal(quiet.exitCode, 0, quiet.stderr);
  assert.equal(quiet.stdout.trim(), '', 'a quiet clone prints no progress');
  assert.equal((await exec(first, 'git -C /home/user/quiet branch --show-current')).trim(), 'master');
  assert.equal((await exec(first, 'git -C /home/user/quiet branch')).includes('--show-current'), false, 'no branch was created from the option');
  // A wide install fans its resolution and its writes out to sibling
  // Durable Objects of THIS namespace: fresh instances Nimbus opens by
  // name, which the host serves through the same supervisorOp forward.
  await request(first, '/file', 'PUT', { path: '/home/user/wide/package.json', content: '{"name":"wide","private":true}' });
  const wide = await request(first, '/exec', 'POST', { command: 'npm install --ignore-scripts express@4.21.2', options: { cwd: '/home/user/wide', timeoutMs: 600_000 } });
  assert.equal(wide.exitCode, 0, wide.stderr + wide.stdout);
  assert.match(wide.stdout, /Resolving \d+ dependencies \(path: fanout/, 'the install resolved through the fan-out');
  // The tree the peers wrote is the coordinator's: every package the fan-out
  // resolved is on this workspace's disk, under the dependent that needs it.
  assert.equal((await exec(first, 'node -e "console.log(require(\'./node_modules/express/package.json\').version)"', { cwd: '/home/user/wide' })).trim(), '4.21.2');
  const widePackages = Number((await exec(first, 'find node_modules -maxdepth 1 -mindepth 1 -type d | wc -l', { cwd: '/home/user/wide' })).trim());
  assert.ok(widePackages >= 60, `express@4 brings about 65 packages; ${widePackages} landed`);
  console.log('PASS quiet clone, git -C, branch --show-current, and a wide install fanned out across the host namespace');

  for (const [name, marker] of [[first, 'alpha'], [second, 'beta']]) {
    if (name === second) {
      const refused = await request(name, '/exec', 'POST', { command: 'curl -fsS http://localhost:3021/' });
      assert.notEqual(refused.exitCode, 0, 'localhost reached the other workspace');
      assert.match(refused.stderr, /[Ff]ailed to connect|ECONNREFUSED/);
    }
    await request(name, '/file', 'PUT', {
      path: '/home/user/server.js',
      content: `
let held;
let timer;
require('node:http').createServer((req, res) => {
  if (req.url === '/park') {
    held = res;
    timer = setTimeout(() => { held = undefined; res.end('expired'); }, 30000);
    return;
  }
  if (req.url === '/park-state') { res.end(held ? 'parked' : 'idle'); return; }
  if (req.url === '/release') {
    clearTimeout(timer);
    if (held) held.end('released');
    held = undefined;
    res.end('released');
    return;
  }
  res.end('${marker}');
}).listen(3021);
console.log('LISTENER_${marker}');`,
    });
    await request(name, '/start', 'POST', { command: 'node /home/user/server.js' });
    const state = await until(() => request(name, '/state'), (value) => value.ports.some((port) => port.port === 3021), 'node listener never bound');
    const port = state.ports.find((value) => value.port === 3021);
    assert.equal((await exec(name, 'curl -fsS http://localhost:3021/')).trim(), marker);
    assert.equal((await exec(name, 'wget -q -O /home/user/download http://127.0.0.1:3021/; cat /home/user/download')).trim(), marker);
    await until(() => request(name, `/logs?pid=${port.pid}`), (value) => value.text.includes(`LISTENER_${marker}`), 'process output did not reach logs');
  }
  console.log('PASS hosted node execution, process output and workspace-local curl/wget');

  const [python] = await Promise.all([
    exec(first, 'python3 -c "print(6 * 7)"'),
    request(first, '/install', 'POST', { spec: 'python' }),
  ]);
  assert.equal(python.trim(), '42');
  await exec(second, 'nimbus install bash');
  assert.equal((await exec(second, "bash -c 'printf bash-ready'")).trim(), 'bash-ready');
  const installed = await Promise.all(names.map((name) => request(name, '/state')));
  assert.deepEqual(installed[0].installed.map((entry) => entry.name), ['cpython']);
  assert.deepEqual(installed[1].installed.map((entry) => entry.name), ['bash']);
  console.log('PASS concurrent first invocation/explicit install, bash and Python isolation');

  let pythonTerminal = await terminal(first);
  await pythonTerminal.run('python3');
  assert.match((await pythonTerminal.run('value = 40')).output, />>> /);
  await pythonTerminal.close();
  pythonTerminal = await terminal(first);
  assert.match(stripAnsi(pythonTerminal.buf).trimEnd(), />>>$/, 'reconnect replaced the active Python prompt with a shell prompt');
  assert.match((await pythonTerminal.run('print(value + 2)')).output, /(?:^|\n)42\r?(?:\n|$)/);
  pythonTerminal.reset();
  pythonTerminal.cmd("import urllib.request; urllib.request.urlopen('http://127.0.0.1:3021/park').read(); open('/home/user/after-cancel', 'w').write('bad')");
  await until(
    () => exec(first, 'curl -fsS http://127.0.0.1:3021/park-state', { shellId: 'observer' }),
    (value) => value.trim() === 'parked',
    'Python did not enter the pending request',
    15_000,
  );
  pythonTerminal.send('\x03');
  await pythonTerminal.waitForPrompt(10_000);
  assert.match(stripAnsi(pythonTerminal.buf), /interrupt|cancel|reset/i, 'busy Ctrl-C did not report its outcome');
  assert.equal((await exec(first, 'curl -fsS http://127.0.0.1:3021/release', { shellId: 'observer' })).trim(), 'released');
  assert.match((await pythonTerminal.run('print(43)')).output, /(?:^|\n)43\r?(?:\n|$)/);
  assert.equal((await request(first, '/exists?path=/home/user/after-cancel')).exists, false, 'cancelled Python continued and wrote a file');
  await pythonTerminal.run('exit()');
  pythonTerminal.ws.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31 }));
  await until(() => request(first, '/terminal-size'), (size) => size.rows === 31 && size.columns === 101, 'resize did not reach the terminal');
  assert.equal((await request(first, '/state')).terminalAttachmentsPreserved, true, 'terminal attachment overwrote host metadata');
  await pythonTerminal.run('export TERMINAL_STATE=kept');
  await pythonTerminal.close();
  const reattached = await terminal(first);
  assert.match((await reattached.run('printf "state=%s\\n" "$TERMINAL_STATE"')).output, /(?:^|\n)state=kept\r?(?:\n|$)/);
  const bashTerminal = await terminal(second);
  await bashTerminal.run('bash');
  assert.match((await bashTerminal.run('printf "interactive-bash\\n"')).output, /(?:^|\n)interactive-bash\r?(?:\n|$)/);
  await bashTerminal.run('exit');
  console.log('PASS bash/Python terminals, real busy cancellation, resize and warm reconnect');

  const closedGenerations = new Map();
  for (const name of names) {
    const before = await request(name, '/host-alarm', 'POST');
    const after = await request(name, '/close', 'POST');
    assert.deepEqual(after.hostRows, [{ id: 'keep', value: 'host-owned' }]);
    const hostTask = before.scheduled.find((task) => task.reason === 'host');
    assert.ok(hostTask);
    assert.deepEqual(after.scheduled, [hostTask], 'runtime teardown changed host scheduling or left its own work queued');
    assert.equal(after.alarm, hostTask.at, 'runtime teardown removed or replaced the host alarm');
    assert.equal((await request(name, '/file?path=/home/user/identity.txt')).content, name === first ? 'alpha' : 'beta');
    closedGenerations.set(name, after.generation);
  }
  console.log('PASS runtime close preserves the supplied VFS, host data and scheduling');

  for (const name of names) {
    // Aborting the object deliberately aborts this request as well.
    const [eviction] = await Promise.allSettled([fetch(`${base}/workspaces/${name}/evict`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })]);
    if (eviction.status === 'fulfilled') {
      await eviction.value.text();
      assert.ok(eviction.value.status >= 500, 'the eviction request unexpectedly completed normally');
    }
    const recovered = await until(() => request(name, '/state'), (state) => state.generation > closedGenerations.get(name), 'object did not reopen after eviction');
    assert.deepEqual(recovered.hostRows, [{ id: 'keep', value: 'host-owned' }]);
  }
  assert.equal((await exec(first, 'python3 -c "print(42)"')).trim(), '42');
  assert.equal((await exec(second, "bash -c 'printf reopened'")).trim(), 'reopened');
  assert.equal((await exec(first, 'printf "%s:%s" "$PWD" "$LIBRARY_SHELL"', { shellId: 'one' })).trim(), '/home/user/one:one');
  console.log('PASS real object eviction restores installed runtimes and named-shell state');
} catch (error) {
  failures.push(error);
} finally {
  const results = await Promise.allSettled([
    ...terminals.map((attached) => attached.close()),
    ...names.map((name) => request(name, '/destroy', 'DELETE')),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
}
if (failures.length > 0) throw new AggregateError(failures, 'library-host acceptance failed');
