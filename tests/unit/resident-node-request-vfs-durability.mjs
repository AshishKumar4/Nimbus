#!/usr/bin/env bun
// A response from a resident Node server is a durability boundary: a request is
// answered only once the writes its handler made have reached the session. The
// process's writes reach the session in the order they were made, so concurrent
// appends, ranged FileHandle writes, truncates and retries after a failure land
// in order, and none is lost. Each scenario is a process of its own over the real
// session (runScenarios).

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetStorage } from './lib/fake-do-kv.mjs';
import { importModuleSet } from './lib/module-map-bundle.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { createAuthority, facetSql, facetSupervisor, launchResident, runScenarios, sleep } from './lib/resident-body.mjs';
import { observeWaves, shimsOnSession } from './lib/shims-on-session.mjs';

const PORT = 4387;
const RESULT = '/home/user/request-result.txt';
const LIVE = '/home/user/live-prefix.txt';
const WAVE = ['writeBatchStream'];
const MUTATIONS = ['writeBatchStream', 'fsWrite', 'fsWriteRange', 'fsTruncate', 'fsFtruncate'];
const dec = new TextDecoder();

const key = (path) => path.replace(/^\/+/, '');
const EIO = (message) => Object.assign(new Error(message), { code: 'EIO' });
const request = (path) => new Request(`http://127.0.0.1:${PORT}/${path}`, { headers: { 'X-Nimbus-Port': String(PORT) } });

/** The session's answer to a wave it refuses with `errno`: a verdict, nothing of the wave applied. */
const refusedWave = (errno) => ({
  ok: false, committedGroupSequence: 0, committedPathCount: 0, committedOps: 0, inodes: 0, chunks: 0, receipts: [],
  error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'publish', message: `${errno}: refused`, errno },
});

/** What the session receives of the process's calls, in the order it receives them. */
function recordOps(ops) {
  const open = new Map();
  return (record) => {
    if (record.type === 'file-begin') {
      const op = { path: record.inode.path, call: record.inode.call, offset: record.inode.offset, text: '' };
      ops.push(op);
      open.set(record.streamContentId, op);
    } else if (record.type === 'file-chunk') {
      open.get(record.streamContentId).text += dec.decode(record.data);
    } else if (record.type === 'truncate') {
      ops.push({ path: record.path, call: 'truncate', size: record.size });
    } else if (record.type === 'call') {
      ops.push({ path: record.call.path, call: record.call.call });
    }
  };
}

/** The data the session received for `path`, in order. */
const received = (ops, path) => ops.filter((op) => op.path === key(path) && op.text !== undefined).map((op) => op.text);

/**
 * The session's calls, gated: once armed, the next call among `only` is held
 * (`held` settles once it is in hand) until `release`, and the others pass.
 */
function gateOf() {
  let hold = null;
  const made = [];
  return {
    arm(only = WAVE) {
      const held = Promise.withResolvers();
      const released = Promise.withResolvers();
      hold = { only, held, released };
      const timeout = sleep(5_000).then(() => {
        throw new Error(`no ${only.join(' or ')} was held within 5 s; the calls made: ${JSON.stringify(made)}`);
      });
      return { held: Promise.race([held.promise, timeout]), release: () => released.resolve() };
    },
    through(name, next) {
      return async (...args) => {
        made.push(name);
        if (hold !== null && hold.only.includes(name)) {
          const current = hold;
          hold = null;
          current.held.resolve();
          await current.released.promise;
        }
        return next(...args);
      };
    },
  };
}

/**
 * The session's answers to a process's calls, as shimsOnSession's overrides
 * take them (`forward` is the session's): each wave is recorded in `ops` as the
 * session receives it, and `wave` (default: as it is) answers it. With `gate`,
 * the calls that change the filesystem pass through it, and `fail` names the
 * error a direct call is answered with once the gate lets it through.
 */
function sessionCalls(ops, forward, { wave = (next) => next, gate = null, fail = () => null } = {}) {
  const through = (name, next) => (gate === null ? next : gate.through(name, next));
  const direct = (name) => through(name, (...args) => {
    const failure = fail(name);
    if (failure !== null) throw failure;
    return forward(name, args);
  });
  return {
    writeBatchStream: through('writeBatchStream', wave(observeWaves(forward, recordOps(ops)))),
    ...(gate === null ? {} : {
      fsWrite: direct('fsWrite'),
      fsWriteRange: direct('fsWriteRange'),
      fsTruncate: direct('fsTruncate'),
      fsFtruncate: direct('fsFtruncate'),
    }),
  };
}

