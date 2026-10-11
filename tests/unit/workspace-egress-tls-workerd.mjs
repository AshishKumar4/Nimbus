// @serial
// @tier slow — drives workerd; CI 23 s wall, 36 s CPU, 1.61 GiB peak (2026-10-11).
// A real session's tls.connect crosses the embedder's optional connectTls RPC.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const policy = process.argv[2];
if (policy) {
  const probe = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: policy === 'without-egress' ? '0' : '1' } });
  try {
    const terminal = await localTerminal(probe, { install: [] });
    try {
      const tls = policy === 'without-tls';
      const result = await terminal.run(`node -e "const s=require('${tls ? 'tls' : 'net'}').connect(${tls ? 443 : 7},'egress-test.invalid'); s.on('error',e=>console.log(e.code+' '+e.message));"`, 60000);
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, tls ? /ERR_NIMBUS_EGRESS_TLS Nimbus: TLS sockets are not available/
        : /ERR_NET_SOCKET_NOT_AVAILABLE net.Socket: outbound TCP from Nimbus facet not yet supported/);
    } finally { await terminal.close(); }
  } finally { await probe.stop(); }
} else {
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
      console.log('TLS refs', socket.unref() === socket, socket.ref() === socket);
      let body = '';
      socket.on('data', (part) => { body += part; });
      socket.on('end', () => console.log('answer', body.trim()));
      socket.on('close', () => console.log('closed TLS refs', socket.unref() === socket, socket.ref() === socket));
      socket.on('error', (error) => { console.error(error.code + ' ' + error.message); process.exitCode = 1; });
    `;
    const result = await run(source);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /secure true true/);
    assert.match(result.stdout, /TLS refs true true/);
    assert.match(result.stdout, /closed TLS refs true true/);
    assert.match(result.stdout, /answer via-egress-tls egress-test\.invalid:443 HEAD \/tls-proof HTTP\/1\.0/);
    const plain = await run(`
      const net = require('net');
      const socket = net.connect(7, 'egress-test.invalid', () => socket.write(Buffer.from([0, 128, 255])));
      console.log('TCP refs', socket.unref() === socket, socket.ref() === socket);
      const parts = [];
      socket.on('data', (part) => parts.push(part));
      socket.on('end', () => console.log('tcp', socket instanceof net.Socket, [...Buffer.concat(parts)].join(',')));
      socket.on('close', () => console.log('closed TCP refs', socket.unref() === socket, socket.ref() === socket));
      socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    `);
    assert.equal(plain.status, 0, plain.stdout);
    assert.match(plain.stdout, /tcp true 0,128,255/);
    assert.match(plain.stdout, /TCP refs true true/);
    assert.match(plain.stdout, /closed TCP refs true true/);
    const refusedTcp = await run(`
      const socket = require('net').connect(7, 'tcp-refused.invalid', () => {
        socket._handle.socket.opened.then(() => console.log('opened refused TCP'));
      });
      let bytes = 0;
      socket.on('data', (part) => { bytes += part.length; });
      socket.on('end', () => console.log('refused TCP EOF', bytes));
      socket.on('close', () => console.log('refused TCP close'));
      socket.on('error', (error) => console.log('refused TCP', error.message));
    `);
    assert.equal(refusedTcp.status, 0, refusedTcp.stdout);
    assert.match(refusedTcp.stdout, /opened refused TCP/);
    assert.match(refusedTcp.stdout, /refused TCP EOF 0/);
    assert.match(refusedTcp.stdout, /refused TCP close/);
    const rejected = await run(`
      const socket = require('tls').connect(443, 'tls-refused.invalid', () => console.log('unexpected secureConnect'));
      socket.on('error', (error) => console.log('refused', error.message));
    `);
    assert.equal(rejected.status, 0, rejected.stdout);
    assert.match(rejected.stdout, /refused egress refused this TLS destination/);
    assert.doesNotMatch(rejected.stdout, /unexpected secureConnect/);
    const timeout = await run(`
      const socket = require('tls').connect({ port: 443, host: 'egress-test.invalid', timeout: 30 });
      const deadline = setTimeout(() => { console.log('TLS timeout missing'); socket.destroy(); }, 1000);
      socket.on('timeout', () => { clearTimeout(deadline); console.log('TLS options timeout'); socket.destroy(); });
      socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    `);
    assert.equal(timeout.status, 0, timeout.stdout);
    assert.match(timeout.stdout, /TLS options timeout/);
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
for (const mode of ['without-tls', 'without-egress']) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], { encoding: 'utf8', timeout: 90000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
}
}
