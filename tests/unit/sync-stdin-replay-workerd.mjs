// @serial
// A synchronous read of stdin waits for its writer, as under Node, and only
// when the program makes one.
//
// Node's fs.readFileSync(0) blocks the whole program until the parent ends
// stdin; readSync(0) blocks until some of it arrives. Code before the read
// runs first, so a child can print READY and its parent write only then. A
// program that merely contains such a read, or never reads, is never held.
// workerd cannot block a JavaScript stack (stop-replay.ts), so Nimbus stops a
// run that reaches such a read before its input is there, waits for the input,
// and runs the program again from the start with it, replaying what the
// stopped run saw and dropping the output it already delivered.
//
// Against the host's Node, through child_process (the broker) and through
// shell pipes:
//   - ready: READY, then `hello\n` and `world\n` 150 ms apart, then the end.
//   - delayed: `a`, 2 s, `b` and the end, written as the child starts.
//   - caught: the read inside try/catch; the stopped run's catch never runs.
//   - prompts: readSync answers each prompt as its line arrives.
//   - unused: a function that would read stdin, never called; stdin never ends.
//   - never-reads: stdin never ends and the program never reads it.
//   - nondeterministic: Math.random, Date.now, new Date() and
//     crypto.randomUUID printed before READY and again after the read.
// And Nimbus's own answers where Node has none: a program that changed the
// world before the read cannot be run again, and says so; Ctrl-C while the
// read waits is 130; a pipe whose writer is still running does not hold
// output of a program that never reads it.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLocalProbe } from './lib/workerd-probe.mjs';

const CHILDREN = {
  ready: [
    "const fs = require('fs');",
    "console.log('child: READY');",
    "const input = fs.readFileSync(0, 'utf8');",
    "console.log('child: got ' + JSON.stringify(input));",
    "console.log('child: done');",
  ].join('\n'),
  delayed: "console.log('SYNC ' + JSON.stringify(require('fs').readFileSync(0, 'utf8')))",
  caught: [
    "const fs = require('fs');",
    "console.log('child: READY');",
    'let input;',
    "try { input = fs.readFileSync(0, 'utf8'); } catch (e) { console.log('child: caught ' + e.code); input = ''; }",
    "console.log('child: got ' + JSON.stringify(input));",
  ].join('\n'),
  prompts: [
    "const fs = require('fs');",
    'const buf = Buffer.alloc(64);',
    'function line() {',
    "  let s = '';",
    '  for (;;) {',
    '    const n = fs.readSync(0, buf, 0, buf.length, null);',
    '    if (n === 0) return s || null;',
    "    s += buf.toString('utf8', 0, n);",
    "    if (s.endsWith('\\n')) return s.slice(0, -1);",
    '  }',
    '}',
    "console.log('name?');",
    'const name = line();',
    "console.log('hello ' + name + '; colour?');",
    'const colour = line();',
    "console.log(name + ' likes ' + colour);",
  ].join('\n'),
  unused: [
    "const fs = require('fs');",
    'function unused() { return fs.readFileSync(0); }',
    "console.log('child: printed');",
  ].join('\n'),
  neverReads: "console.log('child: ran')",
  nondeterministic: [
    "const fs = require('fs');",
    "const crypto = require('crypto');",
    "const draw = () => [Math.random(), Date.now(), new Date().toISOString(), crypto.randomUUID(), crypto.randomBytes(4).toString('hex')].join(' ');",
    "console.log('before ' + draw());",
    "console.log('child: READY');",
    "const input = fs.readFileSync(0, 'utf8');",
    "console.log('after ' + draw() + ' ' + JSON.stringify(input));",
  ].join('\n'),
  // The runner's stop and replay is its own: a program reaches nothing of it.
  private: "console.log('stopReplay ' + typeof globalThis.__nimbusStopReplay + ' ' + typeof __nimbusStopReplay)",
  // readSync past 1 MiB, its parent writing as the child drains: each run
  // after a stop is handed back all the stdin before it, however much.
  history: [
    "const fs = require('fs');",
    'const b = Buffer.alloc(65536);',
    'let total = 0, said = false;',
    'for (;;) {',
    '  const n = fs.readSync(0, b, 0, b.length, null);',
    '  if (n === 0) break;',
    '  total += n;',
    "  if (!said && total >= 1310720) { said = true; console.log('GOT1 ' + total); }",
    '}',
    "console.log('TOTAL ' + total);",
  ].join('\n'),
  // Its parent ends stdin while it runs, before it reads, and after it has
  // written a file (so it could not run again): the read finds the end.
  endedWhileRunning: [
    "const fs = require('fs');",
    "console.log('child: READY');",
    "setTimeout(async () => { await fs.promises.writeFile('/tmp/ended-' + process.pid, 'e'); console.log('got ' + fs.readFileSync(0, 'utf8')); }, 1500);",
  ].join('\n'),
  // A umask set before the read is that run's, even once the session has it
  // (the read waits a beat for it to land); the run after a stop starts from
  // the process's own.
  umask: [
    "const fs = require('fs');",
    'const before = process.umask(0o077);',
    "console.log('child: READY ' + (before === 0o077 ? 'already' : 'fresh'));",
    "setTimeout(() => { const input = fs.readFileSync(0, 'utf8'); console.log('umask ' + process.umask().toString(8) + ' ' + input); }, 500);",
  ].join('\n'),
};

