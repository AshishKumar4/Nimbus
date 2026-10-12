// @serial
// @tier slow — drives workerd; CI 23 s wall, 36 s CPU, 1.61 GiB peak (2026-10-11).
// A real session's tls.connect crosses the embedder's optional connectTls RPC; a
// TLS server of the host's Node checks the names it presents. Needs openssl.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
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
// A real server, for the names TLS presents and checks: the host's Node, on an
// address of this machine that is not loopback (a program's loopback is its
// session's ports), under a CA this workerd trusts (NODE_EXTRA_CA_CERTS, read
// by miniflare at start). Its certificate names the address and fixture.nimbus.test;
// it answers with the server name the client presented.
const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
assert.ok(lan, 'needs an IPv4 address other than loopback');
const dir = mkdtempSync(join(tmpdir(), 'egress-tls-'));
const ssl = (args) => {
  const made = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
};
writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=IP:${lan},DNS:fixture.nimbus.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Nimbus egress test CA',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=fixture.nimbus.test']);
ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'ext.cnf']);
process.env.NODE_EXTRA_CA_CERTS = join(dir, 'ca.pem');
const fixture = spawn('node', ['-e', `
  const fs = require('fs');
  const server = require('tls').createServer({ key: fs.readFileSync(${JSON.stringify(join(dir, 'server.key'))}), cert: fs.readFileSync(${JSON.stringify(join(dir, 'server.pem'))}) }, (socket) => {
    socket.on('error', () => {});
    socket.end('name ' + (socket.servername || '-') + '\\n');
  });
  // A client that refused the server's certificate ends the handshake with an alert.
  server.on('tlsClientError', (error, socket) => console.log('REFUSED ' + (socket.servername || '-')));
  server.listen(0, ${JSON.stringify(lan)}, () => console.log('PORT ' + server.address().port));
`], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
let fixtureOut = '';
const fixturePort = await new Promise((resolve, reject) => {
  fixture.stdout.on('data', (d) => { fixtureOut += d; const m = /PORT (\d+)/.exec(fixtureOut); if (m) resolve(Number(m[1])); });
  fixture.on('exit', (code) => reject(new Error('fixture exited ' + code)));
});
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
    // A servername other than the host reaches the egress, which presents it and checks the server by it; the host's own is Node's default.
    const named = await run(String.raw`
      const tls = require('tls');
      const ask = (servername, path) => new Promise((resolve) => {
        const socket = tls.connect({ port: 443, host: 'egress-test.invalid', servername }, () => {
          socket.write('HEAD ' + path + ' HTTP/1.0\r\nHost: egress-test.invalid\r\n\r\n');
        });
        socket.setEncoding('utf8');
        let body = '';
        socket.on('data', (part) => { body += part; });
        socket.on('end', () => { console.log('answer', body.trim()); resolve(); });
        socket.on('error', (error) => { console.error(error.code + ' ' + error.message); process.exitCode = 1; resolve(); });
      });
      ask('api.egress-test.invalid', '/named').then(() => ask('egress-test.invalid', '/host'));
    `);
    assert.equal(named.status, 0, named.stdout);
    assert.match(named.stdout, /answer via-egress-tls egress-test\.invalid:443 as api\.egress-test\.invalid HEAD \/named HTTP\/1\.0/);
    assert.match(named.stdout, /answer via-egress-tls egress-test\.invalid:443 HEAD \/host HTTP\/1\.0/);
    const timeout = await run(`
      const socket = require('tls').connect({ port: 443, host: 'egress-test.invalid', timeout: 30 });
      const deadline = setTimeout(() => { console.log('TLS timeout missing'); socket.destroy(); }, 1000);
      socket.on('timeout', () => { clearTimeout(deadline); console.log('TLS options timeout'); socket.destroy(); });
      socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    `);
    assert.equal(timeout.status, 0, timeout.stdout);
    assert.match(timeout.stdout, /TLS options timeout/);
    // TLS over a socket the program opened is refused by name, whether or not it has carried bytes:
    // the egress carries that connection, and a new connection would not be the same one.
    const upgrade = (speak) => run(String.raw`
      const tls = require('tls');
      const plain = require('net').connect(443, 'egress-test.invalid');
      const upgrade = () => {
        const socket = tls.connect({ socket: plain, servername: 'api.egress-test.invalid' }, () => console.log('unexpected secureConnect'));
        socket.on('data', (bytes) => console.log('unexpected answer', String(bytes).trim()));
        socket.on('error', (error) => console.log('refused', error.code, error.message));
        socket.on('close', () => console.log('plain destroyed', plain.destroyed));
      };
      if (${speak}) {
        plain.once('connect', () => plain.write('GET /start HTTP/1.0\r\nHost: egress-test.invalid\r\n\r\n'));
        plain.once('data', (bytes) => { console.log('plain', String(bytes).trim()); upgrade(); });
      } else upgrade();
      plain.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    `);
    for (const speak of [false, true]) {
      const refused = await upgrade(speak);
      assert.equal(refused.status, 0, refused.stdout);
      if (speak) assert.match(refused.stdout, /plain plain-egress-ready/);
      assert.match(refused.stdout, /refused ERR_NIMBUS_EGRESS_STARTTLS Nimbus: TLS over a socket the program opened \(tls\.connect\(\{ socket \}\), as STARTTLS does\) is not available/);
      assert.match(refused.stdout, /plain destroyed true/);
      assert.doesNotMatch(refused.stdout, /unexpected/);
    }
    // The name the program gives is the one presented and checked: the right one connects and is
    // the server's SNI; with a wrong one the session refuses the server's certificate, and nothing
    // the program sends or the server answers crosses. (workerd's startTls reports the failure at
    // the first write, as an internal error, so the program writes first, as most protocols do.)
    const names = await run(`
      const tls = require('tls');
      const ask = (servername) => new Promise((resolve) => {
        const socket = tls.connect({ host: ${JSON.stringify(lan)}, port: ${fixturePort}, servername });
        socket.write('hello\\n');
        socket.setEncoding('utf8');
        let body = '';
        socket.on('data', (part) => { body += part; });
        socket.on('error', (error) => console.log(servername, 'failed', error.message));
        socket.on('close', () => { console.log(servername, 'answer', JSON.stringify(body.trim())); resolve(); });
      });
      ask('fixture.nimbus.test').then(() => ask('wrong.nimbus.test'));
    `);
    assert.equal(names.status, 0, names.stdout);
    assert.match(names.stdout, /fixture\.nimbus\.test answer "name fixture\.nimbus\.test"/);
    assert.doesNotMatch(names.stdout, /fixture\.nimbus\.test failed/);
    assert.match(names.stdout, /wrong\.nimbus\.test failed /);
    assert.match(names.stdout, /wrong\.nimbus\.test answer ""/);
    for (const deadline = Date.now() + 5000; !/REFUSED wrong\.nimbus\.test/.test(fixtureOut) && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(fixtureOut, /REFUSED wrong\.nimbus\.test/);
    assert.doesNotMatch(fixtureOut, /REFUSED fixture\.nimbus\.test/);
  } finally { await terminal.close(); }
} finally { await probe.stop(); }
} finally { fixture.kill(); rmSync(dir, { recursive: true, force: true }); delete process.env.NODE_EXTRA_CA_CERTS; }
for (const mode of ['without-tls', 'without-egress']) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], { encoding: 'utf8', timeout: 90000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
}
}