/** A node program over `authority` (shimsOnSession), its calls as sessionCalls answers them. */
function nodeOnSession(authority, options = {}) {
  const ops = [];
  const shims = shimsOnSession({ authority, overrides: (forward) => sessionCalls(ops, forward, options) });
  return { ...shims, ops };
}

/** A resident node program over `authority`, started as a launch starts it; `hooks` replace any of its calls. */
async function residentOnSession(authority, program, { hooks = {}, ...options } = {}) {
  const ops = [];
  let forward;
  const handle = facetSupervisor(authority, { ...sessionCalls(ops, (name, args) => forward(name, args), options), ...hooks });
  forward = handle.forward;
  const { proc } = await launchResident({
    authority, program, env: { SUPERVISOR: handle.supervisor }, cwd: '/home/user', cursor: authority.cursor(),
  });
  return { proc, handle, ops };
}

async function flushKeepsNewerWrite(initial, newer) {
  const authority = createAuthority();
  const path = '/home/user/flush-race.txt';
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const older = gate.arm();
  fs.writeFileSync(path, initial);
  const flushing = fs.promises.truncate(path, String(initial).length);
  await older.held;
  fs.writeFileSync(path, newer);
  older.release();
  await flushing;
  await fs.promises.truncate(path, String(newer).length);
  assert.equal(fs.readFileSync(path, 'utf8'), newer, 'an async helper flush clears only the mutation generation it persisted');
  assert.equal(await authority.peer.readFileString(path), newer, 'the session holds the newer write');
  assert.deepEqual(received(ops, path), [initial, newer], 'the next helper boundary persists the newer pending cell');
}

async function sameBoundaryWaitsBehindOlderFlush() {
  const authority = createAuthority();
  const path = '/home/user/cross-boundary-race.txt';
  const gate = gateOf();
  const { fs, ops, handle } = nodeOnSession(authority, { gate });
  const older = gate.arm();
  fs.writeFileSync(path, 'older');
  const shimFlush = fs.promises.truncate(path, 5);
  await older.held;
  fs.writeFileSync(path, 'newer');
  const boundary = globalThis.__nimbusProcessFs.flush();
  await sleep(20);
  assert.equal(handle.log.calls.writeBatchStream, 1, 'same-path boundary write waits behind the older shim flush');
  older.release();
  await Promise.all([shimFlush, boundary]);
  assert.deepEqual(received(ops, path), ['older', 'newer']);
  assert.equal(await authority.peer.readFileString(path), 'newer');
}

async function olderWriteKeepsNewer() {
  const authority = createAuthority();
  const path = '/home/user/async-write-race.txt';
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const older = gate.arm();
  const write = fs.promises.writeFile(path, 'older');
  await older.held;
  fs.writeFileSync(path, 'newer');
  older.release();
  await write;
  await globalThis.__nimbusProcessFs.flush();
  assert.equal(await authority.peer.readFileString(path), 'newer', 'the next helper boundary persists the newer pending cell');
  assert.deepEqual(received(ops, path), ['older', 'newer']);
}

async function appendThenFull() {
  const authority = createAuthority();
  const path = '/home/user/append-order.txt';
  authority.kfs.writeFile(path, 'base');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const appended = gate.arm();
  const append = fs.promises.appendFile(path, 'A');
  await appended.held;
  const full = fs.promises.writeFile(path, 'newer');
  appended.release();
  await Promise.all([append, full]);
  assert.equal(
    await authority.peer.readFileString(path),
    'newer',
    `an append and the full write after it reach the session in order; the session received ${JSON.stringify(ops)}`,
  );
  assert.deepEqual(received(ops, path), ['A', 'newer']);
}

async function fullThenAppend() {
  const authority = createAuthority();
  const path = '/home/user/full-then-append.txt';
  authority.kfs.writeFile(path, 'base');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const full = gate.arm();
  const write = fs.promises.writeFile(path, 'new');
  await full.held;
  const append = fs.promises.appendFile(path, 'A');
  full.release();
  await Promise.all([write, append]);
  assert.equal(await authority.peer.readFileString(path), 'newA', 'the append extends the full image at the session');
  assert.deepEqual(received(ops, path), ['new', 'A']);
}

