#!/usr/bin/env bun
// A resident process ends as Node's does: when it holds no live handle.
//
// A program judged to start a server runs resident, where a port is routed.
// Its end used to be only process.exit: a resident that simply finished (a
// CLI whose serve path was not taken, `--help`, a server that closed) kept
// running and never reported an exit. It now ends when the handles Node
// counts are gone (timers, operations in flight, listening servers not
// unref'd, a held stdin, open connections: an HTTP exchange being answered, a
// WebSocket or tls client), with the one-shot's accounting, and reports its exit
// as process.exit does. One that finishes during its boot reports before the
// boot answers, so the shell prints its exit instead of "started".
// `--watch` still holds a process with nothing left.
//
// This is the acceptance for the server-launch prediction: a program wrongly
// predicted resident still ends exactly as in Node (only a server predicted
// one-shot is a bug).
//
// The real generated resident body, one launch per child process.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createAuthority, facetSupervisor, launchResident, runScenarios, sleep, until } from './lib/resident-body.mjs';

// The test's own timers, captured before a launch replaces the global ones.
const rawSetTimeout = globalThis.setTimeout;

/** Launch `program` resident, with `files` (VFS key → text) in the session and its bundle. */
async function launch(program, { files = {}, supervisorOverrides = {}, ...options } = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  for (const [path, text] of Object.entries(files)) {
    authority.kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    authority.kfs.writeFile(path, text);
  }
  const { supervisor, log } = facetSupervisor(authority, supervisorOverrides);
  const { proc } = await launchResident({
    authority, program, env: { SUPERVISOR: supervisor }, cursor: authority.cursor(), bundle: files, ...options,
  });
  return { log, proc };
}

/** Commander 11.1.0 itself, installed at home/user/app/node_modules/commander. */
function commanderFiles() {
  const root = new URL('../../node_modules/.bun/commander@11.1.0/node_modules/commander/', import.meta.url).pathname;
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(js|json)$/.test(name)) files[`home/user/app/node_modules/commander/${rel}`] = readFileSync(join(root, rel), 'utf8');
    }
  };
  walk('');
  return files;
}

const SERVER = 'const server = require("http").createServer((req, res) => res.end("hi"));';

