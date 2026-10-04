// @serial
// TLS from a node program that can stop at a synchronous read of stdin, as
// under Node and as from one that cannot stop.
//
// A child whose stdin is open can stop at such a read and run again
// (runtime/stop-replay.ts), so its network goes through the session (the
// supervisor binding is its globalOutbound), and workerd's outbound connect
// cannot carry TLS: the session makes its TLS sessions
// (SupervisorRPC.connect). Each case runs three ways: under the host's
// Node; in Nimbus as a child_process child, whose stdin its parent holds (it
// can stop); and in Nimbus from the terminal with no stdin to wait for (it
// cannot, so workerd's own node:tls makes the TLS). Where Nimbus cannot do
// what Node does, it says so by name; where one Nimbus way can, so must the
// other.
//
// Fixtures, on an address of this machine that is not loopback (a Nimbus
// program's loopback is its session's ports), made by the host's Node:
//   good   TLS under a CA workerd trusts here (NODE_EXTRA_CA_CERTS, read by
//          miniflare at start): SNI and ALPN reported, an echo, a half-close.
//   other  TLS under a CA nothing trusts but the case that names it (`ca`).
//   wss    a WebSocket echo on `good`'s certificate.
//   redis  redis-server over TLS, when it is installed.
//   pg     a PostgreSQL SSLRequest answered 'S', then TLS (a STARTTLS).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change. Needs openssl.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLocalProbe } from './lib/workerd-probe.mjs';

const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null;
if (!lan || spawnSync('openssl', ['version']).status !== 0) {
  console.log('tls-stoppable-workerd: skipped (needs an address but loopback, and openssl)');
  process.exit(0);
}

// ── Certificates ────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'tls-stoppable-'));
const ssl = (args) => {
  const run = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
};
writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=IP:${lan},DNS:fixture.nimbus.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
for (const ca of ['good', 'other']) {
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${ca}-ca.key`, '-out', `${ca}-ca.pem`, '-days', '2', '-subj', `/CN=Nimbus ${ca} test CA`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${ca}.key`, '-out', `${ca}.csr`, '-subj', `/CN=fixture.nimbus.test`]);
  ssl(['x509', '-req', '-in', `${ca}.csr`, '-CA', `${ca}-ca.pem`, '-CAkey', `${ca}-ca.key`, '-CAcreateserial', '-out', `${ca}.pem`, '-days', '2', '-extfile', 'ext.cnf']);
}
const GOOD_CA = join(dir, 'good-ca.pem');
process.env.NODE_EXTRA_CA_CERTS = GOOD_CA;