async function concurrentAppends() {
  const authority = createAuthority();
  const path = '/home/user/concurrent-appends.txt';
  authority.kfs.writeFile(path, 'base');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const first = gate.arm();
  const appendA = fs.promises.appendFile(path, 'A');
  await first.held;
  const appendB = fs.promises.appendFile(path, 'B');
  first.release();
  await Promise.all([appendA, appendB]);
  assert.equal(await authority.peer.readFileString(path), 'baseAB');
  assert.deepEqual(received(ops, path), ['A', 'B']);
}

async function caughtFailureSurfaces() {
  const authority = createAuthority();
  const path = '/home/user/settled-failure.txt';
  authority.kfs.writeFile(path, 'base');
  let failing = false;
  const { fs } = nodeOnSession(authority, {
    wave: (next) => async (stream, fence, owner) => {
      if (failing) {
        await stream.cancel();
        throw EIO('settled before boundary');
      }
      return next(stream, fence, owner);
    },
  });
  const handle = await fs.promises.open(path, 'r+');
  failing = true;
  await assert.rejects(handle.write('X', 0), /settled before boundary/, 'the caller is told');
  failing = false;
  await assert.rejects(globalThis.__nimbusProcessFs.flush(), /settled before boundary/, 'the next boundary reports the failure');
  await globalThis.__nimbusProcessFs.flush();
  await handle.close();
}

async function rangeSharesFullImage() {
  const authority = createAuthority();
  const path = '/home/user/same-generation-claim.txt';
  authority.kfs.writeFile(path, 'base');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const handle = await fs.promises.open(path, 'r+');
  const full = gate.arm();
  fs.writeFileSync(path, 'newbase');
  const ranged = handle.write('X', 0);
  await full.held;
  const boundary = globalThis.__nimbusProcessFs.flush();
  full.release();
  await Promise.all([ranged, boundary]);
  assert.equal(await authority.peer.readFileString(path), 'Xewbase');
  assert.equal(fs.readFileSync(path, 'utf8'), 'Xewbase');
  assert.deepEqual(received(ops, path), ['newbase', 'X'], 'the full image is sent once, and the range after it');
  await handle.close();
}

async function zeroByteWrite() {
  const authority = createAuthority();
  const path = '/home/user/zero-byte-write.txt';
  authority.kfs.writeFile(path, 'base');
  const { fs, ops, log } = nodeOnSession(authority);
  const handle = await fs.promises.open(path, 'r+');
  const result = await handle.write(new Uint8Array(0), 0, 0, 10);
  assert.equal(result.bytesWritten, 0);
  await globalThis.__nimbusProcessFs.flush();
  assert.equal(log.calls.fsWrite ?? 0, 0, 'a zero-byte write makes no write call');
  assert.equal(log.calls.fsWriteRange ?? 0, 0, 'and no ranged write call');
  assert.deepEqual(
    ops.filter((op) => op.path === key(path) && op.call !== 'open' && op.call !== 'close'),
    [],
    'and the session receives no data for it',
  );
  assert.equal(await fs.promises.readFile(path, 'utf8'), 'base', 'the file keeps its content');
  assert.equal(fs.readFileSync(path, 'utf8'), 'base');
  const one = new Uint8Array(1);
  const read = await handle.read(one, 0, 1, null);
  assert.equal(read.bytesRead, 1);
  assert.equal(dec.decode(one), 'b', 'the handle position did not move');
  await handle.close();
}

async function rangeThenFull() {
  const authority = createAuthority();
  const path = '/home/user/handle-range-race.txt';
  authority.kfs.writeFile(path, 'base');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const handle = await fs.promises.open(path, 'r+');
  const range = gate.arm();
  const ranged = handle.write('OLD', 0);
  await range.held;
  fs.writeFileSync(path, 'newer');
  const boundary = globalThis.__nimbusProcessFs.flush();
  range.release();
  await Promise.all([ranged, boundary]);
  assert.equal(await authority.peer.readFileString(path), 'newer', 'the range completion does not overlay the newer write');
  assert.equal(fs.readFileSync(path, 'utf8'), 'newer');
  assert.deepEqual(received(ops, path), ['OLD', 'newer']);
  await handle.close();
}