await runScenarios(import.meta.filename, {
  async finishedProgramExits() {
    const { log } = await launch('console.log("done");');
    assert.deepEqual(log.exit, { code: 0, reason: '' }, 'reported before its boot answered');
    assert.equal(log.stdout, 'done\n');
  },

  async serverThatClosesItsLastListenerExits() {
    const { log } = await launch(`${SERVER}\nserver.listen(3000, () => setTimeout(() => server.close(), 1500));`);
    assert.equal(log.exit, null, 'still serving when its boot answered');
    assert.deepEqual([...log.ports], [3000]);
    await until(() => log.exit !== null, 'the exit after close', 5_000);
    assert.deepEqual(log.exit, { code: 0, reason: '' });
    assert.deepEqual([...log.ports], [], 'the port is released');
  },

  async unrefdListenerAloneExits() {
    const { log } = await launch(`${SERVER}\nserver.listen(3000).unref();`);
    assert.deepEqual(log.exit, { code: 0, reason: '' });
  },

  async idleServerStaysUp() {
    const { log, proc } = await launch(`${SERVER}\nserver.listen(3000);`);
    const response = await proc.fetch(new Request('http://facet/', { headers: { 'X-Nimbus-Port': '3000' } }));
    assert.equal(response.status, 200);
    await sleep(300);
    assert.equal(log.exit, null, 'a live listener holds it, across a request');
    assert.deepEqual([...log.ports], [3000]);
  },

  async pendingTimerExitsAfterItFires() {
    const { log } = await launch('setTimeout(() => console.log("fired"), 1500);');
    assert.equal(log.exit, null, 'the timer is pending when its boot answered');
    await until(() => log.exit !== null, 'the exit after the timer', 5_000);
    assert.equal(log.stdout, 'fired\n');
    assert.deepEqual(log.exit, { code: 0, reason: '' });
  },

  async processExitStillDecides() {
    const { log } = await launch('setInterval(() => {}, 100);\nsetTimeout(() => process.exit(3), 1200);');
    await until(() => log.exit !== null, 'the explicit exit', 5_000);
    assert.equal(log.exit.code, 3);
  },

  // Predicted resident though it serves nothing: it loads a module exporting a
  // Commander program with a serving action, and parses another's, whose
  // action only prints. Commander runs only the parsed program's action.
  async wrongResidentPredictionEndsAsInNode() {
    const program = (action) => [
      "const { Command } = require('commander');",
      'const program = new Command();',
      `program.action(${action});`,
      'module.exports = program;',
    ].join('\n');
    const { log } = await launch("require('./unused.js');\nrequire('./used.js').parse(process.argv);", {
      files: {
        ...commanderFiles(),
        'home/user/app/unused.js': program("() => require('http').createServer().listen(3000)"),
        'home/user/app/used.js': program("() => console.log('built')"),
      },
    });
    assert.equal(log.stdout, 'built\n');
    assert.deepEqual(log.exit, { code: 0, reason: '' });
    assert.deepEqual([...log.ports], []);
  },

  // An HTTP exchange outlives the listener, as its connection does in Node:
  // the handler closes the server, streams 'first', then answers the rest of
  // a streaming upload. Node 22 keeps running until the exchange completes.
  async openExchangeOutlivesClosedServer() {
    const { log, proc } = await launch([
      'const server = require("http").createServer(async (req, res) => {',
      '  server.close();',
      '  res.writeHead(200); res.flushHeaders(); res.write("first");',
      '  let data = ""; for await (const chunk of req) data += Buffer.from(chunk).toString();',
      '  res.end("last:" + data);',
      '});',
      'server.listen(3000);',
    ].join('\n'));
    let upload;
    const body = new ReadableStream({ start(controller) { upload = controller; controller.enqueue(new TextEncoder().encode('a')); } });
    const response = await proc.fetch(new Request('http://facet/', { method: 'POST', headers: { 'X-Nimbus-Port': '3000' }, body, duplex: 'half' }));
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
    await sleep(300);
    assert.equal(log.exit, null, 'still running while the upload and the response are open');
    upload.enqueue(new TextEncoder().encode('b'));
    upload.close();
    let rest = '';
    for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    assert.equal(rest, 'last:ab');
    await until(() => log.exit !== null, 'the exit after the exchange', 5_000);
    assert.deepEqual(log.exit, { code: 0, reason: '' });
  },

  // A request body the handler never reads does not hold the process.
  async ignoredRequestBodyDoesNotHold() {
    const { log, proc } = await launch([
      'const server = require("http").createServer((req, res) => { server.close(); res.end("ok"); });',
      'server.listen(3000);',
    ].join('\n'));
    const response = await proc.fetch(new Request('http://facet/', { method: 'POST', headers: { 'X-Nimbus-Port': '3000' }, body: 'unread' }));
    assert.equal(await response.text(), 'ok');
    await until(() => log.exit !== null, 'the exit after the answered request', 5_000);
    assert.deepEqual(log.exit, { code: 0, reason: '' });
  },

  // A WebSocket client holds the process until it closes, as in Node: here
  // the peer closes it, and nothing else holds the program meanwhile.
  async webSocketClientHoldsUntilClosed() {
    let opened = 0;
    const { log } = await launch([
      'const socket = new WebSocket("wss://relay.invalid/feed");',
      'socket.onclose = (event) => console.log("closed " + event.code);',
    ].join('\n'), {
      supervisorOverrides: {
        wsOpen: async () => { opened = Date.now(); return { id: 7, protocol: '' }; },
        wsPoll: async () => {
          await sleep(40);
          return Date.now() - opened > 2_500 ? [{ kind: 'close', code: 1000, reason: '' }] : [];
        },
        wsSend: async () => {},
        wsClose: async () => {},
      },
    });
    assert.equal(log.exit, null, 'the open socket holds it past its boot');
    await until(() => log.exit !== null, 'the exit after the peer closes', 6_000);
    assert.equal(log.stdout, 'closed 1000\n');
    assert.deepEqual(log.exit, { code: 0, reason: '' });
  },

  // So does a tls.connect socket, until it closes: here the peer accepts the
  // connection and drops it, with no handshake, 2.5 s later.
  async tlsSocketHoldsUntilClosed() {
    const net = await import('node:net');
    const peer = net.createServer((connection) => { rawSetTimeout(() => connection.destroy(), 2_500); });
    await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
    const { log } = await launch([
      `const socket = require("tls").connect({ host: "127.0.0.1", port: ${peer.address().port}, rejectUnauthorized: false });`,
      'socket.on("error", () => {});',
      'socket.on("close", () => console.log("closed"));',
    ].join('\n'));
    assert.equal(log.exit, null, 'the open socket holds it past its boot');
    await until(() => log.exit !== null, 'the exit after the peer drops it', 6_000);
    assert.equal(log.stdout, 'closed\n');
    assert.deepEqual(log.exit, { code: 0, reason: '' });
    peer.close();
  },

  // A handle whose creation throws, caught by the program, holds nothing:
  // Node 22 prints the same five errors and exits 0.
  async caughtCreationFailuresHoldNothing() {
    const program = [
      'for (const [name, make] of [',
      '  ["ws", () => new WebSocket("wss://relay.invalid/feed", [Object.create(null)])],',
      '  ["timer", () => setTimeout(() => {}, Symbol("delay"))],',
      '  ["interval", () => setInterval(() => {}, Symbol("delay"))],',
      '  ["tls", () => require("tls").connect({ host: "127.0.0.1", port: -1 })],',
      '  ["http", () => require("http").request({ host: "127.0.0.1", port: 1, method: "BAD METHOD" })],',
      ']) {',
      '  try { make(); console.log(name + ":created"); } catch (error) { console.log(name + ":" + error.name); }',
      '}',
    ].join('\n');
    const node = Bun.spawnSync(['node', '-e', program], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    assert.equal(node.exitCode, 0, node.stderr.toString());
    const { log } = await launch(program, {
      supervisorOverrides: { wsOpen: async () => ({ id: 7, protocol: '' }), wsPoll: async () => [], wsClose: async () => {} },
    });
    assert.equal(log.stdout, node.stdout.toString(), 'the same errors as Node');
    assert.deepEqual(log.exit, { code: 0, reason: '' }, 'and the same exit, before its boot answered');
  },

  async watchHoldsAFinishedProgram() {
    const { log } = await launch('console.log("done");', { argv: ['--watch', '/home/user/app/main.js'] });
    await sleep(300);
    assert.equal(log.exit, null, '--watch waits for a change');
  },
});
console.log('resident-natural-exit: ok');
