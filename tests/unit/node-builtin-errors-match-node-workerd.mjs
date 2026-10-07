// @serial
// The errors of the builtins a session's node takes from workerd (zlib,
// crypto, buffer, events, url, path, util, vm, repl, diagnostics_channel,
// tls, net, async_hooks, inspector) against host Node's, on the same
// script: every exported function and class of each, called with no
// arguments and with arguments of the wrong type. Where both throw the same
// code and words, the error has Node's shape: name, constructor, String(),
// stack header, own keys (node-shims.ts, "The builtins workerd provides").
// Before, 246 had workerd's: own name and toString, no [CODE] in the stack.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/builtin-errors';
const PROBE = String.raw`
const MODULES = ['zlib', 'crypto', 'buffer', 'events', 'url', 'path', 'util', 'vm', 'repl', 'diagnostics_channel', 'tls', 'net', 'async_hooks', 'inspector'];
// What would start something rather than fail: a REPL on stdin, the
// inspector's port, a connection, a server.
const SKIP = new Set(['repl.start', 'inspector.open', 'inspector.waitForDebugger', 'inspector.close', 'net.connect', 'net.createConnection', 'tls.connect', 'net.createServer', 'tls.createServer', 'net.Server', 'tls.Server', 'net.Socket', 'tls.TLSSocket', 'repl.REPLServer', 'inspector.Session', 'events.on', 'events.once', 'util.debuglog', 'util.debug']);
const ARGS = [[], [Symbol('s')], [5], [{}], ['x', 5]];
const shape = (e) => {
  if (e === null || typeof e !== 'object') return { primitive: String(e) };
  let header; try { header = String(e.stack).split('\n')[0]; } catch { header = '<stack threw>'; }
  let string; try { string = String(e); } catch { string = '<toString threw>'; }
  return { name: e.name, code: e.code, ctor: e.constructor && e.constructor.name, header, string, keys: Object.keys(e), ownName: Object.prototype.hasOwnProperty.call(e, 'name'), message: e.message };
};
(async () => {
  for (const name of MODULES) {
    const mod = require(name);
    for (const key of Object.keys(mod).sort()) {
      const id = name + '.' + key;
      if (SKIP.has(id) || typeof mod[key] !== 'function') continue;
      const isClass = /^[A-Z]/.test(key);
      for (const args of ARGS) {
        const row = { id, args: args.map(String) };
        let result;
        try {
          result = isClass ? new mod[key](...args) : mod[key].apply(mod, args);
          row.returned = true;
        } catch (e) { row.sync = shape(e); }
        if (result && typeof result.then === 'function') {
          const settled = await Promise.race([result.then(() => 'ok', (e) => ({ async: shape(e) })), new Promise((r) => setTimeout(() => r('pending'), 50))]);
          if (typeof settled === 'object') Object.assign(row, settled);
        }
        process.stdout.write('@@' + JSON.stringify(row) + '\n');
      }
    }
  }
  process.exit(0);
})();
`;

const host = mkdtempSync(join(tmpdir(), 'builtin-errors-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
writeFileSync(join(host, 'probe.cjs'), PROBE);
const expected = spawnSync('node', ['probe.cjs'], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: host }, maxBuffer: 64 << 20 });
assert.equal(expected.status, 0, expected.stderr);
const rows = (text) => new Map(text.split('\n').filter((line) => line.startsWith('@@')).map((line) => {
  const row = JSON.parse(line.slice(2));
  return [row.id + '(' + row.args.join(',') + ')', row];
}));
const want = rows(expected.stdout);

console.log('node-builtin-errors-match-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
let got;
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const made = await session.run(`mkdir -p ${W}`, 30_000);
    assert.equal(made.status, 0, made.stdout);
    await session.writeFile(`${W}/probe.cjs`, PROBE);
    const r = await session.run(`cd ${W} && node probe.cjs > out.txt 2>/dev/null; cat out.txt`, 300_000);
    got = rows(splitScenarioOutput(r.stdout).lines.join('\n'));
    assert.ok(got.size > 0, `the probe ran: ${r.stdout.slice(-2000)}`);
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}

// Only where Node throws an error with a code. Where the builtin throws one
// with the same code and words, it has Node's shape (the forwarding
// boundary); where it does not, the difference is the one recorded in
// tests/fixtures/builtin-error-gaps.json — Node's argument validation and
// the functions workerd lacks, which are their own work — no more and no
// fewer: a gap closed is taken off the list.
const GAPS = JSON.parse(readFileSync(new URL('../fixtures/builtin-error-gaps.json', import.meta.url), 'utf8'));
const shapes = [];
const gaps = {};
let compared = 0;
for (const [call, node] of want) {
  const thrown = node.sync ?? node.async;
  if (!thrown || thrown.code === undefined) continue;
  compared++;
  const ours = got.get(call);
  const theirs = ours ? (ours.sync ?? ours.async) : undefined;
  const gap = ours === undefined ? 'missing' : theirs === undefined ? 'no-throw'
    : theirs.code !== thrown.code ? (theirs.code === undefined ? 'uncoded' : 'other-code')
    : theirs.message !== thrown.message ? 'wording' : null;
  if (gap !== null) { gaps[call] = gap; continue; }
  for (const field of ['name', 'code', 'ctor', 'header', 'string', 'keys', 'ownName']) {
    if (JSON.stringify(theirs[field]) !== JSON.stringify(thrown[field])) shapes.push(`${call} ${field}: ${JSON.stringify(thrown[field])} here ${JSON.stringify(theirs[field])}`);
  }
}
console.log(`compared ${compared} coded errors: ${compared - Object.keys(gaps).length} as Node words them, ${Object.keys(gaps).length} recorded gaps`);
assert.deepEqual(shapes, [], `Node's shape:\n${shapes.join('\n')}`);
const changed = [...new Set([...Object.keys(gaps), ...Object.keys(GAPS)])].filter((call) => gaps[call] !== GAPS[call])
  .map((call) => `${call}: recorded ${GAPS[call] ?? 'none'}, now ${gaps[call] ?? 'none'}`);
assert.deepEqual(changed, [], `the gaps are the recorded ones (update tests/fixtures/builtin-error-gaps.json when one closes):\n${changed.join('\n')}`);
console.log('node-builtin-errors-match-node-workerd: the builtins workerd provides fail with Node\'s shape; their other differences are the recorded ones');