async function scheduledRangeThenFull() {
  const authority = createAuthority();
  const path = '/home/user/queued-handle-range-race.txt';
  authority.kfs.writeFile(path, 'base');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const handle = await fs.promises.open(path, 'r+');
  const range = gate.arm();
  const blocker = handle.write('X', 0);
  await range.held;
  const ranged = handle.write('OLD', 0);
  fs.writeFileSync(path, 'newer');
  const boundary = globalThis.__nimbusProcessFs.flush();
  range.release();
  await Promise.all([blocker, ranged, boundary]);
  assert.equal(await authority.peer.readFileString(path), 'newer');
  assert.equal(fs.readFileSync(path, 'utf8'), 'newer');
  assert.deepEqual(received(ops, path), ['X', 'OLD', 'newer'], 'a range scheduled before the sync write is ordered before it');
  await handle.close();
}

async function concurrentHandleAppends() {
  const authority = createAuthority();
  const path = '/home/user/handle-appends.txt';
  authority.kfs.writeFile(path, 'base');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const handle = await fs.promises.open(path, 'a');
  const first = gate.arm();
  const writeA = handle.write('A');
  await first.held;
  const writeB = handle.write('B');
  first.release();
  await Promise.all([writeA, writeB]);
  assert.equal(await authority.peer.readFileString(path), 'baseAB', 'each append lands at the end as it lands');
  assert.deepEqual(ops.filter((op) => op.path === key(path) && op.text !== undefined).map((op) => [op.call, op.text]), [['append', 'A'], ['append', 'B']]);
  await handle.close();
}

async function truncateThenFull() {
  const authority = createAuthority();
  const path = '/home/user/truncate-race.txt';
  authority.kfs.writeFile(path, 'abcdef');
  const gate = gateOf();
  const { fs, ops } = nodeOnSession(authority, { gate });
  const truncate = gate.arm(['fsTruncate']);
  const truncating = fs.promises.truncate(path, 3);
  await truncate.held;
  fs.writeFileSync(path, 'newer');
  const boundary = globalThis.__nimbusProcessFs.flush();
  truncate.release();
  await Promise.all([truncating, boundary]);
  assert.equal(await authority.peer.readFileString(path), 'newer', 'the full content lands after the truncate');
  assert.equal(fs.readFileSync(path, 'utf8'), 'newer');
  assert.deepEqual(received(ops, path), ['newer']);
}

async function refusedWriteRetries() {
  const authority = createAuthority();
  const path = '/home/user/retry-after-failure.txt';
  let refusing = true;
  const { fs, ops } = nodeOnSession(authority, {
    wave: (next) => async (stream, fence, owner) => {
      if (refusing) {
        await stream.cancel();
        return refusedWave('EACCES');
      }
      return next(stream, fence, owner);
    },
  });
  await assert.rejects(fs.promises.writeFile(path, 'failed'), (error) => error.code === 'EACCES', 'the caller is told the refusal');
  refusing = false;
  await fs.promises.writeFile(path, 'recovered');
  await globalThis.__nimbusProcessFs.flush();
  assert.equal(await authority.peer.readFileString(path), 'recovered', 'the path\'s next write is sent and lands');
  assert.deepEqual(received(ops, path), ['recovered'], 'the refused write never reached the session');
}

const SERVER = `
const fs = require('node:fs');
const http = require('node:http');
http.createServer((req, res) => {
  const content = req.url === '/race' ? 'older'
    : req.url === '/same-race' ? 'same'
    : req.url.slice(1);
  fs.writeFileSync('/home/user/request-result.txt', content);
  if (req.url === '/sync-append' || req.url === '/sync-appends') {
    fs.appendFileSync('/home/user/live-prefix.txt', 'A');
    if (req.url === '/sync-appends') {
      fs.appendFileSync('/home/user/live-prefix.txt', 'B');
    }
  }
  if (req.url === '/pending-drain') {
    console.log('blocked prior output');
  }
  if (req.url === '/codegen') {
    // Code produced while serving: staged for the next launch and reported.
    try { globalThis.__nimbusRuntimeCode.compileFunction('async', [], 'return 1', globalThis.__nimbusUnboundOrigin); } catch {}
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: live\\n\\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok:' + req.url);
  if (req.url === '/race' || req.url === '/same-race') {
    // A newer write from a timer, once the case says the older write's RPC is in flight (globalThis.__raceHooks).
    const next = req.url === '/race' ? 'newer' : 'same';
    const { started, written } = globalThis.__raceHooks;
    started.then(() => setTimeout(() => { fs.writeFileSync('/home/user/request-result.txt', next); written(); }, 0));
  }
}).listen(${PORT});
`;