// The parent: each case spawns a child and drives its stdin, and prints one
// CASE line of what came back.
const PARENT = [
  "const { spawn } = require('child_process');",
  `const CHILDREN = ${JSON.stringify(CHILDREN)};`,
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  'function run(name, drive) {',
  '  return new Promise((resolve) => {',
  "    const c = spawn('node', ['-e', CHILDREN[name]]);",
  "    let out = '', err = '';",
  '    const t0 = Date.now();',
  // Stuck at 30 s, which Node never is; the close is still awaited to 120 s,
  // so a late exit tells itself apart from a lost one (TIMING).
  '    let late = false, outAt = null;',
  '    const lateTimer = setTimeout(() => { late = true; }, 30000);',
  '    const lostTimer = setTimeout(() => { c.kill(); resolve({ stuck: true, lost: true, out, outAt }); }, 120000);',
  "    c.stdout.on('data', (d) => { out += d; outAt = Date.now() - t0; });",
  "    c.stderr.on('data', (d) => { err += d; });",
  '    const until = (text) => new Promise((ok) => { const iv = setInterval(() => { if (out.includes(text)) { clearInterval(iv); ok(); } }, 10); });',
  '    drive(c, until).catch(() => {});',
  "    c.on('close', (code) => { clearTimeout(lateTimer); clearTimeout(lostTimer); resolve({ code, out, err, ms: Date.now() - t0, outAt, stuck: late }); });",
  '  });',
  '}',
  'const cases = {',
  "  ready: async (c, until) => { await until('READY'); for (const s of ['hello\\n', 'world\\n']) { await sleep(150); c.stdin.write(s); } await sleep(150); c.stdin.end(); },",
  "  delayed: async (c) => { c.stdin.write('a'); await sleep(2000); c.stdin.end('b'); },",
  "  caught: async (c, until) => { await until('READY'); await sleep(150); c.stdin.end('late'); },",
  "  prompts: async (c, until) => { await until('name?'); await sleep(100); c.stdin.write('ada\\n'); await until('colour?'); await sleep(100); c.stdin.write('blue\\n'); await sleep(100); c.stdin.end(); },",
  '  unused: async () => {},',
  '  neverReads: async () => {},',
  "  nondeterministic: async (c, until) => { await until('READY'); await sleep(150); c.stdin.end('in'); },",
  '  private: async () => {},',
  "  history: async (c, until) => { const piece = Buffer.alloc(65536, 120); for (let i = 0; i < 20; i++) { if (!c.stdin.write(piece)) await new Promise((r) => c.stdin.once('drain', r)); } await until('GOT1'); await sleep(100); c.stdin.end('tail'); },",
  "  endedWhileRunning: async (c, until) => { await until('READY'); c.stdin.end('x'); },",
  "  umask: async (c, until) => { await until('READY'); await sleep(1500); c.stdin.end('x'); },",
  '};',
  '(async () => {',
  '  for (const [name, drive] of Object.entries(cases)) {',
  '    const r = await run(name, drive);',
  '    let shown = { code: r.code, out: r.out };',
  "    if (r.stuck) shown = { stuck: true, out: r.out };",
  // Within 10 s: neither waits for a stdin that never ends.
  "    else if (name === 'unused' || name === 'neverReads') shown.prompt = r.ms < 10000;",
  // The draws differ run to run; what must hold is that each line is printed
  // once and the draws after the read are new ones.
  "    else if (name === 'nondeterministic') {",
  "      const lines = r.out.trim().split('\\n');",
  "      const before = lines.filter((l) => l.startsWith('before ')), after = lines.filter((l) => l.startsWith('after '));",
  "      const draws = (l) => l.split(' ').slice(1, 6);",
  "      shown = { code: r.code, lines: lines.length, before: before.length, after: after.length, fresh: before.length === 1 && after.length === 1 && draws(before[0]).every((d, i) => i === 1 || i === 2 || d !== draws(after[0])[i]), input: after[0] && after[0].endsWith(' \"in\"') };",
  '    }',
  "    console.log('CASE ' + name + ' ' + JSON.stringify(shown));",
  "    console.log('TIMING ' + name + ' ' + JSON.stringify({ lastOutputMs: r.outAt, closeMs: r.lost ? null : r.ms }));",
  '  }',
  // A child killed while stuck may hold the parent open; the cases are done.
  '  process.exit(0);',
  '})();',
].join('\n');

