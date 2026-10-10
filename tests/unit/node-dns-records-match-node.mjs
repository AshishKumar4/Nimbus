import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NODE_DNS_BINDING_SOURCE } from '../../packages/worker/src/runtime/node-dns-binding.ts';

// The same DNS records through Node's c-ares UDP binding and our DNS JSON binding.
// This responder only writes fixture packets; it parses no DNS wire format.
const program = String.raw`
const dgram = require('dgram');
const dns = require('dns');
const domain = (value) => Buffer.concat(value.split('.').filter(Boolean).map((part) => Buffer.concat([Buffer.from([Buffer.byteLength(part)]), Buffer.from(part)])).concat(Buffer.from([0])));
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const txt = (...values) => Buffer.concat(values.map((value) => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)])));
const rows = [
  { method: 'resolve4', type: 1, options: { ttl: true }, answers: [
    { type: 5, TTL: 10, data: 'alias.test.', wire: domain('alias.test') },
    { type: 5, TTL: 20, data: 'last.test.', wire: domain('last.test') },
    { type: 1, TTL: 300, data: '1.2.3.4', wire: Buffer.from([1, 2, 3, 4]) },
  ] },
  { method: 'resolveCname', type: 5, answers: [
    { type: 5, TTL: 10, data: 'alias.test.', wire: domain('alias.test') },
    { type: 5, TTL: 20, data: 'last.test.', wire: domain('last.test') },
  ] },
  { method: 'resolveTxt', type: 16, answers: [
    { type: 16, TTL: 60, data: '"a\\032b" "quote\\\"slash\\\\" ""', wire: txt('a b', 'quote"slash\\', '') },
    { type: 16, TTL: 60, data: '"\\195\\169"', wire: txt('é') },
  ] },
  { method: 'resolveMx', type: 15, options: { ttl: true }, answers: [
    { type: 15, TTL: 60, data: '10 mx.fixture.test.', wire: Buffer.concat([u16(10), domain('mx.fixture.test')]) },
  ] },
  { method: 'resolve4', type: 1, stalledBody: true, answers: [] },
  ...[0, 1, 2, 3, 4, 5].map((Status) => ({ method: 'resolve4', type: 1, Status, answers: [] })),
].map((row, index) => ({ ...row, name: 'case' + index + '.fixture.test' }));
const wire = (id, row) => Buffer.concat([
  id, u16(0x8180 | (row.Status || 0)), u16(1), u16(row.answers.length), u16(0), u16(0), domain(row.name), u16(row.type), u16(1),
  ...row.answers.map((answer) => Buffer.concat([domain(row.name), u16(answer.type), u16(1), u32(answer.TTL), u16(answer.wire.length), answer.wire])),
]);
let nativeAttempts = 0, jsonAttempts = 0;
const binding = __BINDING__({ process, timers: { setTimeout, clearTimeout }, fetch: async (_url, { signal }) => {
  jsonAttempts++;
  if (current.stalledBody) return new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); } }));
  return Response.json({ Status: current.Status || 0, Answer: current.answers });
} }, require('net').isIP);
const shape = (err, values) => err ? { code: err.code, syscall: err.syscall, message: err.message, keys: Object.keys(err) } : values;
let current;
(async () => {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (query, peer) => { nativeAttempts++; if (!current.stalledBody) socket.send(wire(query.subarray(0, 2), current), peer.port, peer.address); });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  try {
    const native = new dns.Resolver({ tries: 2, timeout: 100 });
    native.setServers(['127.0.0.1:' + socket.address().port]);
    const oldChannel = process.binding('cares_wrap').ChannelWrap;
    process.binding('cares_wrap').ChannelWrap = binding.ChannelWrap;
    const ours = new dns.Resolver({ tries: 2, timeout: 100 });
    process.binding('cares_wrap').ChannelWrap = oldChannel;
    const call = (resolver, row) => new Promise((resolve) => resolver[row.method](row.name, row.options, (err, value) => resolve(shape(err, value))));
    for (const row of rows) {
      current = row;
      nativeAttempts = jsonAttempts = 0;
      const expected = await call(native, row);
      const actual = await call(ours, row);
      console.log(JSON.stringify({ method: row.method, status: row.Status ?? 0, expected, actual, nativeAttempts, jsonAttempts }));
      require('assert/strict').deepEqual(actual, expected);
      if (row.stalledBody) require('assert/strict').equal(jsonAttempts, nativeAttempts);
    }
  } finally { socket.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`.replace('__BINDING__', '(' + NODE_DNS_BINDING_SOURCE + ')');
const node = spawnSync('node', ['-e', program], { encoding: 'utf8', timeout: 15_000 });
assert.equal(node.status, 0, node.stdout + node.stderr);
console.log('node-dns-records-match-node: typed records, CNAME chains, TTLs and resolver errors match c-ares');