async function answeredAfterWrites() {
  const authority = createAuthority();
  const { proc, ops } = await residentOnSession(authority, SERVER);
  for (const path of ['first', 'second']) {
    const response = await proc.handleHttpRequest(request(path));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `ok:/${path}`);
    assert.equal(await authority.peer.readFileString(RESULT), path, 'the handler\'s write is durable before the 200 response returns');
  }
  assert.deepEqual(received(ops, RESULT), ['first', 'second'], 'a flushed write is removed rather than rewritten at the next request');
}

async function syncAppendsAtEnd(url, appended) {
  const authority = createAuthority();
  authority.kfs.writeFile(LIVE, 'base');
  const { proc, ops } = await residentOnSession(authority, SERVER);
  assert.equal((await proc.handleHttpRequest(request(url))).status, 200);
  assert.equal(await authority.peer.readFileString(LIVE), `base${appended}`, 'the session holds the appended bytes after its live prefix');
  assert.deepEqual(received(ops, LIVE), [appended], `the appends are one EOF mutation; the session received ${JSON.stringify(ops)}`);
}

async function retention() {
  const authority = createAuthority();
  const { proc } = await residentOnSession(authority, SERVER);
  for (let index = 0; index < 32; index++) {
    assert.equal((await proc.handleHttpRequest(request(`retention-${index}`))).status, 200);
  }
  assert.equal(globalThis.__nimbusProcessFs.client.pendingBytes, 0, 'settled request-boundary writes are not retained');
  assert.equal(await authority.peer.readFileString(RESULT), 'retention-31');
}

async function sharedDrain() {
  const authority = createAuthority();
  const outputGate = Promise.withResolvers();
  const outputStarted = Promise.withResolvers();
  const { proc } = await residentOnSession(authority, SERVER, {
    hooks: {
      stdout: async (bytes) => {
        if (dec.decode(bytes).includes('blocked prior output')) {
          outputStarted.resolve();
          await outputGate.promise;
        }
      },
    },
  });
  let firstCompleted = false;
  const first = proc.handleHttpRequest(request('pending-drain')).then((response) => {
    firstCompleted = true;
    return response;
  });
  await outputStarted.promise;
  let secondCompleted = false;
  const second = proc.handleHttpRequest(request('concurrent-drain')).then((response) => {
    secondCompleted = true;
    return response;
  });
  await sleep(10);
  assert.equal(firstCompleted, false, 'the first request is not answered while the output its handler wrote is held');
  assert.equal(secondCompleted, false, 'the second flush cannot skip work claimed by the first drain');
  outputGate.resolve();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
}

async function streamNotBuffered() {
  const authority = createAuthority();
  const { proc } = await residentOnSession(authority, SERVER);
  const response = await Promise.race([
    proc.handleHttpRequest(request('stream')),
    sleep(1_000).then(() => { throw new Error('stream response was buffered'); }),
  ]);
  assert.equal(response.status, 200);
  assert.equal(await authority.peer.readFileString(RESULT), 'stream');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(dec.decode(first.value), 'data: live\n\n');
  await reader.cancel();
}

/** A request writes `older`; while that write is in flight, its program's timer writes `newer`. */
async function writeDuringFlight(url, after, expected) {
  const authority = createAuthority();
  const gate = gateOf();
  const { proc, ops } = await residentOnSession(authority, SERVER, { gate });
  const older = gate.arm();
  const newerWritten = Promise.withResolvers();
  globalThis.__raceHooks = { started: older.held, written: newerWritten.resolve };
  const raced = proc.handleHttpRequest(request(url));
  await newerWritten.promise;
  older.release();
  assert.equal((await raced).status, 200);
  delete globalThis.__raceHooks;
  assert.equal((await proc.handleHttpRequest(request(after))).status, 200);
  assert.deepEqual(received(ops, RESULT), expected, 'a newer local cell is preserved and flushed before the following handler');
}