// ── Fixtures (the host's Node) ──────────────────────────────────────────────
const FIXTURES = `
const tls = require('tls'), net = require('net'), https = require('https'), crypto = require('crypto'), fs = require('fs');
const dir = ${JSON.stringify(dir)}, host = ${JSON.stringify(lan)};
const creds = (ca) => ({ key: fs.readFileSync(dir + '/' + ca + '.key'), cert: fs.readFileSync(dir + '/' + ca + '.pem') });
const listen = (server) => new Promise((r) => server.listen(0, host, () => r(server.address().port)));
// One line in, then: INFO (what the handshake was), ECHO <n> (n bytes back),
// HALF (answer once the client has ended its side).
const serve = (socket) => {
  socket.on('error', () => {});
  let buf = Buffer.alloc(0), mode = null, left = 0;
  socket.on('data', (d) => {
    if (mode === 'echo') { const take = d.subarray(0, left); left -= take.length; socket.write(take); return; }
    buf = Buffer.concat([buf, d]);
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    const line = buf.subarray(0, nl).toString(), rest = buf.subarray(nl + 1);
    if (line === 'INFO') socket.end(JSON.stringify({ servername: socket.servername || null, alpn: socket.alpnProtocol || null }) + '\\n');
    else if (line.startsWith('ECHO ')) { mode = 'echo'; left = Number(line.slice(5)); if (rest.length) { const take = rest.subarray(0, left); left -= take.length; socket.write(take); } }
    else if (line === 'HALF') { socket.on('end', () => socket.end('after-end\\n')); }
  });
};
const tlsOpts = (ca) => ({ ...creds(ca), ALPNProtocols: ['x-test', 'http/1.1'], allowHalfOpen: true });
(async () => {
  const ports = {};
  ports.good = await listen(tls.createServer(tlsOpts('good'), serve));
  ports.other = await listen(tls.createServer(tlsOpts('other'), serve));
  // A WebSocket echo: the handshake by hand, then unmasked text frames back.
  const wss = https.createServer(creds('good'), (q, s) => s.end('no'));
  wss.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
    socket.on('error', () => {});
    socket.on('data', (frame) => {
      const len = frame[1] & 127, mask = frame.subarray(2, 6), data = Buffer.from(frame.subarray(6, 6 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if ((frame[0] & 15) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      socket.write(Buffer.concat([Buffer.from([0x81, data.length]), data]));
    });
  });
  ports.wss = await listen(wss);
  // PostgreSQL's SSLRequest, answered 'S', then TLS: PING -> PONG.
  ports.pg = await listen(net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (d) => {
      if (!d.equals(Buffer.from('0000000804d2162f', 'hex'))) { socket.destroy(); return; }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, ...creds('good') });
      secure.on('error', () => {});
      secure.on('data', (x) => { if (String(x).includes('PING')) secure.end('PONG\\n'); });
    });
  }));
  console.log('PORTS ' + JSON.stringify(ports));
})();
`;
const fixtures = spawn('node', ['-e', FIXTURES], { stdio: ['ignore', 'pipe', 'inherit'] });
const ports = await new Promise((resolve, reject) => {
  let out = '';
  fixtures.stdout.on('data', (d) => { out += d; const m = /PORTS (.*)/.exec(out); if (m) resolve(JSON.parse(m[1])); });
  fixtures.on('exit', (code) => reject(new Error('fixtures exited ' + code)));
});
let redis = null;
if (spawnSync('redis-server', ['--version']).status === 0) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  ports.redisPassword = randomBytes(12).toString('hex');
  redis = spawn('redis-server', ['--port', '0', '--tls-port', String(port), '--bind', lan, '--save', '', '--appendonly', 'no', '--tls-auth-clients', 'no',
    '--requirepass', ports.redisPassword,
    '--tls-cert-file', join(dir, 'good.pem'), '--tls-key-file', join(dir, 'good.key'), '--tls-ca-cert-file', GOOD_CA], { stdio: 'ignore' });
  ports.redis = port;
  await new Promise((r) => setTimeout(r, 500));
}

