// @serial
// A real session's tls.connect crosses the embedder's optional connectTls RPC.
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const probe = await startLocalProbe({ runtimes: [], vars: { NIMBUS_TEST_EGRESS: '1', NIMBUS_TEST_EGRESS_TLS: '1' } });
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
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
    const encoded = Buffer.from(source).toString('base64');
    const wrote = await terminal.run(`node -e "require('fs').writeFileSync('/home/user/tls-proof.js', Buffer.from('${encoded}', 'base64'))"`);
    assert.equal(wrote.status, 0, wrote.stdout);
    const result = await terminal.run('node /home/user/tls-proof.js', 60000);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /secure true true/);
    assert.match(result.stdout, /answer via-egress-tls egress-test\.invalid:443 HEAD \/tls-proof HTTP\/1\.0/);
  } finally { await terminal.close(); }
} finally { await probe.stop(); }