async function failureRejectsRequest() {
  const authority = createAuthority();
  let failing = false;
  const { proc } = await residentOnSession(authority, SERVER, {
    wave: (next) => async (stream, fence, owner) => {
      if (failing) throw EIO('injected durable write failure');
      return next(stream, fence, owner);
    },
  });
  failing = true;
  await assert.rejects(
    () => proc.handleHttpRequest(request('failure')),
    /injected durable write failure/,
    'durability failure rejects the request instead of answering it',
  );
}

async function codegenFailureNotFatal() {
  const authority = createAuthority();
  const stderr = [];
  const { proc } = await residentOnSession(authority, SERVER, {
    hooks: {
      reportRuntimeCode: async () => { throw new Error('Runtime code report has no live launch'); },
      stderr: async (bytes) => { stderr.push(dec.decode(bytes)); },
    },
  });
  const response = await proc.handleHttpRequest(request('codegen'));
  assert.equal(response.status, 200, 'a failed code report does not fail the response');
  assert.equal(await response.text(), 'ok:/codegen');
  assert.equal(await authority.peer.readFileString(RESULT), 'codegen', 'and the request\'s write is durable');
  assert.ok(
    stderr.some((text) => text.includes('runtime code persistence failed: Runtime code report has no live launch')),
    `the failure reaches the process's stderr: ${JSON.stringify(stderr)}`,
  );
}

const CLEAN = `
const fs = require('node:fs');
const http = require('node:http');
let rangeHandle = null;
http.createServer(async (req, res) => {
  if (req.url === '/warm') {
    rangeHandle = await fs.promises.open('/home/user/clean-range.txt', 'w+');
    await fs.promises.writeFile('/home/user/clean-truncate.txt', 'abcdef');
    res.end('ok');
    return;
  }
  if (req.url === '/range') {
    void rangeHandle.write('R', 0);
  } else {
    void fs.promises.truncate('/home/user/clean-truncate.txt', 2).catch(() => {});
  }
  if (req.url === '/truncate-immediate') {
    setTimeout(() => res.end('ok'), 0);
    return;
  }
  res.end('ok');
}).listen(${PORT});
`;

async function cleanMutations() {
  const authority = createAuthority();
  const gate = gateOf();
  let failTruncate = false;
  const { proc } = await residentOnSession(authority, CLEAN, {
    gate,
    fail: (name) => (failTruncate && name === 'fsTruncate' ? EIO('injected clean truncate failure') : null),
  });
  assert.equal((await proc.handleHttpRequest(request('warm'))).status, 200);

  const range = gate.arm(MUTATIONS);
  let rangeReturned = false;
  const rangeResponse = proc.handleHttpRequest(request('range')).then((response) => {
    rangeReturned = true;
    return response;
  });
  await range.held;
  await sleep(10);
  assert.equal(rangeReturned, false, 'a response is not sent while its ranged write is in flight');
  range.release();
  assert.equal((await rangeResponse).status, 200);
  assert.equal(await authority.peer.readFileString('/home/user/clean-range.txt'), 'R');

  const truncate = gate.arm(['fsTruncate']);
  let truncateReturned = false;
  const truncateResponse = proc.handleHttpRequest(request('truncate')).then((response) => {
    truncateReturned = true;
    return response;
  });
  await truncate.held;
  await sleep(10);
  assert.equal(truncateReturned, false, 'a response is not sent while its truncate is in flight');
  failTruncate = true;
  truncate.release();
  await assert.rejects(
    truncateResponse,
    /injected clean truncate failure/,
    'a floated clean mutation failure rejects the response instead of returning 200',
  );
  await assert.rejects(
    proc.handleHttpRequest(request('truncate-immediate')),
    /injected clean truncate failure/,
    'a mutation failure that settles before response headers remains visible to the boundary',
  );
}

const EXIT = `
const fs = require('node:fs');
fs.appendFileSync('/home/user/exit-before-drain.txt', 'A');
process.exit(0);
`;

async function exitIntent() {
  const authority = createAuthority();
  const handle = facetSupervisor(authority, {
    async writeBatchStream() {
      throw EIO('injected append failure after exit intent');
    },
  });
  await assert.rejects(
    launchResident({ authority, program: EXIT, env: { SUPERVISOR: handle.supervisor }, cwd: '/home/user', cursor: authority.cursor() }),
    /injected append failure after exit intent/,
  );
  assert.equal(handle.log.exit, null, 'long-running Node does not report terminal success before durability');
}

