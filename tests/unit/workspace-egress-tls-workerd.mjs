// @serial
// A real session's tls.connect crosses the embedder's optional connectTls RPC.
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: '1', NIMBUS_TEST_EGRESS_TLS: '1' } });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const run = async (source) => {
      const encoded = Buffer.from(source).toString('base64');
      const wrote = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/tls-proof.js', Buffer.from('${encoded}', 'base64'))"`);
      assert.equal(wrote.status, 0, wrote.stdout);
      return terminal.run('node /home/user/tls-proof.js', 60000);
    };
    const source = String.raw`
      const tls = require('tls');
      const socket = tls.connect(443, 'egress-test.invalid', () => {
        console.log('secure', socket instanceof tls.TLSSocket, socket.encrypted);
        socket.write('HEAD /tls-proof HTTP/1.0\r\nHost: egress-test.invalid\r\n\r\n');
      });
      socket.setEncoding('utf8');
      let body = '';
      socket.on('data', (part) => { body += part; });
      socket.on('end', () => console.log('answer', body.trim()));
      socket.on('error', (error) => { console.error(error.code + ' ' + error.message); process.exitCode = 1; });
    `;
    const result = await run(source);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /secure true true/);
    assert.match(result.stdout, /answer via-egress-tls egress-test\.invalid:443 HEAD \/tls-proof HTTP\/1\.0/);
    const plain = await run(`
      const net = require('net');
      const socket = net.connect(7, 'egress-test.invalid', () => socket.write(Buffer.from([0, 128, 255])));
      const parts = [];
      socket.on('data', (part) => parts.push(part));
      socket.on('end', () => console.log('tcp', socket instanceof net.Socket, [...Buffer.concat(parts)].join(',')));
      socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    `);
    assert.equal(plain.status, 0, plain.stdout);
    assert.match(plain.stdout, /tcp true 0,128,255/);
    const refusedTcp = await run(`
      const socket = require('net').connect(7, 'tcp-refused.invalid');
      socket.on('error', (error) => console.log('refused TCP', error.message));
    `);
    assert.equal(refusedTcp.status, 0, refusedTcp.stdout);
    assert.match(refusedTcp.stdout, /refused TCP .*egress refused this TCP destination/);
    const rejected = await run(`
      const socket = require('tls').connect(443, 'tls-refused.invalid', () => console.log('unexpected secureConnect'));
      socket.on('error', (error) => console.log('refused', error.message));
    `);
    assert.equal(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stdout, /refused egress refused this TLS destination/);
    assert.doesNotMatch(rejected.stdout, /unexpected secureConnect/);
    const upgraded = await run(String.raw`
      const tls = require('tls');
      const plain = require('net').connect(443, 'egress-test.invalid', () => plain.write('GET /start HTTP/1.0\r\nHost: egress-test.invalid\r\n\r\n'));
      plain.once('data', (bytes) => {
        console.log('plain', String(bytes).trim());
        const socket = tls.connect({ socket: plain }, () => {
          console.log('upgraded', plain.destroyed, socket instanceof tls.TLSSocket);
          socket.write('HEAD /upgrade HTTP/1.0\r\nHost: egress-test.invalid\r\n\r\n');
        });
        socket.on('data', (bytes) => console.log('answer', String(bytes).trim()));
        socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
      });
      plain.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    `);
    assert.equal(upgraded.status, 0, upgraded.stdout);
    assert.match(upgraded.stdout, /plain plain-egress-ready/);
    assert.match(upgraded.stdout, /upgraded true true/);
    assert.match(upgraded.stdout, /answer via-egress-tls egress-test\.invalid:443 HEAD \/upgrade HTTP\/1\.0/);
  } finally { await terminal.close(); }
} finally { await probe.stop(); }

const without = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: '1' } });
try {
  const terminal = await localTerminal(without, { install: [] });
  try {
    const result = await terminal.run(`node -e "const s=require('tls').connect(443,'egress-test.invalid'); s.on('error',e=>console.log(e.code+' '+e.message));"`, 60000);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERR_NIMBUS_EGRESS_TLS Nimbus: TLS sockets are not available/);
  } finally { await terminal.close(); }
} finally { await without.stop(); }

const isolate = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: '0' } });
try {
  const terminal = await localTerminal(isolate, { install: [] });
  try {
    const result = await terminal.run(`node -e "const s=require('net').connect(7,'egress-test.invalid'); s.on('error',e=>console.log(e.code+' '+e.message));"`, 60000);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /ERR_NET_SOCKET_NOT_AVAILABLE net.Socket: outbound TCP from Nimbus facet not yet supported/);
  } finally { await terminal.close(); }
} finally { await isolate.stop(); }