// ── The cases: each child prints one line, its result ───────────────────────
const head = [
  "const tls = require('tls'), fs = require('fs');",
  `const HOST = ${JSON.stringify(lan)}, PORTS = ${JSON.stringify(ports)};`,
  `const OTHER_CA = ${JSON.stringify(spawnSync('cat', [join(dir, 'other-ca.pem')], { encoding: 'utf8' }).stdout)};`,
  "const done = (result) => { console.log('RESULT ' + JSON.stringify(result)); };",
  "const failed = (e) => done({ error: (e && e.code) || null, message: String((e && e.message) || e).slice(0, 160) });",
  // Talk one line, collect what comes back until the server ends.
  'const talk = (options, line, extra) => new Promise((resolve) => {',
  '  let s;',
  '  try { s = tls.connect(options); } catch (e) { resolve({ thrown: true, error: e.code || null, message: String(e.message).slice(0, 160) }); return; }',
  "  let got = '';",
  "  s.on('secureConnect', () => { s.write(line + '\\n'); if (extra) extra(s); });",
  "  s.on('data', (d) => { got += d; });",
  "  s.on('end', () => resolve({ authorized: s.authorized, got: got.trim() }));",
  "  s.on('error', (e) => resolve({ error: e.code || null, message: String(e.message).slice(0, 160) }));",
  '});',
].join('\n');
const CASES = {
  // The handshake as the server saw it, and authorized.
  basic: '(async () => done(await talk({ host: HOST, port: PORTS.good }, "INFO")))();',
  sni: '(async () => done(await talk({ host: HOST, port: PORTS.good, servername: "fixture.nimbus.test" }, "INFO")))();',
  alpn: '(async () => done(await talk({ host: HOST, port: PORTS.good, ALPNProtocols: ["x-test"] }, "INFO")))();',
  // A private CA named by the program.
  ca: '(async () => done(await talk({ host: HOST, port: PORTS.other, ca: OTHER_CA }, "INFO")))();',
  // A certificate nothing here trusts: refused, or reported with rejectUnauthorized: false.
  untrusted: '(async () => done(await talk({ host: HOST, port: PORTS.other }, "INFO")))();',
  noReject: [
    '(async () => {',
    '  let s; try { s = tls.connect({ host: HOST, port: PORTS.other, rejectUnauthorized: false }); } catch (e) { failed(e); return; }',
    "  s.on('secureConnect', () => { done({ authorized: s.authorized, authorizationError: String(s.authorizationError) }); s.destroy(); });",
    "  s.on('error', failed);",
    '})();',
  ].join('\n'),
  // What pg, mysql2, ioredis and undici read of the peer certificate.
  peerCert: [
    'const s = tls.connect({ host: HOST, port: PORTS.good });',
    "s.on('secureConnect', () => {",
    '  try {',
    '    const c = s.getPeerCertificate(true);',
    '    done({ cn: c.subject && c.subject.CN, issuer: c.issuer && c.issuer.CN, raw: Buffer.isBuffer(c.raw), fingerprint256: typeof c.fingerprint256, validTo: typeof c.valid_to });',
    '  } catch (e) { failed(e); }',
    '  s.destroy();',
    '});',
    "s.on('error', failed);",
  ].join('\n'),
  // The client ends its side; the server answers after.
  halfClose: '(async () => done(await talk({ host: HOST, port: PORTS.good, allowHalfOpen: true }, "HALF", (s) => s.end())))();',
  // 8 MiB each way, written as the socket takes it.
  backpressure: [
    "const crypto = require('crypto');",
    'const N = 8 * 1024 * 1024, piece = crypto.randomBytes(65536);',
    'const s = tls.connect({ host: HOST, port: PORTS.good });',
    "const sent = crypto.createHash('sha256'), back = crypto.createHash('sha256');",
    'let got = 0, waits = 0;',
    "s.on('secureConnect', async () => {",
    "  s.write('ECHO ' + N + '\\n');",
    '  for (let i = 0; i < N / piece.length; i++) { sent.update(piece); if (!s.write(piece)) { waits++; await new Promise((r) => s.once("drain", r)); } }',
    '});',
    "s.on('data', (d) => { back.update(d); got += d.length; if (got >= N) { done({ bytes: got, same: sent.digest('hex') === back.digest('hex'), waited: waits > 0 }); s.destroy(); } });",
    "s.on('error', failed);",
  ].join('\n'),
  // A STARTTLS: PostgreSQL's SSLRequest on a plain socket, 'S', then TLS on
  // that socket. node:net has no outbound TCP in Nimbus; workerd's own socket
  // class (tls.TLSSocket's prototype) does.
  starttls: [
    // net.Socket under Node; workerd's own socket class in Nimbus.
    'const Plain = Object.getPrototypeOf(tls.TLSSocket);',
    'const p = new Plain();',
    "p.on('error', failed);",
    'p.connect(PORTS.pg, HOST, () => {',
    "  p.write(Buffer.from('0000000804d2162f', 'hex'));",
    "  p.once('data', (d) => {",
    '    let s; try { s = tls.connect({ socket: p, servername: "fixture.nimbus.test" }); } catch (e) { failed(e); return; }',
    "    let got = '';",
    "    s.on('secureConnect', () => s.write('PING\\n'));",
    "    s.on('data', (x) => { got += x; });",
    "    s.on('end', () => done({ answer: String(d), got: got.trim(), authorized: s.authorized }));",
    "    s.on('error', failed);",
    '  });',
    '});',
  ].join('\n'),
  // node:net itself.
  netConnect: "const c = require('net').connect(PORTS.pg, HOST); c.on('connect', () => { done({ connected: true }); c.destroy(); }); c.on('error', failed);",
  // A WebSocket over TLS: one message there and back.
  wss: [
    'const ws = new WebSocket("wss://" + HOST + ":" + PORTS.wss + "/");',
    "ws.onopen = () => ws.send('hi');",
    "ws.onmessage = (e) => { done({ echo: String(e.data) }); ws.close(); };",
    "ws.onerror = (e) => done({ error: 'websocket', message: String(e && e.message || '').slice(0, 160) });",
  ].join('\n'),
  ...(ports.redis ? {
    // AUTH and PING to Redis over TLS (what ioredis's rediss:// does).
    redis: [
      'const pw = PORTS.redisPassword;',
      'const s = tls.connect({ host: HOST, port: PORTS.redis });',
      "let got = '';",
      's.on("secureConnect", () => s.write("*2\\r\\n$4\\r\\nAUTH\\r\\n$" + pw.length + "\\r\\n" + pw + "\\r\\n*1\\r\\n$4\\r\\nPING\\r\\n"));',
      's.on("data", (d) => { got += d; if (got.includes("PONG") || got.startsWith("-")) { done({ reply: got.trim().split("\\r\\n"), authorized: s.authorized }); s.destroy(); } });',
      's.on("error", failed);',
    ].join('\n'),
  } : {}),
};