async function oneShot() {
  const authority = createAuthority();
  const reports = [];
  let appendCalls = 0;
  const handle = facetSupervisor(authority, {
    async writeBatchStream() {
      appendCalls++;
      throw EIO('injected one-shot append failure');
    },
    async reportExit(code) { reports.push(code); },
  });
  adoptCtxExports({ SupervisorRPC: () => handle.supervisor });
  const env = {
    ASSETS: stagedAssets,
    LOADER: {
      get() {
        throw new Error('one-shot generated runner uses LOADER.load');
      },
      load(config) {
        return {
          getEntrypoint() {
            return {
              async run(runRequest, supervisor) {
                const generated = await importModuleSet(config.modules, 'runner.js');
                return generated.default.fetch(runRequest, { ...config.env, SUPERVISOR: supervisor });
              },
            };
          },
        };
      },
    },
  };
  const manager = new FacetManager(
    { id: { toString: () => 'one-shot-exit-ordering' }, waitUntil() {}, storage: facetStorage(facetSql()) },
    env,
    new SessionProcessSupervisor(),
    new PortRegistry(),
    processHostFor,
    {},
  );
  manager.setVfs(authority.rawVfs, authority.files);
  const result = await manager.exec(`
const fs = require('node:fs');
fs.appendFileSync('/home/user/oneshot-exit-before-drain.txt', 'A');
process.exit(0);
`, {
    filename: '<eval>',
    cwd: '/home/user',
    captureOutput: true,
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result));
  assert.equal(appendCalls, 1, `definitive EIO is not retried: ${JSON.stringify(result)}`);
  assert.deepEqual(reports, [1], 'only the final failed durability code is reported');
}

await runScenarios(import.meta.path, {
  'an async flush keeps a newer sync write for the next boundary': () => flushKeepsNewerWrite('older', 'newer'),
  'an async flush keeps an identical newer sync write for the next boundary': () => flushKeepsNewerWrite('same', 'same'),
  'a same-path boundary write waits behind an older shim flush in flight': sameBoundaryWaitsBehindOlderFlush,
  'an older awaited writeFile completes without clearing a newer sync write': olderWriteKeepsNewer,
  'an append and the full write made after it reach the session in order': appendThenFull,
  'a full write queued before an append stays a full image the append extends': fullThenAppend,
  'concurrent appends to a live-only file land in order, none lost': concurrentAppends,
  'a caught failure of an awaited write surfaces at the next boundary, once': caughtFailureSurfaces,
  'a ranged write and a boundary flush of one full image send it once': rangeSharesFullImage,
  'a zero-byte positional write sends no bytes and does not move the handle': zeroByteWrite,
  'a ranged write in flight is ordered before a later sync full write': rangeThenFull,
  'a ranged write scheduled before a sync write is not overlaid on it': scheduledRangeThenFull,
  'concurrent append-mode FileHandle writes land at the end, in order': concurrentHandleAppends,
  'a live truncate in flight is ordered before later full content': truncateThenFull,
  'a refused write rejects its caller, and the next write to the path lands': refusedWriteRetries,
  'a response is answered only once the writes its handler made are at the session': answeredAfterWrites,
  'an appendFileSync to a live file the process does not hold appends at its end': () => syncAppendsAtEnd('sync-append', 'A'),
  'unclaimed appendFileSync fragments are one append at the end': () => syncAppendsAtEnd('sync-appends', 'AB'),
  'settled request-boundary writes are not retained by the process': retention,
  'concurrent request boundaries share one drain, held by the output it waits for': sharedDrain,
  'an open response body is not buffered by the durability boundary': streamNotBuffered,
  'a write made while an older one is in flight reaches the session after it': () => writeDuringFlight('race', 'after-race', ['older', 'newer', 'after-race']),
  'an identical write made while an older one is in flight is sent too': () => writeDuringFlight('same-race', 'after-same-race', ['same', 'same', 'after-same-race']),
  'a durability failure rejects the request instead of answering it': failureRejectsRequest,
  'a failed report of generated code neither fails the response nor skips its writes': codegenFailureNotFatal,
  'a clean ranged write and truncate hold the response until the session has them': cleanMutations,
  'an append that fails after process.exit intent fails the start, reporting no exit': exitIntent,
  'a one-shot run\'s failed append drain reports only its final code': oneShot,
});