const caseLines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('CASE ')).map((line) => line.replace(/\r$/, ''));

// ── The host's Node ─────────────────────────────────────────────────────────
const hostDir = mkdtempSync(join(tmpdir(), 'sync-stdin-replay-'));
let expected;
try {
  const host = spawnSync('node', ['-e', PARENT], { cwd: hostDir, encoding: 'utf8', timeout: 180_000 });
  assert.equal(host.status, 0, host.stderr);
  expected = caseLines(host.stdout);
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
assert.deepEqual(expected, [
  'CASE ready {"code":0,"out":"child: READY\\nchild: got \\"hello\\\\nworld\\\\n\\"\\nchild: done\\n"}',
  'CASE delayed {"code":0,"out":"SYNC \\"ab\\"\\n"}',
  'CASE caught {"code":0,"out":"child: READY\\nchild: got \\"late\\"\\n"}',
  'CASE prompts {"code":0,"out":"name?\\nhello ada; colour?\\nada likes blue\\n"}',
  'CASE unused {"code":0,"out":"child: printed\\n","prompt":true}',
  'CASE neverReads {"code":0,"out":"child: ran\\n","prompt":true}',
  'CASE nondeterministic {"code":0,"lines":3,"before":1,"after":1,"fresh":true,"input":true}',
  'CASE private {"code":0,"out":"stopReplay undefined undefined\\n"}',
  'CASE history {"code":0,"out":"GOT1 1310720\\nTOTAL 1310724\\n"}',
  'CASE endedWhileRunning {"code":0,"out":"child: READY\\ngot x\\n"}',
  'CASE umask {"code":0,"out":"child: READY fresh\\numask 77 x\\n"}',
], 'the host blocks each read for its input and nothing else');

// ── Nimbus ──────────────────────────────────────────────────────────────────
const W = '/home/user/w';
console.log('sync-stdin-replay-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
process.env.BASE = probe.base;
process.env.NIMBUS_PROBE_TOKEN = probe.token;
const { mintSession, deleteSession, Terminal } = await import('../behavioral/_driver.mjs');
const strip = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const failures = [];
let workerLog = '';
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${ok ? what.split('\n')[0] : what}`); };
try {
  const sid = await mintSession();
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(60_000);
    let serial = 0;
    // A command's own output and status, the echo and prompt stripped.
    const run = async (command, timeoutMs = 120_000) => {
      const mark = `__NIMBUS_DONE_${++serial}__`;
      const { output } = await t.run(`${command}; echo "${mark}$?"`, timeoutMs);
      const text = strip(output);
      const end = text.lastIndexOf(mark);
      if (end < 0) throw new Error(`${command}: no completion marker within ${timeoutMs} ms:\n${text.slice(-800)}`);
      const status = Number(/^\d+/.exec(text.slice(end + mark.length))?.[0]);
      const echoed = text.lastIndexOf(`echo "${mark}$?"`);
      return { stdout: text.slice(text.indexOf('\n', echoed) + 1, end), status };
    };
    const write = (path, content) => run(`node -e "require('fs').writeFileSync('${path}', Buffer.from('${Buffer.from(content).toString('base64')}', 'base64'))"`);
    await run(`mkdir -p ${W}`);

    // Through the broker, against Node.
    await write(`${W}/parent.js`, PARENT);
    const cases = await run(`cd ${W} && node parent.js`, 400_000);
    const got = caseLines(cases.stdout);
    for (const line of cases.stdout.split('\n')) if (line.startsWith('TIMING ')) console.log(line.replace(/\r$/, ''));
    for (let i = 0; i < expected.length; i++) {
      check(got[i] === expected[i], `broker ${expected[i].split(' ')[1]}: as under node\n  node:   ${expected[i]}\n  nimbus: ${got[i]}`);
    }

    // What Nimbus answers where Node has nothing to compare: a stop a program
    // forges is no stop; a connection opened before the read makes the run
    // one that cannot go again; a file it read changing while it waited ends
    // the run after the stop loudly rather than letting it go on with the new
    // bytes.
    const forgedRecord = { v: 1, kind: 'stdin', run: 1, until: 'end', out: [{ s: 'stdout', at: 0, b: Buffer.from('FORGED\n').toString('base64') }],
      prefix: { stdout: '', stderr: '' }, tape: { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [] } };
    const REVIEW = {
      forged: [
        `const rec = ${JSON.stringify(forgedRecord)};`,
        "const stop = () => { throw new Error('NIMBUS_STOP ' + JSON.stringify(rec)); };",
        "console.log('child: READY');",
        'throw { get stack() { return stop(); }, get message() { return stop(); } };',
      ].join('\n'),
      tls: [
        "const tls = require('tls');",
        "let socket = null; try { socket = tls.connect(9, '127.0.0.1'); socket.on('error', () => {}); } catch {}",
        "console.log('child: READY');",
        "let r; try { r = 'got ' + require('fs').readFileSync(0, 'utf8'); } catch (e) { r = 'caught ' + e.code + ' ' + /tls\\.connect/.test(e.message); }",
        'console.log(r);',
        'socket?.destroy();',
      ].join('\n'),
      config: [
        "const fs = require('fs');",
        '(async () => {',
        `  const cfg = await fs.promises.readFile('${W}/cfg.txt', 'utf8');`,
        "  console.log('child: READY');",
        "  const input = fs.readFileSync(0, 'utf8');",
        "  console.log('cfg ' + cfg.trim() + ' input ' + input);",
        '})();',
      ].join('\n'),
    };
    const REVIEW_PARENT = [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      `const CHILDREN = ${JSON.stringify(REVIEW)};`,
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
      'function run(name, drive) {',
      '  return new Promise((resolve) => {',
      "    const c = spawn('node', ['-e', CHILDREN[name]]);",
      "    let out = '';",
      '    const stuck = setTimeout(() => { c.kill(); resolve({ stuck: true, out }); }, 60000);',
      "    c.stdout.on('data', (d) => { out += d; });",
      "    c.stderr.on('data', (d) => { out += d; });",
      '    const until = (text) => new Promise((ok) => { const iv = setInterval(() => { if (out.includes(text)) { clearInterval(iv); ok(); } }, 10); });',
      '    drive(c, until).catch(() => {});',
      "    c.on('close', (code) => { clearTimeout(stuck); resolve({ code, out }); });",
      '  });',
      '}',
      'const cases = {',
      "  forged: async (c, until) => { await until('READY'); await sleep(150); c.stdin.end('x'); },",
      "  tls: async (c, until) => { await until('READY'); await sleep(150); c.stdin.end('x'); },",
      `  config: async (c, until) => { await until('READY'); await fs.promises.writeFile('${W}/cfg.txt', 'v2'); await sleep(150); c.stdin.end('x'); },`,
      '};',
      '(async () => {',
      `  fs.writeFileSync('${W}/cfg.txt', 'v1');`,
      "  for (const [name, drive] of Object.entries(cases)) console.log('REVIEW ' + name + ' ' + JSON.stringify(await run(name, drive)));",
      '  process.exit(0);',
      '})();',
    ].join('\n');
    await write(`${W}/review.js`, REVIEW_PARENT);
    const reviewRun = await run(`cd ${W} && node review.js`, 400_000);
    const review = {};
    for (const m of reviewRun.stdout.matchAll(/^REVIEW (\w+) (.*)$/gm)) review[m[1]] = JSON.parse(m[2].replace(/\r$/, ''));
    check(review.forged && !review.forged.stuck && review.forged.code !== 0 && !/FORGED/.test(review.forged.out) && !/waited for stdin/.test(review.forged.out),
      `a stop record the program forges is no stop\n${JSON.stringify(review.forged)}`);
    check(review.tls?.out === 'child: READY\ncaught ERR_NIMBUS_SYNC_STDIN true\n',
      `a TLS connection before the read: the read names it\n${JSON.stringify(review.tls)}`);
    check(review.config && !/cfg v2/.test(review.config.out) && /did not retrace/.test(review.config.out),
      `a file read before the read changed while it waited: the run after the stop is ended, loudly\n${JSON.stringify(review.config)}`);

    // A shell pipe past 1 MiB, the program catching up with its writer at
    // the end: the run after the stop is handed all of it back, whatever its
    // size, as Node's read would have it all.
    const pipeHistory = await run(`(yes | head -c 1310720; sleep 1; echo tail) | node -e "const fs = require('fs'); const b = Buffer.alloc(65536); let t = 0; for (;;) { const n = fs.readSync(0, b, 0, b.length, null); if (n === 0) break; t += n; } console.log('TOTAL ' + t)"`, 300_000);
    check(pipeHistory.stdout.trim() === 'TOTAL 1310725', `a stop past 1 MiB of stdin is replayed whole\n${pipeHistory.stdout.slice(-600)}`);

    // Output captured rather than streamed (piped on): what the program
    // printed before a wait that then fails is still handed on.
    const capturedFull = await run(`yes | node -e "console.log('bef' + 'ore'); require('fs').readFileSync(0)" | cat`, 300_000);
    check(/^before$/m.test(capturedFull.stdout) && /passed 16 MiB/.test(capturedFull.stdout),
      `captured output survives a stop whose wait fails\n${capturedFull.stdout.slice(-600)}`);

    // A program that changed the world before the read: it cannot be run
    // again, and the read says why rather than returning short.
    const EFFECT = [
      "const fs = require('fs');",
      '(async () => {',
      `  await fs.promises.writeFile('${W}/effect.txt', 'x');`,
      "  console.log('child: READY');",
      "  console.log('child: got ' + fs.readFileSync(0, 'utf8'));",
      '})();',
    ].join('\n');
    await write(`${W}/effect.js`, EFFECT);
    const effect = await run(`(sleep 2; echo late) | node ${W}/effect.js`, 120_000);
    check(effect.status === 1 && /ERR_NIMBUS_SYNC_STDIN/.test(effect.stdout) && /writeFile/.test(effect.stdout) && !/child: got/.test(effect.stdout),
      `effect then read: the precise error, exit 1\n${effect.stdout}`);

    // Through a shell pipe: the read waits for the writer, and output of a
    // program that does not read comes at once.
    const piped = await run(`(echo a; sleep 2; echo b) | node -e "console.log(JSON.stringify(require('fs').readFileSync(0, 'utf8')))"`, 120_000);
    check(piped.status === 0 && piped.stdout.trim() === '"a\\nb\\n"', `pipe: readFileSync(0) waits for the writer\n${piped.stdout}`);
    t.reset();
    const t0 = Date.now();
    t.cmd(`sleep 8 | node -e "function u(){require('fs').readFileSync(0)} console.log('print' + 'ed')"`);
    const printedAfter = await t.waitFor((b) => /\nprinted/.test(b), 60_000, 'printed');
    await t.waitForNewPrompt(60_000);
    check(printedAfter < 5_000, `pipe: an unused reader prints before its writer ends (${printedAfter} ms, writer 8000 ms)`);

    // Ctrl-C while the read waits ends the program with 130, as it does
    // node blocked in the read.
    t.reset();
    t.cmd(`sleep 60 | node -e "console.log('wait' + 'ing'); require('fs').readFileSync(0)"`);
    await t.waitFor((b) => /\nwaiting/.test(b), 60_000, 'waiting');
    await new Promise((r) => setTimeout(r, 1000));
    const c0 = Date.now();
    t.send('\x03');
    await t.waitForNewPrompt(30_000);
    const interrupted = Date.now() - c0;
    // The interrupted line's status, read by the next one.
    const status = Number(/S=(\d+)/.exec((await run('echo "S=$?"')).stdout)?.[1]);
    check(status === 130 && interrupted < 10_000, `Ctrl-C during the wait: status ${status}, the prompt back after ${interrupted} ms`);
    // A server started from the terminal: the shell waits for its boot and
    // nothing can write its stdin meanwhile, so the read says so rather than
    // holding the terminal.
    await write(`${W}/term-srv.js`, "require('fs').readFileSync(0); require('http').createServer((q, s) => s.end('x')).listen(8961);");
    const termSrv = await run(`cd ${W} && node term-srv.js`, 120_000);
    check(/ERR_NIMBUS_SYNC_STDIN/.test(termSrv.stdout) && /started from the terminal/.test(termSrv.stdout),
      `a terminal-started server's read names why it cannot wait\n${termSrv.stdout}`);
  } finally {
    await t.close().catch(() => {});
    await deleteSession(sid).catch(() => {});
  }

  // A resident the SDK starts, whose stdin the caller writes and ends: its
  // boot waits for the input, as under Node, and what it printed before the
  // read is in its log once.
  const { Nimbus } = await import('../../packages/sdk/src/index.ts');
  const box = Nimbus.connect({ endpoint: probe.base, token: probe.token }).sandbox(`sync-stdin-${Date.now()}`);
  try {
    await box.files.mkdir('/home/user/rs');
    await box.files.write('/home/user/rs/srv.js', [
      "const fs = require('fs');",
      "console.log('RS before ' + Math.random());",
      "const cfg = fs.readFileSync(0, 'utf8');",
      "require('http').createServer((q, s) => s.end('RS ' + cfg)).listen(8960, () => console.log('RS listening'));",
    ].join('\n'));
    const job = await box.startProcess('node srv.js', { cwd: '/home/user/rs' });
    const until = async (what, read, ms = 60_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    await until('RS before in the log', async () => /RS before/.test((await box.processes.logs(job.pid)).text));
    await new Promise((r) => setTimeout(r, 1500));
    await box.processes.write(job.pid, 'cfg-1');
    await box.processes.endInput(job.pid);
    await until('the server on 8960', async () => (await box.ports.list()).find((p) => p.port === 8960));
    const answer = await box.exec('curl -s http://localhost:8960/');
    const log = (await box.processes.logs(job.pid)).text;
    check(answer.stdout.trim() === 'RS cfg-1' && (log.match(/RS before/g) || []).length === 1 && /RS listening/.test(log),
      `an SDK resident's boot waits for its stdin: answered ${JSON.stringify(answer.stdout)}, log ${JSON.stringify(log)}`);
    await box.processes.kill(job.pid).catch(() => {});
  } finally {
    await box.destroy().catch(() => {});
  }
} catch (error) {
  // What the worker said, for a failure the driver only sees as a closed socket.
  const logPath = join(tmpdir(), `sync-stdin-replay-workerd-${Date.now()}.log`);
  writeFileSync(logPath, probe.log());
  console.error(`sync-stdin-replay-workerd: the worker's log is ${logPath}`);
  throw error;
} finally {
  workerLog = probe.log();
  await probe.stop();
}
if (failures.length > 0) {
  const logPath = join(tmpdir(), `sync-stdin-replay-workerd-${Date.now()}.log`);
  writeFileSync(logPath, workerLog);
  console.error(`sync-stdin-replay-workerd: the worker's log is ${logPath}`);
  console.error(`sync-stdin-replay-workerd: ${failures.length} failure(s):\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log('sync-stdin-replay-workerd: synchronous stdin reads wait for their input, and only reads do');