// The parent: each case as a child_process child, stdin open until the child
// has printed (under Node, the same child is also run with stdin ignored).
const PARENT = [
  "const { spawn } = require('child_process');",
  `const HEAD = ${JSON.stringify(head)};`,
  `const CASES = ${JSON.stringify(CASES)};`,
  'const WAYS = process.argv.includes("both") ? [true, false] : [true];',
  'function run(name, stoppable) {',
  '  return new Promise((resolve) => {',
  "    const c = spawn('node', ['-e', HEAD + '\\n' + CASES[name]], { stdio: [stoppable ? 'pipe' : 'ignore', 'pipe', 'pipe'] });",
  "    let out = '', err = '';",
  "    const stuck = setTimeout(() => { c.kill(); resolve({ stuck: true, out: out.slice(-300), err: err.slice(-300) }); }, 60000);",
  "    c.stdout.on('data', (d) => { out += d; if (stoppable && /RESULT /.test(out)) c.stdin.end(); });",
  "    c.stderr.on('data', (d) => { err += d; });",
  "    c.on('close', () => { clearTimeout(stuck); const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { noResult: true, out: out.slice(-300), err: err.slice(-300) }); });",
  '  });',
  '}',
  '(async () => {',
  '  for (const name of Object.keys(CASES)) {',
  "    for (const stoppable of WAYS) console.log('CASE ' + name + ' ' + (stoppable ? 'stoppable' : 'plain') + ' ' + JSON.stringify(await run(name, stoppable)));",
  '  }',
  '  process.exit(0);',
  '})();',
].join('\n');
const results = (stdout) => {
  const found = {};
  for (const m of stdout.matchAll(/^CASE (\w+) (\w+) (.*)$/gm)) (found[m[1]] ??= {})[m[2]] = JSON.parse(m[3].replace(/\r$/, ''));
  return found;
};

let failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what.split('\n')[0]}`); };
let probe = null;
try {
  // ── The host's Node ─────────────────────────────────────────────────────
  const host = await new Promise((resolve) => {
    const c = spawn('node', ['-e', PARENT, 'both'], { cwd: dir, env: { ...process.env, NODE_EXTRA_CA_CERTS: GOOD_CA } });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(host.code, 0, host.err);
  const node = results(host.out);
  for (const [name, ways] of Object.entries(node)) {
    assert.deepEqual(ways.stoppable, ways.plain, `node: ${name} is the same whichever way stdin is`);
  }
  assert.deepEqual(node.basic.plain, { authorized: true, got: JSON.stringify({ servername: null, alpn: null }) });
  assert.deepEqual(node.sni.plain, { authorized: true, got: JSON.stringify({ servername: 'fixture.nimbus.test', alpn: null }) });
  assert.deepEqual(node.alpn.plain, { authorized: true, got: JSON.stringify({ servername: null, alpn: 'x-test' }) });
  assert.deepEqual(node.ca.plain, { authorized: true, got: JSON.stringify({ servername: null, alpn: null }) });
  assert.equal(node.untrusted.plain.error, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  assert.deepEqual(node.noReject.plain, { authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  assert.deepEqual(node.peerCert.plain, { cn: 'fixture.nimbus.test', issuer: 'Nimbus good test CA', raw: true, fingerprint256: 'string', validTo: 'string' });
  assert.deepEqual(node.halfClose.plain, { authorized: true, got: 'after-end' });
  assert.deepEqual(node.backpressure.plain, { bytes: 8 * 1024 * 1024, same: true, waited: true });
  assert.deepEqual(node.starttls.plain, { answer: 'S', got: 'PONG', authorized: true });
  assert.deepEqual(node.netConnect.plain, { connected: true });
  assert.deepEqual(node.wss.plain, { echo: 'hi' });
  if (ports.redis) assert.deepEqual(node.redis.plain, { reply: ['+OK', '+PONG'], authorized: true });

  // ── Nimbus ───────────────────────────────────────────────────────────────
  console.log('tls-stoppable-workerd: starting local workerd');
  probe = await startLocalProbe({ runtimes: [] });
  process.env.BASE = probe.base;
  process.env.NIMBUS_PROBE_TOKEN = probe.token;
  const { mintSession, deleteSession, Terminal } = await import('../behavioral/_driver.mjs');
  const strip = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
  const sid = await mintSession();
  const t = new Terminal(sid);
  let nimbus;
  try {
    await t.connect();
    await t.waitForPrompt(60_000);
    const W = '/home/user/tls';
    const put = (name, text) => t.run(`node -e "require('fs').writeFileSync('${W}/${name}', Buffer.from('${Buffer.from(text).toString('base64')}', 'base64'))"`, 60_000);
    await t.run(`mkdir -p ${W}`, 60_000);
    await put('parent.js', PARENT);
    const { output } = await t.run(`cd ${W} && node parent.js; echo __TLS_DONE__`, 900_000);
    nimbus = results(strip(output));
    // From the terminal, with no stdin to wait for: it cannot stop.
    for (const name of Object.keys(CASES)) {
      await put(`${name}.js`, head + '\n' + CASES[name]);
      const ran = strip((await t.run(`cd ${W} && node ${name}.js; echo __TLS_DONE__`, 120_000)).output);
      const m = /RESULT (.*)/.exec(ran);
      (nimbus[name] ??= {}).plain = m ? JSON.parse(m[1]) : { noResult: true, out: ran.slice(-300) };
    }
  } finally {
    await t.close().catch(() => {});
    await deleteSession(sid).catch(() => {});
  }
  console.log(JSON.stringify(nimbus));
  const same = (name, way) => JSON.stringify(nimbus[name]?.[way]) === JSON.stringify(node[name].plain);
  const named = (name, way, option) => nimbus[name]?.[way]?.error === 'ERR_OPTION_NOT_IMPLEMENTED' && nimbus[name][way].message.includes(option);
  const show = (name) => `\n  node:      ${JSON.stringify(node[name].plain)}\n  stoppable: ${JSON.stringify(nimbus[name]?.stoppable)}\n  plain:     ${JSON.stringify(nimbus[name]?.plain)}`;
  // As under Node, both ways.
  for (const name of ['halfClose', 'backpressure', ...(ports.redis ? ['redis'] : [])]) {
    check(same(name, 'stoppable') && same(name, 'plain'), `${name}: as under node, stdin open or not${show(name)}`);
  }
  // workerd sends the host as the server name even when it is an address,
  // where Node sends none: the same both ways.
  const ipNamed = { authorized: true, got: JSON.stringify({ servername: lan, alpn: null }) };
  check(JSON.stringify(nimbus.basic?.stoppable) === JSON.stringify(ipNamed) && JSON.stringify(nimbus.basic?.plain) === JSON.stringify(ipNamed),
    `basic: connected and authorized both ways (the address sent as SNI, as workerd does)${show('basic')}`);
  // A server name other than the host: the session sends it, as Node does;
  // workerd's own node:tls checks the certificate against it but sends the
  // host.
  check(same('sni', 'stoppable') && nimbus.sni?.plain?.authorized === true, `sni: as under node where the session makes the TLS${show('sni')}`);
  // A WebSocket over TLS: what one way does, the other does.
  check(JSON.stringify(nimbus.wss?.stoppable) === JSON.stringify(nimbus.wss?.plain), `wss: the same either way${show('wss')}`);
  // What workerd's node:tls does not do, by name, both ways.
  check(named('alpn', 'stoppable', 'ALPNProtocols') && named('alpn', 'plain', 'ALPNProtocols'), `alpn: refused by name${show('alpn')}`);
  check(named('noReject', 'stoppable', 'rejectUnauthorized') && named('noReject', 'plain', 'rejectUnauthorized'), `rejectUnauthorized: false: refused by name${show('noReject')}`);
  const peerRefused = (way) => /getPeerCertificate is not implemented/.test(nimbus.peerCert?.[way]?.message ?? '');
  check(peerRefused('stoppable') && peerRefused('plain'), `getPeerCertificate: refused by name${show('peerCert')}`);
  // A certificate nothing trusts: refused both ways.
  const refusedUntrusted = (way) => nimbus.untrusted?.[way]?.error !== undefined || nimbus.untrusted?.[way]?.thrown === true;
  check(refusedUntrusted('stoppable') && refusedUntrusted('plain') && !/authorized":true/.test(JSON.stringify(nimbus.untrusted)), `untrusted certificate: refused${show('untrusted')}`);
  // A private CA: workerd checks against its trust store only. Refused,
  // never connected unchecked; with stdin open the error names the option.
  check(/options\.ca/.test(nimbus.ca?.stoppable?.message ?? '') && nimbus.ca?.stoppable?.authorized !== true && nimbus.ca?.plain?.authorized !== true,
    `ca: refused, by name where the session makes the TLS${show('ca')}`);
  // node:net has no outbound TCP in Nimbus, either way.
  check(nimbus.netConnect?.stoppable?.error === 'ERR_NET_SOCKET_NOT_AVAILABLE' && nimbus.netConnect?.plain?.error === 'ERR_NET_SOCKET_NOT_AVAILABLE',
    `net.connect: no outbound TCP, by name${show('netConnect')}`);
  // STARTTLS over workerd's own socket class: workerd upgrades it when it
  // makes the TLS; through the session it is refused by name.
  check(same('starttls', 'plain') && named('starttls', 'stoppable', 'options.socket'), `starttls: as under node where workerd makes the TLS, by name through the session${show('starttls')}`);
} finally {
  if (probe) await probe.stop();
  fixtures.kill();
  redis?.kill();
  rmSync(dir, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`tls-stoppable-workerd: ${failures.length} failure(s):\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log('tls-stoppable-workerd: TLS from a child that can stop does what it does from one that cannot, and says what neither does');
